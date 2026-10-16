const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../src/components/coachingEngine');

const HOUR = 3600000;
let clock = new Date('2026-03-01T12:00:00Z').getTime();

/** Build a match row; each call advances the clock by 30 minutes. */
function game(overrides = {}) {
    clock += 30 * 60000;
    return Object.assign({
        matchId: 'M' + clock,
        gameCreation: clock,
        gameDuration: 1800,
        win: 0,
        championName: 'Sejuani',
        teamPosition: 'JUNGLE',
        kills: 3, deaths: 4, assists: 8,
        teamKills: 25,
        deathsBefore10: 0,
        isolatedDeaths: 1,
        detectorWardsPlaced: 4,
        cs10: 62,
        goldDiff15: 0,
        xpDiff15: 0,
        soloKillDiff: 0,
        objectiveRate: 50,
        visionScore: 38,
        teamDragons: 2, teamBarons: 1, turretKills: 2,
        firstBlood: 0,
    }, overrides);
}

test('ranks the metric with the largest recoverable win rate first', () => {
    const rows = [];
    // Early deaths: strong effect. 40 clean games at 70% WR, 40 bad at 30%.
    // Control wards: no effect at all, deliberately.
    //
    // Wins are INTERLEAVED, not blocked. Contiguous runs of losses would
    // manufacture a huge artificial tilt signal, which is not what this test
    // is about — and is unlike real match histories.
    for (let i = 0; i < 40; i++) {
        rows.push(game({ deathsBefore10: 0, win: (i % 10) < 7 ? 1 : 0, detectorWardsPlaced: i % 2 ? 5 : 1 }));
    }
    for (let i = 0; i < 40; i++) {
        rows.push(game({ deathsBefore10: 2, win: (i % 10) < 3 ? 1 : 0, detectorWardsPlaced: i % 2 ? 5 : 1 }));
    }

    const out = Engine.analyse(rows);
    assert.strictEqual(out.focus.id, 'earlyDeaths', 'early deaths should be the focus');
    assert.ok(out.focus.gap > 30, `expected a large gap, got ${out.focus.gap}`);
    assert.ok(out.focus.confident, 'gap far exceeds noise, should be confident');

    const wards = out.allInputs.find(m => m.id === 'controlWards');
    assert.ok(wards.recoverable < out.focus.recoverable, 'a no-effect metric must rank below a real one');
});

test('frequency matters, not just severity', () => {
    const rows = [];
    // A: huge gap, almost never happens (2 of 80 games)
    // B: moderate gap, happens constantly (40 of 80)
    for (let i = 0; i < 78; i++) {
        rows.push(game({
            isolatedDeaths: 0,
            goldDiff15: i < 38 ? 500 : -900,
            win: i < 38 ? 1 : (i < 58 ? 1 : 0),
        }));
    }
    for (let i = 0; i < 2; i++) rows.push(game({ isolatedDeaths: 9, win: 0 }));

    const out = Engine.analyse(rows);
    const iso = out.allInputs.find(m => m.id === 'isolatedDeaths');
    const gold = out.allInputs.find(m => m.id === 'goldDiff15');

    assert.ok(iso.failedGames < 5, 'isolated deaths should rarely fail');
    assert.ok(gold.recoverable > iso.recoverable,
        'a common moderate problem must outrank a rare catastrophic one');
});

test('small samples are not treated as confident', () => {
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(game({ deathsBefore10: 0, win: 1 }));
    for (let i = 0; i < 6; i++) rows.push(game({ deathsBefore10: 3, win: 0 }));

    const out = Engine.analyse(rows);
    const early = out.allInputs.find(m => m.id === 'earlyDeaths');
    assert.strictEqual(early.gap, 100, 'the raw gap is a perfect 100 points');
    assert.strictEqual(early.confident, false, 'but 6 games a side must not be confident');
});

test('a negative gap never becomes a recommendation', () => {
    const rows = [];
    // Player somehow wins MORE when missing the control ward target
    for (let i = 0; i < 30; i++) rows.push(game({ detectorWardsPlaced: 6, win: i < 9 ? 1 : 0 }));
    for (let i = 0; i < 30; i++) rows.push(game({ detectorWardsPlaced: 0, win: i < 24 ? 1 : 0 }));

    const out = Engine.analyse(rows);
    const wards = out.allInputs.find(m => m.id === 'controlWards');
    assert.ok(wards.gap < 0, 'gap is genuinely negative here');
    assert.strictEqual(wards.recoverable, 0, 'recoverable must clamp at 0, never go negative');
});

test('role decides which benchmark applies, and CS is skipped for support', () => {
    const jungle = Engine.analyse(Array.from({ length: 40 }, () => game({ teamPosition: 'JUNGLE' })));
    assert.strictEqual(jungle.role, 'JUNGLE');
    assert.ok(jungle.allInputs.some(m => m.id === 'csAt10'), 'junglers get a CS target');

    const support = Engine.analyse(Array.from({ length: 40 }, () =>
        game({ teamPosition: 'UTILITY', championName: 'Nautilus' })));
    assert.strictEqual(support.role, 'UTILITY');
    assert.ok(!support.allInputs.some(m => m.id === 'csAt10'), 'support must not be judged on CS');

    const cw = support.allInputs.find(m => m.id === 'controlWards');
    assert.strictEqual(cw.target, 6, 'support control ward target is higher than jungle');
});

test('jungle-relevant lane stats get jungle-specific targets, and solo kills skip support', () => {
    const jungle = Engine.analyse(Array.from({ length: 40 }, () => game({ teamPosition: 'JUNGLE' })));
    const objRate = jungle.allInputs.find(m => m.id === 'objectiveRate');
    const solo    = jungle.allInputs.find(m => m.id === 'soloKillDiff');
    const gold    = jungle.allInputs.find(m => m.id === 'goldDiff15');
    assert.strictEqual(objRate.target, 100, 'objective presence: not dead for any of the team objectives');
    assert.strictEqual(solo.target, 0.15, 'jungle solo-kill target reflects ganks, not lane duels');
    assert.strictEqual(gold.target, 0, 'jungle gold@15 target is parity with the enemy jungler');

    const top = Engine.analyse(Array.from({ length: 40 }, () => game({ teamPosition: 'TOP' })));
    const topObjRate = top.allInputs.find(m => m.id === 'objectiveRate');
    assert.strictEqual(topObjRate.target, 100, 'the same bar in every role since the dead/alive rule was fixed');

    const support = Engine.analyse(Array.from({ length: 40 }, () =>
        game({ teamPosition: 'UTILITY', championName: 'Nautilus' })));
    assert.ok(!support.allInputs.some(m => m.id === 'soloKillDiff'), 'support is not judged on solo kills');
});

test('tilt flag only counts losses within one session', () => {
    const rows = [
        game({ win: 0 }), game({ win: 0 }),
        game({ win: 0 }),   // third game, after 2 losses, same session
    ];
    let enriched = Engine._internal.enrich(rows);
    assert.strictEqual(enriched[2]._afterTwoLosses, true, 'same-session third game is tilted');

    // Same three games but with a long break before the third
    const spaced = [game({ win: 0 }), game({ win: 0 })];
    clock += 5 * HOUR;
    spaced.push(game({ win: 0 }));
    enriched = Engine._internal.enrich(spaced);
    assert.strictEqual(enriched[2]._afterTwoLosses, false, 'a 5-hour break resets the tilt count');
});

test('a streaky but behaviour-free history never produces a tilt focus', () => {
    // Wins and losses in runs of 6, with nothing about the player changing.
    // Splitting on win rate makes this look like catastrophic tilt, because
    // games inside a losing run are losses by definition. It must not become
    // the thing the board tells the player to fix.
    const rows = [];
    for (let block = 0; block < 14; block++) {
        const winning = block % 2 === 0;
        for (let i = 0; i < 6; i++) rows.push(game({ win: winning ? 1 : 0 }));
    }

    const out = Engine.analyse(rows);
    const tilt = out.allInputs.find(m => m.id === 'tiltQueue');

    assert.ok(tilt.gap > 20, `the circular gap is genuinely large here: ${tilt.gap.toFixed(1)}`);
    assert.strictEqual(tilt.circular, true);
    assert.notStrictEqual(out.focus && out.focus.id, 'tiltQueue',
        'a circular metric must never be selected as the focus');

});

test('champion pool flag tracks the top three by games played', () => {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push(game({ championName: 'Sejuani' }));
    for (let i = 0; i < 8; i++)  rows.push(game({ championName: 'Vi' }));
    for (let i = 0; i < 6; i++)  rows.push(game({ championName: 'Nocturne' }));
    for (let i = 0; i < 2; i++)  rows.push(game({ championName: 'Ivern' }));

    const enriched = Engine._internal.enrich(rows);
    const ivern = enriched.filter(r => r.championName === 'Ivern');
    const sej   = enriched.filter(r => r.championName === 'Sejuani');
    assert.ok(ivern.every(r => r._onMainChamp === false), 'Ivern is off-pool');
    assert.ok(sej.every(r => r._onMainChamp === true),   'Sejuani is a main');
});

test('outcomes are reported but never ranked as tasks', () => {
    const out = Engine.analyse(Array.from({ length: 40 }, () => game()));
    const ids = out.allInputs.map(m => m.id);
    for (const outcome of ['dragons', 'barons', 'turrets', 'kp', 'firstBlood']) {
        assert.ok(!ids.includes(outcome), `${outcome} must not be a coachable input`);
        assert.ok(out.reference.some(r => r.id === outcome), `${outcome} should appear as evidence`);
    }
    assert.ok(out.focus === null || out.focus.kind === 'input', 'focus is always an input');
});

test('empty and tiny inputs degrade gracefully', () => {
    const empty = Engine.analyse([]);
    assert.strictEqual(empty.empty, true);
    assert.strictEqual(empty.focus, null);
    assert.deepStrictEqual(empty.watch, []);

    const one = Engine.analyse([game()]);
    assert.strictEqual(one.empty, false);
    assert.strictEqual(one.sampleSize, 1);
});
