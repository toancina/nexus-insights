const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const C = require(path.join(SRC, 'services', 'winChanceStats.js'));

const MIN = 60000;
/** One point a minute; the last at `endSec` when given, like winChancePoints. */
const curve = (values, endSec) => values.map((p, i) => ({
    t: i === values.length - 1 && endSec ? endSec * 1000 : i * MIN, p,
}));

test('curveSummary: minute by minute, end, peak and low', () => {
    const c = C.curveSummary(curve([50, 55, 70, 60, 20, 30], 290));
    assert.deepEqual(c.byMinute.map(b => b.minute), [0, 1, 2, 3, 4]);
    assert.equal(c.end.p, 30);
    assert.equal(c.end.t, 290000);
    assert.deepEqual([c.peak.p, c.peak.t], [70, 2 * MIN]);
    assert.deepEqual([c.low.p, c.low.t], [20, 4 * MIN]);
    assert.equal(C.curveSummary([{ t: 0, p: 50 }]), null);
    assert.equal(C.curveSummary([]), null);
});

test('swings: biggest moves first, at most 3 frames wide, never overlapping', () => {
    //            0   1   2   3   4   5   6   7   8   9  10
    const pts = curve([50, 52, 54, 80, 82, 81, 50, 48, 47, 46, 60]);
    const s = C.swings(pts);
    // 82 → 46 (4..9) is 5 frames: too wide. 82 → 48 (4..7) and 81 → 47 (5..8) tie at −34: the earlier wins.
    // 46 → 60 (9..10) doesn't overlap it, so it is the third.
    assert.deepEqual(s.map(x => [x.fromT / MIN, x.toT / MIN, x.change]), [[0, 3, 30], [4, 7, -34], [9, 10, 14]]);
    assert.ok(s.every(x => Math.abs(x.change) >= C.SWING_MIN));
    assert.deepEqual(C.swings(curve([50, 52, 55, 57, 59])), [], 'a slow drift is not a swing');
});

test('winChanceStats: averages, ahead/even/behind at 15, throws and comebacks', () => {
    const flat = (p, minutes = 25) => curve(Array(minutes + 1).fill(p));
    const games = [
        { id: 'throw', win: false, points: curve([50, 60, 75, 70, 40, 20]) },
        { id: 'comeback', win: true, points: curve([50, 40, 25, 50, 80]) },
        { id: 'ahead', win: true, points: flat(65) },
        { id: 'behind', win: false, points: flat(35) },
        { id: 'even', win: true, points: flat(50, 16) },
        { id: 'no curve', win: true, points: [] },
    ];
    const s = C.winChanceStats(games);
    assert.equal(s.games, 5);
    assert.deepEqual(s.at15, { ahead: { games: 1, wins: 1 }, even: { games: 1, wins: 1 }, behind: { games: 1, wins: 0 } });
    assert.equal(s.average[15], (65 + 35 + 50) / 3, 'only games that reached 15 min');
    assert.equal(s.average[20], 50);
    assert.deepEqual(s.throws.map(g => g.id), ['throw']);
    assert.equal(s.throws[0].peak.p, 75);
    assert.deepEqual(s.comebacks.map(g => g.id), ['comeback']);
    assert.equal(s.comebacks[0].low.p, 25);
    assert.equal(C.chanceAtMinute(flat(50, 16), 20), null);
});
