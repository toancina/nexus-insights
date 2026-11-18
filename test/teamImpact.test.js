const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const { computeTeamImpact, impactFor, IMPACT_AREAS, ROLE_PAR } =
    require(path.join(SRC, 'services', 'teamImpact.js'));

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

/** Ten average players, five a side, one per role; `over` tweaks them by participantId. */
function lobby(over = {}) {
    return Array.from({ length: 10 }, (_, i) => {
        const id = i + 1;
        return {
            participantId: id,
            teamId: id <= 5 ? 100 : 200,
            win: id <= 5,
            teamPosition: ROLES[i % 5],
            championName: 'Champ' + id,
            kills: 4, deaths: 4, assists: 6,
            totalDamageDealtToChampions: 20000,
            goldEarned: 11000,
            visionScore: 30,
            damageDealtToObjectives: 8000,
            damageDealtToBuildings: 3000,
            totalHealsOnTeammates: 0,
            totalDamageShieldedOnTeammates: 0,
            totalDamageTaken: 25000,
            damageSelfMitigated: 10000,
            timeCCingOthers: 10,
            ...(over[id] || {}),
        };
    });
}

/** A lobby where every player has exactly their role's usual numbers. */
function parLobby(over = {}) {
    const base = { takedowns: 10, deaths: 4, combat: 20000, gold: 11000, vision: 30, objectives: 8000, tanking: 35000, control: 10 };
    return lobby(Object.fromEntries(Array.from({ length: 10 }, (_, i) => {
        const par = ROLE_PAR[ROLES[i % 5]];
        return [i + 1, {
            kills: base.takedowns * par.takedowns / 2, assists: base.takedowns * par.takedowns / 2,
            deaths: base.deaths * par.deaths,
            totalDamageDealtToChampions: base.combat * par.combat,
            goldEarned: base.gold * par.gold, visionScore: base.vision * par.vision,
            damageDealtToObjectives: base.objectives * par.objectives,
            totalDamageTaken: base.tanking * par.tanking * 0.7, damageSelfMitigated: base.tanking * par.tanking * 0.3,
            timeCCingOthers: base.control * par.control,
            ...(over[i + 1] || {}),
        }];
    })));
}

test('area weights add up to 1', () => {
    const sum = IMPACT_AREAS.reduce((s, a) => s + a[2], 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum}`);
});

test('players with their role\'s usual numbers all score 5.0', () => {
    const impact = computeTeamImpact(parLobby());
    assert.equal(impact.size, 10);
    for (const e of impact.values()) assert.equal(e.score, 5);
});

test('scores stay between 0 and 10', () => {
    const impact = computeTeamImpact(lobby({
        3: { kills: 30, assists: 20, deaths: 0, totalDamageDealtToChampions: 90000, goldEarned: 25000 },
        8: { kills: 0, assists: 0, deaths: 20, totalDamageDealtToChampions: 1000, goldEarned: 4000 },
    }));
    for (const e of impact.values()) assert.ok(e.score >= 0 && e.score <= 10, `score ${e.score}`);
    assert.ok(impact.get(3).score > 8);
    assert.ok(impact.get(8).score < 2);
});

test('the best winner is MVP and the best loser SVP; ranks are 1..10', () => {
    const impact = computeTeamImpact(lobby({
        3: { kills: 12, assists: 10, totalDamageDealtToChampions: 45000, goldEarned: 16000 },
        8: { kills: 9, totalDamageDealtToChampions: 38000, visionScore: 70 },
    }));
    assert.equal(impact.get(3).tag, 'MVP');
    assert.equal(impact.get(3).rank, 1);
    assert.equal(impact.get(8).tag, 'SVP');
    assert.equal(impact.get(8).rank, 2);
    assert.deepEqual([...impact.values()].map(e => e.tag).filter(Boolean).sort(), ['MVP', 'SVP']);
    assert.deepEqual([...impact.values()].map(e => e.rank).sort((a, b) => a - b),
                     [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('a support with huge heals and shields but a bad game does not beat a strong carry', () => {
    // Old formula: healing share ≈ 100% of the team's, so this support won MVP.
    const impact = computeTeamImpact(parLobby({
        5: { kills: 0, assists: 14, deaths: 11, totalHealsOnTeammates: 9000, totalDamageShieldedOnTeammates: 6000 },
        4: { kills: 12, assists: 6, deaths: 2, totalDamageDealtToChampions: 34000, goldEarned: 15000 },
    }));
    assert.ok(impact.get(4).score > impact.get(5).score + 2);
    assert.equal(impact.get(4).tag, 'MVP');
});

test('heals and shields count as combat, in HP, next to damage', () => {
    const plain = computeTeamImpact(parLobby()).get(5).areas.combat;
    const healer = computeTeamImpact(parLobby({ 5: { totalHealsOnTeammates: 6000, totalDamageShieldedOnTeammates: 4000 } })).get(5).areas.combat;
    assert.ok(healer > plain);
    // ...but only as much as the same HP of damage would
    const dmg = computeTeamImpact(parLobby({ 5: { totalDamageDealtToChampions: ROLE_PAR.UTILITY.combat * 20000 + 10000 } })).get(5).areas.combat;
    assert.equal(healer, dmg);
});

test('dying less is better, and role par is respected', () => {
    const fewer = computeTeamImpact(parLobby({ 2: { deaths: 1 } })).get(2);
    const more = computeTeamImpact(parLobby({ 2: { deaths: 9 } })).get(2);
    assert.ok(fewer.areas.deaths > 0 && more.areas.deaths < 0);
    assert.ok(fewer.score > more.score);
    // A jungler with twice the objective damage of a mid is normal for the role
    const impact = computeTeamImpact(parLobby());
    assert.equal(impact.get(2).areas.objectives, impact.get(3).areas.objectives);
});

test('ties on score are broken by damage, kills + assists, gold, vision, then id', () => {
    const { compareImpact } = require(path.join(SRC, 'services', 'teamImpact.js'))._internal;
    const row = (id, extra) => ({ id, score: 5, damage: 1, killsAssists: 1, gold: 1, vision: 1, ...extra });
    const order = (...rows) => rows.sort(compareImpact).map(r => r.id);
    assert.deepEqual(order(row(1), row(2, { damage: 2 })), [2, 1]);
    assert.deepEqual(order(row(1), row(2, { killsAssists: 2 })), [2, 1]);
    assert.deepEqual(order(row(1, { vision: 5 }), row(2, { gold: 2 })), [2, 1]);
    assert.deepEqual(order(row(2), row(1)), [1, 2]);
    assert.deepEqual(order(row(1, { damage: 9 }), row(2, { score: 6 })), [2, 1]);
});

test('missing fields and unknown roles never produce NaN', () => {
    const players = lobby();
    delete players[0].totalHealsOnTeammates;
    delete players[0].damageSelfMitigated;
    players[1].visionScore = undefined;
    players[2].teamPosition = '';
    const impact = computeTeamImpact(players);
    for (const e of impact.values()) {
        assert.ok(Number.isFinite(e.score), `score ${e.score}`);
        for (const z of Object.values(e.areas)) assert.ok(Number.isFinite(z));
    }
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
    assert.deepEqual([...computeTeamImpact(players).keys()], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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
