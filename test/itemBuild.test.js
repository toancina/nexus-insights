/**
 * Issue #7: item purchases from the timeline, build positions, first back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const B = require(path.join(SRC, 'services', 'itemBuild.js'));

const S = 1000;
const ev = (type, t, extra) => ({ type, timestamp: t, participantId: 1, ...extra });
const tl = (events) => ({ info: { frames: [{ events: events.slice(0, 2) }, { events: events.slice(2) }] } });

test('purchases: oldest first, only yours, undo removes the undone buy', () => {
    const purchases = B.purchasesFromTimeline(tl([
        ev('ITEM_PURCHASED', 2 * S, { itemId: 1055 }),
        ev('ITEM_PURCHASED', 3 * S, { itemId: 2003 }),
        ev('ITEM_PURCHASED', 4 * S, { itemId: 1036 }),
        ev('ITEM_UNDO', 5 * S, { beforeId: 1036, afterId: 0 }),        // changed their mind
        { type: 'ITEM_PURCHASED', timestamp: 6 * S, participantId: 7, itemId: 3031 }, // someone else
        ev('ITEM_SOLD', 400 * S, { itemId: 1055 }),
        ev('ITEM_UNDO', 401 * S, { beforeId: 0, afterId: 1055 }),       // undid the sale: no buy
        ev('ITEM_PURCHASED', 380 * S, { itemId: 3031 }),
    ]), 1);
    assert.deepEqual(purchases.map(p => [p.itemId, p.t / S]), [[1055, 2], [2003, 3], [3031, 380]]);
});

test('encode/decode round-trips in whole seconds', () => {
    const list = [{ itemId: 1055, t: 2400 }, { itemId: 6672, t: 812345 }];
    assert.equal(B.encodePurchases(list), '1055:2,6672:812');
    assert.deepEqual(B.decodePurchases('1055:2,6672:812'), [{ itemId: 1055, t: 2000 }, { itemId: 6672, t: 812000 }]);
    assert.deepEqual(B.decodePurchases(''), []);
    assert.equal(B.encodePurchases([]), '');
});

test('lastBoughtAt and firstBackAt', () => {
    const p = [{ itemId: 2003, t: 3 * S }, { itemId: 1055, t: 4 * S }, { itemId: 2003, t: 300 * S }, { itemId: 3006, t: 420 * S }];
    assert.equal(B.lastBoughtAt(p).get(2003), 300 * S);
    assert.equal(B.firstBackAt(p), 300 * S);
    assert.equal(B.firstBackAt(p.slice(0, 2)), null, 'never went back');
});

test('build positions: start, first back window, finished items you kept, in order', () => {
    const purchases = [
        { itemId: 1055, t: 5 * S }, { itemId: 2003, t: 6 * S }, { itemId: 3340, t: 7 * S },   // start
        { itemId: 1036, t: 370 * S }, { itemId: 1001, t: 400 * S },                           // first back (≤ 60 s apart)
        { itemId: 6672, t: 820 * S },                                                          // 1st item
        { itemId: 3006, t: 900 * S },                                                          // boots
        { itemId: 3031, t: 1300 * S },                                                         // 2nd item
        { itemId: 3086, t: 1500 * S },                                                         // sold later, not held
        { itemId: 3036, t: 1700 * S },                                                         // 3rd item
    ];
    const pos = B.buildPositions(purchases, [6672, 3006, 3031, 3036, 0, 0], {
        isExcluded: id => id === 2003 || id === 3340,            // potion, trinket
        isCompleted: id => [6672, 3006, 3031, 3086, 3036].includes(id),
    });
    assert.deepEqual(pos.start, [1055]);
    assert.deepEqual(pos.firstBack, { t: 370 * S, items: [1036, 1001] });
    assert.deepEqual(pos.core, [6672, 3006, 3031, 3036]);
});

test('a finished item bought on the first back still counts as the 1st item', () => {
    const pos = B.buildPositions([{ itemId: 1055, t: 5 * S }, { itemId: 6672, t: 600 * S }], [6672]);
    assert.deepEqual(pos.firstBack.items, [6672]);
    assert.deepEqual(pos.core, [6672]);
});

test('build-order table: combos for start, pick/win rates, rare picks hidden', () => {
    const game = (win, start, core) => ({
        win, finalItems: core,
        purchases: [...start.map((id, i) => ({ itemId: id, t: (i + 1) * S })),
                    ...core.map((id, i) => ({ itemId: id, t: (600 + i * 300) * S }))],
    });
    const games = [];
    for (let i = 0; i < 19; i++) games.push(game(i < 12, [1055, 2003], i < 14 ? [6672, 3031] : [3031, 6672]));
    games.push(game(false, [1083], [3153]));                 // 1 of 20 = 5%: kept
    const t = B.buildOrderTable(games);

    assert.deepEqual(t.start.map(r => [r.key, r.games]), [['1055+2003', 19], ['1083', 1]]);
    assert.deepEqual(t.core[0].map(r => [r.key, r.games, r.wins]), [[6672, 14, 12], [3031, 5, 0], [3153, 1, 0]]);
    assert.equal(t.core[0][0].pickRate, 14 / 20);
    assert.equal(t.core[1][0].key, 3031);

    games.push(...Array.from({ length: 10 }, () => game(true, [1055, 2003], [6672, 3031])));
    assert.ok(!B.buildOrderTable(games).core[0].some(r => r.key === 3153), '1 of 30 is under 5%: hidden');
});

test('first back stats: median, and win rate when earlier vs later', () => {
    const g = (sec, win) => ({ firstBackAt: sec * S, win });
    const s = B.firstBackStats([g(300, true), g(320, true), g(360, false), g(400, false), g(420, true), { firstBackAt: null, win: true }]);
    assert.equal(s.medianMs, 360 * S);
    assert.equal(s.games, 5);
    assert.deepEqual([s.faster.games, s.faster.winRate], [2, 1]);
    assert.deepEqual([s.slower.games, s.slower.wins], [3, 1]);
    assert.equal(B.firstBackStats([]).medianMs, null);
});

// #89: average WPA per build-order row
const withWpa = (purchases, vals) => purchases.map((p, i) => ({ ...p, from: 50, to: 50 + vals[i], wpa: vals[i] }));
const BUILD = [{ itemId: 1055, t: 1 * S }, { itemId: 2003, t: 2 * S }, { itemId: 1036, t: 370 * S },
               { itemId: 1001, t: 380 * S }, { itemId: 6672, t: 600 * S }];

test('rows average WPA of that purchase', () => {
    const t = B.buildOrderTable([
        { win: true,  finalItems: [6672], purchases: BUILD, wpa: withWpa(BUILD, [4, 4, 2, 3, 6]) },
        { win: false, finalItems: [6672], purchases: BUILD, wpa: withWpa(BUILD, [-2, -2, 0, -1, -4]) },
    ]);
    const row = (rows, key) => rows.find(r => r.key === key);
    assert.deepEqual([row(t.start, '1055+2003').wpa, row(t.start, '1055+2003').wpaGames], [1, 2]);   // the trip's first purchase
    assert.equal(row(t.firstBack, 1036).wpa, 1);
    assert.equal(row(t.firstBack, 1001).wpa, 1);
    assert.deepEqual([row(t.core[0], 6672).wpa, row(t.core[0], 6672).wpaGames], [1, 2]);
});

test('rows ignore games without WPA', () => {
    const t = B.buildOrderTable([
        { win: true, finalItems: [6672], purchases: BUILD },
        { win: true, finalItems: [6672], purchases: BUILD, wpa: BUILD.map(() => null) },
        { win: true, finalItems: [6672], purchases: BUILD, wpa: withWpa(BUILD, [1, 1, 1, 1, 3]) },
    ]);
    assert.deepEqual([t.core[0][0].games, t.core[0][0].wpa, t.core[0][0].wpaGames], [3, 3, 1]);
    const none = B.buildOrderTable([{ win: true, finalItems: [6672], purchases: BUILD }]);
    assert.deepEqual([none.core[0][0].wpa, none.core[0][0].wpaGames], [null, 0]);
});
