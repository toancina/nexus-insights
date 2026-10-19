/**
 * itemBuild.js — what you bought and when, from the timeline (#7).
 *
 * Pure. The sync stores your purchases per game as a short string
 * (`itemPurchases`, "itemId:seconds,…" after undos), so build-order stats and
 * the "Bought at" tooltips never re-parse timelines. What counts as a
 * finished item is passed in (Data Dragon decides), keeping this testable.
 *
 * Positions, as in the issue:
 *   start      bought in the first 60 s (the opening shop)
 *   firstBack  everything bought within 60 s of the first purchase after it
 *   core       finished items bought after the opening shop that you still
 *              held at the end, in purchase order: 1st, 2nd, 3rd item…
 */

const STARTING_CUTOFF_MS   = 60000;
const FIRST_BACK_WINDOW_MS = 60000;
const MIN_PICK_RATE        = 0.05;    // rarer items are left out of the tables

function framesOf(timeline) {
    return (timeline && timeline.info ? timeline.info.frames : timeline && timeline.frames) || [];
}

/**
 * Your purchases, oldest first. An ITEM_UNDO of a purchase (beforeId set,
 * afterId 0) removes that item's latest purchase; undoing a sale changes
 * nothing here.
 */
function purchasesFromTimeline(timeline, participantId) {
    const out = [];
    const events = framesOf(timeline).flatMap(f => f.events || [])
        .filter(e => e.participantId === participantId)
        .sort((a, b) => a.timestamp - b.timestamp);
    for (const e of events) {
        if (e.type === 'ITEM_PURCHASED' && e.itemId > 0) {
            out.push({ itemId: e.itemId, t: e.timestamp });
        } else if (e.type === 'ITEM_UNDO' && e.beforeId > 0 && !e.afterId) {
            for (let i = out.length - 1; i >= 0; i--) {
                if (out[i].itemId === e.beforeId) { out.splice(i, 1); break; }
            }
        }
    }
    return out;
}

/** [{itemId, t}] → "3340:1,1055:2,…" (seconds); '' for none. */
function encodePurchases(list) {
    return (list || []).map(p => `${p.itemId}:${Math.round(p.t / 1000)}`).join(',');
}

function decodePurchases(text) {
    if (!text) return [];
    return String(text).split(',').map(s => {
        const [id, sec] = s.split(':').map(Number);
        return { itemId: id, t: sec * 1000 };
    }).filter(p => p.itemId > 0 && Number.isFinite(p.t));
}

/** itemId → when you last bought it (for "Bought at" in tooltips). */
function lastBoughtAt(purchases) {
    const at = new Map();
    for (const p of purchases) at.set(p.itemId, p.t);
    return at;
}

/** When you first went back to buy: the first purchase after the opening shop. */
function firstBackAt(purchases) {
    const p = purchases.find(x => x.t > STARTING_CUTOFF_MS);
    return p ? p.t : null;
}

/**
 * @param {Array}  purchases   decoded, oldest first
 * @param {Array}  finalItems  item ids held at the end (item0–item5)
 * @param {object} opts  { isExcluded(id) trinkets/consumables, isCompleted(id) finished items }
 */
function buildPositions(purchases, finalItems = [], { isExcluded = () => false, isCompleted = () => true } = {}) {
    const kept = purchases.filter(p => !isExcluded(p.itemId));
    const start = kept.filter(p => p.t <= STARTING_CUTOFF_MS).map(p => p.itemId);
    const after = kept.filter(p => p.t > STARTING_CUTOFF_MS);

    let firstBack = null;
    if (after.length) {
        const end = after[0].t + FIRST_BACK_WINDOW_MS;
        firstBack = { t: after[0].t, items: after.filter(p => p.t <= end).map(p => p.itemId) };
    }

    const held = new Set(finalItems.filter(id => id > 0));
    const core = [];
    for (const p of after) {
        if (held.has(p.itemId) && isCompleted(p.itemId) && !core.includes(p.itemId)) core.push(p.itemId);
    }
    return { start, firstBack, core };
}

/**
 * Rows of games / wins / win rate / pick rate per key. With `valueOf(game, key)`
 * each row also averages that number (WPA, #89) over the games that have one.
 */
function rateRows(games, keysOf, valueOf = null) {
    const counts = new Map();
    let withData = 0;
    for (const g of games) {
        const keys = [...new Set(keysOf(g))];
        if (!keys.length) continue;
        withData++;
        for (const k of keys) {
            const c = counts.get(k) || { key: k, games: 0, wins: 0, wpaSum: 0, wpaGames: 0 };
            c.games++;
            if (g.win) c.wins++;
            const v = valueOf ? valueOf(g, k) : null;
            if (Number.isFinite(v)) { c.wpaSum += v; c.wpaGames++; }
            counts.set(k, c);
        }
    }
    return [...counts.values()]
        .map(({ wpaSum, ...c }) => ({
            ...c, winRate: c.wins / c.games, pickRate: withData ? c.games / withData : 0,
            wpa: c.wpaGames ? wpaSum / c.wpaGames : null,
        }))
        .filter(c => c.pickRate >= MIN_PICK_RATE)
        .sort((a, b) => b.games - a.games);
}

/**
 * Build-order table for a set of games (usually one champion).
 * @param {Array<{purchases, finalItems, win, wpa?}>} games  only games that have purchases;
 *        `wpa` (itemWpa.js, aligned with purchases) adds an average WPA to every row
 * @returns {{ start, firstBack, core: [rows for 1st, 2nd, 3rd item] }}
 *          start rows are item combinations: key "1055+2003"
 */
function buildOrderTable(games, opts = {}) {
    const positions = games.map(g => ({ win: g.win, wpa: g.wpa || [], pos: buildPositions(g.purchases, g.finalItems, opts) }));
    // WPA of the opening shop: its first purchase. Of an item later on: its
    // first purchase after the opening shop, the one the row is about.
    const firstWpa = (g, test) => { const w = g.wpa.find(e => e && test(e)); return w ? w.wpa : null; };
    const startWpa = g => firstWpa(g, e => e.t <= STARTING_CUTOFF_MS);
    const itemWpaOf = (g, id) => firstWpa(g, e => e.itemId === id && e.t > STARTING_CUTOFF_MS);
    return {
        start: rateRows(positions, g => (g.pos.start.length ? [[...g.pos.start].sort((a, b) => a - b).join('+')] : []), startWpa),
        firstBack: rateRows(positions, g => (g.pos.firstBack ? g.pos.firstBack.items : []), itemWpaOf),
        core: [0, 1, 2].map(i => rateRows(positions, g => (g.pos.core[i] ? [g.pos.core[i]] : []), itemWpaOf)),
    };
}

/** Median first back, and win rate when you backed earlier vs later than it. */
function firstBackStats(games) {
    const backs = games.filter(g => Number.isFinite(g.firstBackAt));
    if (!backs.length) return { medianMs: null, games: 0, faster: null, slower: null };
    const sorted = backs.map(g => g.firstBackAt).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const seg = list => (list.length ? { games: list.length, wins: list.filter(g => g.win).length,
                                         winRate: list.filter(g => g.win).length / list.length } : null);
    return {
        medianMs, games: backs.length,
        faster: seg(backs.filter(g => g.firstBackAt < medianMs)),
        slower: seg(backs.filter(g => g.firstBackAt >= medianMs)),
    };
}

module.exports = {
    STARTING_CUTOFF_MS, FIRST_BACK_WINDOW_MS, MIN_PICK_RATE,
    purchasesFromTimeline, encodePurchases, decodePurchases, lastBoughtAt, firstBackAt,
    buildPositions, buildOrderTable, firstBackStats,
};
