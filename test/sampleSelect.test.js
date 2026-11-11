const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const S = require(path.join(SRC, 'services', 'sampleSelect.js'));

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 11);

let seq = 0;
const game = (championName, patch, over = {}) => ({
    matchId: `M${++seq}`, championName, patch, queueId: 420, isRemake: 0,
    gameDuration: 1800, gameCreation: NOW - DAY * 10 + seq * 1000, ...over,
});

test('topChampions counts Solo/Duo only, skips remakes, last 2 patches, ties by most recent', () => {
    const matches = [
        game('Yorick', '16.21'), game('Yorick', '16.21'),
        game('Poppy', '16.20'), game('Poppy', '16.21'),       // newest of the tie
        game('Shen', '16.20'),
        ...Array.from({ length: 5 }, () => game('Ahri', '16.21', { queueId: 440 })),
        ...Array.from({ length: 9 }, () => game('Malphite', '16.19')),
        game('Zed', '16.21', { isRemake: 1 }), game('Zed', '16.21', { isRemake: 1 }), game('Zed', '16.21', { isRemake: 1 }),
    ];
    assert.deepEqual(S.topChampions(matches, { now: NOW }), ['Poppy', 'Yorick', 'Shen']);
});

test('topChampions returns [] with no Solo/Duo games in the last 2 patches', () => {
    const matches = [game('Ahri', '16.21', { queueId: 440 }), game('Ahri', '16.20', { queueId: 400 }), game('Yorick', '16.19')];
    assert.deepEqual(S.topChampions(matches, { now: NOW }), []);
    assert.deepEqual(S.topChampions([], { now: NOW }), []);
});

test('sampleGroups: division I of your tier and of the next one', () => {
    const g = r => S.sampleGroups(r).map(x => [x.key, x.tier, x.division, x.label]);
    assert.deepEqual(g({ tier: 'SILVER', rank: 'II' }), [['level', 'SILVER', 'I', 'Silver I'], ['above', 'GOLD', 'I', 'Gold I']]);
    assert.deepEqual(g({ tier: 'GOLD', rank: 'IV' }), [['level', 'GOLD', 'I', 'Gold I'], ['above', 'PLATINUM', 'I', 'Platinum I']]);
    assert.deepEqual(g({ tier: 'DIAMOND', rank: 'I' }), [['level', 'DIAMOND', 'I', 'Diamond I'], ['above', 'MASTER', null, 'Master']]);
    assert.deepEqual(g({ tier: 'MASTER', rank: 'I' }), [['level', 'MASTER', null, 'Master'], ['above', 'GRANDMASTER', null, 'Grandmaster']]);
    assert.deepEqual(g({ tier: 'CHALLENGER', rank: 'I' }), [['level', 'CHALLENGER', null, 'Challenger']]);
    assert.deepEqual(g({ tier: 'IRON', rank: 'III' }), [['level', 'IRON', 'I', 'Iron I'], ['above', 'BRONZE', 'I', 'Bronze I']]);
    assert.deepEqual(g({ tier: 'EMERALD', rank: 'II' }), [['level', 'EMERALD', 'I', 'Emerald I'], ['above', 'DIAMOND', 'I', 'Diamond I']]);
    assert.deepEqual(g(null), []);
    assert.deepEqual(g({ tier: 'UNRANKED' }), []);
});

test('pickBestPlayers: most mastery among players who played it in the last 3 months', () => {
    const recent = NOW - DAY * 5, old = NOW - DAY * 120;
    const c = (puuid, points, lastPlayTime = recent) => ({ puuid, masteries: { 83: { points, lastPlayTime } } });
    const candidates = [
        c('a', 100), c('b', 900), c('c', 500), c('d', 700), c('e', 300), c('f', 800),
        c('stale', 99999, old), c('me', 50000), { puuid: 'noChamp', masteries: { 1: { points: 1e6, lastPlayTime: recent } } },
    ];
    assert.deepEqual(S.pickBestPlayers(candidates, 83, { now: NOW, exclude: 'me' }), ['b', 'f', 'd', 'c', 'e']);
    assert.deepEqual(S.pickBestPlayers(candidates.slice(0, 2), 83, { now: NOW, exclude: null }), ['b', 'a']);
    assert.deepEqual(S.pickBestPlayers(candidates, 83, { now: NOW, exclude: 'me', count: 2 }), ['b', 'f']);
});

test('groupOf matches tier + division against your current groups', () => {
    const silver = S.sampleGroups({ tier: 'SILVER', rank: 'II' });
    const gold = S.sampleGroups({ tier: 'GOLD', rank: 'III' });
    assert.equal(S.groupOf({ tier: 'GOLD', division: 'I' }, silver), 'above');
    assert.equal(S.groupOf({ tier: 'GOLD', division: 'I' }, gold), 'level');
    assert.equal(S.groupOf({ tier: 'SILVER', division: 'I' }, gold), null);   // a group you left
    assert.equal(S.groupOf({ tier: 'MASTER', division: null }, S.sampleGroups({ tier: 'DIAMOND', rank: 'II' })), 'above');
    assert.equal(S.groupOf({ tier: 'GOLD', division: 'II' }, silver), null);
});

test('championKeyOf maps Match-V5 names to Data Dragon keys', () => {
    const list = { Fiddlesticks: { id: 'Fiddlesticks', key: '9' }, MonkeyKing: { id: 'MonkeyKing', key: '62' }, Yorick: { id: 'Yorick', key: '83' } };
    assert.equal(S.championKeyOf('FiddleSticks', list), 9);
    assert.equal(S.championKeyOf('MonkeyKing', list), 62);
    assert.equal(S.championKeyOf('yorick', Object.values(list)), 83);
    assert.equal(S.championKeyOf('Nobody', list), null);
    assert.equal(S.championKeyOf('Yorick', {}), null);
});
