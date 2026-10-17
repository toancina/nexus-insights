const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const { computeTeamImpact, impactFor, IMPACT_AREAS } =
    require(path.join(SRC, 'services', 'teamImpact.js'));

/** Ten identical players; `over` tweaks individual ones by participantId. */
function lobby(over = {}) {
    return Array.from({ length: 10 }, (_, i) => {
        const id = i + 1;
        return {
            participantId: id,
            teamId: id <= 5 ? 100 : 200,
            win: id <= 5,
            championName: 'Champ' + id,
            kills: 4, deaths: 4, assists: 6,
            totalDamageDealtToChampions: 20000,
            goldEarned: 11000,
            visionScore: 30,
            damageDealtToObjectives: 8000,
            damageDealtToBuildings: 3000,
            totalHealsOnTeammates: 0,
            totalDamageTaken: 25000,
            ...(over[id] || {}),
        };
    });
}

test('identical players: every area is a fifth of the team, score 20', () => {
    const impact = computeTeamImpact(lobby());
    assert.equal(impact.size, 10);
    for (const entry of impact.values()) {
        assert.equal(entry.score, 20);
        // Nobody healed anyone: that area is skipped, not counted as 0
        assert.equal(entry.shares.healing, null);
        assert.equal(Object.values(entry.shares).filter(v => v !== null).length, IMPACT_AREAS.length - 1);
    }
});

test('the biggest contributor on each side is MVP (winners) and SVP (losers)', () => {
    const impact = computeTeamImpact(lobby({
        3: { kills: 12, assists: 10, totalDamageDealtToChampions: 45000, goldEarned: 16000 },
        8: { kills: 9, totalDamageDealtToChampions: 38000, visionScore: 70 },
    }));
    assert.equal(impact.get(3).tag, 'MVP');
    assert.equal(impact.get(3).rank, 1);
    assert.equal(impact.get(8).tag, 'SVP');
    assert.equal(impact.get(8).rank, 2);
    const tags = [...impact.values()].map(e => e.tag).filter(Boolean);
    assert.deepEqual(tags.sort(), ['MVP', 'SVP']);
    // Ranks are 1..10 with no gaps or repeats
    assert.deepEqual([...impact.values()].map(e => e.rank).sort((a, b) => a - b),
                     [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('shares are measured against the player\'s own team', () => {
    const impact = computeTeamImpact(lobby({ 1: { totalDamageDealtToChampions: 40000 } }));
    // 40000 of 120000 on team 100
    assert.equal(impact.get(1).shares.damage, 33.3);
    // Team 200 is untouched by player 1's damage
    assert.equal(impact.get(6).shares.damage, 20);
});

test('objective damage excludes structures, which have their own area', () => {
    const impact = computeTeamImpact(lobby({ 2: { damageDealtToObjectives: 23000, damageDealtToBuildings: 3000 } }));
    // (23000-3000) of (20000 + 4*5000) on team 100
    assert.equal(impact.get(2).shares.objectiveDamage, 50);
    assert.equal(impact.get(2).shares.structureDamage, 20);
});

test('ties on score are broken by damage, kills + assists, gold, vision, then id', () => {
    const { compareImpact } = require(path.join(SRC, 'services', 'teamImpact.js'))._internal;
    const row = (id, extra) => ({ id, score: 20, damage: 1, killsAssists: 1, gold: 1, vision: 1, ...extra });
    const order = (...rows) => rows.sort(compareImpact).map(r => r.id);
    assert.deepEqual(order(row(1), row(2, { damage: 2 })), [2, 1]);
    assert.deepEqual(order(row(1), row(2, { killsAssists: 2 })), [2, 1]);
    assert.deepEqual(order(row(1, { vision: 5 }), row(2, { gold: 2 })), [2, 1]);
    assert.deepEqual(order(row(2), row(1)), [1, 2]);
    assert.deepEqual(order(row(1, { damage: 9 }), row(2, { score: 21 })), [2, 1]);
});

test('missing fields count as zero and never produce NaN', () => {
    const players = lobby();
    delete players[0].totalHealsOnTeammates;
    delete players[0].damageDealtToBuildings;
    players[1].visionScore = undefined;
    const impact = computeTeamImpact(players);
    for (const e of impact.values()) assert.ok(Number.isFinite(e.score), `score ${e.score}`);
});

test('impactFor finds you by champion and team, like the rest of the app', () => {
    const players = lobby({ 7: { kills: 15, totalDamageDealtToChampions: 50000 } });
    const me = impactFor(players, 'Champ7', 200);
    assert.equal(me.tag, 'SVP');
    assert.equal(me.rank, 1);
    assert.equal(impactFor(players, 'Champ7', 100), null);
    assert.equal(impactFor([], 'Champ7', 200), null);
});

test('participants without participantId fall back to their position', () => {
    const players = lobby().map(({ participantId, ...p }) => p);
    const impact = computeTeamImpact(players);
    assert.deepEqual([...impact.keys()], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('no ranks for games without 10 players, e.g. Arena (#68)', () => {
    const arena = Array.from({ length: 16 }, (_, i) => ({
        ...lobby()[i % 10], participantId: i + 1, teamId: 100 + Math.floor(i / 2), win: i < 2,
    }));
    assert.equal(computeTeamImpact(arena).size, 0);
    assert.equal(impactFor(arena, arena[0].championName, arena[0].teamId), null);
    assert.equal(computeTeamImpact(lobby().slice(0, 9)).size, 0);
    assert.equal(computeTeamImpact(lobby()).size, 10);
});
