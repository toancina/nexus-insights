/**
 * liveGameLoader.js — loads the Live page's stats for every player (#59).
 *
 * Phase 1, everyone at once (the shared rate limiter in riotApi paces it):
 * Riot ID → PUUID, ranks, mastery on their champion. ~30 calls, a few seconds.
 * Phase 2, one player at a time, enemies first: their last Solo/Duo games.
 * Only games not stored yet are downloaded, so ~110 calls on a first look and
 * almost none after. Your own row uses your stored games instead.
 *
 * Riot ID → PUUID, mastery and recent-id lists are kept in memory for the
 * life of the loader, ranks and games in the database (liveGameStore), all
 * for CACHE_TTL_MS, so loading the same game again makes no calls.
 *
 * `api` and `store` are injected, which is how the tests run it without the
 * network or SQLite.
 */

const { RECENT_COUNT, RECENT_QUEUE, CACHE_TTL_MS, playerGameRows, recentForm } = require('./liveGame');
const { friendlyRiotError, isKeyError } = require('./riotErrors');

// Thrown to unwind a player's work once the load is cancelled or the key failed
const STOP = Symbol('stop');

function createLiveGameLoader({ api, store, now = Date.now }) {
    const puuids = new Map();      // lower-case Riot ID → PUUID (never changes)
    const masteries = new Map();   // `${puuid}:${championKey}` → { value, at }
    const recentIds = new Map();   // puuid → { ids, at }
    const fresh = (hit) => !!hit && hit.at >= now() - CACHE_TTL_MS;

    async function load(players, { onUpdate = () => {}, onProgress = () => {}, isCancelled = () => false, ownGames = null } = {}) {
        const entries = players.map(() => ({ puuid: null, league: null, mastery: null, form: null, error: null }));
        let keyError = null;
        const stopped = () => !!keyError || isCancelled();

        // Every Riot call goes through here: nothing new starts once stopped,
        // and a bad key stops everyone, not just this player.
        const call = async (fn) => {
            if (stopped()) throw STOP;
            try {
                return await fn();
            } catch (err) {
                if (isKeyError(err)) { keyError = keyError || err; throw STOP; }
                throw err;
            }
        };
        const update = (i) => { if (!stopped()) onUpdate(i, { ...entries[i] }); };
        const result = () => (keyError ? { error: friendlyRiotError(keyError) } : isCancelled() ? { cancelled: true } : { ok: true });
        // After a key error, rows that didn't finish say so instead of "loading" forever
        const finish = () => {
            if (keyError && !isCancelled()) {
                const message = friendlyRiotError(keyError);
                for (const p of players.filter(x => x.lookup)) {
                    const e = entries[p.index];
                    if (e.league && e.form) continue;
                    e.error = e.error || message;
                    onUpdate(p.index, { ...e });
                }
            }
            return result();
        };
        let lobby = new Set();   // PUUIDs in this game: only their rows are stored

        async function puuidOf(p) {
            if (p.puuid) return p.puuid;
            const key = p.riotId.toLowerCase();
            if (!puuids.has(key)) puuids.set(key, await call(() => api.getPuuidByRiotId(p.gameName, p.tagLine)));
            return puuids.get(key);
        }

        async function ranksOf(puuid) {
            let cached = null;
            try { cached = await store.getRanks(puuid, CACHE_TTL_MS, now()); }
            catch (err) { console.warn('Live game: cached ranks unavailable:', err.message); }
            if (cached) return cached;
            const league = await call(() => api.getLeagueByPuuid(puuid));
            try { await store.saveRanks(puuid, league, now()); }
            catch (err) { console.warn('Live game: could not cache ranks:', err.message); }
            return league;
        }

        async function masteryOf(puuid, championKey) {
            const key = `${puuid}:${championKey}`;
            if (!fresh(masteries.get(key))) {
                masteries.set(key, { value: await call(() => api.getChampionMastery(puuid, championKey)), at: now() });
            }
            return masteries.get(key).value;
        }

        async function recentRows(puuid) {
            if (!fresh(recentIds.get(puuid))) {
                const ids = await call(() => api.getRecentMatchIds(puuid, { queue: RECENT_QUEUE, count: RECENT_COUNT }));
                recentIds.set(puuid, { ids, at: now() });
            }
            const ids = recentIds.get(puuid).ids;
            const have = await store.getPlayerGames(puuid, ids);
            const stored = new Set(have.map(r => r.matchId));
            const matches = await Promise.all(ids.filter(id => !stored.has(id)).map(id =>
                call(() => api.getMatchData(id)).catch(err => {
                    if (err === STOP) throw err;
                    console.warn(`Live game: match ${id} unavailable:`, err.message);
                    return null;   // leave this game out, keep the rest
                })));
            const rows = matches.filter(Boolean).flatMap(playerGameRows).filter(r => lobby.has(r.puuid));
            if (rows.length) await store.savePlayerGames(rows);
            return [...have, ...rows.filter(r => r.puuid === puuid)];
        }

        // Phase 1: who they are, their rank, their mastery on this champion
        await Promise.all(players.filter(p => p.lookup).map(async p => {
            const e = entries[p.index];
            try {
                e.puuid = await puuidOf(p);
                e.league = await ranksOf(e.puuid);
                if (p.championKey != null) e.mastery = await masteryOf(e.puuid, p.championKey);
            } catch (err) {
                if (err === STOP) return;
                e.error = friendlyRiotError(err);
            }
            update(p.index);
        }));
        if (stopped()) return finish();
        lobby = new Set(entries.map(e => e.puuid).filter(Boolean));

        // Phase 2: recent games, enemies first
        const you = players.find(p => p.isYou);
        const lookups = players.filter(p => p.lookup);
        const queue = you
            ? [...lookups.filter(p => p.team !== you.team), ...lookups.filter(p => p.team === you.team)]
            : lookups;

        let done = 0;
        for (const p of queue) {
            if (stopped()) break;
            const e = entries[p.index];
            const own = p.isYou && ownGames;   // null when you're on another account
            if (own || e.puuid) {
                try {
                    const rows = own
                        ? (ownGames || []).filter(g => g.queueId === RECENT_QUEUE)
                            .sort((a, b) => b.gameCreation - a.gameCreation).slice(0, RECENT_COUNT)
                        : await recentRows(e.puuid);
                    e.form = recentForm(rows, p.championId);
                } catch (err) {
                    if (err === STOP) break;
                    e.error = e.error || friendlyRiotError(err);
                }
                update(p.index);
            }
            done++;
            if (!stopped()) onProgress({ done, total: queue.length });
        }
        return finish();
    }

    return { load };
}

module.exports = { createLiveGameLoader };
