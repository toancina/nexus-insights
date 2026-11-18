/**
 * coachingProgress.js — the numbers behind the Coaching page (2026-10).
 *
 * The page is organised around one question: "am I improving, game to game?"
 *
 *   rankHeader      current Solo/Duo rank + LP over the last 10 games
 *   lastGameReport  one game vs. your own normal (the 20 games before it)
 *   focusHits       the coaching focus, hit / missed for each of the last 10
 *   areaTrends      each Analytics area: last 10 games vs. the 10 before
 *
 * No second set of formulas: every stat value comes from running the
 * Analytics engine (`computeTabStats`) over the relevant games — a list of
 * one game for the last-game report — so Coaching can never disagree with
 * the cards on the Analytics page. Pure functions; the engine is injected.
 *
 * Solo/Duo only (queue 420), remakes excluded, oldest → newest.
 */

const SOLO_QUEUE = 420;
const WINDOW     = 10;   // "last 10 vs. the 10 before"
const BASELINE   = 20;   // a game is compared with the 20 before it

/**
 * The stats in the game report depend on the role played that game: four
 * general ones + four for the role (roleBenchmarks.js). Their rank badges use
 * per-role thresholds, and "usual" is the 20 earlier games in the SAME role.
 * (obj_rate and plates_taken are left out: both were miscomputed until the
 * timelineRules.js fix, and obj_rate sits at 93–98% for everyone anyway.)
 */
const Roles = require('./roleBenchmarks');
const { groupOf } = require('../services/sampleSelect');
const { RANK_COLORS } = require('./rankTiers');
const MIN_ROLE_BASELINE = 5;   // fewer same-role games than this → compare with all roles

/** Kept for callers/tests: the stats of a report in an unknown role. */
const REPORT_STATS = Roles.statsForRole('UNKNOWN').map(id => ({ id, ...Roles.STAT_INFO[id] }));

/** Areas for the trends section, each with the stat its sparkline follows. */
const AREAS = [
    { tab: 'Lane Phase',   lead: 'gd_15' },
    { tab: 'Combat',       lead: 'dmg_share' },
    { tab: 'Death Review', lead: 'dr_avg_deaths' },
    { tab: 'Vision',       lead: 'vis_vs_min' },
    { tab: 'Objectives',   lead: 'obj_tower' },
    { tab: 'Economy',      lead: 'eco_gold_min' },
];

const isNum = v => v !== null && v !== undefined && !Number.isNaN(v) && Number.isFinite(Number(v));

function defaultIsRemake(m) {
    if (m.isRemake !== null && m.isRemake !== undefined) return !!m.isRemake;
    return (m.gameDuration || 0) < 300;
}

/** Solo/Duo games, remakes removed, oldest first. */
function soloGames(all, isRemake = defaultIsRemake) {
    return (all || [])
        .filter(m => m.queueId === SOLO_QUEUE && !isRemake(m))
        .sort((a, b) => a.gameCreation - b.gameCreation);
}

/** Every tab whose stats a computation will touch (for JSON prefetching). */
function tabsNeeded() {
    return [...new Set([...Object.values(Roles.STAT_INFO).map(s => s.tab), ...AREAS.map(a => a.tab)])];
}

/**
 * The fetched players' values (sample games, 2026-11), per group: their rows
 * in `roles` when the group has MIN_GROUP_GAMES of them there, else all of the
 * group's rows. Only rows that carry stats (stored after rows had them, or
 * filled in since). Same computeTabStats as your own numbers.
 * samples: { rows, groups } or null → [].
 */
const MIN_GROUP_GAMES = 5;
function sampleComparison(samples, tabs, computeTabStats, roles) {
    if (!samples || !Array.isArray(samples.rows) || !samples.rows.length) return [];
    const usable = samples.rows.filter(r => r.dmgShare != null && isNum(r.kills));
    const roleSet = new Set((roles || []).filter(r => r && r !== 'UNKNOWN'));
    return (samples.groups || []).map(g => {
        const inGroup = usable.filter(r => groupOf(r, samples.groups) === g.key);
        const inRole = inGroup.filter(r => roleSet.has(Roles.normRole(r.teamPosition)));
        const byRole = inRole.length >= MIN_GROUP_GAMES;
        const list = byRole ? inRole : inGroup;
        const cards = {};
        for (const tab of tabs) Object.assign(cards, cardsById(computeTabStats, tab, list));
        return { key: g.key, label: g.label, games: list.length, byRole, cards };
    }).filter(c => c.games > 0);
}

function groupValues(comparison, id) {
    return comparison.map(c => {
        const card = c.cards[id];
        const ok = card && isNum(card.value);
        return { key: c.key, label: c.label, games: c.games, byRole: c.byRole,
            value: ok ? card.value : null, display: ok ? card.displayValue : '—' };
    });
}

function cardsById(computeTabStats, tab, games, prev = []) {
    const out = {};
    if (!games.length) return out;
    for (const c of computeTabStats(tab, games, prev) || []) out[c.id] = c;
    return out;
}

// ── Rank header ────────────────────────────────────────────────────────────

/**
 * @param {object[]} games      solo games, oldest first
 * @param {object}   lpDeltas   matchId → LP change (from the LP tracker)
 */
function rankHeader(games, lpDeltas = {}) {
    const last = games.slice(-WINDOW);
    const wins = last.filter(g => g.win).length;
    let lp = 0, tracked = 0;
    for (const g of last) {
        const d = lpDeltas[g.matchId];
        if (isNum(d)) { lp += Number(d); tracked++; }
    }
    return {
        games: last.length,
        wins,
        losses: last.length - wins,
        lpChange: tracked ? lp : null,
        lpTracked: tracked,
    };
}

// ── Last-game report ───────────────────────────────────────────────────────

function verdict(value, baseline, higherIsBetter, tol) {
    if (!isNum(value) || !isNum(baseline)) return null;
    const diff = value - baseline;
    const allowed = tol + Math.abs(baseline) * 0.05;
    if (Math.abs(diff) <= allowed) return 'same';
    return (diff > 0) === !!higherIsBetter ? 'better' : 'worse';
}

/**
 * One game compared with the BASELINE games before it in the same role.
 * @param {object[]} games   solo games, oldest first
 * @param {number}   index   which game (games.length - 1 = most recent)
 * @param {object}   [opts]  { getBenchmark(statId) → general thresholds }
 */
function lastGameReport(games, index, computeTabStats, opts = {}) {
    if (!games.length) return null;
    const i = Math.max(0, Math.min(games.length - 1, index));
    const game = games[i];
    const role = Roles.normRole(game.teamPosition);
    const general = opts.getBenchmark
        || (typeof window !== 'undefined' && window.getStatBenchmark) || null;

    // "Usual" = the 20 earlier games in this role; too few → all roles
    const earlier = games.slice(0, i);
    const sameRole = role === 'UNKNOWN' ? [] : earlier.filter(g => Roles.normRole(g.teamPosition) === role);
    const byRole = sameRole.length >= MIN_ROLE_BASELINE;
    const baselineGames = (byRole ? sameRole : earlier).slice(-BASELINE);

    const ids = Roles.statsForRole(role);
    const tabs = [...new Set(ids.map(id => Roles.STAT_INFO[id].tab))];
    const gameCards = {}, baseCards = {};
    for (const tab of tabs) {
        Object.assign(gameCards, cardsById(computeTabStats, tab, [game]));
        Object.assign(baseCards, cardsById(computeTabStats, tab, baselineGames));
    }

    const comparison = opts.samples ? sampleComparison(opts.samples, tabs, computeTabStats, [role]) : null;

    const stats = ids.map(id => {
        const info = Roles.STAT_INFO[id];
        const g = gameCards[id], b = baseCards[id];
        if (!g || !isNum(g.value)) return null;   // not measurable for this game
        const tier = g.benchmarkable
            ? Roles.tierFor(g.value, Roles.benchmarkFor(id, role, general), g.higherIsBetter)
            : null;
        return {
            id,
            label: info.label,
            value: g.value,
            display: g.displayValue,
            baseline: b && isNum(b.value) ? b.value : null,
            baselineDisplay: b && isNum(b.value) ? b.displayValue : '—',
            higherIsBetter: g.higherIsBetter,
            verdict: baselineGames.length >= 5 ? verdict(g.value, b && b.value, g.higherIsBetter, info.tol) : null,
            tier,
            roleBenchmark: !!(Roles.ROLE_BENCHMARKS[role] && Roles.ROLE_BENCHMARKS[role][id]),
            color: tier ? RANK_COLORS[tier] : null,
            ...(comparison ? { groups: groupValues(comparison, id) } : {}),
        };
    }).filter(Boolean);

    return {
        index: i,
        total: games.length,
        game,
        role,
        baselineByRole: byRole,
        baselineCount: baselineGames.length,
        stats,
        better: stats.filter(s => s.verdict === 'better').length,
        worse:  stats.filter(s => s.verdict === 'worse').length,
        same:   stats.filter(s => s.verdict === 'same').length,
    };
}

// ── Focus: hit or missed, game by game ─────────────────────────────────────

function targetFor(metric, role) {
    if (!metric.target) return null;
    const t = metric.target[role];
    return t === undefined ? metric.target.default : t;
}

/**
 * @param {object[]} games   solo games, oldest first
 * @param {object}   engine  coachingEngine (METRICS + _internal.enrich)
 * @param {string}   metricId, role
 */
function focusHits(games, engine, metricId, role) {
    const metric = engine.METRICS.find(m => m.id === metricId);
    if (!metric) return null;
    const enriched = engine._internal.enrich(games);
    const target = targetFor(metric, role);

    const mark = r => {
        if (metric.skipRoles && metric.skipRoles.includes(r.teamPosition)) return null;
        const v = metric.value(r);
        if (!isNum(v) || target === null) return null;
        return metric.lowerIsBetter ? v <= target : v >= target;
    };

    const recent = enriched.slice(-WINDOW);
    const before = enriched.slice(-2 * WINDOW, -WINDOW);
    const rate = list => {
        const m = list.map(mark).filter(x => x !== null);
        return m.length ? { hit: m.filter(Boolean).length, of: m.length } : null;
    };

    return {
        target,
        dots: recent.map(r => ({
            matchId: r.matchId,
            met: mark(r),
            win: !!r.win,
            champion: r.championName,
            when: r.gameCreation,
            value: metric.value(r),
        })),
        recent: rate(recent),
        before: rate(before),
    };
}

// ── Trends by area ─────────────────────────────────────────────────────────

function areaVerdict(cards) {
    const judged = cards.filter(c => c.isImproving !== null && c.isImproving !== undefined);
    if (!judged.length) return 'steady';
    const up = judged.filter(c => c.isImproving).length;
    const down = judged.length - up;
    const score = (up - down) / cards.length;
    if (score >= 0.25) return 'improving';
    if (score <= -0.25) return 'slipping';
    return 'steady';
}

/** Relative size of a change, so CS and gold can be ranked together. */
function relChange(c, prev) {
    if (!isNum(c.value) || !isNum(prev)) return 0;
    return Math.abs(c.value - prev) / Math.max(Math.abs(prev), 1e-6);
}

/**
 * @param {object[]} games   solo games, oldest first
 * @param {number}   [sparkPoints]  how many rolling-10 points per sparkline
 */
/**
 * @param {object}   [opts]  { all: Set|array of area tabs to base on ALL games }
 *
 * Last-10 mode (default): last 10 games vs. the 10 before; sparkline = rolling
 * 10-game average over the last ~40 games.
 * All-games mode: every Solo/Duo game, the second half of them vs. the first
 * half; sparkline = rolling 20-game average across the whole history.
 */
function areaTrends(games, computeTabStats, sparkPoints = 30, opts = {}) {
    if (games.length < WINDOW) return [];
    const allSet = new Set(opts.all || []);

    return AREAS.map(area => {
        const all = allSet.has(area.tab);
        const t = all
            ? areaTrendAll(area, games, computeTabStats, sparkPoints)
            : areaTrendRecent(area, games, computeTabStats, sparkPoints);
        if (!opts.samples) return t;
        // The fetched players in the roles of the games this card is about
        const compared = all ? games : games.slice(-WINDOW);
        const roles = [...new Set(compared.map(g => Roles.normRole(g.teamPosition)))];
        return { ...t, groups: groupValues(sampleComparison(opts.samples, [area.tab], computeTabStats, roles), area.lead) };
    });
}

function areaTrendAll(area, games, computeTabStats, sparkPoints) {
    const half = Math.floor(games.length / 2);
    const before = games.slice(0, half);
    const after = games.slice(half);
    const all = cardsById(computeTabStats, area.tab, games);
    const first = cardsById(computeTabStats, area.tab, before);
    const second = cardsById(computeTabStats, area.tab, after);
    const cards = Object.values(cardsById(computeTabStats, area.tab, after, before))
        .filter(c => c.benchmarkable && c.aggregationType !== 'count' && isNum(c.value));

    const highlights = cards
        .filter(c => first[c.id] && isNum(first[c.id].value) && c.isImproving !== null)
        .map(c => ({
            id: c.id,
            label: c.label,
            now: second[c.id].displayValue,
            before: first[c.id].displayValue,
            improving: c.isImproving,
            size: relChange(c, first[c.id].value),
        }))
        .sort((a, b) => b.size - a.size)
        .slice(0, 3);

    // Rolling 20-game average, sampled evenly across the whole history
    const w = Math.min(2 * WINDOW, games.length);
    const ends = [];
    const span = games.length - w;
    const n = Math.min(sparkPoints, span + 1);
    for (let k = 0; k < n; k++) ends.push(w + Math.round(n === 1 ? span : (span * k) / (n - 1)));
    const spark = [...new Set(ends)].map(end => {
        const c = cardsById(computeTabStats, area.tab, games.slice(end - w, end))[area.lead];
        return c && isNum(c.value) ? c.value : null;
    });
    const leadCard = all[area.lead];

    return {
        tab: area.tab,
        mode: 'all',
        games: games.length,
        sparkWindow: w,
        verdict: before.length >= 5 ? areaVerdict(cards) : 'steady',
        improving: cards.filter(c => c.isImproving === true).length,
        slipping: cards.filter(c => c.isImproving === false).length,
        total: cards.length,
        highlights,
        lead: leadCard ? {
            id: area.lead,
            label: leadCard.label,
            display: leadCard.displayValue,
            higherIsBetter: leadCard.higherIsBetter,
            color: leadCard.benchmarkRank && leadCard.benchmarkRank !== 'unrated' ? leadCard.color : null,
        } : null,
        spark,
    };
}

function areaTrendRecent(area, games, computeTabStats, sparkPoints) {
    const recent = games.slice(-WINDOW);
    const before = games.slice(-2 * WINDOW, -WINDOW);
    {
        const now = cardsById(computeTabStats, area.tab, recent);
        const prev = cardsById(computeTabStats, area.tab, before);
        // Same rule as the stat history chart: only benchmarkable averages,
        // no counts — those are the cards whose trend means something.
        const cards = Object.values(cardsById(computeTabStats, area.tab, recent, before))
            .filter(c => c.benchmarkable && c.aggregationType !== 'count' && isNum(c.value));

        const highlights = cards
            .filter(c => prev[c.id] && isNum(prev[c.id].value) && c.isImproving !== null)
            .map(c => ({
                id: c.id,
                label: c.label,
                now: now[c.id].displayValue,
                before: prev[c.id].displayValue,
                improving: c.isImproving,
                size: relChange(c, prev[c.id].value),
            }))
            .sort((a, b) => b.size - a.size)
            .slice(0, 3);

        // Sparkline: rolling 10-game value of the lead stat
        const spark = [];
        const start = Math.max(WINDOW, games.length - sparkPoints + 1);
        for (let end = start; end <= games.length; end++) {
            const c = cardsById(computeTabStats, area.tab, games.slice(end - WINDOW, end))[area.lead];
            spark.push(c && isNum(c.value) ? c.value : null);
        }
        const leadCard = now[area.lead];

        return {
            tab: area.tab,
            mode: 'recent',
            games: recent.length,
            sparkWindow: WINDOW,
            verdict: before.length >= 5 ? areaVerdict(cards) : 'steady',
            improving: cards.filter(c => c.isImproving === true).length,
            slipping: cards.filter(c => c.isImproving === false).length,
            total: cards.length,
            highlights,
            lead: leadCard ? {
                id: area.lead,
                label: leadCard.label,
                display: leadCard.displayValue,
                higherIsBetter: leadCard.higherIsBetter,
                color: leadCard.benchmarkRank && leadCard.benchmarkRank !== 'unrated' ? leadCard.color : null,
            } : null,
            spark,
        };
    }
}

module.exports = {
    SOLO_QUEUE, WINDOW, BASELINE, REPORT_STATS, AREAS,
    soloGames, tabsNeeded, rankHeader, lastGameReport, focusHits, areaTrends,
    _internal: { verdict, areaVerdict, targetFor },
};
