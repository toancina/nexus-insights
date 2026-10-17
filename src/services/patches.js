/**
 * patches.js — game patch per match, and the Analytics period filter (#6).
 *
 * Pure. A period is a string, so it can live in a <select> value:
 *   ''              all time
 *   'patches:N'     the N newest patches you have games on
 *   'patch:16.20'   one patch
 *   'days:N'        the last N days
 * Games whose patch isn't known yet (not indexed) only drop out of the patch
 * periods, never out of the time windows.
 */

const DAY_MS = 86400000;

/** '16.20.719.1234' → '16.20' ('' when it doesn't look like a version). */
function patchOf(gameVersion) {
    const m = /^(\d+)\.(\d+)/.exec(String(gameVersion || ''));
    return m ? `${Number(m[1])}.${Number(m[2])}` : '';
}

/** Newest first, by number: 16.10 comes before 16.9. */
function comparePatchDesc(a, b) {
    const [a1, a2] = a.split('.').map(Number);
    const [b1, b2] = b.split('.').map(Number);
    return (b1 - a1) || (b2 - a2);
}

/** Patches you have games on, newest first: [{ patch, games }]. */
function patchList(matches) {
    const counts = new Map();
    for (const m of matches) if (m.patch) counts.set(m.patch, (counts.get(m.patch) || 0) + 1);
    return [...counts].map(([patch, games]) => ({ patch, games }))
        .sort((x, y) => comparePatchDesc(x.patch, y.patch));
}

/** The time windows the dropdown offers, in days. */
const WINDOWS = [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 3 months'], [182, 'Last 6 months'], [365, 'Last year']];

function periodLabel(period) {
    const [kind, arg] = String(period || '').split(':');
    if (kind === 'patches') return `Last ${arg} patch${arg === '1' ? '' : 'es'}`;
    if (kind === 'patch') return `Patch ${arg}`;
    if (kind === 'days') {
        const w = WINDOWS.find(([d]) => String(d) === arg);
        return w ? w[1] : `Last ${arg} days`;
    }
    return 'All time';
}

/**
 * @param {Array}  matches
 * @param {string} period
 * @param {object} [opts]  { now } for tests
 */
function filterByPeriod(matches, period, { now = Date.now() } = {}) {
    const [kind, arg] = String(period || '').split(':');
    if (kind === 'patches') {
        const keep = new Set(patchList(matches).slice(0, Number(arg) || 0).map(p => p.patch));
        return matches.filter(m => keep.has(m.patch));
    }
    if (kind === 'patch' && arg) return matches.filter(m => m.patch === arg);
    if (kind === 'days' && Number(arg) > 0) {
        const since = now - Number(arg) * DAY_MS;
        return matches.filter(m => m.gameCreation >= since);
    }
    return matches;
}

/** Win rate on each patch, newest first, at most `limit` patches. */
function patchWinRates(matches, limit = 6) {
    const by = new Map();
    for (const m of matches) {
        if (!m.patch) continue;
        const r = by.get(m.patch) || { patch: m.patch, games: 0, wins: 0 };
        r.games++;
        if (m.win === 1) r.wins++;
        by.set(m.patch, r);
    }
    return [...by.values()]
        .sort((x, y) => comparePatchDesc(x.patch, y.patch))
        .slice(0, limit)
        .map(r => ({ ...r, winRate: r.wins / r.games }));
}

/**
 * The Data Dragon version for a game's patch ("16.10" → "16.10.1"), so an
 * item that has since been removed still has its icon (#67). The newest
 * listed version of that patch, else "<patch>.1" when the list isn't loaded;
 * null when the patch is unknown.
 * @param {string} patch     major.minor, as stored in matches.patch
 * @param {string[]} versions Data Dragon's versions.json (newest first)
 */
function ddragonVersionForPatch(patch, versions) {
    if (!/^\d+\.\d+$/.test(String(patch || ''))) return null;
    const listed = (versions || []).find(v => v.startsWith(patch + '.'));
    return listed || `${patch}.1`;
}

module.exports = { ddragonVersionForPatch, patchOf, comparePatchDesc, patchList, filterByPeriod, patchWinRates, periodLabel, WINDOWS };
