/**
 * sampleStore.js — other players' sample games (see sampleSelect.js).
 *
 * Kept apart from `matches` (your history) so nothing in Match History or your
 * statistics ever counts them:
 *   sample_games    one row per game: when, patch, blue side's result, win
 *                   features (winFeatures.js) and the gzipped blobs, so derived
 *                   values can be recomputed without downloading again
 *   sample_rows     the player a game was downloaded for: champion, items,
 *                   purchases, runes, result, the tier + division they were
 *                   picked from, and `stats`: their full matches-style row
 *                   (matchService.statsRowFor) as JSON, for Coaching
 *   sample_skips    games checked and found to be on another champion
 *   sample_players  players seen in a division list, with their mastery
 *   sample_lists    when each division list page was last fetched
 *
 * Apex tiers have no division; it is stored as '' and read back as null.
 * The schema is created on first use, like liveGameStore.js.
 */

const { db } = require('./database');
const { compressJson, decompressJsonAsync } = require('./compression');
const { RETENTION_MS } = require('./sampleSelect');

const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

const ITEM_COLUMNS = ['item0', 'item1', 'item2', 'item3', 'item4', 'item5', 'item6'];
const ROW_COLUMNS = ['matchId', 'puuid', 'championName', 'teamId', 'teamPosition', 'win', 'tier', 'division',
    'itemPurchases', ...ITEM_COLUMNS, 'primaryRune', 'secondaryRuneStyle'];
const SAVED_COLUMNS = [...ROW_COLUMNS, 'stats'];

const div = d => (d == null ? '' : String(d));
const undiv = d => (d === '' || d == null ? null : d);

let schema = null;

/**
 * Version of the stats JSON in sample_rows. Bump it when a stat's formula
 * changes, and fillMissingStats recomputes every row from its blobs once.
 * 1 = first version; 2 = team impact rescored (2026-11-18).
 */
const STATS_VERSION = 2;

function ensureSchema() {
    if (!schema) {
        schema = (async () => {
            await run(`CREATE TABLE IF NOT EXISTS sample_games (
                matchId TEXT PRIMARY KEY, gameCreation INTEGER NOT NULL, gameDuration INTEGER, patch TEXT,
                blueWin INTEGER, winFeatures TEXT, rawJson BLOB, timelineJson BLOB)`);
            await run(`CREATE TABLE IF NOT EXISTS sample_rows (
                matchId TEXT NOT NULL, puuid TEXT NOT NULL, championName TEXT, teamId INTEGER, teamPosition TEXT,
                win INTEGER, tier TEXT, division TEXT, itemPurchases TEXT,
                ${ITEM_COLUMNS.map(c => `${c} INTEGER`).join(', ')}, primaryRune INTEGER, secondaryRuneStyle INTEGER,
                PRIMARY KEY (matchId, puuid))`);
            await run(`CREATE TABLE IF NOT EXISTS sample_skips (
                matchId TEXT NOT NULL, puuid TEXT NOT NULL, gameCreation INTEGER, PRIMARY KEY (matchId, puuid))`);
            await run(`CREATE TABLE IF NOT EXISTS sample_players (
                puuid TEXT NOT NULL, tier TEXT NOT NULL, division TEXT NOT NULL, page INTEGER,
                masteries TEXT, checkedAt INTEGER, listedAt INTEGER, PRIMARY KEY (puuid, tier, division))`);
            await run(`CREATE TABLE IF NOT EXISTS sample_lists (
                tier TEXT NOT NULL, division TEXT NOT NULL, page INTEGER NOT NULL, fetchedAt INTEGER,
                PRIMARY KEY (tier, division, page))`);
            const rowCols = (await all('PRAGMA table_info(sample_rows)')).map(c => c.name);
            if (!rowCols.includes('stats')) await run('ALTER TABLE sample_rows ADD COLUMN stats TEXT');
            await run('CREATE INDEX IF NOT EXISTS idx_sample_rows_puuid ON sample_rows (puuid)');
            await run('CREATE TABLE IF NOT EXISTS sample_meta (key TEXT PRIMARY KEY, value TEXT)');
        })();
        schema.catch(() => { schema = null; });   // let the next call retry
    }
    return schema;
}

/**
 * Store one downloaded game and the row it was downloaded for. The game goes
 * in first; every reader joins rows to games, so a game whose row failed to
 * save is invisible (and removed straight away, best effort).
 */
async function saveGame({ game, row }) {
    await ensureSchema();
    await run(`INSERT OR REPLACE INTO sample_games
        (matchId, gameCreation, gameDuration, patch, blueWin, winFeatures, rawJson, timelineJson)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [game.matchId, game.gameCreation, game.gameDuration ?? null, game.patch ?? null, game.blueWin ?? null,
        game.winFeatures ?? null,
        game.rawJson == null ? null : compressJson(game.rawJson),
        game.timelineJson == null ? null : compressJson(game.timelineJson)]);
    try {
        await run(`INSERT OR REPLACE INTO sample_rows (${SAVED_COLUMNS.join(', ')}) VALUES (${SAVED_COLUMNS.map(() => '?').join(', ')})`,
            SAVED_COLUMNS.map(c => (c === 'division' ? div(row[c]) : row[c] ?? null)));
    } catch (err) {
        await run('DELETE FROM sample_games WHERE matchId = ? AND matchId NOT IN (SELECT matchId FROM sample_rows)', [game.matchId])
            .catch(() => {});
        throw err;
    }
}

async function saveSkip(matchId, puuid, gameCreation) {
    await ensureSchema();
    await run('INSERT OR REPLACE INTO sample_skips (matchId, puuid, gameCreation) VALUES (?, ?, ?)', [matchId, puuid, gameCreation ?? null]);
}

/** Every match id already handled for this player: stored or skipped. */
async function knownMatchIds(puuid) {
    await ensureSchema();
    const rows = await all(`SELECT r.matchId FROM sample_rows r JOIN sample_games g USING (matchId) WHERE r.puuid = ?
        UNION SELECT matchId FROM sample_skips WHERE puuid = ?`, [puuid, puuid]);
    return new Set(rows.map(r => r.matchId));
}

/** Stored games of this player on this champion. */
async function storedCount(puuid, championName) {
    await ensureSchema();
    const r = await get(`SELECT COUNT(*) AS n FROM sample_rows r JOIN sample_games g USING (matchId)
        WHERE r.puuid = ? AND r.championName = ?`, [puuid, championName]);
    return r ? r.n : 0;
}

/**
 * Players stored for one division: [{ puuid, page, masteries, checkedAt, listedAt }].
 * `listedAt` = when the list page they were last seen on was fetched, so a
 * cached page is exactly the players with that page and that time.
 */
async function getPlayers(tier, division) {
    await ensureSchema();
    const rows = await all('SELECT puuid, page, masteries, checkedAt, listedAt FROM sample_players WHERE tier = ? AND division = ? ORDER BY page, puuid',
        [tier, div(division)]);
    return rows.map(r => {
        let masteries = {};
        try { masteries = JSON.parse(r.masteries || '{}') || {}; } catch { masteries = {}; }
        return { puuid: r.puuid, page: r.page, masteries, checkedAt: r.checkedAt, listedAt: r.listedAt };
    });
}

async function savePlayers(rows) {
    if (!rows || !rows.length) return;
    await ensureSchema();
    for (const p of rows) {
        await run(`INSERT OR REPLACE INTO sample_players (puuid, tier, division, page, masteries, checkedAt, listedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [p.puuid, p.tier, div(p.division), p.page ?? null, JSON.stringify(p.masteries || {}),
            p.checkedAt ?? null, p.listedAt ?? null]);
    }
}

async function listFetchedAt(tier, division, page) {
    await ensureSchema();
    const r = await get('SELECT fetchedAt FROM sample_lists WHERE tier = ? AND division = ? AND page = ?', [tier, div(division), page]);
    return r ? r.fetchedAt : null;
}

async function saveListFetched(tier, division, page, at) {
    await ensureSchema();
    await run('INSERT OR REPLACE INTO sample_lists (tier, division, page, fetchedAt) VALUES (?, ?, ?, ?)', [tier, div(division), page, at]);
}

/**
 * Every stored sample row: its stats row (all the `matches` columns) with the
 * row's and game's own fields on top. No blobs.
 */
async function getSampleRows() {
    await ensureSchema();
    const rows = await all(`SELECT ${SAVED_COLUMNS.map(c => `r.${c}`).join(', ')},
            g.gameCreation, g.gameDuration, g.patch, g.blueWin, g.winFeatures
        FROM sample_rows r JOIN sample_games g USING (matchId)
        ORDER BY g.gameCreation DESC`);
    return rows.map(({ stats, ...r }) => {
        let s = {};
        try { s = stats ? JSON.parse(stats) || {} : {}; } catch { s = {}; }
        return { ...s, ...r, division: undiv(r.division), queueId: 420, isRemake: 0 };
    });
}

/**
 * Rows stored before they carried stats: compute them from the stored blobs
 * with statsOf (matchService.statsRowFor). Returns how many were filled.
 */
async function statsVersion() {
    const r = await get("SELECT value FROM sample_meta WHERE key = 'statsVersion'");
    return r ? Number(r.value) || 1 : 1;
}
async function setStatsVersion(v) {
    await ensureSchema();
    await run("INSERT OR REPLACE INTO sample_meta (key, value) VALUES ('statsVersion', ?)", [String(v)]);
}

async function fillMissingStats(statsOf) {
    await ensureSchema();
    // Stats saved under an older formula are recomputed, once
    if (await statsVersion() < STATS_VERSION) {
        await run('UPDATE sample_rows SET stats = NULL');
        await setStatsVersion(STATS_VERSION);
    }
    const missing = await all(`SELECT r.matchId, r.puuid FROM sample_rows r JOIN sample_games g USING (matchId)
        WHERE r.stats IS NULL`);
    let filled = 0;
    for (const { matchId, puuid } of missing) {
        try {
            const blobs = await get('SELECT rawJson, timelineJson FROM sample_games WHERE matchId = ?', [matchId]);
            const raw = blobs && blobs.rawJson ? await decompressJsonAsync(blobs.rawJson) : null;
            const timeline = blobs && blobs.timelineJson ? await decompressJsonAsync(blobs.timelineJson) : null;
            const stats = raw ? statsOf(raw, timeline, puuid) : null;
            // '{}' when there is nothing to compute, so the row isn't tried again
            await run('UPDATE sample_rows SET stats = ? WHERE matchId = ? AND puuid = ?', [JSON.stringify(stats || {}), matchId, puuid]);
            filled++;
        } catch (err) {
            console.warn(`Sample stats for ${matchId} failed:`, err.message);
        }
    }
    return filled;
}

/** Delete everything older than RETENTION_MS; returns how many of each went. */
async function prune(now = Date.now()) {
    await ensureSchema();
    const since = now - RETENTION_MS;
    const games = (await run('DELETE FROM sample_games WHERE gameCreation < ?', [since])).changes;
    const rows = (await run('DELETE FROM sample_rows WHERE matchId NOT IN (SELECT matchId FROM sample_games)')).changes;
    const skips = (await run('DELETE FROM sample_skips WHERE gameCreation IS NULL OR gameCreation < ?', [since])).changes;
    const players = (await run('DELETE FROM sample_players WHERE checkedAt IS NULL OR checkedAt < ?', [since])).changes;
    await run('DELETE FROM sample_lists WHERE fetchedAt IS NULL OR fetchedAt < ?', [since]);
    return { games, rows, skips, players };
}

module.exports = {
    ensureSchema, saveGame, saveSkip, knownMatchIds, storedCount,
    getPlayers, savePlayers, listFetchedAt, saveListFetched, getSampleRows, fillMissingStats, prune,
    STATS_VERSION, _internal: { setStatsVersion },
};
