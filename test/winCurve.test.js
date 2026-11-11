const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const C = require(path.join(SRC, 'services', 'winCurve.js'));
const { winChancePoints, itemWpa } = require(path.join(SRC, 'services', 'itemWpa.js'));
const { teamSeries, winProbability } = require(path.join(SRC, 'services', 'matchTimeline.js'));
const { encodeFeatures } = require(path.join(SRC, 'services', 'winFeatures.js'));

const MIN = 60000;
const frame = (m, gold) => ({ m, gold, xp: 0, kills: 0, towers: 0, inhibs: 0, dragons: 0, soul: 0, baron: 0, elder: 0 });
const FEATURES = encodeFeatures([frame(0, 0), frame(1, 1000), frame(2, 2500)]);
const GOLD_ONLY = { ok: true, coef: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
const match = (over = {}) => ({ matchId: 'M1', teamId: 100, win: 1, gameDuration: 125,
    winChance: '50,55,62', winFeatures: FEATURES, ...over });
const purchases = [{ itemId: 3078, t: 30000 }, { itemId: 3047, t: 90000 }];

test.afterEach(() => C.configure({ enabled: false, model: null }));

test('off: today\'s points and window WPA', () => {
    C.configure({ enabled: false, model: GOLD_ONLY });
    const m = match();
    assert.equal(C.isFitted(), false);
    assert.deepEqual(C.pointsFor(m), winChancePoints(m.winChance, m.gameDuration));
    assert.deepEqual(C.purchaseWpa(purchases, m), itemWpa(purchases, winChancePoints(m.winChance, m.gameDuration)));
});

test('on but the model failed its check: still today\'s curve', () => {
    C.configure({ enabled: true, model: { ok: false, reason: 'check' } });
    assert.equal(C.isFitted(), false);
    assert.deepEqual(C.pointsFor(match()), winChancePoints('50,55,62', 125));
});

test('fitted: reads winFeatures, flips for team 200, the two sides add to 100', () => {
    C.configure({ enabled: true, model: GOLD_ONLY });
    assert.equal(C.isFitted(), true);
    const blue = C.pointsFor(match());
    const red = C.pointsFor(match({ matchId: 'M1', teamId: 200 }));
    assert.equal(blue.length, 3);
    assert.equal(blue[1].p, Math.round(100 / (1 + Math.exp(-1))));
    blue.forEach((pt, i) => { assert.equal(pt.p + red[i].p, 100); assert.equal(pt.t, red[i].t); });
});

test('fitted: WPA is won vs expected', () => {
    C.configure({ enabled: true, model: GOLD_ONLY });
    const w = C.purchaseWpa(purchases, match({ win: 0 }));
    assert.equal(w[0].itemId, 3078);
    assert.ok(w[0].wpa < 0 && w[0].from > 50);
    assert.equal(w[0].wpa, -w[0].from);
    assert.ok(Number.isFinite(w[0].v));
});

test('a sample row (no stored win chance) uses the hand-tuned curve from its features while not fitted', () => {
    C.configure({ enabled: true, model: null });
    const pts = C.pointsFor(match({ matchId: 'S1', winChance: undefined }));
    assert.equal(pts[2].p, Math.round(winProbability(2500, 0, 0) * 100));
});

test('seriesFor: today\'s series when off, the model\'s win chance when fitted', () => {
    const raw = { info: { participants: [{ participantId: 1, teamId: 100 }, { participantId: 6, teamId: 200 }] } };
    const timeline = { info: { frames: [0, 1, 2].map(i => ({ timestamp: i * MIN, events: [],
        participantFrames: { 1: { totalGold: 500 + 1000 * i, xp: 0 }, 6: { totalGold: 500, xp: 0 } } })) } };
    assert.deepEqual(C.seriesFor(raw, timeline, 100), teamSeries(raw, timeline, 100));
    C.configure({ enabled: true, model: GOLD_ONLY });
    const s = C.seriesFor(raw, timeline, 200);
    assert.ok(Math.abs(s[2].winProb - 1 / (1 + Math.exp(2))) < 1e-12);
    assert.equal(s[2].goldDiff, -2000);
});
