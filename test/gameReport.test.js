/**
 * Issue #9: per-game report — comparison with your season / patch / week,
 * highlights and timeline blunders.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { stubDatabase, makeMatch, SRC } = require('./helpers');

stubDatabase([]);
global.window = global.window || {};
require(path.join(SRC, 'components', 'analyticsEngine.js'));
const R = require(path.join(SRC, 'services', 'gameReport.js'));
const cts = window.computeTabStats;

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 16, 18);
const MIN = 60000;

test('pools: same queue and role, never the game itself; patch; 7 days before', () => {
    const game = makeMatch({ matchId: 'g', queueId: 420, teamPosition: 'TOP', patch: '16.20', gameCreation: NOW });
    const all = [
        game,
        makeMatch({ matchId: 'a', queueId: 420, teamPosition: 'TOP', patch: '16.20', gameCreation: NOW - 2 * DAY }),
        makeMatch({ matchId: 'b', queueId: 420, teamPosition: 'TOP', patch: '16.19', gameCreation: NOW - 20 * DAY }),
        makeMatch({ matchId: 'c', queueId: 420, teamPosition: 'MIDDLE', patch: '16.20', gameCreation: NOW - DAY }),
        makeMatch({ matchId: 'd', queueId: 440, teamPosition: 'TOP', patch: '16.20', gameCreation: NOW - DAY }),
        makeMatch({ matchId: 'e', queueId: 420, teamPosition: 'TOP', patch: '16.20', gameCreation: NOW + DAY }),  // after
    ];
    const p = R.comparisonPools(game, all);
    assert.deepEqual(p.season.map(m => m.matchId), ['a', 'b', 'e']);
    assert.deepEqual(p.patch.map(m => m.matchId), ['a', 'e']);
    assert.deepEqual(p.week.map(m => m.matchId), ['a']);
});

test('verdict: ±10%, direction-aware, with a floor for differences near 0', () => {
    assert.equal(R.verdict(9.1, 8.1, true), 'good');
    assert.equal(R.verdict(8.5, 8.1, true), 'even');
    assert.equal(R.verdict(7, 5, false), 'bad', 'more deaths is worse');
    assert.equal(R.verdict(150, 20, true, 1000), 'good', '+130 gold vs a 1000 floor is 13%');
    assert.equal(R.verdict(60, 20, true, 1000), 'even', '+40 gold is noise, not +200%');
    assert.equal(R.verdict(null, 5, true), null);
});

test('compareGame: values from computeTabStats, and needs 3 games to compare', () => {
    const base = { queueId: 420, teamPosition: 'TOP', gameDuration: 1800, teamKills: 30 };
    // Same game in every way except CS: 9 CS/min against a usual 7
    const same = { kills: 4, deaths: 6, assists: 4, totalDamageDealtToChampions: 20000, goldEarned: 11000 };
    const game = makeMatch({ ...base, ...same, matchId: 'g', gameCreation: NOW, totalMinionsKilled: 270 });
    const season = Array.from({ length: 5 }, (_, i) => makeMatch({ ...base, ...same, matchId: `s${i}`, gameCreation: NOW - (10 + i) * DAY,
        totalMinionsKilled: 210 }));
    const { rows, games } = R.compareGame(game, [game, ...season], cts);
    assert.deepEqual(games, { season: 5, patch: 0, week: 0 });

    const csm = rows.find(r => r.id === 'avg_csm');
    assert.equal(csm.game.value, 9);
    assert.equal(csm.season.value, 7);
    assert.equal(csm.season.verdict, 'good');
    assert.equal(csm.week, null, 'no games in the week before: no comparison');

    const h = R.highlights(rows);
    assert.equal(h.good[0], '9.0 CS/min, +29% vs your season average');
    assert.deepEqual(h.bad, []);

    // Fewer deaths is the good direction
    const careful = makeMatch({ ...base, ...same, matchId: 'c', gameCreation: NOW, totalMinionsKilled: 210, deaths: 2 });
    const d = R.compareGame(careful, [careful, ...season], cts).rows.find(r => r.id === 'dr_avg_deaths');
    assert.equal(d.season.verdict, 'good');
});

// ---------------------------------------------------------------------------
function rawAndTimeline(deaths, { gold = () => 0 } = {}) {
    const raw = { info: { participants: Array.from({ length: 10 }, (_, i) => ({
        participantId: i + 1, teamId: i < 5 ? 100 : 200, championName: i === 6 ? 'Zed' : `C${i + 1}`,
    })) } };
    const frames = [];
    for (let m = 0; m <= 30; m++) {
        const pf = {};
        for (let p = 1; p <= 10; p++) pf[p] = { totalGold: p <= 5 ? gold(m) : 0, xp: 0 };
        frames.push({ timestamp: m * MIN, participantFrames: pf,
            events: deaths.filter(d => d.t > (m - 1) * MIN && d.t <= m * MIN)
                .map(d => ({ type: 'CHAMPION_KILL', timestamp: d.t, victimId: 1, killerId: d.killer })) });
    }
    return { raw, timeline: { info: { frames } } };
}

test('blunders: early death, same killer three times, two deaths close together', () => {
    const { raw, timeline } = rawAndTimeline([
        { t: 2.5 * MIN, killer: 7 }, { t: 9 * MIN, killer: 7 }, { t: 21 * MIN, killer: 8 }, { t: 22.5 * MIN, killer: 7 },
    ]);
    const b = R.blunders(raw, timeline, 1, 100);
    assert.deepEqual(b, [
        'Died in the first 3 minutes (2:30)',
        'Died to Zed three times',
        'Died twice within 3 minutes around 22:30',
    ]);
});

test('blunders: deaths while ahead and the death that cost the most', () => {
    // Per player: team 100 is 2,500 gold ahead at 20:00 (~73%), then throws
    const gold = m => (m <= 20 ? m * 25 : 500 - (m - 20) * 600);
    const { raw, timeline } = rawAndTimeline([{ t: 20.2 * MIN, killer: 9 }], { gold });
    const b = R.blunders(raw, timeline, 1, 100);
    assert.equal(b[0], '1 death while your team was ahead (win chance 60%+)');
    assert.match(b[1], /^The death at 20:12 cost the most: win chance \d+% → \d+%$/);
});

test('no deaths, no blunders; at most three', () => {
    assert.deepEqual(R.blunders(rawAndTimeline([]).raw, rawAndTimeline([]).timeline, 1, 100), []);
    const many = rawAndTimeline([{ t: MIN, killer: 7 }, { t: 2 * MIN, killer: 7 }, { t: 3 * MIN, killer: 7 }, { t: 10 * MIN, killer: 8 }]);
    assert.equal(R.blunders(many.raw, many.timeline, 1, 100).length, 3);
});

test('blunders use the fitted curve when one is configured', () => {
    const winCurve = require(path.join(SRC, 'services', 'winCurve.js'));
    const gold = m => (m <= 20 ? m * 25 : 500 - (m - 20) * 600);
    const { raw, timeline } = rawAndTimeline([{ t: 20.2 * MIN, killer: 9 }], { gold });
    // A model that reads a gold lead backwards: the team that was "ahead" is now behind
    winCurve.configure({ enabled: true, model: { ok: true, coef: [-1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } });
    try {
        const b = R.blunders(raw, timeline, 1, 100);
        assert.ok(!b.some(x => /while your team was ahead/.test(x)), b.join(' | '));
    } finally {
        winCurve.configure({ enabled: false, model: null });
    }
    assert.equal(R.blunders(raw, timeline, 1, 100)[0], '1 death while your team was ahead (win chance 60%+)');
});
