const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { stubDatabase, SRC } = require('./helpers');

stubDatabase([]);
const { computeAdvancedStatsForMatch } = require(path.join(SRC, 'services', 'matchService.js'));

// ---------------------------------------------------------------------------
// A hand-built 25-minute game. "Me" is Ahri mid (participant 3, blue side),
// laning against Zed (participant 8).
// ---------------------------------------------------------------------------

const MIN = 60_000;
const ME = 3, OPP = 8, MY_JUNGLER = 2;
const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const MID = { x: 7000, y: 7000 };
const FAR = { x: 1000, y: 13000 };

function makeMatch({ gameDuration = 25 * 60, ...meOverrides } = {}) {
    const participants = Array.from({ length: 10 }, (_, i) => {
        const pid = i + 1;
        const teamId = pid <= 5 ? 100 : 200;
        return {
            participantId: pid, puuid: `p${pid}`, teamId,
            teamPosition: POSITIONS[i % 5], championName: `Champ${pid}`,
            kills: teamId === 200 ? 2 : 1, deaths: 1, assists: 2,
            totalDamageDealtToChampions: 10000, goldEarned: 10000, totalDamageTaken: 15000,
            challenges: { turretPlatesTaken: 0, soloKills: 0 },
        };
    });
    Object.assign(participants[ME - 1], {
        championName: 'Ahri', kills: 4, deaths: 2, assists: 5,
        totalDamageDealtToChampions: 20000, goldEarned: 12000, totalDamageTaken: 20000,
        doubleKills: 1, firstBloodKill: true,
        damageDealtToBuildings: 4000, damageDealtToObjectives: 6500,
        challenges: { turretPlatesTaken: 2, soloKills: 1, killParticipation: 0.6,
                      visionScoreAdvantageLaneOpponent: 0.25 },
        ...meOverrides,
    });
    Object.assign(participants[OPP - 1], {
        championName: 'Zed', challenges: { turretPlatesTaken: 1, soloKills: 0 },
    });
    return { metadata: { matchId: 'EUW1_1' }, info: { gameDuration, participants } };
}

/** One frame per minute. Me: 8 CS, 400 gold, 450 XP a minute; Zed a bit less. */
function makeTimeline(minutes = 20) {
    const frames = [];
    for (let m = 0; m <= minutes; m++) {
        const participantFrames = {};
        for (let pid = 1; pid <= 10; pid++) {
            participantFrames[pid] = { minionsKilled: 0, jungleMinionsKilled: 0, totalGold: 500, xp: 0, position: FAR };
        }
        const level = Math.min(18, 1 + Math.floor(m * 0.75));   // level 10 at 12:00
        participantFrames[ME]  = { minionsKilled: 8 * m, jungleMinionsKilled: 0, totalGold: 500 + 400 * m, xp: 450 * m, level, position: MID };
        participantFrames[OPP] = { minionsKilled: 7 * m, jungleMinionsKilled: 0, totalGold: 500 + 380 * m, xp: 430 * m, position: MID };
        frames.push({ timestamp: m * MIN, participantFrames, events: [] });
    }
    // At 12:00 my jungler stands next to me
    if (frames[12]) frames[12].participantFrames[MY_JUNGLER].position = { x: 7500, y: 7000 };
    const at = (t, e) => { if (frames[Math.floor(t / MIN)]) frames[Math.floor(t / MIN)].events.push({ timestamp: t, ...e }); };
    at(3 * MIN,       { type: 'CHAMPION_KILL', killerId: ME,  victimId: OPP, bounty: 300, position: MID });
    at(5 * MIN + 10e3, { type: 'CHAMPION_KILL', killerId: OPP, victimId: ME,  bounty: 300, position: MID }); // alone, early
    at(5 * MIN + 30e3, { type: 'ELITE_MONSTER_KILL', killerId: MY_JUNGLER, monsterType: 'HORDE' });         // level 4: 8 s respawn, alive again
    at(8 * MIN,       { type: 'ELITE_MONSTER_KILL', killerId: MY_JUNGLER, monsterType: 'DRAGON' });         // I'm alive
    at(12 * MIN,      { type: 'CHAMPION_KILL', killerId: OPP, victimId: ME,  bounty: 450, position: MID }); // shutdown, jungler near
    at(12 * MIN + 5e3,  { type: 'ELITE_MONSTER_KILL', killerId: MY_JUNGLER, monsterType: 'HORDE' });        // dead
    at(12 * MIN + 30e3, { type: 'ELITE_MONSTER_KILL', killerId: MY_JUNGLER, monsterType: 'DRAGON' });       // level 10: 32.5 s, still dead
    at(13 * MIN,      { type: 'ELITE_MONSTER_KILL', killerId: 7, monsterType: 'DRAGON' });                  // theirs, not counted
    at(14 * MIN,      { type: 'CHAMPION_KILL', killerId: ME,  victimId: 9,   bounty: 500, position: MID }); // shutdown claimed
    // Plates: two of mine (one sent twice), one of Zed's, and plate events after 14:00 that don't count
    const plate = (t, killerId, x) => at(t, { type: 'TURRET_PLATE_DESTROYED', killerId, teamId: killerId === ME ? 200 : 100, laneType: 'MID_LANE', position: { x, y: 8500 } });
    plate(6 * MIN, ME, 8955); plate(6 * MIN, ME, 8955); plate(9 * MIN, ME, 8960);
    plate(7 * MIN, OPP, 5846);
    plate(15 * MIN, ME, 8955); plate(16 * MIN, OPP, 5846);
    return { info: { frames } };
}

const compute = (match = makeMatch(), timeline = makeTimeline()) =>
    computeAdvancedStatsForMatch(match, timeline, 'Ahri', 100);

test('lane differences at 15:00 against the same-position opponent', () => {
    const s = compute();
    assert.equal(s.csDiff15, 120 - 105);
    assert.equal(s.goldDiff15, 6500 - 6200);
    assert.equal(s.xpDiff15, 6750 - 6450);
    assert.equal(s.laneOpponent, 'Zed');
});

test('gold / XP gap to the lane opponent per minute (#12)', () => {
    const g = JSON.parse(compute().laneGaps);
    assert.equal(g.gold.length, 21);
    assert.equal(g.gold[15], 6500 - 6200);
    assert.equal(g.xp[10], 4500 - 4300);
    // No timeline: '' (none), not null (null = not indexed yet)
    assert.equal(compute(makeMatch(), null).laneGaps, '');
});

test('CS at 10, 15 and 20 minutes', () => {
    const s = compute();
    assert.deepEqual([s.cs10, s.cs15, s.cs20], [80, 120, 160]);
});

test('deaths: early, isolated, shutdowns', () => {
    const s = compute();
    assert.equal(s.deathsBefore10, 1);
    // 5:10 death had nobody near and no objective; the 12:00 one had the jungler
    assert.equal(s.isolatedDeaths, 1);
    assert.equal(s.shutdownsGiven, 1);
    assert.equal(s.shutdownBountyGiven, 450);
    assert.equal(s.shutdownsClaimed, 1);
});

test('objective rate counts my team\'s monsters I was alive for', () => {
    // Grubs 5:30 alive (died 5:10, 8 s respawn), dragon 8:00 alive; grubs 12:05
    // and dragon 12:30 dead (died 12:00, 32.5 s at level 10). Enemy dragon ignored.
    assert.equal(compute().objectiveRate, 50);
});

test('plates: mine and my lane opponent\'s before 14:00, a repeated event once', () => {
    const s = compute();
    assert.equal(s.platesTaken, 2);
    assert.equal(s.platesLost, 1);
    // From the timeline only: Riot's challenge counter also counted later events
    assert.equal(compute(makeMatch(), null).platesTaken, null);
});

test('first blood, solo kills and vision come from the match payload', () => {
    const s = compute();
    assert.equal(s.firstBlood, 1);
    assert.equal(s.soloKillDiff, 1);
    assert.equal(s.visionAdvantage, 0.25);
});

test('shares, ratios and counts', () => {
    const s = compute();
    assert.equal(s.dmgShare, 0.333);         // 20k of 60k team damage
    assert.equal(s.goldShare, 0.231);        // 12k of 52k team gold
    assert.equal(s.killParticipation, 0.6);  // Riot's own value wins
    assert.equal(s.dmgGoldRatio, 1.667);
    assert.equal(s.dmgTakenPerDeath, 10000);
    assert.equal(s.multikills, 1);
    assert.equal(s.enemyTeamKills, 10);
    assert.equal(s.isRemake, 0);
});

test('a game that ended before 15:00 has no @15 values', () => {
    const s = compute(makeMatch({ gameDuration: 13 * 60 }), makeTimeline(13));
    assert.equal(s.csDiff15, null);
    assert.equal(s.goldDiff15, null);
    assert.equal(s.cs15, null);
    assert.equal(s.cs20, null);
    assert.equal(s.cs10, 80);
});

test('without a timeline, payload values are still filled', () => {
    const s = compute(makeMatch(), null);
    assert.equal(s.csDiff15, null);
    assert.equal(s.isolatedDeaths, null);
    assert.equal(s.objectiveRate, null);
    assert.equal(s.dmgShare, 0.333);
    assert.equal(s.soloKillDiff, 1);
});

test('remakes, and a player who isn\'t in the game', () => {
    assert.equal(compute(makeMatch({ gameDuration: 200 }), null).isRemake, 1);
    assert.equal(compute(makeMatch({ gameEndedInEarlySurrender: true }), null).isRemake, 1);

    const s = computeAdvancedStatsForMatch(makeMatch(), makeTimeline(), 'Teemo', 100);
    assert.equal(s.dmgShare, null);
    assert.equal(s.csDiff15, null);
    assert.equal(s.firstBlood, 0);
});

test('turret and objective damage, first death time (#15)', () => {
    const s = compute();
    assert.equal(s.turretDamage, 4000);
    assert.equal(s.objectiveDamage, 2500);       // objectives minus buildings
    assert.equal(s.firstDeathAt, 5 * MIN + 10e3);

    // A deathless game has no first death, but still counts as indexed
    const tl = makeTimeline();
    for (const f of tl.info.frames) f.events = f.events.filter(e => e.victimId !== ME);
    const clean = compute(makeMatch(), tl);
    assert.equal(clean.firstDeathAt, null);
    assert.equal(clean.turretDamage, 4000);

    // Old payloads without the fields: 0, never null (null means "not indexed")
    const old = compute(makeMatch({ damageDealtToBuildings: undefined, damageDealtToObjectives: undefined }), null);
    assert.equal(old.turretDamage, 0);
    assert.equal(old.objectiveDamage, 0);
});

test('winFeatures: one frame per timeline frame, from team 100\'s side; \'\' without a timeline', () => {
    const { decodeFeatures, frameFeatures } = require(path.join(SRC, 'services', 'winFeatures.js'));
    const match = makeMatch(), timeline = makeTimeline();
    const s = compute(match, timeline);
    assert.ok(s.winFeatures, 'written');
    assert.deepEqual(decodeFeatures(s.winFeatures).map(f => f.gold), frameFeatures(match, timeline).map(f => f.gold));
    // A player on team 200 stores the same team-100 features
    const red = computeAdvancedStatsForMatch(match, timeline, match.info.participants.find(p => p.teamId === 200).championName, 200);
    assert.equal(red.winFeatures, s.winFeatures);
    assert.equal(compute(match, null).winFeatures, '');
});
