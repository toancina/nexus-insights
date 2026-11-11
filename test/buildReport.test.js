const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const { buildReport } = require(path.join(SRC, 'services', 'buildReport.js'));
const winCurve = require(path.join(SRC, 'services', 'winCurve.js'));
const { sampleGroups } = require(path.join(SRC, 'services', 'sampleSelect.js'));
const { encodeFeatures } = require(path.join(SRC, 'services', 'winFeatures.js'));

const GROUPS = sampleGroups({ tier: 'SILVER', rank: 'II' });
const isBuildItem = id => id >= 3000 && id !== 3047;    // 3047 stands in for boots
const ZERO = { m: 0, gold: 0, xp: 0, kills: 0, towers: 0, inhibs: 0, dragons: 0, soul: 0, baron: 0, elder: 0 };
const FEATURES = encodeFeatures([ZERO, { ...ZERO, m: 1 }]);      // a 50% curve under any model
let n = 0;

/** A game with a compact build: [[itemId, seconds], …]; final items = everything bought. */
function g(build, over = {}) {
    const ids = build.map(b => b[0]);
    return {
        matchId: `G${++n}`, championName: 'Yorick', teamPosition: 'TOP', teamId: 100, win: 1, gameDuration: 1800,
        itemPurchases: build.map(([id, s]) => `${id}:${s}`).join(','),
        item0: ids[0] || 0, item1: ids[1] || 0, item2: ids[2] || 0, item3: ids[3] || 0, item4: 0, item5: 0,
        primaryRune: 8010, secondaryRuneStyle: 8400, winFeatures: FEATURES, ...over,
    };
}
const sample = (tier, build, over = {}) => g(build, { tier, division: 'I', puuid: `p-${tier}-${n % 3}`, ...over });

test.afterEach(() => winCurve.configure({ enabled: false, model: null }));

test('your finished items with purchase time and your usual time from your other games', () => {
    const game = g([[1055, 20], [3078, 900], [3047, 1000], [6631, 1500]]);
    const mine = [game, g([[1055, 20], [3078, 540]]), g([[1055, 20], [3078, 660]]), g([[1055, 20], [3078, 600]], { championName: 'Poppy' })];
    const r = buildReport(game, mine, [], GROUPS, { isBuildItem });
    assert.deepEqual(r.items.map(i => i.itemId), [3078, 6631]);
    assert.equal(r.items[0].t, 900000);
    assert.equal(r.items[0].usualT, 600000);        // not this game's 900, not the Poppy game
    assert.equal(r.items[1].usualT, null);
    assert.equal(r.rune.keystone, 8010);
    assert.equal(r.noSamples, true);
});

test('each group: players, games, most common 1st/2nd/3rd item and keystone with shares', () => {
    const game = g([[3078, 600]]);
    const rows = [
        sample('SILVER', [[6631, 600], [3078, 900]]), sample('SILVER', [[6631, 600], [3078, 900]]),
        sample('SILVER', [[3078, 600]], { primaryRune: 8021 }),
        sample('GOLD', [[3078, 600], [6631, 900]]),
    ];
    const r = buildReport(game, [game], rows, GROUPS, { isBuildItem });
    assert.equal(r.noSamples, false);
    const level = r.groups.find(x => x.key === 'level');
    assert.equal(level.label, 'Silver I');
    assert.equal(level.games, 3);
    assert.equal(level.core[0].itemId, 6631);
    assert.ok(Math.abs(level.core[0].share - 2 / 3) < 1e-9);
    assert.equal(level.keystone.id, 8010);
    assert.ok(Math.abs(level.keystone.share - 2 / 3) < 1e-9);
    const above = r.groups.find(x => x.key === 'above');
    assert.equal(above.core[0].itemId, 3078);
    assert.equal(above.core[1].itemId, 6631);
});

test('better: only beyond the luck margin, and never with the curve off', () => {
    const game = g([[3078, 600]], { win: 0 });
    // 20 games each: your first item always lost, the other always won (from a 50% curve)
    const rows = [
        ...Array.from({ length: 20 }, () => sample('SILVER', [[3078, 600]], { win: 0 })),
        ...Array.from({ length: 20 }, () => sample('GOLD', [[6631, 600]], { win: 1 })),
    ];
    assert.equal(buildReport(game, [game], rows, GROUPS, { isBuildItem }).better, null);
    winCurve.configure({ enabled: true, model: { ok: true, coef: new Array(12).fill(0.1) } });
    const r = buildReport(game, [game], rows, GROUPS, { isBuildItem });
    assert.deepEqual({ itemId: r.better.itemId, insteadOf: r.better.insteadOf, slot: r.better.slot }, { itemId: 6631, insteadOf: 3078, slot: 0 });
    assert.ok(Math.abs(r.better.gap - 100) < 1e-9);
    // Within the margin: 3–3 against 4–2 over 6 games each is a 17-point gap, margins ±40 each
    const close = [
        ...[1, 1, 1, 0, 0, 0].map(win => sample('SILVER', [[3078, 600]], { win })),
        ...[1, 1, 1, 1, 0, 0].map(win => sample('GOLD', [[6631, 600]], { win })),
    ];
    assert.equal(buildReport(game, [game], close, GROUPS, { isBuildItem }).better, null);
});
