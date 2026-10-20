/**
 * winChanceStats.js — the win-chance curve put into numbers the Chat page can
 * quote. Pure.
 *
 * One game: the curve minute by minute, its peak and low, and the biggest
 * swings (the largest moves within SWING_WINDOW frames, at least SWING_MIN
 * points, not overlapping). Many games: throws, comebacks, the average at
 * 10/15/20 min, and how often you win from ahead / even / behind at 15.
 *
 * Input is [{t, p}] in percent, as itemWpa.winChancePoints makes from the
 * stored `winChance` column. The curve is matchTimeline's estimate (#3).
 */

const { chanceAt } = require('./itemWpa');

const SWING_MIN     = 10;   // points
const SWING_WINDOW  = 3;    // frames (minutes)
const MAX_SWINGS    = 3;
const THROW_PEAK    = 70;   // lost after being at least this likely to win
const COMEBACK_LOW  = 30;   // won after being at most this likely to win
const AHEAD_AT_15   = 60;
const BEHIND_AT_15  = 40;
const CHECKPOINTS   = [10, 15, 20];
const MINUTE        = 60000;

function extremes(points) {
    let peak = points[0], low = points[0];
    for (const p of points) {
        if (p.p > peak.p) peak = p;
        if (p.p < low.p) low = p;
    }
    return { peak, low };
}

/**
 * The biggest moves, oldest first: [{ fromT, toT, from, to, change }].
 * Windows may share an end frame but not overlap.
 */
function swings(points) {
    const candidates = [];
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j <= Math.min(points.length - 1, i + SWING_WINDOW); j++) {
            const change = points[j].p - points[i].p;
            if (Math.abs(change) >= SWING_MIN) candidates.push({ i, j, change });
        }
    }
    candidates.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || (a.j - a.i) - (b.j - b.i) || a.i - b.i);
    const chosen = [];
    for (const c of candidates) {
        if (chosen.length >= MAX_SWINGS) break;
        if (chosen.some(s => c.i < s.j && s.i < c.j)) continue;
        chosen.push(c);
    }
    return chosen.sort((a, b) => a.i - b.i).map(c => ({
        fromT: points[c.i].t, toT: points[c.j].t,
        from: points[c.i].p, to: points[c.j].p, change: c.change,
    }));
}

/**
 * One game's curve: { byMinute: [{minute, p}], end, peak, low, swings },
 * or null with fewer than two points. The last frame is the game's end, so
 * it is `end` rather than a minute.
 */
function curveSummary(points) {
    if (!points || points.length < 2) return null;
    const last = points[points.length - 1];
    const { peak, low } = extremes(points);
    return {
        byMinute: points.slice(0, -1).map(p => ({ minute: Math.round(p.t / MINUTE), p: p.p })),
        end: last,
        peak, low,
        swings: swings(points),
    };
}

/** Win chance at `minute`, or null when the game ended before it. */
function chanceAtMinute(points, minute) {
    const t = minute * MINUTE;
    return points.length && points[points.length - 1].t >= t ? chanceAt(points, t) : null;
}

/**
 * @param {Array<{win: boolean, points: Array}>} games  newest first; other
 *        fields are kept, so the caller can name the examples
 * @returns {{ games, average: {10, 15, 20}, at15: {ahead, even, behind}, throws: [], comebacks: [] }}
 *          averages in percent (null with no game that long); at15 rows are
 *          { games, wins }; throws/comebacks are the input games, with
 *          `peak` / `low` added
 */
function winChanceStats(games) {
    const withCurve = games.filter(g => g.points && g.points.length >= 2);
    const average = {};
    for (const minute of CHECKPOINTS) {
        const values = withCurve.map(g => chanceAtMinute(g.points, minute)).filter(Number.isFinite);
        average[minute] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    }

    const at15 = { ahead: { games: 0, wins: 0 }, even: { games: 0, wins: 0 }, behind: { games: 0, wins: 0 } };
    const throws = [], comebacks = [];
    for (const g of withCurve) {
        const p15 = chanceAtMinute(g.points, 15);
        if (Number.isFinite(p15)) {
            const row = at15[p15 >= AHEAD_AT_15 ? 'ahead' : p15 <= BEHIND_AT_15 ? 'behind' : 'even'];
            row.games++;
            if (g.win) row.wins++;
        }
        const { peak, low } = extremes(g.points);
        if (!g.win && peak.p >= THROW_PEAK) throws.push({ ...g, peak });
        if (g.win && low.p <= COMEBACK_LOW) comebacks.push({ ...g, low });
    }
    return { games: withCurve.length, average, at15, throws, comebacks };
}

module.exports = {
    SWING_MIN, SWING_WINDOW, THROW_PEAK, COMEBACK_LOW, AHEAD_AT_15, BEHIND_AT_15,
    curveSummary, swings, chanceAtMinute, winChanceStats,
};
