/**
 * nextItem.js — your best next item during a live game (#90). Pure.
 *
 * The Live page knows which finished items you own (Live Client playerlist).
 * Your stored games on that champion say what you bought next when you had
 * exactly those finished items, and how your team's win chance moved after
 * that purchase (item WPA, #89). Candidates are ranked by average WPA.
 *
 * "Finished" is decided by the caller (Data Dragon), like itemBuild.js; the
 * Live page passes the Build order card's rule, so boots are left out.
 *
 * With too few games for your exact items, the largest subset of them with
 * enough games is used instead (the one with the most games at that size),
 * and `basis` says which. Items you own are never candidates: a game that
 * matched on a subset counts the first item after that point you don't own.
 */

const { decodePurchases } = require('./itemBuild');
const { itemWpa, winChancePoints } = require('./itemWpa');

const MIN_GAMES = 5;   // same as LOW_SAMPLE on the Champions page

/** Finished items in purchase order, each once (its first purchase), with its index in `purchases`. */
function buildSteps(purchases, isCompleted) {
    const seen = new Set();
    const steps = [];
    purchases.forEach((p, index) => {
        if (isCompleted(p.itemId) && !seen.has(p.itemId)) {
            seen.add(p.itemId);
            steps.push({ itemId: p.itemId, index });
        }
    });
    return steps;
}

/**
 * The step a game took after having exactly `basis` (its first basis.size
 * finished items are those), skipping items you own; null if it never had
 * exactly those items or bought nothing else after.
 */
function nextAfter(steps, basis, owned) {
    const k = basis.size;
    if (steps.length < k || !steps.slice(0, k).every(s => basis.has(s.itemId))) return null;
    return steps.slice(k).find(s => !owned.has(s.itemId)) || null;
}

function tally(games, steps, basis, owned) {
    const counts = new Map();
    let matched = 0;
    steps.forEach((gameSteps, i) => {
        const next = nextAfter(gameSteps, basis, owned);
        if (!next) return;
        matched++;
        const g = games[i];
        const c = counts.get(next.itemId) || { itemId: next.itemId, games: 0, wins: 0, wpaSum: 0, wpaGames: 0 };
        c.games++;
        if (g.win) c.wins++;
        const w = (g.wpa || [])[next.index];
        if (w && Number.isFinite(w.wpa)) { c.wpaSum += w.wpa; c.wpaGames++; }
        counts.set(next.itemId, c);
    });
    return { matched, counts };
}

/** Every k-item subset of `list`, in list order. */
function subsets(list, k, from = 0) {
    if (k === 0) return [[]];
    const out = [];
    for (let i = from; i <= list.length - k; i++) {
        for (const rest of subsets(list, k - 1, i + 1)) out.push([list[i], ...rest]);
    }
    return out;
}

/** Ranked by average WPA when WPA has minGames games, else after those, by games. */
function rankOptions(counts, minGames) {
    const rows = [...counts.values()].map(({ wpaSum, ...c }) => ({
        ...c, winRate: c.wins / c.games, wpa: c.wpaGames ? wpaSum / c.wpaGames : null,
    }));
    return [
        ...rows.filter(r => r.wpaGames >= minGames).sort((a, b) => b.wpa - a.wpa || b.games - a.games),
        ...rows.filter(r => r.wpaGames < minGames).sort((a, b) => b.games - a.games),
    ];
}

/**
 * @param {Array<{purchases, win, wpa}>} games  championGames() output
 * @param {number[]} owned  item ids you hold now; non-finished ones are ignored
 * @param {object} opts  { isCompleted(id), minGames }
 * @returns {{ basis: number[], games: number, options: Array<{itemId, games, wins, winRate, wpa, wpaGames}> }}
 */
function nextItemOptions(games, owned, { isCompleted = () => true, minGames = MIN_GAMES } = {}) {
    const list = games || [];
    const mine = [...new Set((owned || []).filter(id => id > 0 && isCompleted(id)))];
    const ownedSet = new Set(mine);
    const steps = list.map(g => buildSteps(g.purchases || [], isCompleted));

    let best = null;
    for (let k = mine.length; k >= 0; k--) {
        let level = null;
        for (const basis of subsets(mine, k)) {
            const t = tally(list, steps, new Set(basis), ownedSet);
            if (!level || t.matched > level.matched) level = { basis, ...t };
        }
        if (level.matched >= minGames) { best = level; break; }
        if (!best || level.matched > best.matched) best = level;
    }
    return { basis: best.basis, games: best.matched, options: rankOptions(best.counts, minGames) };
}

/**
 * Your stored games on `champion` (Data Dragon id, compared case-insensitively
 * since Match-V5 writes "FiddleSticks") that have purchase data, in `position`
 * when at least minRoleGames of them were played there, else in every role.
 */
function championGames(matches, champion, position, { minRoleGames = MIN_GAMES } = {}) {
    const name = String(champion || '').toLowerCase();
    const mine = (matches || []).filter(m => m.itemPurchases && String(m.championName || '').toLowerCase() === name);
    const inRole = position ? mine.filter(m => (m.teamPosition || '') === position) : [];
    const useRole = inRole.length >= minRoleGames;
    return {
        role: useRole ? position : null,
        games: (useRole ? inRole : mine).map(m => {
            const purchases = decodePurchases(m.itemPurchases);
            return { purchases, win: !!m.win, wpa: itemWpa(purchases, winChancePoints(m.winChance, m.gameDuration)) };
        }),
    };
}

module.exports = { MIN_GAMES, nextItemOptions, championGames };
