/**
 * Issue #8: death positions, zones by game phase, density.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const D = require(path.join(SRC, 'services', 'deathMap.js'));
const M = D.MAP_SIZE;
const MIN = 60000;

test('red-side deaths are turned to the blue side without swapping top and bottom', () => {
    // A red player dying in top lane near red's top tower (top-left half of the
    // map) must stay in top lane: x small-ish, y large.
    const p = D.toBlueSide({ x: 4000, y: 13500 }, 200);
    assert.deepEqual(p, { x: M - 13500, y: M - 4000 });
    assert.ok(p.y > p.x, 'still on the top side of the map');
    // Red's fountain becomes blue's fountain corner
    const fountain = D.toBlueSide({ x: 14300, y: 14300 }, 200);
    assert.ok(fountain.x < 1000 && fountain.y < 1000);
    assert.deepEqual(D.toBlueSide({ x: 1, y: 2 }, 100), { x: 1, y: 2 });
});

test('deaths from the timeline: yours, with a position, oldest first', () => {
    const tl = { info: { frames: [
        { events: [{ type: 'CHAMPION_KILL', timestamp: 9 * MIN, victimId: 3, position: { x: 7000, y: 7000 } }] },
        { events: [
            { type: 'CHAMPION_KILL', timestamp: 20 * MIN, victimId: 3, position: { x: 1000, y: 2000 } },
            { type: 'CHAMPION_KILL', timestamp: 12 * MIN, victimId: 3 },                       // no position
            { type: 'CHAMPION_KILL', timestamp: 15 * MIN, victimId: 8, position: { x: 1, y: 1 } }, // someone else
        ] },
    ] } };
    const deaths = D.deathsFromTimeline(tl, 3, 100);
    assert.deepEqual(deaths.map(d => d.t / MIN), [9, 20]);
});

test('encode/decode round-trips', () => {
    const list = [{ x: 7000.4, y: 1200, t: 545600 }, { x: 13000, y: 12000, t: 1800000 }];
    assert.equal(D.encodeDeaths(list), '7000,1200,546;13000,12000,1800');
    assert.deepEqual(D.decodeDeaths('7000,1200,546;13000,12000,1800'),
        [{ x: 7000, y: 1200, t: 546000 }, { x: 13000, y: 12000, t: 1800000 }]);
    assert.deepEqual(D.decodeDeaths(''), []);
});

test('zones along the base-to-base diagonal, phases by time', () => {
    assert.equal(D.zoneOf({ x: 1500, y: 1500 }), 'own');
    assert.equal(D.zoneOf({ x: 7500, y: 7400 }), 'middle');
    assert.equal(D.zoneOf({ x: 12000, y: 13000 }), 'enemy');
    assert.equal(D.phaseOf(13 * MIN).key, 'early');
    assert.equal(D.phaseOf(14 * MIN).key, 'early', '14:00 itself is still early');
    assert.equal(D.phaseOf(20 * MIN).key, 'mid');
    assert.equal(D.phaseOf(40 * MIN).key, 'late');
});

test('zones by phase and the biggest shift', () => {
    const at = (zone, min) => ({ ...{ own: { x: 1000, y: 1000 }, middle: { x: 7500, y: 7500 }, enemy: { x: 13000, y: 13000 } }[zone], t: min * MIN });
    const deaths = [
        at('own', 5), at('middle', 6), at('middle', 8), at('own', 10), at('enemy', 12),       // early: 20% enemy
        at('enemy', 16), at('enemy', 18), at('middle', 20), at('enemy', 22), at('own', 24),  // mid: 60% enemy
    ];
    const phases = D.zonesByPhase(deaths);
    assert.deepEqual(phases.map(p => [p.key, p.deaths]), [['early', 5], ['mid', 5]]);
    assert.equal(phases[0].enemy, 0.2);
    assert.equal(phases[1].enemy, 0.6);
    assert.equal(phases[0].own + phases[0].middle + phases[0].enemy, 1);

    const shift = D.biggestShift(phases);
    assert.deepEqual([shift.zone, shift.from, shift.to, shift.fromPhase], ['enemy', 0.2, 0.6, 'Early (0–14m)']);
    assert.equal(D.biggestShift(phases.slice(0, 1)), null, 'needs two phases');
    assert.equal(D.biggestShift([phases[0], phases[0]]), null, 'nothing moved');
});

test('density counts deaths close to each one', () => {
    const dots = D.densityDots([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 5000, y: 5000 }], 600);
    assert.deepEqual(dots.map(d => d.density), [2, 2, 1]);
});

test('densityDots (grid) matches the all-pairs count on random deaths (#66)', () => {
    // The old algorithm, kept here as the reference
    const allPairs = (deaths, radius) => deaths.map(d => ({ x: d.x, y: d.y,
        density: deaths.filter(o => (o.x - d.x) ** 2 + (o.y - d.y) ** 2 <= radius * radius).length }));
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const deaths = Array.from({ length: 800 }, () => ({ x: Math.round(rnd() * 14980), y: Math.round(rnd() * 14980) }));
    // clusters, points exactly on the radius, on cell edges, and duplicates
    deaths.push({ x: 600, y: 0 }, { x: 0, y: 0 }, { x: 1200, y: 1200 }, { x: 1200, y: 1200 }, { x: 599.5, y: 600 });
    for (const radius of [600, 300, 1000]) {
        assert.deepEqual(D.densityDots(deaths, radius), allPairs(deaths, radius), `radius ${radius}`);
    }
    assert.deepEqual(D.densityDots([]), []);
});

test('densityDots handles ~10,000 deaths quickly', () => {
    const deaths = Array.from({ length: 10000 }, (_, i) => ({ x: (i * 7919) % 14980, y: (i * 104729) % 14980 }));
    const t = Date.now();
    D.densityDots(deaths);
    assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
});
