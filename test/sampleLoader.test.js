const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const L = require(path.join(SRC, 'services', 'sampleLoader.js'));
const { sampleGroups } = require(path.join(SRC, 'services', 'sampleSelect.js'));

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 11);
const YORICK = { name: 'Yorick', key: 83 };
const SILVER = sampleGroups({ tier: 'SILVER', rank: 'II' }).slice(0, 1);   // Silver I only

const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`),
    { isAxiosError: true, response: { status } });

/** A Match-V5 game where `puuid` played `champ`. */
function rawGame(id, puuid, champ, over = {}) {
    return {
        metadata: { matchId: id },
        info: {
            gameCreation: NOW - DAY, gameDuration: 1800, gameVersion: '16.21.512.1',
            teams: [{ teamId: 100, win: true }, { teamId: 200, win: false }],
            participants: [
                { puuid, participantId: 1, teamId: 100, championName: champ, teamPosition: 'TOP', win: true,
                    item0: 3078, item1: 3047, item2: 0, item3: 0, item4: 0, item5: 0, item6: 3340,
                    perks: { styles: [{ selections: [{ perk: 8010 }] }, { style: 8400 }] } },
                { puuid: 'other', participantId: 6, teamId: 200, championName: 'Darius', win: false },
            ],
            ...over,
        },
    };
}
const timeline = () => ({ info: { frames: [
    { timestamp: 0, participantFrames: {}, events: [{ type: 'ITEM_PURCHASED', participantId: 1, itemId: 1055, timestamp: 9000 }] },
    { timestamp: 60000, participantFrames: {}, events: [] },
] } });

/**
 * World: pages of division players, each player's masteries and games.
 * games[puuid] = list of champion names, newest first.
 */
function fakeApi(world, over = {}) {
    const calls = { list: 0, apex: 0, mastery: 0, ids: 0, match: 0, timeline: 0 };
    const fetched = [];
    const api = {
        async getLeagueEntries(tier, division, page) { calls.list++; return (world.pages[`${tier} ${division}`] || [])[page - 1] || []; },
        async getApexLeague(tier) { calls.apex++; return world.apex?.[tier] || []; },
        async getAllMasteries(puuid) { calls.mastery++; return world.masteries[puuid] || []; },
        async getMatchIds(puuid) { calls.ids++; return (world.games[puuid] || []).map((_, i) => `${puuid}-${i}`); },
        async getMatchData(id) {
            calls.match++; fetched.push(id);
            const [puuid, i] = [id.slice(0, id.lastIndexOf('-')), Number(id.slice(id.lastIndexOf('-') + 1))];
            return rawGame(id, puuid, world.games[puuid][i]);
        },
        async getMatchTimeline() { calls.timeline++; return timeline(); },
        ...over,
    };
    return { api, calls, fetched };
}

/** In-memory version of sampleStore.js with the same semantics. */
function fakeStore() {
    const games = new Map(), rows = new Map(), skips = new Set(), players = new Map(), lists = new Map();
    const k = (...a) => a.map(x => (x == null ? '' : x)).join('|');
    return {
        games, rows, skips,
        async saveGame({ game, row }) {
            if (!row.puuid) throw new Error('NOT NULL');
            games.set(game.matchId, game); rows.set(k(row.matchId, row.puuid), row);
        },
        async saveSkip(matchId, puuid) { skips.add(k(matchId, puuid)); },
        async knownMatchIds(puuid) {
            const ids = new Set();
            for (const r of rows.values()) if (r.puuid === puuid) ids.add(r.matchId);
            for (const s of skips) { const [m, p] = s.split('|'); if (p === puuid) ids.add(m); }
            return ids;
        },
        async storedCount(puuid, champ) { return [...rows.values()].filter(r => r.puuid === puuid && r.championName === champ).length; },
        async getPlayers(tier, division) { return [...players.values()].filter(p => p.tier === tier && (p.division || null) === (division || null)); },
        async savePlayers(list) { for (const p of list) players.set(k(p.puuid, p.tier, p.division), { ...p }); },
        async listFetchedAt(tier, division, page) { return lists.get(k(tier, division, page)) ?? null; },
        async saveListFetched(tier, division, page, at) { lists.set(k(tier, division, page), at); },
    };
}

const mastery = (key, points, lastPlayTime = NOW - DAY) => ({ championId: key, championPoints: points, lastPlayTime });

/** Silver I page 1: s1..s6 play Yorick (alternating with Ahri), plus "me". */
function world() {
    const w = { pages: { 'SILVER I': [[]] }, masteries: {}, games: {} };
    for (let i = 1; i <= 6; i++) {
        const p = `s${i}`;
        w.pages['SILVER I'][0].push({ puuid: p });
        w.masteries[p] = [mastery(83, 1000 * i)];
        w.games[p] = Array.from({ length: 20 }, (_, j) => (j % 2 ? 'Ahri' : 'Yorick'));
    }
    w.pages['SILVER I'][0].push({ puuid: 'me' });
    w.masteries.me = [mastery(83, 999999)];
    w.games.me = Array(20).fill('Yorick');
    return w;
}

const runOnce = (api, store, opts = {}) => L.createSampleLoader({ api, store, now: () => opts.now || NOW })
    .run({ champions: [YORICK], groups: SILVER, selfPuuid: 'me', shouldStop: () => null, ...opts });

test('fetches the timeline only for games on the champion and records a skip for the rest', async () => {
    const { api, calls } = fakeApi(world());
    const store = fakeStore();
    const r = await runOnce(api, store);
    assert.equal(r.stopped, null);
    assert.equal(r.stored, 25);                       // 5 players × 5 games
    assert.equal(calls.timeline, 25);                 // only Yorick games
    assert.equal(calls.match, 5 * 9);                 // Y A Y A Y A Y A Y → 9 checks to reach 5
    assert.equal(store.skips.size, 5 * 4);
    assert.deepEqual(r.found, { Yorick: { level: 5 } });
    assert.ok([...store.rows.values()].every(row => row.tier === 'SILVER' && row.division === 'I'));
});

test('never picks selfPuuid, and picks the most mastery', async () => {
    const { api } = fakeApi(world());
    const store = fakeStore();
    await runOnce(api, store);
    const picked = new Set([...store.rows.values()].map(row => row.puuid));
    assert.ok(!picked.has('me'));
    assert.deepEqual([...picked].sort(), ['s2', 's3', 's4', 's5', 's6']);
});

test('stops a player at 15 checks when they rarely play the champion', async () => {
    const w = world();
    w.games.s6 = Array(20).fill('Ahri');
    const { api, fetched } = fakeApi(w);
    const store = fakeStore();
    await runOnce(api, store);
    assert.equal(fetched.filter(id => id.startsWith('s6-')).length, 15);
    assert.equal(await store.storedCount('s6', 'Yorick'), 0);
});

test('never downloads a known id again, and reuses lists and masteries', async () => {
    const w = world();
    w.games.s6 = Array(20).fill('Ahri');
    const { api, calls, fetched } = fakeApi(w);
    const store = fakeStore();
    await runOnce(api, store);
    const before = { ...calls };
    await runOnce(api, store);
    assert.equal(calls.list, before.list, 'list fetched today is reused');
    assert.equal(calls.mastery, before.mastery, 'masteries checked within 7 days are reused');
    assert.equal(new Set(fetched).size, fetched.length, 'no match fetched twice');

    await runOnce(api, store, { now: NOW + 8 * DAY });
    assert.ok(calls.list > before.list, 'list fetched again after a day');
    assert.ok(calls.mastery > before.mastery, 'masteries checked again after 7 days');
});

test('scans further pages only while a champion lacks 5 candidates, never more than 3', async () => {
    const w = { pages: { 'SILVER I': [] }, masteries: {}, games: {} };
    const page = (names) => names.map(p => {
        w.masteries[p] = [mastery(83, 100)]; w.games[p] = Array(5).fill('Yorick'); return { puuid: p };
    });
    w.pages['SILVER I'] = [page(['a1', 'a2', 'a3']), page(['b1']), page(['c1']), page(['d1', 'd2', 'd3', 'd4', 'd5'])];
    const { api, calls } = fakeApi(w);
    const r = await runOnce(api, fakeStore());
    assert.equal(calls.list, 3);
    assert.deepEqual(r.found, { Yorick: { level: 5 } });

    const w2 = world();
    w2.pages['SILVER I'].push([{ puuid: 'never' }]);
    const two = fakeApi(w2);
    await runOnce(two.api, fakeStore());
    assert.equal(two.calls.list, 1, 'page 1 already had 5 Yorick players');
});

test('a 401 stops with stopped "key" and stores nothing for the game in flight', async () => {
    const { api } = fakeApi(world(), { async getMatchTimeline() { throw httpError(401); } });
    const store = fakeStore();
    const r = await runOnce(api, store);
    assert.equal(r.stopped, 'key');
    assert.equal(store.games.size, 0);
    assert.equal(store.skips.size, 0, 'the Yorick game whose timeline failed is not marked as skipped');
});

test('a 404 match is skipped, not fatal', async () => {
    let first = true;
    const base = fakeApi(world());
    const { api } = fakeApi(world(), {
        async getMatchData(id) { if (first) { first = false; throw httpError(404); } return base.api.getMatchData(id); },
    });
    const store = fakeStore();
    const r = await runOnce(api, store);
    assert.equal(r.stopped, null);
    // s6: the 404 plus 5 Ahri games on the way to its 5th Yorick game (index 10); 4 each for the others
    assert.equal(store.skips.size, 6 + 4 * 4);
    assert.equal(await store.storedCount('s6', 'Yorick'), 5);
});

test('shouldStop stops before the next call with stopped "paused"', async () => {
    const { api, calls } = fakeApi(world());
    let n = 0;
    const r = await runOnce(api, fakeStore(), { shouldStop: () => (++n > 3 ? 'sync' : null) });
    assert.equal(r.stopped, 'paused');
    assert.equal(calls.list + calls.mastery + calls.ids + calls.match + calls.timeline, 3);
});

test('apex groups read the whole league in one call', async () => {
    const w = { pages: {}, apex: { MASTER: [{ puuid: 'm1' }] }, masteries: { m1: [mastery(83, 5)] }, games: { m1: ['Yorick'] } };
    const { api, calls } = fakeApi(w);
    const groups = sampleGroups({ tier: 'DIAMOND', rank: 'I' }).filter(g => g.key === 'above');
    const store = fakeStore();
    const r = await L.createSampleLoader({ api, store, now: () => NOW })
        .run({ champions: [YORICK], groups, selfPuuid: null, shouldStop: () => null });
    assert.equal(calls.apex, 1);
    assert.equal(calls.list, 0);
    assert.deepEqual(r.found, { Yorick: { above: 1 } });
    assert.equal([...store.rows.values()][0].division, null);
});

test('sampleGameFrom builds the row; null for a remake or a missing player', () => {
    const g = L.sampleGameFrom(rawGame('X1', 'p', 'Yorick'), timeline(), 'p');
    assert.equal(g.game.matchId, 'X1');
    assert.equal(g.game.patch, '16.21');
    assert.equal(g.game.blueWin, 1);
    assert.equal(g.row.championName, 'Yorick');
    assert.equal(g.row.teamId, 100);
    assert.equal(g.row.win, 1);
    assert.equal(g.row.itemPurchases, '1055:9');
    assert.equal(g.row.item0, 3078);
    assert.equal(g.row.item6, 3340);
    assert.equal(g.row.primaryRune, 8010);
    assert.equal(g.row.secondaryRuneStyle, 8400);
    assert.equal(L.sampleGameFrom(rawGame('X2', 'p', 'Yorick', { gameDuration: 200 }), timeline(), 'p'), null);
    assert.equal(L.sampleGameFrom(rawGame('X3', 'p', 'Yorick'), timeline(), 'nobody'), null);
});

test('sampleGameFrom sets winFeatures and blueWin', () => {
    const red = rawGame('X9', 'p', 'Yorick');
    red.info.participants[0].teamId = 200; red.info.participants[0].win = false;
    red.info.teams = [{ teamId: 100, win: true }, { teamId: 200, win: false }];
    const g = L.sampleGameFrom(red, timeline(), 'p');
    assert.equal(g.game.blueWin, 1);
    assert.equal(typeof g.game.winFeatures, 'string');
    assert.equal(g.game.winFeatures.split(';').length, 2);
    assert.equal(L.sampleGameFrom(rawGame('X8', 'p', 'Yorick'), null, 'p').game.winFeatures, '');
});
