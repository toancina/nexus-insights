/**
 * Issue #68: games from queues the app doesn't support (old Arena games) are
 * removed once, with their teammates rows, against a real temporary SQLite file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');
const { SRC } = require('./helpers');

test('migration 7 removes unsupported-queue games and their teammates, once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-queues-'));
    const pathsFile = path.join(SRC, 'services', 'paths.js');
    const fake = new Module(pathsFile);
    fake.filename = pathsFile; fake.loaded = true; fake.exports = { userDataPath: dir };
    require.cache[pathsFile] = fake;
    const dbFile = path.join(SRC, 'services', 'database.js');
    delete require.cache[dbFile];
    const DB = require(dbFile);
    const run = (sql, p = []) => new Promise((res, rej) => DB.db.run(sql, p, e => e ? rej(e) : res()));
    const all = (sql, p = []) => new Promise((res, rej) => DB.db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

    try {
        await run(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
        await run(`CREATE TABLE matches (matchId TEXT PRIMARY KEY, queueId INTEGER, gameCreation INTEGER)`);
        await run(`CREATE TABLE match_teammates (matchId TEXT PRIMARY KEY, teammates TEXT)`);
        const games = [['SOLO', 420], ['FLEX', 440], ['PREMADE', 710], ['DRAFT', 400], ['CLASH', 700],
                       ['ARENA1', 1700], ['ARENA2', 1700], ['ARAM', 450]];
        for (const [id, q] of games) {
            await run('INSERT INTO matches VALUES (?, ?, 0)', [id, q]);
            await run('INSERT INTO match_teammates VALUES (?, ?)', [id, '[]']);
        }

        await DB.migrateUnsupportedQueues();
        const kept = ['CLASH', 'DRAFT', 'FLEX', 'PREMADE', 'SOLO'];
        assert.deepEqual((await all('SELECT matchId FROM matches ORDER BY matchId')).map(r => r.matchId), kept);
        assert.deepEqual((await all('SELECT matchId FROM match_teammates ORDER BY matchId')).map(r => r.matchId), kept);

        // Runs once: a game stored later is left to sync's own filter
        await run('INSERT INTO matches VALUES (?, ?, 0)', ['ARENA3', 1700]);
        await DB.migrateUnsupportedQueues();
        assert.equal((await all("SELECT * FROM matches WHERE matchId = 'ARENA3'")).length, 1);
        assert.equal((await all('SELECT * FROM schema_version WHERE version = 7')).length, 1);
    } finally {
        await new Promise(r => DB.db.close(r));
        delete require.cache[pathsFile];
        delete require.cache[dbFile];
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a database without the teammates table migrates too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-queues-'));
    const pathsFile = path.join(SRC, 'services', 'paths.js');
    const fake = new Module(pathsFile);
    fake.filename = pathsFile; fake.loaded = true; fake.exports = { userDataPath: dir };
    require.cache[pathsFile] = fake;
    const dbFile = path.join(SRC, 'services', 'database.js');
    delete require.cache[dbFile];
    const DB = require(dbFile);
    const run = (sql, p = []) => new Promise((res, rej) => DB.db.run(sql, p, e => e ? rej(e) : res()));
    const all = (sql, p = []) => new Promise((res, rej) => DB.db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

    try {
        await run(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
        await run(`CREATE TABLE matches (matchId TEXT PRIMARY KEY, queueId INTEGER, gameCreation INTEGER)`);
        await run('INSERT INTO matches VALUES (?, ?, 0)', ['SOLO', 420]);
        await run('INSERT INTO matches VALUES (?, ?, 0)', ['ARENA', 1700]);
        await DB.migrateUnsupportedQueues();
        assert.deepEqual((await all('SELECT matchId FROM matches')).map(r => r.matchId), ['SOLO']);
    } finally {
        await new Promise(r => DB.db.close(r));
        delete require.cache[pathsFile];
        delete require.cache[dbFile];
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
