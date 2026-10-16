const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { stubDatabase, makeMatch, makeRow, resetSeq, SRC } = require('./helpers');

// The engine and matchService both reach for services/database at require time,
// so the stub has to be installed first.
const rows = [
    makeRow({ win: 1, kills: 10, deaths: 2, assists: 6,  gameDuration: 1800, visionScore: 40, totalMinionsKilled: 220 }),
    makeRow({ win: 0, kills: 2,  deaths: 8, assists: 3,  gameDuration: 2400, visionScore: 20, totalMinionsKilled: 150 }),
    makeRow({ win: 1, kills: 6,  deaths: 4, assists: 12, gameDuration: 1500, visionScore: 55, totalMinionsKilled: 190 }),
];
stubDatabase(rows);

global.window = {};
const ms = require(path.join(SRC, 'services', 'matchService.js'));
require(path.join(SRC, 'components', 'analyticsEngine.js'));

const matches = rows.map(({ rawJson, timelineJson, ...scalar }) => scalar);
const TABS = ['Overview', 'Lane Phase', 'Combat', 'Death Review', 'Objectives',
              'Vision', 'Economy', 'Macro', 'Consistency'];

const cardById = (cards, id) => cards.find(c => c.id === id);

test.before(async () => {
    // Warm every blob so tab-specific assertions see full data
    const ids = matches.map(m => m.matchId);
    await ms.loadRawJson(ids);
    await ms.loadTimelineJson(ids);
});

test('every tab returns cards and never throws', () => {
    for (const tab of TABS) {
        const cards = window.computeTabStats(tab, matches, []);
        assert.ok(Array.isArray(cards), `${tab} should return an array`);
        assert.ok(cards.length > 0, `${tab} should produce at least one card`);
        for (const c of cards) {
            assert.ok(c.id && c.label, `${tab} card missing id/label`);
            assert.ok(!Number.isNaN(c.value), `${tab} card ${c.id} is NaN`);
        }
    }
});

test('empty match list returns no cards rather than dividing by zero', () => {
    for (const tab of TABS) {
        assert.deepEqual(window.computeTabStats(tab, [], []), []);
    }
});

test('Overview win rate matches the fixtures', () => {
    const cards = window.computeTabStats('Overview', matches, []);
    // 2 wins out of 3
    assert.equal(Math.round(cardById(cards, 'win_rate').value), 67);
    assert.equal(cardById(cards, 'total_matches').value, 3);
});

test('Overview KDA is computed over totals, not averaged per game', () => {
    const cards = window.computeTabStats('Overview', matches, []);
    // (10+2+6 kills + 6+3+12 assists) / (2+8+4 deaths) = 39/14
    assert.equal(cardById(cards, 'avg_kda').value.toFixed(3), (39 / 14).toFixed(3));
});

test('a single perfect game does not produce Infinity KDA', () => {
    const flawless = [makeMatch({ kills: 5, deaths: 0, assists: 5 })];
    const cards = window.computeTabStats('Overview', flawless, []);
    const kda = cardById(cards, 'avg_kda').value;
    assert.ok(Number.isFinite(kda), `KDA should be finite, got ${kda}`);
});

test('Consistency streaks read the list newest-first', () => {
    // matchesData is ordered newest first; two wins bracket one loss
    const cards = window.computeTabStats('Consistency', matches, []);
    assert.equal(cardById(cards, 'con_max_win').value, 1);
    assert.equal(cardById(cards, 'con_max_loss').value, 1);
    assert.equal(Math.round(cardById(cards, 'con_overall_wr').value), 67);
});

test('Vision averages come straight off the scalar columns', () => {
    const cards = window.computeTabStats('Vision', matches, []);
    const expected = (40 + 20 + 55) / 3;
    assert.equal(cardById(cards, 'vis_score').value.toFixed(3), expected.toFixed(3));
});

test('Economy CS/min divides by real game length', () => {
    const cards = window.computeTabStats('Economy', matches, []);
    const expected = ((220 / 30) + (150 / 40) + (190 / 25)) / 3;
    assert.equal(cardById(cards, 'eco_cs_min').value.toFixed(3), expected.toFixed(3));
});

test('Macro average game length is in minutes', () => {
    const cards = window.computeTabStats('Macro', matches, []);
    const expected = (30 + 40 + 25) / 3;
    assert.equal(cardById(cards, 'mac_dur').value.toFixed(3), expected.toFixed(3));
});

test('Lane Phase reads CS from the timeline', () => {
    const cards = window.computeTabStats('Lane Phase', matches, []);
    // Fixture timeline gives 7 cs/minute, so CS@10 = 70
    assert.equal(cardById(cards, 'cs_10').value, 70);
    assert.equal(cardById(cards, 'cs_15').value, 105);
});

test('Death Review counts pre-10-minute deaths from timeline events', () => {
    const cards = window.computeTabStats('Death Review', matches, []);
    // One early death per fixture match
    assert.equal(cardById(cards, 'dr_early_deaths').value.toFixed(2), '1.00');
});

test('tabs that need no JSON still work with an empty blob cache', () => {
    ms.clearJsonCache();
    for (const tab of ['Overview', 'Objectives', 'Macro', 'Consistency']) {
        const cards = window.computeTabStats(tab, matches, []);
        assert.ok(cards.length > 0, `${tab} broke without blobs`);
        assert.ok(cards.every(c => !Number.isNaN(c.value)), `${tab} produced NaN without blobs`);
    }
});

test('a payload missing totalDamageTaken does not NaN the whole Combat tab', async () => {
    // Regression: Riot omits fields on some older/alternate-queue payloads.
    // A single undefined used to propagate through avg() and blank the card,
    // discarding every other match's contribution along with it.
    ms.clearJsonCache();
    await ms.loadRawJson(matches.map(m => m.matchId));

    const cards = window.computeTabStats('Combat', matches, []);
    for (const c of cards) {
        assert.ok(!Number.isNaN(c.value), `Combat card ${c.id} is NaN`);
        assert.ok(Number.isFinite(c.value), `Combat card ${c.id} is not finite: ${c.value}`);
    }
});

test('zero gold or zero duration does not yield Infinity', () => {
    const degenerate = [makeMatch({ goldEarned: 0, gameDuration: 0, totalMinionsKilled: 0, deaths: 0 })];
    for (const tab of TABS) {
        const cards = window.computeTabStats(tab, degenerate, []);
        for (const c of cards) {
            assert.ok(Number.isFinite(c.value) || c.value === 0,
                `${tab} card ${c.id} = ${c.value} on a degenerate match`);
        }
    }
});

test('TAB_JSON_NEEDS covers every tab the engine can render', () => {
    for (const tab of TABS) {
        assert.ok(window.TAB_JSON_NEEDS[tab], `${tab} missing from TAB_JSON_NEEDS`);
    }
});

test('blob-dependent tabs degrade to non-NaN when blobs are missing', () => {
    ms.clearJsonCache();
    for (const tab of ['Lane Phase', 'Combat', 'Death Review', 'Vision', 'Economy']) {
        const cards = window.computeTabStats(tab, matches, []);
        assert.ok(cards.every(c => !Number.isNaN(c.value)),
            `${tab} produced NaN with an empty cache instead of degrading`);
    }
});

test('remake detection uses the stored flag, falling back to duration', () => {
    const isRemake = (m) => {
        if (m.isRemake !== null && m.isRemake !== undefined) return m.isRemake === 1;
        return (m.gameDuration || 0) < 300;
    };
    // Riot's flag wins even for a longer game
    assert.equal(isRemake({ isRemake: 1, gameDuration: 1800 }), true);
    // ...and a short game Riot did NOT flag is still a real game
    assert.equal(isRemake({ isRemake: 0, gameDuration: 120 }), false);
    // Rows predating the column fall back to duration
    assert.equal(isRemake({ gameDuration: 108 }), true);
    assert.equal(isRemake({ gameDuration: 1800 }), false);
    assert.equal(isRemake({}), true, 'a missing duration is treated as a remake, not a real game');
});

test('a remake does not drag averages toward zero', () => {
    const real   = [makeMatch({ gameDuration: 1800, kills: 8, deaths: 2, assists: 6, totalMinionsKilled: 200 })];
    const withRemake = [
        ...real,
        makeMatch({ gameDuration: 108, kills: 0, deaths: 0, assists: 0, totalMinionsKilled: 0, isRemake: 1 }),
    ];
    const filtered = withRemake.filter(m => m.isRemake !== 1);

    const kdaOf = (list) => {
        const cards = window.computeTabStats('Overview', list, []);
        return cards.find(c => c.id === 'avg_csm').value;
    };
    assert.equal(kdaOf(filtered).toFixed(4), kdaOf(real).toFixed(4),
        'filtering the remake should reproduce the clean result exactly');
    assert.ok(kdaOf(withRemake) < kdaOf(real), 'and leaving it in should measurably drag CS/min down');
});

test('Combat impact cards: stored columns, rawJson fallback, and "--" with no data', async () => {
    // Fallback: rows indexed before impact existed are parsed from rawJson.
    // In the fixture "you" out-damage and out-earn every teammate → rank 1.
    ms.clearJsonCache();
    await ms.loadRawJson(matches.map(m => m.matchId));
    let cards = window.computeTabStats('Combat', matches, []);
    assert.equal(cardById(cards, 'impact_rank').value, 1);
    assert.equal(cardById(cards, 'impact_rank').displayValue, '#1.0');
    assert.equal(cardById(cards, 'mvp_rate').value, 100);

    // Stored columns win over the blob
    const stored = matches.map((m, i) => ({ ...m, impactRank: i === 0 ? 1 : 4, impactTag: i === 0 ? 'MVP' : null }));
    cards = window.computeTabStats('Combat', stored, []);
    assert.equal(cardById(cards, 'impact_rank').value, 3);
    assert.equal(Math.round(cardById(cards, 'mvp_rate').value), 33);
    assert.equal(cardById(cards, 'impact_rank').higherIsBetter, false);

    // Nothing to go on: finite value, "--" shown, no trend against a real period
    ms.clearJsonCache();
    cards = window.computeTabStats('Combat', matches, stored);
    for (const id of ['impact_rank', 'mvp_rate']) {
        assert.equal(cardById(cards, id).displayValue, '--');
        assert.ok(Number.isFinite(cardById(cards, id).value));
        assert.equal(cardById(cards, id).trend, null);
    }
});

test('objective/turret damage per minute and first death cards (#15)', () => {
    const games = [
        makeMatch({ gameDuration: 1800, turretDamage: 6000, objectiveDamage: 3000, firstDeathAt: 6 * 60000 }),
        makeMatch({ gameDuration: 1200, turretDamage: 1200, objectiveDamage: 600,  firstDeathAt: null }),
        makeMatch({ gameDuration: 1500, turretDamage: null, objectiveDamage: null, firstDeathAt: null }), // not indexed
    ];
    const obj = window.computeTabStats('Objectives', games, []);
    assert.equal(cardById(obj, 'turret_dmg_min').value, (200 + 60) / 2);
    assert.equal(cardById(obj, 'obj_dmg_min').value, (100 + 30) / 2);
    assert.equal(cardById(obj, 'obj_dmg_min').benchmarkable, false);

    const dr = window.computeTabStats('Death Review', games, []);
    assert.equal(cardById(dr, 'dr_first_death').displayValue, '6:00');

    // Nothing indexed yet: "--", not 0
    const none = window.computeTabStats('Objectives', [games[2]], []);
    assert.equal(cardById(none, 'turret_dmg_min').displayValue, '--');
});

// ---------------------------------------------------------------------------
// Role-weighted rank badges (#56)
// ---------------------------------------------------------------------------
test('role-weighted: plates ignore jungle games, rank per lane ladder, breakdown by role', () => {
    const lane = (role, lost, taken) => makeMatch({ teamPosition: role, statsComputedAt: 1, platesLost: lost, platesTaken: taken });
    const games = [
        ...Array.from({ length: 6 }, () => lane('JUNGLE', 0, 0)),
        ...Array.from({ length: 3 }, () => lane('MIDDLE', 1.3, 1.5)),
        ...Array.from({ length: 1 }, () => lane('TOP', 1.8, 1.7)),
    ];
    const plain = cardById(window.computeTabStats('Lane Phase', games, []), 'plates_lost');
    const weighted = cardById(window.computeTabStats('Lane Phase', games, [], { roleWeighted: true }), 'plates_lost');

    // Old behaviour: jungle zeros drag the average down to "Grandmaster"-ish
    assert.ok(plain.value < 0.6);
    // New: laner games only (3 × 1.3 + 1 × 1.8) / 4, ranked per lane → Gold
    assert.ok(Math.abs(weighted.value - 1.425) < 1e-9);
    assert.equal(weighted.benchmarkRank, 'gold');
    assert.deepEqual(weighted.roleBreakdown.map(e => [e.role, e.games, e.tier]), [['MIDDLE', 3, 'gold'], ['TOP', 1, 'silver']]);

    // Plates Taken: same games, jungle left out instead of dragging it toward Iron
    const taken = cardById(window.computeTabStats('Lane Phase', games, [], { roleWeighted: true }), 'plates_taken');
    assert.ok(Math.abs(taken.value - 1.55) < 1e-9);
});

test('role-weighted: a role a stat doesn\'t apply to shows "--"', () => {
    const jungle = Array.from({ length: 4 }, () => makeMatch({ teamPosition: 'JUNGLE', statsComputedAt: 1, platesLost: 0, platesTaken: 0 }));
    for (const opts of [{ roleWeighted: true }, { roleWeighted: true, role: 'JUNGLE' }]) {
        const c = cardById(window.computeTabStats('Lane Phase', jungle, [], opts), 'plates_lost');
        assert.equal(c.displayValue, '--', JSON.stringify(opts));
        assert.equal(c.value, null);
    }
    // Stats that do apply to junglers keep their value
    const kda = cardById(window.computeTabStats('Overview', jungle, [], { roleWeighted: true, role: 'JUNGLE' }), 'avg_kda');
    assert.notEqual(kda.displayValue, '--');
});

test('role-weighted: supports get scaled ladders; without the flag nothing changes', () => {
    const sup = Array.from({ length: 5 }, () => makeMatch({ teamPosition: 'UTILITY', totalDamageDealtToChampions: 9000, gameDuration: 1800 }));
    const general = cardById(window.computeTabStats('Overview', sup, []), 'dmg_min');
    const weighted = cardById(window.computeTabStats('Overview', sup, [], { roleWeighted: true }), 'dmg_min');
    assert.equal(general.value, weighted.value);                 // same number
    assert.equal(general.benchmarkRank, 'iron');                 // 300 dmg/min on the general ladder
    assert.notEqual(weighted.benchmarkRank, 'iron');             // a support's ladder is 0.6x
    // Neutral trend arrow for game length
    const longer = cardById(window.computeTabStats('Macro', [makeMatch({ gameDuration: 2400 })], [makeMatch({ gameDuration: 1500 })]), 'mac_dur');
    assert.equal(longer.isImproving, null);
    assert.ok(longer.trend);
});
