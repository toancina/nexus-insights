const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');
const { SRC } = require('./helpers');

// Point services/paths at a throwaway folder before database.js opens its file
// (as test/lpAttribution.test.js does).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-live-'));
const pathsFile = path.join(SRC, 'services', 'paths.js');
const fake = new Module(pathsFile);
fake.filename = pathsFile; fake.loaded = true; fake.exports = { userDataPath: dir };
require.cache[pathsFile] = fake;

const DB = require(path.join(SRC, 'services', 'database.js'));
const store = require(path.join(SRC, 'services', 'liveGameStore.js'));

const run = (sql, p = []) => new Promise((res, rej) => DB.db.run(sql, p, e => e ? rej(e) : res()));
const all = (sql, p = []) => new Promise((res, rej) => DB.db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

// player_ranks as databases from before #59 have it
const created = run(`CREATE TABLE player_ranks (puuid TEXT PRIMARY KEY, soloTier TEXT, soloRank TEXT, soloLP INTEGER,
    flexTier TEXT, flexRank TEXT, flexLP INTEGER, fetchedAt INTEGER NOT NULL)`);

const entry = (over = {}) => ({ tier: 'SILVER', rank: 'II', leaguePoints: 13, wins: 11, losses: 10,
    hotStreak: false, veteran: false, freshBlood: false, inactive: false, ...over });

test.after(() => new Promise(res => DB.db.close(() => { fs.rmSync(dir, { recursive: true, force: true }); res(); })));

test('saveRanks / getRanks round-trip, with flags and W/L', async () => {
    await created;
    const league = { solo: entry({ hotStreak: true, veteran: true }), flex: entry({ tier: 'GOLD', rank: 'IV', leaguePoints: 50, wins: 3, losses: 4 }) };
    await store.saveRanks('p1', league, 1000);
    assert.deepEqual(await store.getRanks('p1', 5000, 2000), league);
});

test('getRanks treats rows older than maxAge as missing', async () => {
    await created;
    await store.saveRanks('p2', { solo: entry(), flex: null }, 1000);
    assert.equal(await store.getRanks('p2', 500, 2000), null);
    assert.ok(await store.getRanks('p2', 5000, 2000));
    assert.equal(await store.getRanks('nobody', 5000, 2000), null);
});

test('an unranked player is cached as { solo: null, flex: null }', async () => {
    await created;
    await store.saveRanks('p3', { solo: null, flex: null }, 1000);
    assert.deepEqual(await store.getRanks('p3', 5000, 2000), { solo: null, flex: null });
});

const game = (matchId, puuid, over = {}) => ({ matchId, puuid, queueId: 420, gameCreation: 100, championName: 'Ahri',
    win: 1, kills: 1, deaths: 2, assists: 3, isRemake: 0, ...over });

test('savePlayerGames / getPlayerGames return only the asked ids for that player', async () => {
    await created;
    await store.savePlayerGames([
        game('M1', 'a'), game('M1', 'b', { championName: 'Zed', win: 0 }),
        game('M2', 'a', { gameCreation: 200 }), game('M3', 'a', { gameCreation: 300 }),
    ]);
    const rows = await store.getPlayerGames('a', ['M1', 'M3', 'M9']);
    assert.deepEqual(rows.map(r => r.matchId).sort(), ['M1', 'M3']);
    assert.deepEqual(rows.find(r => r.matchId === 'M1'), game('M1', 'a'));
    assert.deepEqual(await store.getPlayerGames('b', ['M1']), [game('M1', 'b', { championName: 'Zed', win: 0 })]);
    assert.deepEqual(await store.getPlayerGames('a', []), []);
});

test('savePlayerGames replaces a row stored twice', async () => {
    await created;
    await store.savePlayerGames([game('M5', 'c', { kills: 1 })]);
    await store.savePlayerGames([game('M5', 'c', { kills: 9 })]);
    assert.equal((await store.getPlayerGames('c', ['M5']))[0].kills, 9);
});

test('ensureSchema is safe to run on a database that already has the columns', async () => {
    await created;
    await store.ensureSchema();
    await store.ensureSchema();
    const cols = (await all('PRAGMA table_info(player_ranks)')).map(c => c.name);
    for (const c of ['soloWins', 'soloLosses', 'flexWins', 'flexLosses', 'soloFlags']) assert.ok(cols.includes(c), c);
    assert.equal((await all("SELECT name FROM sqlite_master WHERE name = 'player_games'")).length, 1);
});
