/**
 * coachingBoard.js — the Coaching page's habit board (#61). Pure, tested.
 *
 * One ticket per habit the engine scores (coachingEngine METRICS, kind
 * 'input'), in four columns from worst to best: Slipping, Needs work,
 * Improving, On track. A ticket's column comes from how often you hit the
 * habit's target in your last 10 Solo/Duo games versus the 10 before, so
 * tickets move by themselves as you play.
 *
 * Each game is judged against the target for the role played in THAT game
 * (the old "Your focus" used your main role's target for every game).
 */

const WINDOW = 10;       // last 10 games vs. the 10 before
const ON_TRACK = 0.7;    // on target in at least 7 of 10
const MIN_GAMES = 5;     // fewer judged games than this: too early to place

const COLUMNS = [
    { id: 'slipping',  label: 'Slipping',   hint: 'was on track, now missing more often' },
    { id: 'needs',     label: 'Needs work', hint: 'below target and not getting better' },
    { id: 'improving', label: 'Improving',  hint: 'below target, but hitting it more often' },
    { id: 'ontrack',   label: 'On track',   hint: 'on target in 7 or more of the last 10' },
];

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/** The target for a habit in a role, or null when it has none. */
function targetFor(metric, role) {
    if (!metric.target) return null;
    const t = metric.target[role];
    return t === undefined ? metric.target.default : t;
}

/**
 * Hit (true), miss (false) or not judged (null) for one game: skipped roles
 * (support solo kills) and missing values aren't judged.
 */
function markGame(metric, game) {
    if (metric.skipRoles && metric.skipRoles.includes(game.teamPosition)) return null;
    const target = targetFor(metric, game.teamPosition);
    const v = metric.value(game);
    if (!isNum(v) || target === null || target === undefined) return null;
    return metric.lowerIsBetter ? v <= target : v >= target;
}

function rate(marks) {
    const judged = marks.filter(m => m !== null);
    return judged.length ? { hit: judged.filter(Boolean).length, of: judged.length } : null;
}

/**
 * The column for a habit, from its hits in the last 10 (`recent`) and the 10
 * before (`before`), each { hit, of } or null. null = too few games to place.
 */
function statusFor(recent, before) {
    if (!recent || recent.of < MIN_GAMES) return null;
    const r = recent.hit / recent.of;
    const b = before && before.of >= MIN_GAMES ? before.hit / before.of : null;
    if (r >= ON_TRACK) return 'ontrack';
    if (b !== null && b >= ON_TRACK) return 'slipping';
    if (b !== null && r > b) return 'improving';
    return 'needs';
}

/**
 * Per-game marks for one habit over the last 10 games, oldest first, for the
 * ticket detail's hit/miss dots.
 */
function habitDots(metric, enriched) {
    return enriched.slice(-WINDOW).map(g => ({
        matchId: g.matchId,
        met: markGame(metric, g),
        win: !!g.win,
        champion: g.championName,
        role: g.teamPosition,
        when: g.gameCreation,
        value: metric.value(g),
        target: targetFor(metric, g.teamPosition),
    }));
}

/**
 * The board.
 * @param {object[]} games   Solo/Duo games, oldest first
 * @param {object}   engine  coachingEngine (METRICS, _internal.enrich)
 * @param {object[]} inputs  engine.analyse(games).allInputs (win rate at stake, tips)
 * @returns {{ columns: Array<{id,label,hint,tickets}>, tooFew: object[], tickets: object[] }}
 */
function buildBoard(games, engine, inputs = []) {
    const enriched = engine._internal.enrich(games);
    const byId = new Map((inputs || []).map(i => [i.id, i]));
    const tickets = [];
    const tooFew = [];

    for (const metric of engine.METRICS) {
        // Circular habits (queueing after two losses) can't be worked on
        // directly, so they aren't tickets
        if (metric.kind !== 'input' || metric.excludeFromFocus) continue;
        const recent = rate(enriched.slice(-WINDOW).map(g => markGame(metric, g)));
        const before = rate(enriched.slice(-2 * WINDOW, -WINDOW).map(g => markGame(metric, g)));
        const info = byId.get(metric.id) || {};
        const ticket = {
            id: metric.id,
            label: metric.label,
            rule: metric.rule || '',
            unit: metric.unit || '',
            decimals: metric.decimals,
            binary: !!metric.binary,
            lowerIsBetter: !!metric.lowerIsBetter,
            recent, before,
            status: statusFor(recent, before),
            stake: isNum(info.recoverable) ? info.recoverable : 0,
            wrMet: isNum(info.wrMet) ? info.wrMet : null,
            wrMissed: isNum(info.wrMissed) ? info.wrMissed : null,
            confident: !!info.confident,
            sampleSize: info.sampleSize || 0,
        };
        (ticket.status ? tickets : tooFew).push(ticket);
    }

    const columns = COLUMNS.map(c => ({
        ...c,
        // Most win rate at stake first, then the lower hit rate
        tickets: tickets.filter(t => t.status === c.id).sort((a, b) =>
            (b.stake - a.stake) || ((a.recent.hit / a.recent.of) - (b.recent.hit / b.recent.of)) || a.label.localeCompare(b.label)),
    }));
    return { columns, tooFew, tickets };
}

/**
 * Tickets whose column changed since the statuses saved last visit:
 * { [id]: { from, to } }. Habits that are new or were too early aren't moves.
 */
function movesSince(saved, tickets) {
    const out = {};
    for (const t of tickets || []) {
        const from = saved && saved[t.id];
        if (from && t.status && from !== t.status) out[t.id] = { from, to: t.status };
    }
    return out;
}

/** { id: status } to save for next visit's moves. */
function statusMap(tickets) {
    return Object.fromEntries((tickets || []).filter(t => t.status).map(t => [t.id, t.status]));
}

const columnLabel = id => (COLUMNS.find(c => c.id === id) || {}).label || id;

module.exports = {
    WINDOW, ON_TRACK, MIN_GAMES, COLUMNS,
    targetFor, markGame, statusFor, habitDots, buildBoard, movesSince, statusMap, columnLabel,
};
