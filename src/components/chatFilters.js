/**
 * chatFilters.js — the filters every chat data tool takes, and which values
 * the stored games have for them (get_filter_options). Pure; tested in
 * test/chatTools.test.js.
 *
 * The app's own filters (game mode, period, champion, role) plus a few it
 * doesn't have: each normal mode on its own, lane opponent, result and game
 * length. Period filters run first, on every stored game, as the app's
 * period dropdown does: "last patch" is the newest patch you played at all.
 */

const { patchOf, patchList, filterByPeriod } = require('../services/patches');

const QUEUES = {
    solo:      [420],
    flex:      [440],
    ranked:    [420, 440],
    premade:   [710],
    normal:    [400, 430, 480, 490, 700],
    draft:     [400],
    blind:     [430],
    swiftplay: [480],
    quickplay: [490],
    clash:     [700],
};

const QUEUE_NAMES = {
    solo: 'Ranked Solo/Duo', flex: 'Ranked Flex', ranked: 'Ranked (Solo + Flex)', premade: 'Ranked Premade (5-stack)',
    normal: 'Normal games', draft: 'Normal Draft', blind: 'Normal Blind', swiftplay: 'Swiftplay',
    quickplay: 'Quickplay', clash: 'Clash',
};

const QUEUE_LABEL = {
    420: 'Ranked Solo', 440: 'Ranked Flex', 710: 'Ranked Premade', 400: 'Normal Draft', 430: 'Normal Blind',
    480: 'Swiftplay', 490: 'Quickplay', 700: 'Clash',
};

const ROLE_ALIASES = {
    top: 'TOP', jungle: 'JUNGLE', jg: 'JUNGLE', jungler: 'JUNGLE',
    mid: 'MIDDLE', middle: 'MIDDLE',
    adc: 'BOTTOM', bot: 'BOTTOM', bottom: 'BOTTOM', carry: 'BOTTOM', marksman: 'BOTTOM',
    support: 'UTILITY', supp: 'UTILITY', sup: 'UTILITY', utility: 'UTILITY',
};

const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };
const ROLE_ARG   = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'adc', UTILITY: 'support' };

// Display names whose internal Riot name differs
const CHAMPION_ALIASES = { wukong: 'monkeyking', nunu: 'nunu', 'renataglasc': 'renata' };

const RESULTS = { win: true, won: true, wins: true, loss: false, lost: false, losses: false, lose: false };

/** Schema of the shared filters. Short descriptions: they are sent with every request. */
const FILTER_PROPS = {
    queue: { type: 'string', enum: ['all', ...Object.keys(QUEUES)],
             description: 'Default all. solo = Ranked Solo/Duo, ranked = solo + flex, normal = all unranked.' },
    champion: { type: 'string', description: 'Yours.' },
    role: { type: 'string', enum: ['top', 'jungle', 'mid', 'adc', 'support'] },
    lane_opponent: { type: 'string', description: 'Their champion.' },
    result: { type: 'string', enum: ['win', 'loss'] },
    patch: { type: 'string', description: '"16.20" or "latest".' },
    last_n_patches: { type: 'integer' },
    last_n_days: { type: 'integer' },
    since: { type: 'string', description: 'YYYY-MM-DD' },
    until: { type: 'string', description: 'YYYY-MM-DD' },
    min_minutes: { type: 'integer', description: 'Game length.' },
    max_minutes: { type: 'integer', description: 'Game length.' },
    last_n_games: { type: 'integer', description: 'Newest N, after the other filters.' },
};

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const posInt = v => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };

/** 'YYYY-MM-DD' → local-midnight ms, or null. */
function parseDay(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s).trim());
    if (!m) return null;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return Number.isFinite(t) ? t : null;
}

/**
 * Match a champion name the way people type it ("lee sin", "Wukong", "kaisa")
 * against the names in `field` of these games.
 */
function championMatcher(query, matches, field = 'championName') {
    const q = norm(query);
    if (!q) return { ok: true, test: () => true };
    const target = CHAMPION_ALIASES[q] || q;

    const played = [...new Set(matches.map(m => m[field]).filter(Boolean))];
    const exact  = played.filter(c => norm(c) === target);
    if (exact.length) return { ok: true, name: exact[0], test: m => norm(m[field]) === target };

    const partial = played.filter(c => norm(c).startsWith(target) || norm(c).includes(target));
    if (partial.length === 1) {
        const n = norm(partial[0]);
        return { ok: true, name: partial[0], test: m => norm(m[field]) === n };
    }
    const none = field === 'laneOpponent' ? `No games against "${query}" in lane.` : `No stored games on "${query}".`;
    return {
        ok: false,
        error: partial.length
            ? `"${query}" matches several champions: ${partial.slice(0, 8).join(', ')}. Ask which one.`
            : none,
    };
}

/**
 * Apply the shared filter arguments. Returns { matches (newest first),
 * description } or { error }: errors go back to the model as data so it can
 * tell the user.
 */
function applyFilters(all, args = {}, { now = Date.now() } = {}) {
    let list = all.slice();
    const parts = [];

    // Period: over every game, before the other filters (as in the app)
    if (args.patch) {
        const asked = String(args.patch).trim().toLowerCase();
        const patches = patchList(list);
        const patch = /^(latest|last|current|newest)$/.test(asked) ? (patches[0] && patches[0].patch) : patchOf(asked);
        if (!patch) {
            return { error: patches.length ? `Bad patch "${args.patch}". Use e.g. "${patches[0].patch}" or "latest".`
                                           : 'No patch is known for any game yet (games are still being indexed).' };
        }
        if (!patches.some(p => p.patch === patch)) {
            return { error: `No games on patch ${patch}. Patches with games: ${patches.slice(0, 8).map(p => p.patch).join(', ') || 'none indexed yet'}.` };
        }
        list = filterByPeriod(list, `patch:${patch}`);
        parts.push(`patch ${patch}`);
    }
    const nPatches = posInt(args.last_n_patches);
    if (nPatches) {
        list = filterByPeriod(list, `patches:${nPatches}`);
        parts.push(`last ${nPatches} patch${nPatches === 1 ? '' : 'es'}`);
    }
    const nDays = posInt(args.last_n_days);
    if (nDays) {
        list = filterByPeriod(list, `days:${nDays}`, { now });
        parts.push(`last ${nDays} days`);
    }

    const queue = String(args.queue || 'all').toLowerCase();
    if (queue !== 'all') {
        const ids = Object.hasOwn(QUEUES, queue) ? QUEUES[queue] : null;
        if (!ids) return { error: `Unknown queue "${args.queue}". Use all, ${Object.keys(QUEUES).join(', ')}.` };
        list = list.filter(m => ids.includes(m.queueId));
        parts.push(QUEUE_NAMES[queue]);
    }

    if (args.champion) {
        const cm = championMatcher(args.champion, list);
        if (!cm.ok) return { error: cm.error };
        list = list.filter(cm.test);
        parts.push(cm.name);
    }

    if (args.role) {
        const role = ROLE_ALIASES[norm(args.role)] || String(args.role).toUpperCase();
        if (!ROLE_LABEL[role]) return { error: `Unknown role "${args.role}". Use top, jungle, mid, adc or support.` };
        list = list.filter(m => (m.teamPosition || '') === role);
        parts.push(ROLE_LABEL[role]);
    }

    if (args.lane_opponent) {
        const om = championMatcher(args.lane_opponent, list, 'laneOpponent');
        if (!om.ok) return { error: om.error };
        list = list.filter(om.test);
        parts.push(`vs ${om.name}`);
    }

    if (args.result) {
        const won = Object.hasOwn(RESULTS, norm(args.result)) ? RESULTS[norm(args.result)] : undefined;
        if (won === undefined) return { error: `Unknown result "${args.result}". Use win or loss.` };
        list = list.filter(m => (m.win === 1 || m.win === true) === won);
        parts.push(won ? 'wins' : 'losses');
    }

    const minM = posInt(args.min_minutes), maxM = posInt(args.max_minutes);
    if (minM) { list = list.filter(m => (m.gameDuration || 0) >= minM * 60); parts.push(`${minM}+ min`); }
    if (maxM) { list = list.filter(m => (m.gameDuration || 0) <= maxM * 60); parts.push(`up to ${maxM} min`); }

    const since = parseDay(args.since), until = parseDay(args.until);
    if (args.since && since === null) return { error: `Bad date "${args.since}" — use YYYY-MM-DD.` };
    if (args.until && until === null) return { error: `Bad date "${args.until}" — use YYYY-MM-DD.` };
    if (since !== null) { list = list.filter(m => m.gameCreation >= since); parts.push(`since ${args.since}`); }
    // until is inclusive of that whole day
    if (until !== null) { list = list.filter(m => m.gameCreation < until + 86400000); parts.push(`until ${args.until}`); }

    // Newest first, so "last N games" is a simple slice
    list.sort((a, b) => b.gameCreation - a.gameCreation);
    const n = posInt(args.last_n_games);
    if (n) { list = list.slice(0, n); parts.push(`last ${n} games`); }

    return { matches: list, description: parts.length ? parts.join(', ') : 'all stored games' };
}

/** Name → count, most first. */
function counts(list, keyOf, limit = Infinity) {
    const c = new Map();
    for (const m of list) {
        const k = keyOf(m);
        if (k) c.set(k, (c.get(k) || 0) + 1);
    }
    return Object.fromEntries([...c].sort((a, b) => b[1] - a[1]).slice(0, limit));
}

/** What the filters can be set to: values that have games, with counts. */
function filterOptions(matches) {
    const queues = {};
    for (const [key, ids] of Object.entries(QUEUES)) {
        const n = matches.filter(m => ids.includes(m.queueId)).length;
        if (n) queues[key] = n;
    }
    return {
        total_games: matches.length,
        queues,
        roles: counts(matches, m => ROLE_ARG[m.teamPosition]),
        patches_newest_first: Object.fromEntries(patchList(matches).slice(0, 12).map(p => [p.patch, p.games])),
        champions: counts(matches, m => m.championName),
        most_faced_lane_opponents: counts(matches, m => m.laneOpponent, 15),
    };
}

module.exports = {
    QUEUES, QUEUE_NAMES, QUEUE_LABEL, ROLE_ALIASES, ROLE_LABEL, FILTER_PROPS,
    norm, posInt, parseDay, championMatcher, applyFilters, filterOptions,
};
