const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const W = require(path.join(SRC, 'services', 'winFeatures.js'));

const raw = { info: { participants: [
    { participantId: 1, teamId: 100, championName: 'Yorick' },
    { participantId: 6, teamId: 200, championName: 'Darius' },
] } };

const pf = (g1, x1, g6, x6) => ({ 1: { totalGold: g1, xp: x1 }, 6: { totalGold: g6, xp: x6 } });
const ev = (timestamp, type, extra) => ({ timestamp, type, ...extra });

const timeline = { info: { frames: [
    { timestamp: 0, participantFrames: pf(500, 0, 500, 0), events: [] },
    { timestamp: 60000, participantFrames: pf(1000, 300, 800, 250), events: [
        ev(30000, 'CHAMPION_KILL', { killerId: 1, victimId: 6 }),
        ev(50000, 'CHAMPION_KILL', { killerId: 0, victimId: 1 }),     // execution: no kill for anyone
    ] },
    { timestamp: 240000, participantFrames: pf(2000, 900, 1500, 800), events: [
        ev(90000, 'BUILDING_KILL', { buildingType: 'TOWER_BUILDING', teamId: 200 }),
        ev(100000, 'BUILDING_KILL', { buildingType: 'INHIBITOR_BUILDING', teamId: 200 }),
        ev(110000, 'ELITE_MONSTER_KILL', { monsterType: 'DRAGON', monsterSubType: 'FIRE_DRAGON', killerTeamId: 100 }),
        ev(115000, 'ELITE_MONSTER_KILL', { monsterType: 'DRAGON', monsterSubType: 'WATER_DRAGON', killerTeamId: 100 }),
        ev(116000, 'ELITE_MONSTER_KILL', { monsterType: 'DRAGON', monsterSubType: 'AIR_DRAGON', killerTeamId: 100 }),
        ev(117000, 'ELITE_MONSTER_KILL', { monsterType: 'DRAGON', monsterSubType: 'EARTH_DRAGON', killerTeamId: 100 }),
        ev(200000, 'ELITE_MONSTER_KILL', { monsterType: 'BARON_NASHOR', killerTeamId: 200 }),
        ev(230000, 'ELITE_MONSTER_KILL', { monsterType: 'DRAGON', monsterSubType: 'ELDER_DRAGON', killerTeamId: 100 }),
    ] },
    { timestamp: 420000, participantFrames: pf(3000, 1500, 2600, 1400), events: [] },
] } };

test('frameFeatures: differences from team 100\'s side, one per frame', () => {
    const f = W.frameFeatures(raw, timeline);
    assert.equal(f.length, 4);
    assert.deepEqual(f[0], { m: 0, gold: 0, xp: 0, kills: 0, towers: 0, inhibs: 0, dragons: 0, soul: 0, baron: 0, elder: 0 });
    assert.deepEqual(f[1], { m: 1, gold: 200, xp: 50, kills: 1, towers: 0, inhibs: 0, dragons: 0, soul: 0, baron: 0, elder: 0 });
    assert.deepEqual(f[2], { m: 4, gold: 500, xp: 100, kills: 1, towers: 1, inhibs: 1, dragons: 4, soul: 1, baron: -1, elder: 1 });
    // inhibitor back after 5 min, Baron buff over after 3, Elder after 2.5
    assert.deepEqual(f[3], { m: 7, gold: 400, xp: 100, kills: 1, towers: 1, inhibs: 0, dragons: 4, soul: 1, baron: 0, elder: 0 });
});

test('frameFeatures is [] without frames', () => {
    assert.deepEqual(W.frameFeatures(raw, null), []);
    assert.deepEqual(W.frameFeatures(raw, { info: { frames: [] } }), []);
});

test('encode / decode round-trip; malformed text decodes to []', () => {
    const f = W.frameFeatures(raw, timeline);
    const text = W.encodeFeatures(f);
    assert.equal(text.split(';')[2], '4.00,500,100,1,1,1,4,1,-1,1');
    assert.deepEqual(W.decodeFeatures(text), f);
    assert.equal(W.encodeFeatures([]), '');
    assert.deepEqual(W.decodeFeatures(''), []);
    assert.deepEqual(W.decodeFeatures('x,y'), []);
    assert.deepEqual(W.decodeFeatures('1,2,3'), []);
});

test('flipFeatures negates every difference but keeps the minute', () => {
    const f = W.frameFeatures(raw, timeline)[2];
    assert.deepEqual(W.flipFeatures(f), { m: 4, gold: -500, xp: -100, kills: -1, towers: -1, inhibs: -1, dragons: -4, soul: -1, baron: 1, elder: -1 });
});
