/**
 * championStats.js — the numbers behind the Champions page (#4).
 *
 * Pure: takes the match rows the Analytics cards get (current queue filter,
 * remakes excluded) and returns plain rows. Summary formulas match
 * calcOverview in analyticsEngine.js, so the two pages agree:
 * KDA summed over games, CS/min, damage/min and KP averaged per game.
 *
 * Items are each game's final build (item0–item5; item6 is the trinket),
 * counted once per game. Build ORDER needs the timeline's purchase events
 * and is issue #7.
 */

const ROLE_LABELS = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };
const roleLabel = role => ROLE_LABELS[role] || (role ? role.charAt(0) + role.slice(1).toLowerCase() : 'No role');

const ITEM_SLOTS = ['item0', 'item1', 'item2', 'item3', 'item4', 'item5'];

const fin = v => (Number.isFinite(v) ? v : null);
const mean = arr => {
    const xs = arr.filter(Number.isFinite);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const minutes = m => (m.gameDuration > 0 ? m.gameDuration / 60 : null);

/** Games, W/L and the headline averages for a list of games. */
function summarize(games) {
    const n = games.length;
    const wins = games.filter(m => m.win === 1).length;
    const sum = k => games.reduce((a, m) => a + (Number.isFinite(m[k]) ? m[k] : 0), 0);
    return {
        games: n,
        wins,
        losses: n - wins,
        winRate: n ? wins / n : null,
        kda: n ? (sum('kills') + sum('assists')) / Math.max(1, sum('deaths')) : null,
        csPerMin: mean(games.map(m => minutes(m) ? m.totalMinionsKilled / minutes(m) : null)),
        dmgPerMin: mean(games.map(m => minutes(m) ? m.totalDamageDealtToChampions / minutes(m) : null)),
        kp: mean(games.map(m => m.teamKills > 0 ? (m.kills + m.assists) / m.teamKills : 0)),
        impactRank: mean(games.map(m => fin(m.impactRank))),
        gd15: mean(games.map(m => fin(m.goldDiff15))),
        csd15: mean(games.map(m => fin(m.csDiff15))),
        lastPlayed: games.reduce((a, m) => Math.max(a, m.gameCreation || 0), 0) || null,
    };
}

/** Group into a Map, keeping first-seen order (so sorts are stable). */
function groupBy(list, keyOf) {
    const map = new Map();
    for (const item of list) {
        const key = keyOf(item);
        if (key === null || key === undefined) continue;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
    }
    return map;
}

const byGamesDesc = (a, b) => b.games - a.games;

function rolesOf(games) {
    return [...groupBy(games, m => m.teamPosition || '')]
        .map(([role, list]) => ({ role, games: list.length }))
        .sort(byGamesDesc);
}

/**
 * One row per role, most played first: the Roles table on Overview (#10).
 * `playRate` is the share of these games; '' (no position) is "No role".
 */
function roleTable(matches) {
    return [...groupBy(matches, m => m.teamPosition || '')]
        .map(([role, games]) => ({
            role, label: roleLabel(role), ...summarize(games),
            playRate: games.length / matches.length,
        }))
        .sort(byGamesDesc);
}

/** One row per champion, most played first. */
function championTable(matches) {
    return [...groupBy(matches, m => m.championName)]
        .map(([champion, games]) => {
            const roles = rolesOf(games);
            return { champion, ...summarize(games), roles, mainRole: roles[0] ? roles[0].role : '' };
        })
        .sort(byGamesDesc);
}

/**
 * Sort rows by `key`. Nulls always go last; ties fall back to most games.
 * With `minGames`, rows with fewer games sink below the rest when sorting by
 * a stat, so a 1-game 100% doesn't top the win-rate sort. Returns a new array.
 */
function sortRows(rows, key, dir = 'desc', { minGames = 0 } = {}) {
    const sign = dir === 'asc' ? 1 : -1;
    const sinks = key !== 'champion' && key !== 'games' && minGames > 0;
    return [...rows].sort((a, b) => {
        if (sinks) {
            const aLow = a.games < minGames, bLow = b.games < minGames;
            if (aLow !== bLow) return aLow ? 1 : -1;
        }
        const x = a[key], y = b[key];
        const xNull = x === null || x === undefined, yNull = y === null || y === undefined;
        if (xNull || yNull) return xNull === yNull ? b.games - a.games : (xNull ? 1 : -1);
        const cmp = typeof x === 'string' ? x.localeCompare(y) : x - y;
        return cmp !== 0 ? sign * cmp : b.games - a.games;
    });
}

/** Win/pick rows for something counted once per game (an item, a rune page). */
function rateRows(games, keysOf, total) {
    const counts = new Map();
    for (const m of games) {
        for (const key of new Set(keysOf(m))) {
            const c = counts.get(key) || { key, games: 0, wins: 0 };
            c.games++;
            if (m.win === 1) c.wins++;
            counts.set(key, c);
        }
    }
    return [...counts.values()]
        .map(c => ({ ...c, winRate: c.wins / c.games, pickRate: total ? c.games / total : 0 }))
        .sort(byGamesDesc);
}

function itemRows(games, isCoreItem) {
    return rateRows(games, m => ITEM_SLOTS.map(s => m[s]).filter(id => id > 0 && isCoreItem(id)), games.length)
        .map(({ key, ...r }) => ({ itemId: key, ...r }));
}

/**
 * Everything on one champion's detail view.
 *
 * @param {Array}    matches
 * @param {string}   champion
 * @param {object}   [opts]
 * @param {string}   [opts.role]        teamPosition to narrow to (null = all)
 * @param {Function} [opts.isCoreItem]  itemId → bool (finished items only); the
 *                                      page passes a Data Dragon-based check
 */
/**
 * A rune page's number (sample games, 2026-11): its win rate minus the
 * champion's over the same games, in points, with a 95% binomial margin. A
 * page that always won or always lost gets its margin from (wins+1)/(games+2),
 * so a 3/3 page isn't reported as certain.
 */
function runeEdge(row, championWinRate) {
    if (!row.games || championWinRate == null) return { edge: null, edgeMargin: null };
    const wr = row.winRate;
    const p = wr === 0 || wr === 1 ? (row.wins + 1) / (row.games + 2) : wr;
    return { edge: (wr - championWinRate) * 100, edgeMargin: 1.96 * Math.sqrt(p * (1 - p) / row.games) * 100 };
}

function championDetail(matches, champion, { role = null, isCoreItem = id => id > 0 } = {}) {
    const all = matches.filter(m => m.championName === champion);
    const games = role ? all.filter(m => (m.teamPosition || '') === role) : all;
    const summary = summarize(games);

    const runes = rateRows(games, m => (m.primaryRune ? [`${m.primaryRune}|${m.secondaryRuneStyle || 0}`] : []), games.length)
        .map(({ key, ...r }) => {
            const [keystone, secondary] = key.split('|').map(Number);
            return { keystone, secondary, ...r, ...runeEdge(r, summary.winRate) };
        });

    const known = games.filter(m => m.laneOpponent);
    const matchups = [...groupBy(known, m => m.laneOpponent)]
        .map(([opponent, list]) => ({
            opponent,
            ...summarize(list),
            items: itemRows(list, isCoreItem),
            runes: rateRows(list, m => (m.primaryRune ? [m.primaryRune] : []), list.length)
                .map(({ key, ...r }) => ({ keystone: key, ...r })),
        }))
        .sort(byGamesDesc);

    return {
        champion, role,
        summary,
        roles: rolesOf(all),
        runes,
        items: itemRows(games, isCoreItem),
        matchups,
        unmatched: games.length - known.length,
    };
}

module.exports = { summarize, championTable, championDetail, roleTable, sortRows, roleLabel, ROLE_LABELS };
