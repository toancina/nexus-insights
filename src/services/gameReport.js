/**
 * gameReport.js — the report on one game in its expanded row (#9). Pure.
 *
 * 1. A table of 9 stats for this game against your season, this patch and
 *    the 7 days before it, in the same queue and role. Every value comes
 *    from computeTabStats (passed in), so it can't disagree with the
 *    Analytics cards. ±10% colours a cell; for deaths lower is better.
 * 2. "Went well" / "went wrong": the biggest differences from your season.
 * 3. "Blunders" from the timeline: an early death, deaths to the same
 *    champion, two deaths close together, deaths while your team was
 *    ahead, and the death that cost the most win chance.
 * At most three points per section.
 */

const { rosterOf, formatClock } = require('./matchTimeline');
const winCurve = require('./winCurve');

const REPORT_STATS = [
    { tab: 'Overview',     id: 'avg_kda',       label: 'KDA' },
    { tab: 'Overview',     id: 'avg_kp',        label: 'Kill participation' },
    { tab: 'Overview',     id: 'avg_csm',       label: 'CS/min' },
    { tab: 'Overview',     id: 'dmg_min',       label: 'Damage/min' },
    { tab: 'Economy',      id: 'eco_gold_min',  label: 'Gold/min' },
    { tab: 'Vision',       id: 'vis_vs_min',    label: 'Vision/min' },
    { tab: 'Death Review', id: 'dr_avg_deaths', label: 'Deaths' },
    // Differences can sit near 0, so ±10% is measured against at least this
    { tab: 'Lane Phase',   id: 'gd_15',         label: 'GD@15',  floor: 1000 },
    { tab: 'Lane Phase',   id: 'csd_15',        label: 'CSD@15', floor: 10 },
];
const THRESHOLD = 0.10;
const MIN_POOL = 3;           // fewer games to compare with isn't an average
const MAX_POINTS = 3;
const DAY = 86400000;

/** The games to compare against: same queue and role, never the game itself. */
function comparisonPools(game, all) {
    const same = all.filter(m => m.matchId !== game.matchId && m.queueId === game.queueId &&
        (m.teamPosition || '') === (game.teamPosition || ''));
    return {
        season: same,
        patch: game.patch ? same.filter(m => m.patch === game.patch) : [],
        week: same.filter(m => m.gameCreation < game.gameCreation && m.gameCreation >= game.gameCreation - 7 * DAY),
    };
}

function cardsFor(computeTabStats, list) {
    const byTab = new Map();
    const out = new Map();
    for (const s of REPORT_STATS) {
        if (!byTab.has(s.tab)) byTab.set(s.tab, list.length ? computeTabStats(s.tab, list, []) || [] : []);
        const card = byTab.get(s.tab).find(c => c.id === s.id);
        if (card) out.set(s.id, card);
    }
    return out;
}

/** 'good' / 'bad' / 'even': this game against a baseline, ±10%. */
function verdict(value, baseline, higherIsBetter, floor = 0) {
    if (!Number.isFinite(value) || !Number.isFinite(baseline)) return null;
    const rel = (value - baseline) / Math.max(Math.abs(baseline), floor, 1e-9);
    if (Math.abs(rel) < THRESHOLD) return 'even';
    return (rel > 0) === higherIsBetter ? 'good' : 'bad';
}

/**
 * @param {object}   game             the light match row
 * @param {Array}    all              every game (remakes out)
 * @param {Function} computeTabStats  window.computeTabStats
 */
function compareGame(game, all, computeTabStats) {
    const pools = comparisonPools(game, all);
    const mine = cardsFor(computeTabStats, [game]);
    const base = Object.fromEntries(Object.entries(pools).map(([k, list]) =>
        [k, { games: list.length, cards: list.length >= MIN_POOL ? cardsFor(computeTabStats, list) : new Map() }]));

    const rows = REPORT_STATS.filter(s => mine.has(s.id)).map(s => {
        const c = mine.get(s.id);
        const col = key => {
            const b = base[key].cards.get(s.id);
            return b ? { value: b.value, display: b.displayValue, verdict: verdict(c.value, b.value, c.higherIsBetter, s.floor) } : null;
        };
        return {
            id: s.id, label: s.label, higherIsBetter: c.higherIsBetter, floor: s.floor || 0,
            game: { value: c.value, display: c.displayValue },
            season: col('season'), patch: col('patch'), week: col('week'),
        };
    });
    return { rows, games: { season: pools.season.length, patch: pools.patch.length, week: pools.week.length } };
}

/** The biggest differences from your season average, best/worst first. */
function highlights(rows) {
    const scored = rows.filter(r => r.season && r.season.verdict && r.season.verdict !== 'even').map(r => {
        const diff = r.game.value - r.season.value;
        const rel = diff / Math.max(Math.abs(r.season.value), r.floor, 1e-9);
        const pctText = r.floor ? `season ${r.season.display}` : `${rel > 0 ? '+' : '−'}${Math.round(Math.abs(rel) * 100)}% vs your season average`;
        return { verdict: r.season.verdict, size: Math.abs(rel), text: `${r.game.display} ${r.label}, ${pctText}` };
    }).sort((a, b) => b.size - a.size);
    return {
        good: scored.filter(s => s.verdict === 'good').slice(0, MAX_POINTS).map(s => s.text),
        bad: scored.filter(s => s.verdict === 'bad').slice(0, MAX_POINTS).map(s => s.text),
    };
}

const WORDS = ['', 'once', 'twice', 'three times', 'four times', 'five times'];
const times = n => WORDS[n] || `${n} times`;

/**
 * Event-based mistakes for one player, most telling first.
 * @returns {string[]} at most three
 */
function blunders(raw, timeline, participantId, teamId) {
    const roster = rosterOf(raw);
    const frames = (timeline && timeline.info ? timeline.info.frames : timeline && timeline.frames) || [];
    const deaths = frames.flatMap(f => f.events || [])
        .filter(e => e.type === 'CHAMPION_KILL' && e.victimId === participantId)
        .sort((a, b) => a.timestamp - b.timestamp);
    if (!deaths.length) return [];

    const out = [];
    const early = deaths.find(d => d.timestamp < 3 * 60000);
    if (early) out.push(`Died in the first 3 minutes (${formatClock(early.timestamp)})`);

    const byKiller = new Map();
    for (const d of deaths) if (roster[d.killerId]) byKiller.set(d.killerId, (byKiller.get(d.killerId) || 0) + 1);
    const [killer, count] = [...byKiller].sort((a, b) => b[1] - a[1])[0] || [];
    if (count >= 3) out.push(`Died to ${roster[killer].championName} ${times(count)}`);

    const pairs = deaths.slice(1).filter((d, i) => d.timestamp - deaths[i].timestamp <= 3 * 60000);
    if (pairs.length === 1) out.push(`Died twice within 3 minutes around ${formatClock(pairs[0].timestamp)}`);
    else if (pairs.length > 1) out.push(`Died twice within 3 minutes ${times(pairs.length)} (first around ${formatClock(pairs[0].timestamp)})`);

    // Win chance before / after each death, from the timeline's team series
    const series = winCurve.seriesFor(raw, timeline, teamId);
    if (series.length > 1) {
        const before = t => [...series].reverse().find(p => p.t <= t) || series[0];
        const after = t => series.find(p => p.t >= t + 60000) || series[series.length - 1];
        const ahead = deaths.filter(d => before(d.timestamp).winProb >= 0.6);
        if (ahead.length) out.push(`${ahead.length} death${ahead.length === 1 ? '' : 's'} while your team was ahead (win chance 60%+)`);

        const swing = deaths
            .map(d => ({ d, drop: before(d.timestamp).winProb - after(d.timestamp).winProb, from: before(d.timestamp).winProb, to: after(d.timestamp).winProb }))
            .sort((a, b) => b.drop - a.drop)[0];
        if (swing && swing.drop >= 0.1) {
            out.push(`The death at ${formatClock(swing.d.timestamp)} cost the most: win chance ${Math.round(swing.from * 100)}% → ${Math.round(swing.to * 100)}%`);
        }
    }
    return out.slice(0, MAX_POINTS);
}

module.exports = { REPORT_STATS, THRESHOLD, MIN_POOL, comparisonPools, verdict, compareGame, highlights, blunders };
