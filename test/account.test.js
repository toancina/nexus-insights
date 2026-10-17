/**
 * Issue #73: games and LP readings are kept per account (PUUID), and only the
 * configured account is synced or shown.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');
const { SRC } = require('./helpers');

const A = require(path.join(SRC, 'services', 'account.js'));

const cfg = (over = {}) => ({ gameName: 'Toan', tagLine: 'NBG', platform: 'euw1', ...over });

test('account key and scope', () => {
    assert.equal(A.accountKey(cfg()), 'toan#nbg@euw1');
    assert.equal(A.accountKey(cfg({ tagLine: '' })), '');

    // Never resolved (first run, or a database from before #73): everything
    assert.deepEqual(A.accountScope(cfg()), { sql: '1 = 1', params: [] });
    // Resolved: that PUUID, plus untagged rows
    const resolved = cfg({ puuid: 'P1', puuidFor: 'toan#nbg@euw1' });
    assert.deepEqual(A.accountScope(resolved, 'm.puuid'), { sql: '(m.puuid = ? OR m.puuid IS NULL)', params: ['P1'] });
    // Riot ID changed, not resolved yet: never the old account's games
    assert.deepEqual(A.accountScope({ ...resolved, gameName: 'Friend' }), { sql: 'puuid IS NULL', params: [] });
    // Another server is another account
    assert.equal(A.isResolved({ ...resolved, platform: 'na1' }), false);
});

test('planAccount re-tags only when the same Riot ID gets a new PUUID', () => {
    const resolved = cfg({ puuid: 'P1', puuidFor: 'toan#nbg@euw1' });
    // Same account, same PUUID: nothing to do
    assert.deepEqual(A.planAccount(resolved, 'P1'), { puuid: 'P1', puuidFor: 'toan#nbg@euw1', remapFrom: null, changed: false });
    // Same Riot ID, new PUUID (a key from another Riot project): move the rows
    assert.equal(A.planAccount(resolved, 'P1-new').remapFrom, 'P1');
    // Rename of the same account: same PUUID, new key, nothing re-tagged
    const renamed = A.planAccount({ ...resolved, tagLine: 'GGWP' }, 'P1');
    assert.equal(renamed.remapFrom, null);
    assert.equal(renamed.changed, true);
    // Another account: its own PUUID, the old rows stay the old account's
    assert.equal(A.planAccount({ ...resolved, gameName: 'Friend' }, 'P2').remapFrom, null);
    // First time
    assert.deepEqual(A.planAccount(cfg(), 'P1'), { puuid: 'P1', puuidFor: 'toan#nbg@euw1', remapFrom: null, changed: true });
});

test('resolveAccount saves the PUUID and re-tags on a new key project', async () => {
    let saved = cfg({ puuid: 'OLD', puuidFor: 'toan#nbg@euw1' });
    const retagged = [];
    const deps = {
        loadConfig: () => ({ ...saved }),
        updateConfig: patch => { saved = { ...saved, ...patch }; return true; },
        getPuuid: async (name, tag) => (assert.equal(`${name}#${tag}`, 'Toan#NBG'), 'NEW'),
        retag: async (from, to) => { retagged.push([from, to]); },
    };
    assert.deepEqual(await A.resolveAccount(deps), { puuid: 'NEW', changed: true });
    assert.deepEqual(retagged, [['OLD', 'NEW']]);
    assert.equal(saved.puuid, 'NEW');
    assert.deepEqual(await A.resolveAccount(deps), { puuid: 'NEW', changed: false });
    assert.equal(retagged.length, 1);
    saved = {};
    assert.equal(await A.resolveAccount(deps), null, 'no Riot ID configured');
});

test('migration 8 tags games by their player; LP readings only with one owner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-account-'));
    const pathsFile = path.join(SRC, 'services', 'paths.js');
    const fake = new Module(pathsFile);
    fake.filename = pathsFile; fake.loaded = true; fake.exports = { userDataPath: dir };
    require.cache[pathsFile] = fake;
    const files = ['database.js', 'config.js'].map(f => path.join(SRC, 'services', f));
    files.forEach(f => delete require.cache[f]);
    const DB = require(files[0]);
    const C = require(files[1]);
    const { compressJson } = require(path.join(SRC, 'services', 'compression.js'));
    const run = (sql, p = []) => new Promise((res, rej) => DB.db.run(sql, p, e => e ? rej(e) : res()));
    const all = (sql, p = []) => new Promise((res, rej) => DB.db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
    const game = (me, champ, team) => compressJson({ info: { participants: [
        { puuid: me, championName: champ, teamId: team },
        { puuid: 'someone-else', championName: 'Other', teamId: team === 100 ? 200 : 100 },
    ] } });

    try {
        await run(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
        await run(`CREATE TABLE matches (matchId TEXT PRIMARY KEY, queueId INTEGER, gameCreation INTEGER,
                   gameDuration INTEGER, isRemake INTEGER, championName TEXT, teamId INTEGER, rawJson BLOB)`);
        await run(`CREATE TABLE lp_history (id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL,
                   tier TEXT, rank TEXT, lp INTEGER NOT NULL, recorded_date TEXT NOT NULL,
                   recorded_at INTEGER NOT NULL, matchId TEXT, wins INTEGER, losses INTEGER, manual INTEGER)`);
        await run(`INSERT INTO matches VALUES ('G1', 420, 1000, 1800, 0, 'Ahri', 100, ?)`, [game('ME', 'Ahri', 100)]);
        await run(`INSERT INTO matches VALUES ('G2', 420, 2000, 1800, 0, 'Jinx', 200, ?)`, [game('ME', 'Jinx', 200)]);
        await run(`INSERT INTO lp_history (queue, tier, rank, lp, recorded_date, recorded_at) VALUES ('solo','GOLD','I',50,'2026-10-01',3000)`);

        await DB.migrateAccountTags();
        assert.deepEqual((await all('SELECT matchId, puuid FROM matches ORDER BY matchId')).map(r => [r.matchId, r.puuid]),
            [['G1', 'ME'], ['G2', 'ME']]);
        assert.deepEqual((await all('SELECT puuid FROM lp_history')).map(r => r.puuid), ['ME'], 'one owner: LP is theirs');

        // Another account's game stored by mistake, plus its LP reading
        await run(`INSERT INTO matches (matchId, queueId, gameCreation, gameDuration, isRemake, championName, teamId, puuid)
                   VALUES ('F1', 420, 4000, 1800, 0, 'Zed', 100, 'FRIEND')`);
        await run(`INSERT INTO lp_history (queue, tier, rank, lp, recorded_date, recorded_at, puuid) VALUES ('solo','IRON','IV',10,'2026-10-02',5000,'FRIEND')`);

        // Not resolved yet: everything shows (as before #73)
        assert.equal((await DB.getLpReadings('solo')).length, 2);
        // Resolved to ME: only ME's readings, and new readings are tagged
        C.updateConfig({ gameName: 'Toan', tagLine: 'NBG', platform: 'euw1', puuid: 'ME', puuidFor: 'toan#nbg@euw1' });
        assert.deepEqual((await DB.getLpReadings('solo')).map(r => r.lp), [50]);
        const res = await DB.recordLpReading('solo', 'GOLD', 'I', 70, { wins: 10, losses: 8, puuid: 'ME' });
        assert.equal(res.delta, 20, 'measured from ME\'s last reading, not FRIEND\'s');
        assert.deepEqual((await all("SELECT puuid FROM lp_history WHERE lp = 70")).map(r => r.puuid), ['ME']);
        const scope = await DB.scopeFor('matches');
        assert.deepEqual((await all(`SELECT matchId FROM matches WHERE ${scope.sql} ORDER BY matchId`, scope.params)).map(r => r.matchId), ['G1', 'G2']);

        // A new key project: same Riot ID, new PUUID → the rows follow
        await DB.retagAccount('ME', 'ME2');
        assert.equal((await all("SELECT * FROM matches WHERE puuid = 'ME2'")).length, 2);
        assert.equal((await all("SELECT * FROM lp_history WHERE puuid = 'ME2'")).length, 2);

        await DB.migrateAccountTags();                      // runs once
        assert.equal((await all('SELECT * FROM schema_version WHERE version = 8')).length, 1);
    } finally {
        await new Promise(r => DB.db.close(r));
        delete require.cache[pathsFile];
        files.forEach(f => delete require.cache[f]);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('migration 8 leaves LP readings untagged when games have two owners', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-account-'));
    const pathsFile = path.join(SRC, 'services', 'paths.js');
    const fake = new Module(pathsFile);
    fake.filename = pathsFile; fake.loaded = true; fake.exports = { userDataPath: dir };
    require.cache[pathsFile] = fake;
    const files = ['database.js', 'config.js'].map(f => path.join(SRC, 'services', f));
    files.forEach(f => delete require.cache[f]);
    const DB = require(files[0]);
    const { compressJson } = require(path.join(SRC, 'services', 'compression.js'));
    const run = (sql, p = []) => new Promise((res, rej) => DB.db.run(sql, p, e => e ? rej(e) : res()));
    const all = (sql, p = []) => new Promise((res, rej) => DB.db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
    const game = (me, champ) => compressJson({ info: { participants: [{ puuid: me, championName: champ, teamId: 100 }] } });
    try {
        await run(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
        await run(`CREATE TABLE matches (matchId TEXT PRIMARY KEY, championName TEXT, teamId INTEGER, rawJson BLOB)`);
        await run(`CREATE TABLE lp_history (id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT, lp INTEGER, recorded_at INTEGER)`);
        await run(`INSERT INTO matches VALUES ('G1', 'Ahri', 100, ?)`, [game('ME', 'Ahri')]);
        await run(`INSERT INTO matches VALUES ('G2', 'Zed', 100, ?)`, [game('FRIEND', 'Zed')]);
        await run(`INSERT INTO matches VALUES ('G3', 'Lux', 100, NULL)`);
        await run(`INSERT INTO lp_history (queue, lp, recorded_at) VALUES ('solo', 50, 1)`);
        await DB.migrateAccountTags();
        assert.deepEqual((await all('SELECT matchId, puuid FROM matches ORDER BY matchId')).map(r => [r.matchId, r.puuid]),
            [['G1', 'ME'], ['G2', 'FRIEND'], ['G3', null]]);
        assert.deepEqual((await all('SELECT puuid FROM lp_history')).map(r => r.puuid), [null]);
    } finally {
        await new Promise(r => DB.db.close(r));
        delete require.cache[pathsFile];
        files.forEach(f => delete require.cache[f]);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
