const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const R = require(path.join(SRC, 'components', 'roleRanks.js'));
const ladder = values => Object.fromEntries(R.TIERS.map((t, i) => [t, values[i]]));

// Plates Lost (lower is better) and CS/min (higher is better), general ladders
const PLATES_LOST = ladder([2.5, 2.1, 1.8, 1.5, 1.2, 1.0, 0.8, 0.6, 0.5, 0.4]);
const CSM = ladder([4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.3, 8.6]);

test('tierScore: the whole part is the tier evaluateBenchmark gives', () => {
    // same >= / <= rule, from the top tier down
    const tierOf = (v, t, hi) => { for (const k of [...R.TIERS].reverse()) if (hi ? v >= t[k] : v <= t[k]) return k; return 'iron'; };
    for (const v of [3, 2.5, 2.2, 1.5, 1.31, 1.21, 0.8, 0.45, 0.4, 0.1]) {
        assert.equal(R.scoreToTier(R.tierScore(v, PLATES_LOST, false)), tierOf(v, PLATES_LOST, false), `plates ${v}`);
    }
    for (const v of [3, 4.5, 5.2, 6.0, 6.9, 8.6, 9.5]) {
        assert.equal(R.scoreToTier(R.tierScore(v, CSM, true)), tierOf(v, CSM, true), `cs ${v}`);
    }
});

test('tierScore: fraction toward the next tier, clamped at the ends', () => {
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
    near(R.tierScore(6.25, CSM, true), 3.5);                // halfway Gold → Platinum
    near(R.tierScore(1.35, PLATES_LOST, false), 3.5);
    assert.equal(R.tierScore(2, CSM, true), 0);             // below Iron
    assert.equal(R.tierScore(12, CSM, true), 9);            // above Challenger
    assert.equal(R.tierScore(null, CSM, true), null);
    assert.equal(R.tierScore(5, null, true), null);
});

test('combineScores: weighted by games, then back to a tier', () => {
    // Mid 1.31 lost plates (Gold, 419 games), Top 1.77 (Silver, 186 games)
    const mid = R.tierScore(1.31, PLATES_LOST, false), top = R.tierScore(1.77, PLATES_LOST, false);
    const c = R.combineScores([{ games: 419, score: mid }, { games: 186, score: top }]);
    assert.equal(c.tier, 'gold');
    assert.equal(c.games, 605);
    assert.ok(c.score > top && c.score < mid);
    assert.equal(R.combineScores([]), null);
    assert.equal(R.combineScores([{ games: 3, score: null }]), null);
});

test('roles: grouping, unknown positions, and stats that don\'t apply', () => {
    const groups = R.groupByRole([
        { teamPosition: 'JUNGLE' }, { teamPosition: 'MIDDLE' }, { teamPosition: 'JUNGLE' }, { teamPosition: '' }, {},
    ]);
    assert.deepEqual(groups.map(g => [g.role, g.matches.length]), [['JUNGLE', 2], ['UNKNOWN', 2], ['MIDDLE', 1]]);
    assert.equal(R.notApplicable('plates_lost', 'JUNGLE'), true);
    assert.equal(R.notApplicable('plates_lost', 'MIDDLE'), false);
    assert.equal(R.notApplicable('cs_10', 'UTILITY'), true);
    assert.equal(R.notApplicable('cs_10', 'JUNGLE'), false);
    assert.equal(R.notApplicable('win_rate', 'UTILITY'), false);
});

test('breakdownText lists each role with its value, tier and games', () => {
    assert.equal(R.breakdownText([
        { role: 'MIDDLE', displayValue: '1.3', tier: 'gold', games: 419 },
        { role: 'TOP', displayValue: '1.8', tier: 'silver', games: 186 },
    ]), 'Mid 1.3 Gold (419) · Top 1.8 Silver (186)');
});
