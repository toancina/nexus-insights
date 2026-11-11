/**
 * sampleLoader.js — downloads sample games (rules in sampleSelect.js).
 *
 * Per group (your level, the level above):
 *   1. Division list pages (League-V4, ~205 players each), re-fetched at most
 *      once a day, scanned until every champion has 5 candidates or MAX_PAGES
 *      pages are read. Apex leagues are one call.
 *   2. Each listed player's mastery on every champion (one call per player,
 *      re-checked after 7 days).
 *   3. Per champion, the 5 players with the most mastery on it. For each, their
 *      Solo/Duo ids of the last 90 days, newest first: every id not handled
 *      yet costs one match call to see the champion; only games on that
 *      champion get the timeline call and are stored. 5 stored games or
 *      MAX_CHECKS_PER_PLAYER checks end a player.
 *
 * `shouldStop()` is asked before every call; a reason pauses the run (your
 * sync or a live game comes first). A rejected key stops it. `api` and `store`
 * are injected, which is how the tests run it without network or SQLite.
 */

const { purchasesFromTimeline, encodePurchases } = require('./itemBuild');
const { patchOf } = require('./patches');
const { friendlyRiotError, isKeyError } = require('./riotErrors');
const { DAY_MS, RETENTION_MS, PLAYERS_PER_GROUP, GAMES_PER_PLAYER, pickBestPlayers } = require('./sampleSelect');

const MAX_PAGES = 3;
const LIST_TTL_MS = DAY_MS;
const MASTERY_TTL_MS = 7 * DAY_MS;
const MAX_CHECKS_PER_PLAYER = 15;
const SOLO_QUEUE = 420;
const ITEMS = ['item0', 'item1', 'item2', 'item3', 'item4', 'item5', 'item6'];

const STOP = Symbol('stop');
const status = err => err && err.response && err.response.status;

function participantOf(raw, puuid) {
    const list = (raw && raw.info && raw.info.participants) || [];
    return list.find(p => p.puuid === puuid) || null;
}

function isRemakeGame(info, me) {
    return (me && me.gameEndedInEarlySurrender === true) || (info.gameDuration || 0) < 300;
}

/**
 * One downloaded game → what sampleStore.saveGame takes; null for a remake or
 * when `puuid` isn't in the game. tier/division are set by the loader.
 */
function sampleGameFrom(raw, timeline, puuid) {
    const info = raw && raw.info;
    const me = participantOf(raw, puuid);
    if (!info || !me || isRemakeGame(info, me)) return null;
    const pid = me.participantId || ((info.participants || []).indexOf(me) + 1);
    const blue = (info.teams || []).find(t => t.teamId === 100);
    const blueWin = blue ? (blue.win ? 1 : 0) : ((me.teamId === 100) === !!me.win ? 1 : 0);
    const matchId = (raw.metadata && raw.metadata.matchId) || String(info.gameId || '');
    const row = {
        matchId, puuid,
        championName: me.championName, teamId: me.teamId, teamPosition: me.teamPosition || '',
        win: me.win ? 1 : 0, tier: null, division: null,
        itemPurchases: timeline ? encodePurchases(purchasesFromTimeline(timeline, pid)) : '',
        primaryRune: me.perks?.styles?.[0]?.selections?.[0]?.perk || null,
        secondaryRuneStyle: me.perks?.styles?.[1]?.style || null,
    };
    for (const c of ITEMS) row[c] = me[c] || 0;
    return {
        game: {
            matchId, gameCreation: info.gameCreation, gameDuration: info.gameDuration,
            patch: patchOf(info.gameVersion), blueWin, winFeatures: null,
            rawJson: raw, timelineJson: timeline,
        },
        row,
    };
}

function masteryMap(list, since) {
    const out = {};
    for (const m of list || []) {
        if (m && m.lastPlayTime >= since) out[m.championId] = { points: m.championPoints, lastPlayTime: m.lastPlayTime };
    }
    return out;
}

function createSampleLoader({ api, store, now = Date.now }) {
    async function run({ champions, groups, selfPuuid = null, shouldStop = () => null, onProgress = () => {} } = {}) {
        const result = { stored: 0, checked: 0, calls: 0, found: {}, stopped: null, message: null };
        for (const c of champions || []) result.found[c.name] = {};

        const call = (fn) => {
            const reason = shouldStop();
            if (reason) throw Object.assign(new Error(`stopped: ${reason}`), { [STOP]: reason });
            result.calls++;
            return fn();
        };
        const fresh = (at, ttl) => at != null && now() - at < ttl;

        /** Players listed on one page, from cache when fetched within a day. */
        async function pagePlayers(group, page) {
            const { tier, division } = group;
            const fetchedAt = await store.listFetchedAt(tier, division, page);
            const stored = await store.getPlayers(tier, division);
            if (fresh(fetchedAt, LIST_TTL_MS)) return stored.filter(p => p.page === page && p.listedAt === fetchedAt);

            onProgress(`Reading the ${group.label} list${division ? ` (page ${page})` : ''}…`);
            const entries = division
                ? await call(() => api.getLeagueEntries(tier, division, page))
                : await call(() => api.getApexLeague(tier));
            const at = now();
            const known = new Map(stored.map(p => [p.puuid, p]));
            const list = (entries || []).map(e => {
                const s = known.get(e.puuid);
                return { puuid: e.puuid, tier, division, page, masteries: s ? s.masteries : {}, checkedAt: s ? s.checkedAt : null, listedAt: at };
            });
            await store.savePlayers(list);
            await store.saveListFetched(tier, division, page, at);
            return list;
        }

        async function checkMasteries(group, players) {
            const since = now() - RETENTION_MS;
            for (const p of players) {
                if (p.puuid === selfPuuid || fresh(p.checkedAt, MASTERY_TTL_MS)) continue;
                const list = await call(() => api.getAllMasteries(p.puuid));
                p.masteries = masteryMap(list, since);
                p.checkedAt = now();
                await store.savePlayers([{ ...p, tier: group.tier, division: group.division }]);
            }
        }

        const pick = (candidates, champ) => pickBestPlayers(candidates, champ.key, { now: now(), exclude: selfPuuid, count: PLAYERS_PER_GROUP });

        async function candidatesFor(group) {
            const candidates = [];
            const pages = group.division ? MAX_PAGES : 1;
            for (let page = 1; page <= pages; page++) {
                const players = await pagePlayers(group, page);
                if (!players.length) break;
                await checkMasteries(group, players);
                candidates.push(...players);
                if (champions.every(c => pick(candidates, c).length >= PLAYERS_PER_GROUP)) break;
            }
            return candidates;
        }

        const idsCache = new Map();
        async function gamesFor(puuid, champ, group) {
            let have = await store.storedCount(puuid, champ.name);
            if (have >= GAMES_PER_PLAYER) return;
            const known = await store.knownMatchIds(puuid);
            if (!idsCache.has(puuid)) {
                idsCache.set(puuid, await call(() => api.getMatchIds(puuid, now() - RETENTION_MS, SOLO_QUEUE)) || []);
            }
            const champName = String(champ.name).toLowerCase();
            let checks = 0;
            for (const id of idsCache.get(puuid)) {
                if (have >= GAMES_PER_PLAYER || checks >= MAX_CHECKS_PER_PLAYER) break;
                if (known.has(id)) continue;
                checks++;
                result.checked++;
                let raw;
                try {
                    raw = await call(() => api.getMatchData(id));
                } catch (err) {
                    if (status(err) !== 404) throw err;
                    await store.saveSkip(id, puuid, now());
                    known.add(id);
                    continue;
                }
                const info = raw && raw.info;
                const me = participantOf(raw, puuid);
                if (!info || !me || String(me.championName || '').toLowerCase() !== champName || isRemakeGame(info, me)) {
                    await store.saveSkip(id, puuid, info ? info.gameCreation : now());
                    known.add(id);
                    continue;
                }
                let timeline;
                try {
                    timeline = await call(() => api.getMatchTimeline(id));
                } catch (err) {
                    if (status(err) !== 404) throw err;
                    await store.saveSkip(id, puuid, info.gameCreation);
                    known.add(id);
                    continue;
                }
                const built = sampleGameFrom(raw, timeline, puuid);
                if (!built) { await store.saveSkip(id, puuid, info.gameCreation); known.add(id); continue; }
                built.row.tier = group.tier;
                built.row.division = group.division;
                await store.saveGame(built);
                known.add(id);
                have++;
                result.stored++;
            }
        }

        try {
            for (const group of groups || []) {
                const candidates = await candidatesFor(group);
                for (const champ of champions || []) {
                    const picks = pick(candidates, champ);
                    result.found[champ.name][group.key] = picks.length;
                    for (let i = 0; i < picks.length; i++) {
                        onProgress(`${champ.name}: ${group.label} player ${i + 1} of ${picks.length}…`);
                        await gamesFor(picks[i], champ, group);
                    }
                }
            }
        } catch (err) {
            if (err && err[STOP]) result.stopped = 'paused';
            else if (isKeyError(err)) { result.stopped = 'key'; result.message = friendlyRiotError(err); }
            else { result.stopped = 'error'; result.message = (err && err.message) || String(err); }
        }
        return result;
    }

    return { run };
}

module.exports = { MAX_PAGES, LIST_TTL_MS, MASTERY_TTL_MS, MAX_CHECKS_PER_PLAYER, sampleGameFrom, createSampleLoader };
