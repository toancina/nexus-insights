/**
 * #7 / #8: the computed-stats pipeline stores your purchases and death spots.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { stubDatabase, SRC } = require('./helpers');

stubDatabase([]);
global.window = global.window || {};
const { computeAdvancedStatsForMatch } = require(path.join(SRC, 'services', 'matchService.js'));

const raw = { info: { gameDuration: 1800, participants: Array.from({ length: 10 }, (_, i) => ({
    participantId: i + 1, teamId: i < 5 ? 100 : 200, championName: 'C' + (i + 1), teamPosition: 'TOP',
})) } };

test('purchases and deaths are stored for the tracked player; red side turned to blue', () => {
    const timeline = { info: { frames: [
        { timestamp: 0, participantFrames: {}, events: [
            { type: 'ITEM_PURCHASED', timestamp: 2000, participantId: 7, itemId: 1055 },
            { type: 'ITEM_PURCHASED', timestamp: 3000, participantId: 2, itemId: 9999 },     // someone else
        ] },
        { timestamp: 60000, participantFrames: {}, events: [
            { type: 'CHAMPION_KILL', timestamp: 610000, victimId: 7, killerId: 2, position: { x: 4000, y: 13500 } },
            { type: 'ITEM_PURCHASED', timestamp: 615000, participantId: 7, itemId: 3006 },
        ] },
    ] } };
    const s = computeAdvancedStatsForMatch(raw, timeline, 'C7', 200);
    assert.equal(s.itemPurchases, '1055:2,3006:615');
    assert.equal(s.deathPositions, `${14980 - 13500},${14980 - 4000},610`);
});

test("no timeline: '' for both, so the backfill doesn't keep coming back", () => {
    const s = computeAdvancedStatsForMatch(raw, null, 'C1', 100);
    assert.equal(s.itemPurchases, '');
    assert.equal(s.deathPositions, '');
});

// #89: your team's win chance per timeline frame, for item WPA
test('win chance is stored per frame for your team', () => {
    const { winProbability } = require(path.join(SRC, 'services', 'matchTimeline.js'));
    const timeline = { info: { frames: [
        { timestamp: 0, participantFrames: {}, events: [] },
        { timestamp: 60000, participantFrames: { 1: { totalGold: 500, xp: 0 }, 6: { totalGold: 3000, xp: 0 } }, events: [] },
    ] } };
    const red = computeAdvancedStatsForMatch(raw, timeline, 'C7', 200);
    assert.equal(red.winChance, `50,${Math.round(winProbability(2500, 0, 0) * 100)}`);
    const blue = computeAdvancedStatsForMatch(raw, timeline, 'C1', 100);
    assert.equal(blue.winChance, `50,${Math.round(winProbability(-2500, 0, 0) * 100)}`);
});

test("no timeline stores '' for win chance", () => {
    assert.equal(computeAdvancedStatsForMatch(raw, null, 'C1', 100).winChance, '');
});
