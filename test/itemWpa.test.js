const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const W = require(path.join(SRC, 'services', 'itemWpa.js'));

const S = 1000;
const MIN = 60 * S;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

/** One point a minute for minutes 0..last, win chance = 30 + minute (so WPA = minutes passed). */
const linear = (last) => Array.from({ length: last + 1 }, (_, m) => ({ t: m * MIN, p: 30 + m }));
const buy = (itemId, sec) => ({ itemId, t: sec * S });

test('encode/decode round-trip', () => {
    assert.equal(W.encodeWinChance([{ t: 0, winProb: 0.5 }, { t: MIN, winProb: 0.523 }, { t: 90 * S, winProb: 0.486 }]), '50,52,49');
    assert.deepEqual(W.decodeWinChance('50,52,49'), [50, 52, 49]);
    assert.equal(W.encodeWinChance([]), '');
    assert.deepEqual(W.decodeWinChance(''), []);
});

test('decodeWinChance ignores a malformed string', () => {
    assert.deepEqual(W.decodeWinChance('50,x'), []);
    assert.deepEqual(W.decodeWinChance('50,101'), []);
    assert.deepEqual(W.decodeWinChance(null), []);
});

test('winChancePoints puts the last frame at game end', () => {
    assert.deepEqual(W.winChancePoints('40,50,60,70', 150),
        [{ t: 0, p: 40 }, { t: MIN, p: 50 }, { t: 2 * MIN, p: 60 }, { t: 150 * S, p: 70 }]);
    assert.deepEqual(W.winChancePoints('40,50', undefined), [{ t: 0, p: 40 }, { t: MIN, p: 50 }]);
    assert.deepEqual(W.winChancePoints('', 1800), []);
});

test('seriesPoints turns a teamSeries into points in percent', () => {
    assert.deepEqual(W.seriesPoints([{ t: 0, winProb: 0.5 }, { t: 61000, winProb: 0.25 }]), [{ t: 0, p: 50 }, { t: 61000, p: 25 }]);
});

test('chanceAt interpolates between frames', () => {
    const pts = [{ t: 0, p: 40 }, { t: MIN, p: 60 }];
    assert.equal(W.chanceAt(pts, 30 * S), 50);
    assert.equal(W.chanceAt(pts, -5), 40);
    assert.equal(W.chanceAt(pts, 10 * MIN), 60);
    assert.equal(W.chanceAt([], 5), null);
});

test('the window ends at the next trip, not the same trip', () => {
    const r = W.itemWpa([buy(3078, 870), buy(2055, 872), buy(3071, 1150)], linear(30));
    assert.equal(r.length, 3);
    close(r[0].wpa, (1150 - 870) / 60);       // the ward 2 s later is the same trip
    close(r[1].wpa, (1150 - 872) / 60);
    assert.equal(r[0].itemId, 3078);
    assert.equal(r[0].t, 870 * S);
    close(r[0].from, 30 + 870 / 60);
    close(r[0].to, 30 + 1150 / 60);
});

test('the window is capped at 5 minutes', () => {
    const r = W.itemWpa([buy(3078, 600), buy(3071, 1200)], linear(30));
    close(r[0].wpa, 5);
    close(r[0].to, 30 + 15);
});

test('the last purchase runs to the last frame at most', () => {
    const r = W.itemWpa([buy(3078, 480)], linear(10));
    close(r[0].wpa, 2);
});

test('two purchases of the same item are counted separately', () => {
    const r = W.itemWpa([buy(2055, 300), buy(2055, 900)], linear(30));
    assert.deepEqual(r.map(x => x.t), [300 * S, 900 * S]);
    close(r[0].wpa, 5);
    close(r[1].wpa, 5);
});

test('purchases at the edges of the game give numbers, not NaN', () => {
    const r = W.itemWpa([buy(1055, 0), buy(3006, 650)], linear(10));
    assert.ok(r.every(x => Number.isFinite(x.wpa) && Number.isFinite(x.from) && Number.isFinite(x.to)));
    close(r[0].wpa, 5);
    assert.equal(r[1].wpa, 0);    // bought after the last frame
});

test('a game with one frame gives 0', () => {
    const r = W.itemWpa([buy(1055, 5), buy(3006, 400)], [{ t: 0, p: 50 }]);
    assert.deepEqual(r.map(x => x.wpa), [0, 0]);
});

test('no win chance means no WPA', () => {
    assert.deepEqual(W.itemWpa([buy(1055, 5)], []), [null]);
    assert.deepEqual(W.itemWpa([], linear(5)), []);
});

test('lastPurchaseWpa uses the last purchase, rounded', () => {
    const m = W.lastPurchaseWpa([buy(2055, 300), buy(3006, 600), buy(2055, 900)], linear(30));
    assert.equal(m.size, 2);
    assert.deepEqual(m.get(2055), { from: 45, to: 50 });
    assert.deepEqual(m.get(3006), { from: 40, to: 45 });
    assert.equal(W.lastPurchaseWpa([buy(2055, 300)], []).size, 0);
});

test('wpaLine formats the exact copy', () => {
    assert.equal(W.wpaLine(46, 58), 'Win chance 46% → 58% (+12) until your next trip to the shop');
    assert.equal(W.wpaLine(50, 47), 'Win chance 50% → 47% (−3) until your next trip to the shop');
    assert.equal(W.wpaLine(50, 50), 'Win chance 50% → 50% (0) until your next trip to the shop');
});

test('the window constants', () => {
    assert.equal(W.TRIP_GAP_MS, 60000);
    assert.equal(W.WINDOW_CAP_MS, 5 * 60000);
});

test('asStored rounds like the stored columns, so both tooltips agree', () => {
    const { encodePurchases, decodePurchases } = require(path.join(SRC, 'services', 'itemBuild.js'));
    // 870.6 s and 930.5 s are 59.9 s apart (same trip) but 60 s apart once rounded to seconds
    const purchases = [{ itemId: 1026, t: 870600 }, { itemId: 2055, t: 930500 }, { itemId: 3006, t: 1100000 }];
    const series = Array.from({ length: 31 }, (_, m) => ({ t: m * MIN + 400, winProb: 0.3 + m * 0.0137 }));
    const stored = W.lastPurchaseWpa(decodePurchases(encodePurchases(purchases)), W.winChancePoints(W.encodeWinChance(series), 1830));
    const s = W.asStored(purchases, series, 1830);
    assert.deepEqual(W.lastPurchaseWpa(s.purchases, s.points), stored);
});

test('formatWpa: sign from the rounded value, never "-0.0"', () => {
    assert.equal(W.formatWpa(3.14), '+3.1');
    assert.equal(W.formatWpa(-0.34), '−0.3');
    assert.equal(W.formatWpa(-0.04), '0.0');
    assert.equal(W.formatWpa(0.04), '0.0');
    assert.equal(W.formatWpa(0), '0.0');
});
