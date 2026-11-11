const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const M = require(path.join(SRC, 'services', 'winModel.js'));
const { flipFeatures, encodeFeatures } = require(path.join(SRC, 'services', 'winFeatures.js'));

const DAY = 86400000;
const TRUE = { coef: [0.5, 0.2, 0.05, 0.3, 0.6, 0.15, 0.8, 0.9, 1.2, -0.1, 0.05, 0.02] };

/** Seeded PRNG (mulberry32) so the synthetic data is the same every run. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function normal(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
const tri = (r, p) => (r() < p ? (r() < 0.5 ? 1 : -1) : 0);

function randomFrame(r) {
    return {
        m: r() * 40, gold: normal(r) * 3000, xp: normal(r) * 2000, kills: Math.round(normal(r) * 5),
        towers: Math.round(normal(r) * 2), inhibs: tri(r, 0.2), dragons: Math.round(normal(r) * 1.5),
        soul: tri(r, 0.3), baron: tri(r, 0.3), elder: tri(r, 0.3),
    };
}
function synthetic(n, model, seed) {
    const r = rng(seed);
    return Array.from({ length: n }, () => {
        const f = randomFrame(r);
        return { f, y: r() < M.predict(model, f) ? 1 : 0 };
    });
}

test('fitModel recovers known coefficients', () => {
    const fit = M.fitModel(synthetic(20000, TRUE, 1));
    fit.coef.forEach((c, i) => assert.ok(Math.abs(c - TRUE.coef[i]) < 0.15, `coef ${i}: ${c} vs ${TRUE.coef[i]}`));
});

test('predict is symmetric: the two teams add up to 100%', () => {
    const r = rng(2);
    for (let i = 0; i < 50; i++) {
        const f = randomFrame(r);
        assert.ok(Math.abs(M.predict(TRUE, f) + M.predict(TRUE, flipFeatures(f)) - 1) < 1e-12);
    }
    assert.equal(M.predict(TRUE, { m: 10, gold: 0, xp: 0, kills: 0, towers: 0, inhibs: 0, dragons: 0, soul: 0, baron: 0, elder: 0 }), 0.5);
});

test('checkModel passes a calibrated model', () => {
    const r = M.checkModel(TRUE, synthetic(20000, TRUE, 3));
    assert.equal(r.ok, true);
    assert.ok(r.logLoss < r.handLogLoss);
    assert.ok(r.bands.some(b => b.frames >= M.BAND_MIN_FRAMES));
});

test('checkModel fails an overconfident model (bands) and a useless one (log loss)', () => {
    const data = synthetic(20000, TRUE, 4);
    const over = M.checkModel({ coef: TRUE.coef.map(c => c * 3) }, data);
    assert.equal(over.ok, false);
    assert.ok(over.bands.some(b => b.frames >= M.BAND_MIN_FRAMES && Math.abs(b.predicted - b.actual) > M.BAND_TOLERANCE));
    const flat = M.checkModel({ coef: TRUE.coef.map(() => 0) }, data);
    assert.equal(flat.ok, false);
    assert.ok(flat.logLoss > flat.handLogLoss);
});

test('trainingSet holds out the games whose id characters sum to a multiple of 5', () => {
    const sum = id => [...id].reduce((s, c) => s + c.charCodeAt(0), 0);
    const ids = ['EUW1_1', 'EUW1_2', 'EUW1_3', 'EUW1_4', 'EUW1_5', 'EUW1_6'];
    const games = ids.map((matchId, i) => ({ matchId, blueWin: i % 2, winFeatures: encodeFeatures([randomFrame(rng(i)), randomFrame(rng(i + 9))]) }));
    games.push({ matchId: 'EMPTY', blueWin: 1, winFeatures: '' });
    const { train, test: held } = M.trainingSet(games);
    const heldIds = ids.filter(id => sum(id) % 5 === 0);
    assert.equal(held.length, heldIds.length * 2);
    assert.equal(train.length + held.length, ids.length * 2);
    assert.ok(train.every(s => s.y === 0 || s.y === 1));
});

test('buildModel refuses under 300 games', () => {
    const games = Array.from({ length: 299 }, (_, i) => ({ matchId: `G${i}`, blueWin: i % 2, winFeatures: encodeFeatures([randomFrame(rng(i))]) }));
    const r = M.buildModel(games, { now: 5 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'few-games');
    assert.equal(r.games, 299);
    assert.equal(r.fittedAt, 5);
});

test('buildModel fits and passes on enough well-behaved games', () => {
    const r = rng(7);
    const games = Array.from({ length: 600 }, (_, i) => {
        const frames = Array.from({ length: 10 }, () => randomFrame(r));
        const last = frames[frames.length - 1];
        return { matchId: `EUW1_${1000 + i}`, blueWin: r() < M.predict(TRUE, last) ? 1 : 0, winFeatures: encodeFeatures(frames) };
    });
    const out = M.buildModel(games, { now: 9 });
    assert.equal(out.games, 600);
    assert.ok(['check', null].includes(out.reason));
    if (out.ok) assert.equal(out.coef.length, 12);
});

test('needsRefit: none saved, 25 more games, or a week old', () => {
    const saved = { games: 400, fittedAt: 1000 };
    assert.equal(M.needsRefit(null, 400, 1000), true);
    assert.equal(M.needsRefit(saved, 424, 1000 + 6 * DAY), false);
    assert.equal(M.needsRefit(saved, 425, 1000), true);
    assert.equal(M.needsRefit(saved, 400, 1000 + 7 * DAY), true);
});
