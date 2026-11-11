const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');
const { SRC } = require('./helpers');

// Point services/paths at a throwaway folder before database.js opens its file
// (as test/liveGameStore.test.js does).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sample-'));
const pathsFile = path.join(SRC, 'services', 'paths.js');
const fake = new Module(pathsFile);
fake.filename = pathsFile; fake.loaded = true; fake.exports = { userDataPath: dir };
require.cache[pathsFile] = fake;

const DB = require(path.join(SRC, 'services', 'database.js'));
const store = require(path.join(SRC, 'services', 'sampleStore.js'));

const DAY = 86400000;
const NOW = 400 * DAY;

test.after(() => new Promise(res => DB.db.close(() => { fs.rmSync(dir, { recursive: true, force: true }); res(); })));

const gameOf = (matchId, over = {}) => ({
    matchId, gameCreation: NOW - DAY, gameDuration: 1800, patch: '16.21', blueWin: 1, winFeatures: '0.00,0,0,0,0,0,0,0,0,0',
    rawJson: { info: { gameId: 1 } }, timelineJson: { info: { frames: [] } }, ...over,
});
const rowOf = (matchId, puuid, over = {}) => ({
    matchId, puuid, championName: 'Yorick', teamId: 100, teamPosition: 'TOP', win: 1, tier: 'GOLD', division: 'I',
    itemPurchases: '1055:10,3078:900', item0: 3078, item1: 3047, item2: 0, item3: 0, item4: 0, item5: 0, item6: 3340,
    primaryRune: 8010, secondaryRuneStyle: 8400, ...over,
});

test('saveGame / getSampleRows round-trip without blobs', async () => {
    await store.saveGame({ game: gameOf('S1'), row: rowOf('S1', 'p1') });
    const rows = await store.getSampleRows();
    const r = rows.find(x => x.matchId === 'S1');
    assert.ok(r);
    for (const [k, v] of Object.entries(rowOf('S1', 'p1'))) assert.deepEqual(r[k], v, k);
    assert.equal(r.gameCreation, NOW - DAY);
    assert.equal(r.patch, '16.21');
    assert.equal(r.blueWin, 1);
    assert.equal(r.winFeatures, '0.00,0,0,0,0,0,0,0,0,0');
    assert.equal(r.isRemake, 0);
    assert.equal(r.queueId, 420);
    assert.ok(!('rawJson' in r) && !('timelineJson' in r));
});

test('an apex row keeps a null division', async () => {
    await store.saveGame({ game: gameOf('S-apex'), row: rowOf('S-apex', 'p9', { tier: 'MASTER', division: null }) });
    const r = (await store.getSampleRows()).find(x => x.matchId === 'S-apex');
    assert.equal(r.division, null);
});

test('knownMatchIds includes stored and skipped ids for that player only', async () => {
    await store.saveGame({ game: gameOf('K1'), row: rowOf('K1', 'k') });
    await store.saveSkip('K2', 'k', NOW - DAY);
    await store.saveSkip('K3', 'other', NOW - DAY);
    const ids = await store.knownMatchIds('k');
    assert.ok(ids.has('K1') && ids.has('K2'));
    assert.ok(!ids.has('K3'));
    assert.equal(await store.storedCount('k', 'Yorick'), 1);
    assert.equal(await store.storedCount('k', 'Poppy'), 0);
});

test('players and division lists round-trip', async () => {
    await store.savePlayers([{ puuid: 'a', tier: 'SILVER', division: 'I', page: 1, masteries: { 83: { points: 900, lastPlayTime: NOW } }, checkedAt: NOW, listedAt: NOW - 1 }]);
    const players = await store.getPlayers('SILVER', 'I');
    assert.deepEqual(players, [{ puuid: 'a', page: 1, masteries: { 83: { points: 900, lastPlayTime: NOW } }, checkedAt: NOW, listedAt: NOW - 1 }]);
    assert.deepEqual(await store.getPlayers('GOLD', 'I'), []);
    assert.equal(await store.listFetchedAt('SILVER', 'I', 1), null);
    await store.saveListFetched('SILVER', 'I', 1, NOW);
    assert.equal(await store.listFetchedAt('SILVER', 'I', 1), NOW);
    await store.saveListFetched('MASTER', null, 1, NOW - 5);
    assert.equal(await store.listFetchedAt('MASTER', null, 1), NOW - 5);
});

test('prune deletes what is older than 90 days and keeps newer', async () => {
    await store.saveGame({ game: gameOf('P-old', { gameCreation: NOW - 91 * DAY }), row: rowOf('P-old', 'q') });
    await store.saveGame({ game: gameOf('P-new', { gameCreation: NOW - 89 * DAY }), row: rowOf('P-new', 'q') });
    await store.saveSkip('P-skip-old', 'q', NOW - 91 * DAY);
    await store.savePlayers([
        { puuid: 'stale', tier: 'GOLD', division: 'I', page: 1, masteries: {}, checkedAt: NOW - 91 * DAY },
        { puuid: 'fresh', tier: 'GOLD', division: 'I', page: 1, masteries: {}, checkedAt: NOW - DAY },
    ]);
    const removed = await store.prune(NOW);
    assert.ok(removed.games >= 1 && removed.rows >= 1 && removed.skips >= 1 && removed.players >= 1);
    const ids = (await store.getSampleRows()).map(r => r.matchId);
    assert.ok(!ids.includes('P-old'));
    assert.ok(ids.includes('P-new'));
    assert.ok(!(await store.knownMatchIds('q')).has('P-skip-old'));
    assert.deepEqual((await store.getPlayers('GOLD', 'I')).map(p => p.puuid), ['fresh']);
});

test('saveGame writes nothing visible when the row insert fails', async () => {
    await assert.rejects(store.saveGame({ game: gameOf('BAD'), row: rowOf('BAD', null) }));
    assert.ok(!(await store.getSampleRows()).some(r => r.matchId === 'BAD'));
    assert.equal(await store.storedCount(null, 'Yorick'), 0);
});
