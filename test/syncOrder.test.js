const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { SRC } = require('./helpers');

const { oldestFirst, shouldStopSync } = require(path.join(SRC, 'services', 'syncOrder.js'));

/** An error shaped like the one axios throws for an HTTP status. */
const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`),
    { isAxiosError: true, response: { status } });

test('oldestFirst orders ids by game number, across queues', () => {
    // Riot's lists: newest first, one queue after another
    const ids = ['EUW1_900', 'EUW1_700', 'EUW1_950', 'EUW1_800', 'EUW1_710'];
    assert.deepEqual(oldestFirst(ids), ['EUW1_700', 'EUW1_710', 'EUW1_800', 'EUW1_900', 'EUW1_950']);
    assert.deepEqual(oldestFirst(new Set(['NA1_2', 'NA1_10'])), ['NA1_2', 'NA1_10']);
});

test('shouldStopSync: stop on failures a later sync can get past', () => {
    assert.equal(shouldStopSync(httpError(401)), true);
    assert.equal(shouldStopSync(httpError(403)), true);
    assert.equal(shouldStopSync(httpError(429)), true);
    assert.equal(shouldStopSync(httpError(503)), true);
    // network error: axios error without a response
    assert.equal(shouldStopSync(Object.assign(new Error('ECONNRESET'), { isAxiosError: true })), true);
    assert.equal(shouldStopSync(Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })), true);
});

test('shouldStopSync: skip games that will never work', () => {
    assert.equal(shouldStopSync(httpError(404)), false);
    assert.equal(shouldStopSync(new TypeError("Cannot read properties of undefined (reading 'participants')")), false);
    assert.equal(shouldStopSync(null), false);
});

// ---------------------------------------------------------------------------
// syncMatches end to end, against a fake Riot API and an in-memory table
// ---------------------------------------------------------------------------

const PUUID = 'me';
const T0 = Date.UTC(2026, 9, 1, 12, 0);
const HOUR = 3600_000;

/** 30 games on Riot's side, one an hour. */
const RIOT_GAMES = Array.from({ length: 30 }, (_, i) => ({ id: `EUW1_${5000 + i}`, at: T0 + i * HOUR }));

function fakeMatch({ id, at, queue = 420 }) {
    const player = (n, teamId) => ({
        puuid: n === 0 ? PUUID : `p${n}`, participantId: n + 1, teamId,
        championName: n === 0 ? 'Ahri' : `Champ${n}`, champLevel: 15, win: teamId === 100,
        kills: 5, deaths: 3, assists: 7, goldEarned: 11000,
        totalMinionsKilled: 180, neutralMinionsKilled: 10,
        totalDamageDealtToChampions: 20000, visionScore: 25,
        teamPosition: 'MIDDLE', lane: 'MIDDLE',
    });
    return {
        metadata: { matchId: id },
        info: {
            queueId: queue, gameCreation: at, gameDuration: 1800,
            participants: Array.from({ length: 10 }, (_, n) => player(n, n < 5 ? 100 : 200)),
            teams: [{ teamId: 100, objectives: {} }, { teamId: 200, objectives: {} }],
        },
    };
}

function stubModule(relPath, exports) {
    const p = path.join(SRC, relPath);
    const m = new Module(p, null);
    m.filename = p;
    m.loaded = true;
    m.exports = exports;
    require.cache[p] = m;
}

/** In-memory `matches` table that answers the queries syncMatches makes. */
const stored = new Map();
stubModule('services/database.js', {
    db: {
        all(sql, params, cb) {
            if (typeof params === 'function') cb = params;
            cb(null, [...stored.keys()].map(matchId => ({ matchId })));
        },
        get(sql, params, cb) {
            if (typeof params === 'function') cb = params;
            const times = [...stored.values()].map(r => r.gameCreation);
            cb(null, { latestTime: times.length ? Math.max(...times) : null });
        },
        run(sql, params, cb) {
            if (/^\s*INSERT/i.test(sql)) stored.set(params[0], { gameCreation: params[2] });
            if (cb) cb.call({}, null);
        },
    },
    initDatabase: () => {},
});

let keyWorksFor = Infinity;   // match fetches left before the key "expires"
let missingGame = null;       // a game Riot answers 404 for
stubModule('services/riotApi.js', {
    // Like Riot: only this queue's games after startTime, newest first
    async getMatchIds(puuid, startTime, queue) {
        return RIOT_GAMES.filter(g => (g.queue ?? 420) === queue && g.at >= startTime).map(g => g.id).reverse();
    },
    async getMatchData(id) {
        if (keyWorksFor <= 0) throw Object.assign(new Error('expired'), { isAxiosError: true, response: { status: 403 } });
        keyWorksFor--;
        if (id === missingGame) throw Object.assign(new Error('gone'), { isAxiosError: true, response: { status: 404 } });
        return fakeMatch(RIOT_GAMES.find(g => g.id === id));
    },
    async getMatchTimeline() { throw new Error('no timeline in this test'); },
});

const { syncMatches } = require(path.join(SRC, 'services', 'matchService.js'));

test('an interrupted sync followed by a normal sync stores every game (#13)', async () => {
    stored.clear();
    // Already have the first 10 games; a week passes with 20 more
    for (const g of RIOT_GAMES.slice(0, 10)) stored.set(g.id, { gameCreation: g.at });

    keyWorksFor = 8;
    await assert.rejects(syncMatches(PUUID), err => err.response.status === 403 && err.savedBeforeStop === 8);
    assert.equal(stored.size, 18);

    keyWorksFor = Infinity;   // new key
    const result = await syncMatches(PUUID);
    assert.equal(result.newMatches, 12);
    assert.deepEqual([...stored.keys()].sort(), RIOT_GAMES.map(g => g.id).sort());
});

test('a game Riot no longer has is skipped, not a reason to stop', async () => {
    stored.clear();
    keyWorksFor = Infinity;
    missingGame = RIOT_GAMES[3].id;
    const result = await syncMatches(PUUID);
    missingGame = null;
    assert.equal(result.newMatches, 29);
    assert.equal(stored.has(RIOT_GAMES[3].id), false);
});

test('a Ranked Premade game (queue 710, missing from Riot\'s queues.json) is synced', async () => {
    stored.clear();
    keyWorksFor = Infinity;
    for (const g of RIOT_GAMES) stored.set(g.id, { gameCreation: g.at });
    const premade = { id: 'EUW1_6000', at: T0 + 40 * HOUR, queue: 710 };
    RIOT_GAMES.push(premade);
    try {
        assert.equal((await syncMatches(PUUID)).newMatches, 1);
        assert.equal(stored.has(premade.id), true);
    } finally {
        RIOT_GAMES.pop();
    }
});

// ---------------------------------------------------------------------------
// Fill gaps (#18): games an old sync skipped
// ---------------------------------------------------------------------------
const { fillGaps } = require(path.join(SRC, 'services', 'matchService.js'));

test('Fill gaps stores the games an old sync skipped, which a normal sync never would (#18)', async () => {
    stored.clear();
    keyWorksFor = Infinity;
    // A hole in the middle: games 10–19 missing
    for (const g of [...RIOT_GAMES.slice(0, 10), ...RIOT_GAMES.slice(20)]) stored.set(g.id, { gameCreation: g.at });

    assert.equal((await syncMatches(PUUID)).newMatches, 0, 'a normal sync only looks after the newest game');

    const statuses = [];
    const r = await fillGaps(PUUID, (c, t, status) => statuses.push(status));
    assert.deepEqual([r.listed, r.missing, r.newMatches], [30, 10, 10]);
    assert.deepEqual([...stored.keys()].sort(), RIOT_GAMES.map(g => g.id).sort());
    assert.ok(statuses.includes('listing') && statuses.includes('complete'));

    assert.equal((await fillGaps(PUUID)).missing, 0, 'nothing left to fill');
});

test('Fill gaps follows the same stop rule: oldest first, stop on an expired key', async () => {
    stored.clear();
    for (const g of RIOT_GAMES.slice(20)) stored.set(g.id, { gameCreation: g.at });   // 0–19 missing

    keyWorksFor = 5;
    await assert.rejects(fillGaps(PUUID), err => err.response.status === 403 && err.savedBeforeStop === 5);
    assert.ok(RIOT_GAMES.slice(0, 5).every(g => stored.has(g.id)), 'the five oldest were stored');
    assert.ok(!stored.has(RIOT_GAMES[5].id));

    keyWorksFor = Infinity;
    assert.equal((await fillGaps(PUUID)).newMatches, 15);
    assert.equal(stored.size, 30);
});

test('Fill gaps from a chosen date lists only games since then', async () => {
    stored.clear();
    keyWorksFor = Infinity;
    const r = await fillGaps(PUUID, null, { since: RIOT_GAMES[25].at });
    assert.deepEqual([r.listed, r.newMatches], [5, 5]);
});

test('seasonStart: January 1 (UTC) of the current year (#38)', () => {
    const { seasonStart } = require(path.join(SRC, 'services', 'syncOrder.js'));
    assert.equal(seasonStart(Date.UTC(2026, 9, 16, 12)), Date.UTC(2026, 0, 1));
    assert.equal(seasonStart(Date.UTC(2027, 0, 1, 0, 0, 1)), Date.UTC(2027, 0, 1));
    assert.equal(seasonStart(Date.UTC(2027, 11, 31, 23, 59)), Date.UTC(2027, 0, 1));
    assert.equal(new Date(seasonStart()).getUTCFullYear(), new Date().getUTCFullYear());
});
