/**
 * roleBenchmarks.js — per-role rank thresholds + which stats each role's
 * game report shows.
 *
 * Used by Coaching (one game, one role) and by the Analytics cards, which rank
 * each role's games on that role's ladder and combine the results (#56,
 * components/roleRanks.js).
 *
 * Only stats whose normal value really depends on the role get an override
 * (CS for junglers/supports, damage share, vision, kill participation, …).
 * Lane-opponent differences (GD/CSD/XPD@15) compare you with someone in the
 * same role already, so they use the general ladder.
 *
 * The numbers are estimates of typical per-role averages at each rank — not
 * official Riot data. Tune them here.
 */

const TIERS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];
const ladder = values => Object.fromEntries(TIERS.map((t, i) => [t, values[i]]));

const ROLE_BENCHMARKS = {
    TOP: {
        avg_kp:      ladder([30, 34, 38, 41, 44, 46, 48, 50, 52, 54]),
        avg_csm:     ladder([4.8, 5.3, 5.8, 6.3, 6.7, 7.1, 7.5, 7.9, 8.2, 8.5]),
        dmg_share:   ladder([17, 19, 21, 22.5, 24, 25.5, 27, 28.5, 30, 31.5]),
        vis_vs_min:  ladder([0.45, 0.52, 0.60, 0.68, 0.76, 0.84, 0.92, 1.00, 1.08, 1.16]),
        // side lanes die alone more often by design
        dr_isolated: ladder([2.4, 2.1, 1.8, 1.5, 1.3, 1.1, 0.9, 0.75, 0.6, 0.5]),
    },
    JUNGLE: {
        avg_kp:      ladder([40, 44, 48, 51, 54, 57, 60, 62, 64, 66]),
        avg_csm:     ladder([4.6, 5.0, 5.4, 5.8, 6.1, 6.4, 6.7, 7.0, 7.3, 7.6]),
        dmg_share:   ladder([12, 13.5, 15, 16.5, 18, 19.5, 21, 22.5, 24, 25.5]),
        vis_vs_min:  ladder([0.75, 0.88, 1.00, 1.12, 1.25, 1.38, 1.52, 1.68, 1.85, 2.00]),
        // junglers path alone, so some isolated deaths are part of the role
        dr_isolated: ladder([2.6, 2.3, 2.0, 1.8, 1.6, 1.4, 1.2, 1.0, 0.85, 0.7]),
    },
    MIDDLE: {
        avg_kp:      ladder([38, 42, 46, 49, 52, 55, 57, 59, 61, 63]),
        avg_csm:     ladder([5.0, 5.6, 6.1, 6.6, 7.0, 7.4, 7.8, 8.2, 8.5, 8.8]),
        dmg_share:   ladder([18, 20, 22, 24, 25.5, 27, 28.5, 30, 31.5, 33]),
        vis_vs_min:  ladder([0.50, 0.58, 0.66, 0.74, 0.82, 0.90, 0.98, 1.06, 1.14, 1.22]),
    },
    BOTTOM: {
        avg_kp:      ladder([40, 44, 47, 50, 53, 55, 57, 59, 61, 63]),
        avg_csm:     ladder([5.2, 5.8, 6.3, 6.8, 7.2, 7.6, 8.0, 8.4, 8.7, 9.0]),
        dmg_share:   ladder([19, 21, 23, 25, 26.5, 28, 29.5, 31, 32.5, 34]),
        vis_vs_min:  ladder([0.45, 0.53, 0.61, 0.69, 0.77, 0.85, 0.93, 1.01, 1.09, 1.17]),
    },
    UTILITY: {
        avg_kp:      ladder([45, 49, 53, 56, 59, 62, 64, 66, 68, 70]),
        avg_csm:     ladder([0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4]),
        dmg_share:   ladder([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
        vis_vs_min:  ladder([1.60, 1.85, 2.10, 2.35, 2.60, 2.85, 3.10, 3.35, 3.60, 3.90]),
        vis_control: ladder([2.5, 3.2, 3.9, 4.6, 5.3, 6.0, 6.7, 7.4, 8.1, 9.0]),
        vis_killed:  ladder([3, 4, 5, 6, 7, 8, 9, 10, 11, 13]),
    },
};

/** Stats every report shows, whatever the role. */
const GENERAL_STATS = ['avg_kda', 'avg_kp', 'deaths_10', 'dr_isolated'];

/** The four role-specific stats. UNKNOWN = role couldn't be read. */
const ROLE_STATS = {
    TOP:     ['cs_10', 'csd_15', 'xpd_15', 'solo_kill_diff'],
    JUNGLE:  ['avg_csm', 'gd_15', 'obj_dragon', 'vis_vs_min'],
    MIDDLE:  ['cs_10', 'csd_15', 'xpd_15', 'dmg_share'],
    BOTTOM:  ['cs_10', 'avg_csm', 'dmg_share', 'dmg_gold'],
    UTILITY: ['vis_vs_min', 'vis_control', 'vis_killed', 'vis_adv'],
    UNKNOWN: ['avg_csm', 'gd_15', 'vis_vs_min', 'dmg_share'],
};

/**
 * Where each stat lives in the Analytics engine, its tile label, and `tol`:
 * the absolute difference that still counts as "about the same as usual"
 * (plus 5% of the usual value).
 */
const STAT_INFO = {
    avg_kda:        { tab: 'Overview',     label: 'KDA',                tol: 0.15 },
    avg_kp:         { tab: 'Overview',     label: 'Kill participation', tol: 2 },
    avg_csm:        { tab: 'Overview',     label: 'CS / min',           tol: 0.2 },
    deaths_10:      { tab: 'Lane Phase',   label: 'Deaths before 10',   tol: 0.2 },
    cs_10:          { tab: 'Lane Phase',   label: 'CS at 10 min',       tol: 3 },
    csd_15:         { tab: 'Lane Phase',   label: 'CS diff @15',        tol: 4 },
    gd_15:          { tab: 'Lane Phase',   label: 'Gold diff @15',      tol: 100 },
    xpd_15:         { tab: 'Lane Phase',   label: 'XP diff @15',        tol: 100 },
    solo_kill_diff: { tab: 'Lane Phase',   label: 'Solo kill diff',     tol: 0.3 },
    dmg_share:      { tab: 'Combat',       label: 'Damage share',       tol: 1 },
    dmg_gold:       { tab: 'Combat',       label: 'Damage per gold',    tol: 0.08 },
    dr_isolated:    { tab: 'Death Review', label: 'Isolated deaths',    tol: 0.3 },
    obj_dragon:     { tab: 'Objectives',   label: 'Dragon control',     tol: 8 },
    vis_vs_min:     { tab: 'Vision',       label: 'Vision / min',       tol: 0.05 },
    vis_control:    { tab: 'Vision',       label: 'Control wards',      tol: 0.5 },
    vis_killed:     { tab: 'Vision',       label: 'Wards killed',       tol: 1 },
    vis_adv:        { tab: 'Vision',       label: 'Vision advantage',   tol: 0.1 },
};

const ROLES = Object.keys(ROLE_STATS).filter(r => r !== 'UNKNOWN');

function normRole(role) {
    const r = String(role || '').toUpperCase();
    return ROLES.includes(r) ? r : 'UNKNOWN';
}

/** Stat ids shown for a role, general first. */
function statsForRole(role) {
    const own = ROLE_STATS[normRole(role)];
    return [...GENERAL_STATS, ...own.filter(id => !GENERAL_STATS.includes(id))];
}

/** Cards that measure the same thing as an overridden stat share its ladder. */
const ALIASES = { eco_cs_min: 'avg_csm', kp_combat: 'avg_kp' };

/**
 * Stats with no ladder of their own for a role, but far off the general one:
 * the general ladder times a factor (#56). Estimates, from per-role averages
 * over ~1,700 ranked/normal games: supports deal ~0.6x the damage, earn ~0.76x
 * the gold and have ~2.3x the vision score and wards placed; laners deal
 * ~1.15x the damage with ~0.7x the vision; junglers deal ~0.87x the damage.
 */
const ROLE_SCALE = {
    UTILITY: { avg_dmg: 0.6, dmg_min: 0.6, dmg_min_combat: 0.6, eco_gold: 0.76, eco_gold_min: 0.76, vis_score: 2.3, vis_placed: 2.3 },
    TOP:     { avg_dmg: 1.15, dmg_min: 1.15, dmg_min_combat: 1.15, vis_score: 0.7, vis_placed: 0.75 },
    MIDDLE:  { avg_dmg: 1.15, dmg_min: 1.15, dmg_min_combat: 1.15, vis_score: 0.7, vis_placed: 0.75 },
    BOTTOM:  { avg_dmg: 1.15, dmg_min: 1.15, dmg_min_combat: 1.15, vis_score: 0.7, vis_placed: 0.75 },
    JUNGLE:  { avg_dmg: 0.87, dmg_min: 0.87, dmg_min_combat: 0.87 },
};
const scaledCache = new Map();

/**
 * Thresholds for a stat in a role: the role's own ladder (or an alias's),
 * else the general ladder scaled for the role, else the general ladder.
 */
function benchmarkFor(statId, role, general) {
    const r = normRole(role);
    const own = ROLE_BENCHMARKS[r];
    if (own && own[statId]) return own[statId];
    if (own && ALIASES[statId] && own[ALIASES[statId]]) return own[ALIASES[statId]];
    const base = typeof general === 'function' ? general(statId) : null;
    const factor = (ROLE_SCALE[r] || {})[statId];
    if (!base || !factor) return base;
    const key = `${r}:${statId}`;
    if (!scaledCache.has(key)) {
        scaledCache.set(key, Object.fromEntries(TIERS.map(t => [t, +(base[t] * factor).toFixed(3)])));
    }
    return scaledCache.get(key);
}

/** Same rule as analyticsEngine.evaluateBenchmark (>= / <=), from the top tier down. */
function tierFor(value, thresholds, higherIsBetter) {
    if (!thresholds || value === null || value === undefined || Number.isNaN(Number(value))) return null;
    for (const t of [...TIERS].reverse()) {
        if (higherIsBetter ? value >= thresholds[t] : value <= thresholds[t]) return t;
    }
    return 'iron';
}

module.exports = {
    TIERS, ROLE_BENCHMARKS, ROLE_SCALE, ALIASES, GENERAL_STATS, ROLE_STATS, STAT_INFO, ROLES,
    normRole, statsForRole, benchmarkFor, tierFor,
};
