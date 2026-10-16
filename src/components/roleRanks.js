/**
 * roleRanks.js — role-weighted rank badges for the Analytics cards (#56).
 * Pure, tested.
 *
 * A card used to rank one average over every filtered game, so mixing roles
 * skewed role-dependent stats (jungle games count as ~0 plates lost, so
 * Plates Lost looked like Grandmaster). Now each role's average is ranked on
 * that role's own ladder, as a continuous score, and the scores are averaged
 * weighted by games played. Stats that don't apply to a role ignore that
 * role's games completely.
 */

const TIERS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];

/**
 * Stats that say nothing about a role: its games are left out of the card's
 * value and rank. Supports barely farm, so CS and lane-farm stats don't apply;
 * plates are a laner stat (a jungler's "lane opponent" is the enemy jungler).
 */
const NOT_APPLICABLE = {
    UTILITY: ['avg_csm', 'eco_cs_min', 'avg_cs', 'eco_cs', 'cs_10', 'cs_15', 'cs_20', 'csd_15',
              'plates_taken', 'plates_lost', 'solo_kill_diff'],
    JUNGLE:  ['plates_taken', 'plates_lost'],
};

const ROLE_NAMES = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support', UNKNOWN: 'No role' };

/** A game's role: its teamPosition, or UNKNOWN when Riot didn't assign one. */
function roleOf(match) {
    const r = String((match && match.teamPosition) || '').toUpperCase();
    return ROLE_NAMES[r] && r !== 'UNKNOWN' ? r : 'UNKNOWN';
}

function notApplicable(statId, role) {
    return (NOT_APPLICABLE[role] || []).includes(statId);
}

/** Games grouped by role, biggest group first: [{ role, matches }]. */
function groupByRole(matches) {
    const groups = new Map();
    for (const m of matches || []) {
        const role = roleOf(m);
        if (!groups.has(role)) groups.set(role, []);
        groups.get(role).push(m);
    }
    return [...groups].map(([role, list]) => ({ role, matches: list }))
        .sort((a, b) => b.matches.length - a.matches.length);
}

/**
 * A value's place on a ladder as a number: Iron = 0 … Challenger = 9, with the
 * fraction of the way to the next tier's threshold. Its whole part is always
 * the tier evaluateBenchmark gives (>= for higher-is-better, <= for lower).
 */
function tierScore(value, thresholds, higherIsBetter) {
    if (!thresholds || value === null || value === undefined || !Number.isFinite(Number(value))) return null;
    const t = TIERS.map(k => thresholds[k]);
    const reached = v => (higherIsBetter ? value >= v : value <= v);
    let i = -1;
    for (let k = TIERS.length - 1; k >= 0; k--) {
        if (reached(t[k])) { i = k; break; }
    }
    if (i < 0) return 0;                 // below Iron's threshold: still Iron
    if (i === TIERS.length - 1) return TIERS.length - 1;
    const span = t[i + 1] - t[i];
    const frac = span === 0 ? 0 : (value - t[i]) / span;
    return i + Math.max(0, Math.min(0.999, frac));
}

const scoreToTier = score => TIERS[Math.max(0, Math.min(TIERS.length - 1, Math.floor(score)))];

/**
 * Combine per-role scores, weighted by games: [{ games, score }] → tier name,
 * or null when nothing could be scored.
 */
function combineScores(entries) {
    let games = 0, sum = 0;
    for (const e of entries || []) {
        if (e.score === null || e.score === undefined || !(e.games > 0)) continue;
        games += e.games;
        sum += e.games * e.score;
    }
    return games ? { tier: scoreToTier(sum / games), score: sum / games, games } : null;
}

/** "Mid 1.3 Gold (419) · Top 1.8 Silver (186)" for a card's tooltip. */
function breakdownText(entries) {
    return (entries || []).map(e => {
        const tier = e.tier ? ` ${e.tier.charAt(0).toUpperCase()}${e.tier.slice(1)}` : '';
        return `${ROLE_NAMES[e.role] || e.role} ${e.displayValue}${tier} (${e.games})`;
    }).join(' · ');
}

module.exports = {
    TIERS, NOT_APPLICABLE, ROLE_NAMES,
    roleOf, notApplicable, groupByRole, tierScore, scoreToTier, combineScores, breakdownText,
};
