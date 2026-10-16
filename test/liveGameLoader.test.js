const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const { createLiveGameLoader } = require(path.join(SRC, 'services', 'liveGameLoader.js'));

const H = 3600_000;
const T = Date.UTC(2026, 9, 16, 20);

const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`),
    { isAxiosError: true, response: { status } });

/** Ten parsePlayers-shaped rows: you + 4 allies (CHAOS), 5 enemies (ORDER). */
function makePlayers(over = {}) {
    return Array.from({ length: 10 }, (_, i) => ({
        index: i,
        riotId: `P${i}#EUW`, gameName: `P${i}`, tagLine: 'EUW',
        puuid: null,
        championName: 'Ahri', championId: 'Ahri', championKey: 103,
        team: i < 5 ? 'CHAOS' : 'ORDER',
        position: '', spells: [null, null], keystoneId: null,
        isBot: false, isYou: i === 2, lookup: true,
        ...(over[i] || {}),
    }));
}

const soloEntry = { tier: 'SILVER', rank: 'II', leaguePoints: 13, wins: 11, losses: 10,
    hotStreak: false, veteran: false, freshBlood: false, inactive: false };

/** Each player's last games: two of their own; P5 and P6 also share 'shared'. */
function idsFor(puuid) {
    const own = [`${puuid}-m1`, `${puuid}-m2`];
    return puuid === 'pu-P5' || puuid === 'pu-P6' ? ['shared', ...own] : own;
}

function matchFor(id) {
    const players = id === 'shared' ? ['pu-P5', 'pu-P6'] : [id.replace(/-m\d$/, '')];
    return {
        metadata: { matchId: id },
        info: {
            queueId: 420, gameCreation: T - H, gameDuration: 1800,
            participants: players.map(puuid => ({ puuid, championName: 'Ahri', win: true, kills: 2, deaths: 1, assists: 3 })),
        },
    };
}

function fakeApi(over = {}) {
    const calls = { getPuuidByRiotId: 0, getLeagueByPuuid: 0, getChampionMastery: 0, getRecentMatchIds: 0, getMatchData: 0 };
    const log = [];
    const impl = {
        getPuuidByRiotId: async (gameName) => `pu-${gameName}`,
        getLeagueByPuuid: async () => ({ solo: soloEntry, flex: null }),
        getChampionMastery: async () => ({ level: 7, points: 80000, lastPlayTime: T - 2 * H }),
        getRecentMatchIds: async (puuid) => idsFor(puuid),
        getMatchData: async (id) => matchFor(id),
        ...over,
    };
    const api = {};
    for (const name of Object.keys(calls)) {
        api[name] = async (...args) => { calls[name]++; log.push([name, args[0]]); return impl[name](...args); };
    }
    api.calls = calls;
    api.log = log;
    api.total = () => Object.values(calls).reduce((s, n) => s + n, 0);
    return api;
}

function fakeStore() {
    const ranks = new Map();
    const games = new Map();
    return {
        ranks, games,
        async getRanks(puuid, maxAgeMs, now) {
            const r = ranks.get(puuid);
            return r && r.at >= now - maxAgeMs ? r.league : null;
        },
        async saveRanks(puuid, league, now) { ranks.set(puuid, { league, at: now }); },
        async getPlayerGames(puuid, ids) { return ids.map(id => games.get(`${id}|${puuid}`)).filter(Boolean); },
        async savePlayerGames(rows) { for (const r of rows) games.set(`${r.matchId}|${r.puuid}`, r); },
    };
}

function setup({ api = fakeApi(), store = fakeStore(), now = () => T } = {}) {
    const loader = createLiveGameLoader({ api, store, now });
    const updates = new Map();
    const progress = [];
    const opts = {
        onUpdate: (i, entry) => updates.set(i, entry),
        onProgress: (p) => progress.push(p),
        isCancelled: () => false,
        ownGames: [],
    };
    return { api, store, loader, updates, progress, opts };
}

test('phase 1 makes 3 calls per player and fills league and mastery', async () => {
    const { api, loader, updates, opts } = setup();
    const r = await loader.load(makePlayers(), opts);
    assert.deepEqual(r, { ok: true });
    assert.equal(api.calls.getPuuidByRiotId, 10);
    assert.equal(api.calls.getLeagueByPuuid, 10);
    assert.equal(api.calls.getChampionMastery, 10);
    const e = updates.get(7);
    assert.equal(e.puuid, 'pu-P7');
    assert.deepEqual(e.league, { solo: soloEntry, flex: null });
    assert.deepEqual(e.mastery, { level: 7, points: 80000, lastPlayTime: T - 2 * H });
    assert.equal(e.error, null);
});

test('bots and players without a tag get no API calls', async () => {
    const { api, loader, updates, opts } = setup();
    const players = makePlayers();
    for (const i of [0, 1, 3, 4, 5, 6, 7, 8, 9]) players[i] = { ...players[i], isBot: i % 2 === 0, lookup: false };
    await loader.load(players, opts);
    assert.deepEqual(api.log.map(([name, arg]) => name === 'getPuuidByRiotId' ? arg : null).filter(Boolean), ['P2']);
    assert.equal(api.calls.getLeagueByPuuid, 1);
    assert.equal(api.calls.getChampionMastery, 1);
    assert.equal(updates.has(0), false);
});

test('a second load of the same game makes no API calls', async () => {
    const { api, loader, opts } = setup();
    await loader.load(makePlayers(), opts);
    const before = api.total();
    const r = await loader.load(makePlayers(), opts);
    assert.deepEqual(r, { ok: true });
    assert.equal(api.total(), before);
});

test('ranks younger than 24 h come from the store; older ones are fetched again', async () => {
    const store = fakeStore();
    const players = makePlayers({ 5: { puuid: 'fresh' }, 6: { puuid: 'stale' } });
    store.ranks.set('fresh', { league: { solo: null, flex: null }, at: T - 23 * H });
    store.ranks.set('stale', { league: { solo: null, flex: null }, at: T - 25 * H });
    const { api, loader, updates, opts } = setup({ store });
    await loader.load(players, opts);
    const leagueFor = api.log.filter(([n]) => n === 'getLeagueByPuuid').map(([, p]) => p);
    assert.equal(leagueFor.includes('fresh'), false);
    assert.equal(leagueFor.includes('stale'), true);
    assert.deepEqual(updates.get(5).league, { solo: null, flex: null });
    assert.equal(store.ranks.get('stale').at, T);
});

test('phase 2 fetches only games not in the store, and a game two players share once', async () => {
    const store = fakeStore();
    store.games.set('pu-P7-m1|pu-P7', { matchId: 'pu-P7-m1', puuid: 'pu-P7', queueId: 420, gameCreation: T - 2 * H,
        championName: 'Ahri', win: 0, kills: 0, deaths: 5, assists: 0, isRemake: 0 });
    const { api, loader, updates, opts } = setup({ store });
    await loader.load(makePlayers(), opts);
    const fetched = api.log.filter(([n]) => n === 'getMatchData').map(([, id]) => id);
    assert.equal(fetched.filter(id => id === 'shared').length, 1);
    assert.equal(fetched.includes('pu-P7-m1'), false);
    assert.equal(fetched.length, 9 * 2 - 1 + 1);   // 9 players × 2 own games, one stored, plus the shared one
    assert.equal(updates.get(5).form.games, 3);
    assert.equal(updates.get(6).form.games, 3);
    assert.deepEqual([updates.get(7).form.games, updates.get(7).form.wins], [2, 1]);
});

test('your own row uses ownGames and makes no phase 2 calls', async () => {
    const own = [
        { matchId: 'o1', queueId: 420, gameCreation: T - 3 * H, championName: 'Ahri', win: 1, kills: 5, deaths: 1, assists: 5, isRemake: 0 },
        { matchId: 'o2', queueId: 440, gameCreation: T - 2 * H, championName: 'Ahri', win: 0, kills: 0, deaths: 9, assists: 0, isRemake: 0 },
        { matchId: 'o3', queueId: 420, gameCreation: T - 1 * H, championName: 'Zed', win: 0, kills: 1, deaths: 2, assists: 1, isRemake: 0 },
    ];
    const { api, loader, updates, opts } = setup();
    await loader.load(makePlayers(), { ...opts, ownGames: own });
    assert.equal(api.log.some(([n, p]) => n === 'getRecentMatchIds' && p === 'pu-P2'), false);
    const f = updates.get(2).form;
    assert.deepEqual([f.games, f.wins, f.onChamp.games], [2, 1, 1]);
    assert.deepEqual(f.strip, [true, false]);
});

test('missing ranks and mastery are not errors', async () => {
    const api = fakeApi({ getLeagueByPuuid: async () => ({ solo: null, flex: null }), getChampionMastery: async () => null });
    const { loader, updates, opts } = setup({ api });
    await loader.load(makePlayers(), opts);
    const e = updates.get(8);
    assert.deepEqual([e.league, e.mastery, e.error], [{ solo: null, flex: null }, null, null]);
});

test('a 401/403 stops the whole load', async () => {
    const api = fakeApi({
        getLeagueByPuuid: async (puuid) => { if (puuid === 'pu-P3') throw httpError(403); return { solo: soloEntry, flex: null }; },
    });
    const { loader, opts } = setup({ api });
    const r = await loader.load(makePlayers(), opts);
    assert.match(r.error, /invalid or expired/);
    assert.equal(api.calls.getRecentMatchIds, 0);
    assert.equal(api.calls.getMatchData, 0);
});

test('a 404 on one player marks that row and the load goes on', async () => {
    const api = fakeApi({
        getPuuidByRiotId: async (gameName) => { if (gameName === 'P6') throw httpError(404); return `pu-${gameName}`; },
    });
    const { loader, updates, opts } = setup({ api });
    const r = await loader.load(makePlayers(), opts);
    assert.deepEqual(r, { ok: true });
    assert.equal(updates.get(6).error, 'Player not found. Check your Riot ID');
    assert.equal(updates.get(6).form, null);
    assert.ok(updates.get(7).form);
    assert.equal(api.log.some(([n, p]) => n === 'getRecentMatchIds' && p === undefined), false);
});

test('a game Riot fails to return is left out, not the whole row', async () => {
    const api = fakeApi({ getMatchData: async (id) => { if (id === 'pu-P8-m1') throw httpError(500); return matchFor(id); } });
    const { loader, updates, opts } = setup({ api });
    await loader.load(makePlayers(), opts);
    assert.equal(updates.get(8).error, null);
    assert.equal(updates.get(8).form.games, 1);
});

test('a cancelled load stops calling the API', async () => {
    const { api, loader, opts } = setup();
    let cancel = false;
    const r = await loader.load(makePlayers(), { ...opts, isCancelled: () => cancel, onUpdate: () => { cancel = true; } });
    assert.deepEqual(r, { cancelled: true });
    assert.equal(api.calls.getRecentMatchIds, 0);
    assert.equal(api.calls.getMatchData, 0);

    const fresh = setup();
    assert.deepEqual(await fresh.loader.load(makePlayers(), { ...fresh.opts, isCancelled: () => true }), { cancelled: true });
    assert.equal(fresh.api.total(), 0);
});

test('enemies load before allies in phase 2, with progress per player', async () => {
    const { api, loader, progress, opts } = setup();
    await loader.load(makePlayers(), opts);
    const order = api.log.filter(([n]) => n === 'getRecentMatchIds').map(([, p]) => p);
    assert.deepEqual(order, ['pu-P5', 'pu-P6', 'pu-P7', 'pu-P8', 'pu-P9', 'pu-P0', 'pu-P1', 'pu-P3', 'pu-P4']);
    assert.deepEqual(progress.map(p => p.done), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.ok(progress.every(p => p.total === 10));
});
