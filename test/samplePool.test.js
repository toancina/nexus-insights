const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const P = require(path.join(SRC, 'services', 'samplePool.js'));
const { sampleGroups } = require(path.join(SRC, 'services', 'sampleSelect.js'));

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 11);
const SILVER = sampleGroups({ tier: 'SILVER', rank: 'II' });
const GOLD = sampleGroups({ tier: 'GOLD', rank: 'III' });

const mine = (over = {}) => ({ matchId: `M${Math.random()}`, championName: 'Yorick', teamPosition: 'TOP', patch: '16.21', gameCreation: NOW - DAY, ...over });
const sample = (tier, division, over = {}) => ({ matchId: `S${Math.random()}`, championName: 'Yorick', teamPosition: 'TOP', patch: '16.21',
    gameCreation: NOW - DAY, tier, division, ...over });

test('championPool joins your games and current-group sample rows, with counts', () => {
    const r = P.championPool(
        [mine(), mine(), mine({ championName: 'Poppy' })],
        [sample('SILVER', 'I'), sample('GOLD', 'I'), sample('GOLD', 'I'), sample('GOLD', 'I', { championName: 'Poppy' })],
        'Yorick', { groups: SILVER, now: NOW });
    assert.deepEqual(r.counts, { mine: 2, level: 1, above: 2 });
    assert.equal(r.games.length, 5);
    assert.deepEqual(r.games.filter(g => g.sample).map(g => g.sample).sort(), ['above', 'above', 'level']);
    assert.ok(r.games.filter(g => !g.sample).every(g => g.championName === 'Yorick'));
});

test('drops sample rows from groups you left', () => {
    const r = P.championPool([], [sample('SILVER', 'I'), sample('GOLD', 'I'), sample('PLATINUM', 'I')], 'yorick', { groups: GOLD, now: NOW });
    assert.deepEqual(r.counts, { mine: 0, level: 1, above: 1 });
});

test('applies role and period to sample rows; patch periods follow your patches', () => {
    const rows = [sample('SILVER', 'I'), sample('SILVER', 'I', { teamPosition: 'JUNGLE' }),
        sample('SILVER', 'I', { patch: '16.19', gameCreation: NOW - 40 * DAY })];
    assert.equal(P.championPool([], rows, 'Yorick', { groups: SILVER, role: 'TOP', now: NOW }).counts.level, 2);
    assert.equal(P.championPool([], rows, 'Yorick', { groups: SILVER, period: 'days:30', now: NOW }).counts.level, 2);
    // Your newest patch is 16.21 → 'patches:1' keeps only 16.21 sample rows
    const yours = [mine(), mine({ patch: '16.20' })];
    assert.equal(P.championPool([], rows, 'Yorick', { groups: SILVER, period: 'patches:1', patchSource: yours, now: NOW }).counts.level, 2);
    assert.equal(P.championPool([], rows, 'Yorick', { groups: SILVER, period: 'patch:16.19', now: NOW }).counts.level, 1);
});

test('poolLabel', () => {
    assert.equal(P.poolLabel({ mine: 214, level: 25, above: 18 }, SILVER), 'From 257 games: yours 214 · Silver I 25 · Gold I 18');
    assert.equal(P.poolLabel({ mine: 10, level: 0, above: 3 }, SILVER), 'From 13 games: yours 10 · Gold I 3');
});
