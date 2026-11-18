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

test('getSampleRows merges the stats row under the row\'s own fields', async () => {
    const stats = JSON.stringify({ kills: 9, deaths: 2, cs15: 120, championName: 'Wrong', win: 0 });
    await store.saveGame({ game: gameOf('ST1'), row: rowOf('ST1', 'st', { stats }) });
    const r = (await store.getSampleRows()).find(x => x.matchId === 'ST1');
    assert.equal(r.kills, 9);
    assert.equal(r.cs15, 120);
    assert.equal(r.championName, 'Yorick', 'the row\'s own fields win');
    assert.equal(r.win, 1);
    assert.ok(!('stats' in r));
});

test('fillMissingStats computes stats for rows saved without them, from the stored blobs', async () => {
    await store.saveGame({ game: gameOf('FS1', { rawJson: { info: { gameId: 77 } } }), row: rowOf('FS1', 'fs') });
    const seen = [];
    const n = await store.fillMissingStats((raw, tl, puuid) => { seen.push([raw.info.gameId, puuid]); return { kills: 3 }; });
    assert.ok(n >= 1);
    assert.ok(seen.some(([id, p]) => id === 77 && p === 'fs'));
    assert.equal((await store.getSampleRows()).find(x => x.matchId === 'FS1').kills, 3);
    assert.equal(await store.fillMissingStats(() => ({ kills: 4 })), 0, 'nothing left to fill');
});
