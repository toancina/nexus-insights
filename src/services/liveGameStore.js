/**
 * liveGameStore.js — what the Live page (#59) remembers between games.
 *
 * - Other players' ranks go in `player_ranks`, the table #29 left unused when
 *   sync stopped fetching everyone's rank. It gains W/L and the Solo/Duo flags.
 * - Other players' recent games go in `player_games`: one small row per player
 *   per match, never the JSON blobs, and never in `matches` (your history).
 *   A fetched match stores all ten players, so a game two players in the
 *   lobby shared is downloaded once.
 *
 * The schema is created on first use, like matchService.loadTeammates.
 */

const { db } = require('./database');

const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, e => (e ? rej(e) : res())));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

const FLAGS = ['hotStreak', 'veteran', 'freshBlood', 'inactive'];
const GAME_COLUMNS = ['matchId', 'puuid', 'queueId', 'gameCreation', 'championName', 'win',
    'kills', 'deaths', 'assists', 'isRemake'];
const ROWS_PER_INSERT = 50;   // 500 parameters, well under SQLite's limit

let schema = null;

function ensureSchema() {
    if (!schema) {
        schema = (async () => {
            await run(`CREATE TABLE IF NOT EXISTS player_ranks (
                puuid TEXT PRIMARY KEY, soloTier TEXT, soloRank TEXT, soloLP INTEGER,
                flexTier TEXT, flexRank TEXT, flexLP INTEGER, fetchedAt INTEGER NOT NULL)`);
            const cols = (await all('PRAGMA table_info(player_ranks)')).map(c => c.name);
            const add = [['soloWins', 'INTEGER'], ['soloLosses', 'INTEGER'], ['flexWins', 'INTEGER'],
                ['flexLosses', 'INTEGER'], ['soloFlags', 'TEXT']];
            for (const [name, type] of add) {
                if (!cols.includes(name)) await run(`ALTER TABLE player_ranks ADD COLUMN ${name} ${type}`);
            }
            await run(`CREATE TABLE IF NOT EXISTS player_games (
                matchId TEXT NOT NULL, puuid TEXT NOT NULL, queueId INTEGER, gameCreation INTEGER,
                championName TEXT, win INTEGER, kills INTEGER, deaths INTEGER, assists INTEGER,
                isRemake INTEGER, PRIMARY KEY (matchId, puuid))`);
            await run('CREATE INDEX IF NOT EXISTS idx_player_games_puuid ON player_games (puuid, gameCreation DESC)');
        })();
        schema.catch(() => { schema = null; });   // let the next call retry
    }
    return schema;
}

/** A player's ranks, as getLeagueByPuuid returns them, or null if not stored or older than maxAgeMs. */
async function getRanks(puuid, maxAgeMs, now = Date.now()) {
    await ensureSchema();
    const r = await get('SELECT * FROM player_ranks WHERE puuid = ?', [puuid]);
    if (!r || r.fetchedAt < now - maxAgeMs) return null;

    const flags = new Set(String(r.soloFlags || '').split(',').filter(Boolean));
    const entry = (tier, rank, lp, wins, losses, withFlags) => tier ? {
        tier, rank, leaguePoints: lp, wins, losses,
        ...Object.fromEntries(FLAGS.map(f => [f, withFlags && flags.has(f)])),
    } : null;
    return {
        solo: entry(r.soloTier, r.soloRank, r.soloLP, r.soloWins, r.soloLosses, true),
        flex: entry(r.flexTier, r.flexRank, r.flexLP, r.flexWins, r.flexLosses, false),
    };
}

async function saveRanks(puuid, league, now = Date.now()) {
    await ensureSchema();
    const s = (league && league.solo) || {};
    const f = (league && league.flex) || {};
    await run(`INSERT OR REPLACE INTO player_ranks
        (puuid, soloTier, soloRank, soloLP, soloWins, soloLosses, soloFlags,
         flexTier, flexRank, flexLP, flexWins, flexLosses, fetchedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        puuid,
        s.tier ?? null, s.rank ?? null, s.leaguePoints ?? null, s.wins ?? null, s.losses ?? null,
        FLAGS.filter(k => s[k]).join(','),
        f.tier ?? null, f.rank ?? null, f.leaguePoints ?? null, f.wins ?? null, f.losses ?? null,
        now,
    ]);
}

/** Stored rows for this player among `matchIds`. */
async function getPlayerGames(puuid, matchIds) {
    if (!matchIds || !matchIds.length) return [];
    await ensureSchema();
    return all(`SELECT ${GAME_COLUMNS.join(', ')} FROM player_games
        WHERE puuid = ? AND matchId IN (${matchIds.map(() => '?').join(',')})`, [puuid, ...matchIds]);
}

async function savePlayerGames(rows) {
    if (!rows || !rows.length) return;
    await ensureSchema();
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
        const batch = rows.slice(i, i + ROWS_PER_INSERT);
        const one = `(${GAME_COLUMNS.map(() => '?').join(', ')})`;
        await run(`INSERT OR REPLACE INTO player_games (${GAME_COLUMNS.join(', ')}) VALUES ${batch.map(() => one).join(', ')}`,
            batch.flatMap(r => GAME_COLUMNS.map(c => r[c] ?? null)));
    }
}

module.exports = { ensureSchema, getRanks, saveRanks, getPlayerGames, savePlayerGames };
