/**
 * itemWpa.js — win probability added (WPA) for item purchases (#89). Pure.
 *
 * WPA of a purchase = your team's estimated win chance at the end of its
 * window minus at the purchase, in percentage points. The window runs to your
 * next trip to the shop (your first purchase at least TRIP_GAP_MS later), at
 * most WINDOW_CAP_MS, and stops at the last timeline frame. So everything you
 * buy on one trip shares an end, and items bought late don't just measure
 * whether you won.
 *
 * The win chance is matchTimeline's estimate (#3). Stored rows carry it in the
 * `winChance` column, one whole percentage per timeline frame; expanded rows
 * compute it from the full timeline. It describes what happened while you had
 * the item, not what the item caused.
 */

const { STARTING_CUTOFF_MS, FIRST_BACK_WINDOW_MS, encodePurchases, decodePurchases } = require('./itemBuild');

const TRIP_GAP_MS   = FIRST_BACK_WINDOW_MS;   // same 60 s the "First back" row uses
const WINDOW_CAP_MS = 5 * 60 * 1000;
const FRAME_MS      = 60 * 1000;

/** teamSeries output → "50,52,49" (whole %); '' for none. */
function encodeWinChance(series) {
    return (series || []).map(s => Math.round(s.winProb * 100)).join(',');
}

/** "50,52,49" → [50, 52, 49]; [] if empty or any value isn't a whole 0–100. */
function decodeWinChance(text) {
    if (!text) return [];
    const parts = String(text).split(',');
    if (!parts.every(s => /^\d{1,3}$/.test(s) && Number(s) <= 100)) return [];
    return parts.map(Number);
}

/**
 * Stored win chance → [{t, p}]. Frame i is at i minutes, except the last,
 * which Riot puts at the game's end (clamped to its minute).
 */
function winChancePoints(text, gameDurationSec) {
    const values = decodeWinChance(text);
    const n = values.length;
    return values.map((p, i) => {
        let t = i * FRAME_MS;
        if (i === n - 1 && n > 1 && Number.isFinite(gameDurationSec)) {
            t = Math.min(i * FRAME_MS, Math.max((i - 1) * FRAME_MS, gameDurationSec * 1000));
        }
        return { t, p };
    });
}

/** A full teamSeries (expanded rows) → [{t, p}] in percent. */
function seriesPoints(series) {
    return (series || []).map(s => ({ t: s.t, p: s.winProb * 100 }));
}

/**
 * Full-timeline purchases and win chance, rounded the way the stored columns
 * are (seconds, whole %), so an expanded row's tooltip gives the same numbers
 * as the match row's for the same game.
 */
function asStored(purchases, series, gameDurationSec) {
    return {
        purchases: decodePurchases(encodePurchases(purchases)),
        points: winChancePoints(encodeWinChance(series), gameDurationSec),
    };
}

/** Win chance (%) at `t`, linear between frames, held at both ends; null with no points. */
function chanceAt(points, t) {
    if (!points || !points.length) return null;
    if (t <= points[0].t) return points[0].p;
    const last = points[points.length - 1];
    if (t >= last.t) return last.p;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (t <= b.t) return b.t === a.t ? b.p : a.p + (b.p - a.p) * (t - a.t) / (b.t - a.t);
    }
    return last.p;
}

/**
 * WPA for every purchase (oldest first), aligned with `purchases`:
 * { itemId, t, from, to, wpa } in percent, or null for all when there's no
 * win chance. Each purchase counts on its own, repeats included.
 */
function itemWpa(purchases, points) {
    const list = purchases || [];
    if (!points || !points.length) return list.map(() => null);
    const lastT = points[points.length - 1].t;
    return list.map(p => {
        const next = list.find(q => q.t - p.t >= TRIP_GAP_MS);
        const end = Math.max(p.t, Math.min(next ? next.t : Infinity, p.t + WINDOW_CAP_MS, lastT));
        const from = chanceAt(points, p.t);
        const to = chanceAt(points, end);
        return { itemId: p.itemId, t: p.t, from, to, wpa: to - from };
    });
}

/** itemId → { from, to } (whole %) of its last purchase, for tooltips like "Bought at". */
function lastPurchaseWpa(purchases, points) {
    const out = new Map();
    for (const w of itemWpa(purchases, points)) {
        if (w) out.set(w.itemId, { from: Math.round(w.from), to: Math.round(w.to) });
    }
    return out;
}

/**
 * One row per item over many games (Chat): games it was bought in, wins, pick
 * rate, when it was bought and its average WPA, from each game's first
 * purchase of it after the opening shop, the purchase the Build order card's
 * rows use. Most-bought first.
 * @param {Array<{purchases, wpa, win}>} games  wpa aligned with purchases (itemWpa)
 * @param {Function} isCounted  itemId → whether it gets a row (finished items)
 */
function itemTable(games, isCounted = () => true) {
    const rows = new Map();
    for (const g of games) {
        const seen = new Set();
        (g.purchases || []).forEach((p, i) => {
            if (p.t <= STARTING_CUTOFF_MS || seen.has(p.itemId) || !isCounted(p.itemId)) return;
            seen.add(p.itemId);
            const r = rows.get(p.itemId) || { itemId: p.itemId, games: 0, wins: 0, tSum: 0, wpaSum: 0, wpaGames: 0 };
            r.games++;
            if (g.win) r.wins++;
            r.tSum += p.t;
            const w = g.wpa && g.wpa[i];
            if (w) { r.wpaSum += w.wpa; r.wpaGames++; }
            rows.set(p.itemId, r);
        });
    }
    return [...rows.values()].map(({ tSum, wpaSum, ...r }) => ({
        ...r, winRate: r.wins / r.games, pickRate: games.length ? r.games / games.length : 0,
        avgT: tSum / r.games, wpa: r.wpaGames ? wpaSum / r.wpaGames : null,
    })).sort((a, b) => b.games - a.games);
}

/** An average WPA for display: "+3.1", "\u22120.3", "0.0" (sign from the rounded value). */
function formatWpa(value) {
    const v = Math.round(value * 10) / 10;
    return `${v > 0 ? '+' : v < 0 ? '\u2212' : ''}${Math.abs(v).toFixed(1)}`;
}

/** Tooltip line: "Win chance 46% → 58% (+12) until your next trip to the shop". */
function wpaLine(from, to) {
    const d = to - from;
    const change = d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0';
    return `Win chance ${from}% → ${to}% (${change}) until your next trip to the shop`;
}

module.exports = {
    TRIP_GAP_MS, WINDOW_CAP_MS,
    encodeWinChance, decodeWinChance, winChancePoints, seriesPoints, asStored, chanceAt,
    itemWpa, lastPurchaseWpa, itemTable, formatWpa, wpaLine,
};
