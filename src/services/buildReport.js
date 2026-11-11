/**
 * buildReport.js — Coaching's "Build and runes" for one game (sample games,
 * 2026-11). Pure, tested.
 *
 * Your finished items in that game with when you bought them against your
 * usual time on the champion, each item's and your rune page's number over
 * the pool (your other games + sample games, samplePool.js), what players at
 * your level and one above most often build and take, and at most one
 * "better option": an item that beats yours in the same slot beyond both luck
 * margins (only possible with the fitted curve: the window WPA has none).
 */

const { decodePurchases, buildOrderTable, buildPositions, STARTING_CUTOFF_MS } = require('./itemBuild');
const { itemTable, beatsBeyondMargin } = require('./itemWpa');
const { championDetail } = require('./championStats');
const { championPool } = require('./samplePool');
const winCurve = require('./winCurve');

const MIN_GAMES = 5;
const finals = m => [m.item0, m.item1, m.item2, m.item3, m.item4, m.item5];
const won = m => m.win === 1 || m.win === true;

function asGame(m) {
    const purchases = decodePurchases(m.itemPurchases);
    return { purchases, win: won(m), finalItems: finals(m), wpa: winCurve.purchaseWpa(purchases, m) };
}

/** First purchase time of each finished item after the opening shop, in order. */
function firstPurchases(purchases, isBuildItem) {
    const out = new Map();
    for (const p of purchases) {
        if (p.t > STARTING_CUTOFF_MS && isBuildItem(p.itemId) && !out.has(p.itemId)) out.set(p.itemId, p.t);
    }
    return out;
}

function topShare(values) {
    const counts = new Map();
    for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
    const [id, c] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
    return id == null ? null : { id, share: c / values.length };
}

function buildReport(game, myGames, sampleRows, groups, { isBuildItem = () => true, isExcluded = () => false } = {}) {
    const champ = game.championName;
    const others = (myGames || []).filter(m => m.matchId !== game.matchId);
    const pool = championPool(others, sampleRows, champ, { groups });
    const poolGames = pool.games.filter(m => m.itemPurchases).map(asGame);
    const opts = { isExcluded, isCompleted: isBuildItem };

    // Your items, with your usual time from your other games on the champion
    const mine = decodePurchases(game.itemPurchases);
    const myOthers = others.filter(m => m.championName === champ && m.itemPurchases)
        .map(m => firstPurchases(decodePurchases(m.itemPurchases), isBuildItem));
    const table = new Map(itemTable(poolGames, isBuildItem).map(r => [r.itemId, r]));
    const items = [...firstPurchases(mine, isBuildItem)].map(([itemId, t]) => {
        const times = myOthers.map(f => f.get(itemId)).filter(Number.isFinite);
        const row = table.get(itemId);
        const enough = row && row.wpaGames >= MIN_GAMES;
        return {
            itemId, t,
            usualT: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
            wpa: enough ? row.wpa : null, margin: enough ? row.margin : null, games: row ? row.wpaGames : 0,
        };
    });

    // Your rune page's number over the pool
    const page = championDetail(pool.games, champ).runes
        .find(r => r.keystone === game.primaryRune && r.secondary === (game.secondaryRuneStyle || 0));
    const rune = {
        keystone: game.primaryRune || null, secondary: game.secondaryRuneStyle || null,
        edge: page && page.games >= MIN_GAMES ? page.edge : null,
        edgeMargin: page && page.games >= MIN_GAMES ? page.edgeMargin : null,
    };

    // What each group builds and takes
    const groupRows = (groups || []).map(g => {
        const rows = pool.games.filter(r => r.sample === g.key);
        const t = buildOrderTable(rows.filter(r => r.itemPurchases).map(asGame), opts);
        return {
            key: g.key, label: g.label,
            players: new Set(rows.map(r => r.puuid).filter(Boolean)).size,
            games: rows.length,
            core: [0, 1, 2].map(i => (t.core[i][0] ? { itemId: Number(t.core[i][0].key), share: t.core[i][0].pickRate } : null)),
            keystone: topShare(rows.map(r => r.primaryRune)),
        };
    });

    // At most one better option: the largest gap beyond both margins
    const yourCore = buildPositions(mine, finals(game), opts).core;
    const all = buildOrderTable(poolGames, opts);
    let better = null;
    yourCore.slice(0, 3).forEach((id, slot) => {
        const rows = all.core[slot] || [];
        const yours = rows.find(r => r.key === id);
        if (!yours || yours.wpaGames < MIN_GAMES) return;
        for (const r of rows) {
            if (r.key === id || r.wpaGames < MIN_GAMES || !beatsBeyondMargin(r, yours)) continue;
            const gap = r.wpa - yours.wpa;
            if (!better || gap > better.gap) better = { itemId: Number(r.key), insteadOf: id, slot, gap };
        }
    });

    return {
        items, rune, groups: groupRows, better, yourCore: yourCore.slice(0, 3),
        noSamples: pool.counts.level + pool.counts.above === 0,
    };
}

module.exports = { buildReport };
