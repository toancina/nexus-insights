const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { stubDatabase, makeMatch, SRC } = require('./helpers');

stubDatabase([]);
global.window = global.window || {};
require(path.join(SRC, 'components', 'analyticsEngine.js'));
const P = require(path.join(SRC, 'components', 'coachingProgress.js'));
const Engine = require(path.join(SRC, 'components', 'coachingEngine.js'));
const cts = window.computeTabStats;

const DAY = 86400000;
function series(n, f) {
    return Array.from({ length: n }, (_, i) => makeMatch(Object.assign({
        matchId: 'EUW1_' + i, queueId: 420, teamPosition: 'JUNGLE',
        gameCreation: Date.UTC(2026, 5, 1) + i * DAY, gameDuration: 1800,
    }, f(i))));
}

test('only Solo/Duo, no remakes, oldest first', () => {
    const all = [
        makeMatch({ matchId: 'a', queueId: 420, gameCreation: 3 }),
        makeMatch({ matchId: 'b', queueId: 440, gameCreation: 2 }),
        makeMatch({ matchId: 'c', queueId: 420, gameCreation: 1 }),
        makeMatch({ matchId: 'd', queueId: 420, gameCreation: 4, gameDuration: 200 }),
    ];
    assert.deepEqual(P.soloGames(all).map(g => g.matchId), ['c', 'a']);
});

test('last-game report uses the Analytics formulas and compares with the 20 games before', () => {
    // 25 ordinary games, then one great game
    const games = series(26, i => i < 25
        ? { kills: 3, deaths: 5, assists: 5, win: i % 2 }
        : { kills: 12, deaths: 1, assists: 10, win: 1 });
    const r = P.lastGameReport(games, games.length - 1, cts);
    assert.equal(r.baselineCount, 20);
    const kda = r.stats.find(s => s.id === 'avg_kda');
    // same number the Overview card would show for that one game
    const card = cts('Overview', [games[25]]).find(c => c.id === 'avg_kda');
    assert.equal(kda.value, card.value);
    assert.equal(kda.verdict, 'better');
    assert.ok(r.better >= 1);
});

test('stepping back compares an earlier game with the games before IT', () => {
    const games = series(30, () => ({ kills: 3, deaths: 3, assists: 3 }));
    const r = P.lastGameReport(games, 5, cts);
    assert.equal(r.index, 5);
    assert.equal(r.baselineCount, 5);
    assert.equal(P.lastGameReport(games, 999, cts).index, 29, 'clamped to the newest game');
});

test('tiny differences count as "same", not better/worse', () => {
    const { verdict } = P._internal;
    assert.equal(verdict(2.71, 2.68, true, 0.15), 'same');
    assert.equal(verdict(3.5, 2.68, true, 0.15), 'better');
    assert.equal(verdict(1, 0.6, false, 0.2), 'worse');
    assert.equal(verdict(null, 1, true, 0.1), null);
});

test('focus dots: hit/missed per game for the last 10, compared with the 10 before', () => {
    // early deaths: bad for 10 games, then good for 10
    const games = series(20, i => ({ deathsBefore10: i < 10 ? 2 : 0 }));
    const hits = P.focusHits(games, Engine, 'earlyDeaths', 'JUNGLE');
    assert.equal(hits.dots.length, 10);
    assert.ok(hits.dots.every(d => d.met === true));
    assert.deepEqual(hits.recent, { hit: 10, of: 10 });
    assert.deepEqual(hits.before, { hit: 0, of: 10 });
});

test('area trends: last 10 vs the 10 before, with a rolling sparkline', () => {
    // deaths drop sharply in the last 10 games
    const games = series(30, i => i < 20
        ? { deaths: 8, deathsBefore10: 2, isolatedDeaths: 4, kills: 4, assists: 6 }
        : { deaths: 2, deathsBefore10: 0, isolatedDeaths: 1, kills: 4, assists: 6 });
    const areas = P.areaTrends(games, cts);
    assert.deepEqual(areas.map(a => a.tab), P.AREAS.map(a => a.tab));
    const dr = areas.find(a => a.tab === 'Death Review');
    assert.equal(dr.verdict, 'improving');
    assert.equal(dr.spark.length, 21, 'one point per 10-game window ending at games 10..30');
    assert.equal(P.areaTrends(games.slice(0, 5), cts).length, 0, 'needs at least 10 games');
});

test('rank header: W-L and LP over the last 10, saying how many had LP tracked', () => {
    const games = series(12, i => ({ win: i % 3 !== 0 }));
    const h = P.rankHeader(games, { EUW1_11: 20, EUW1_10: -15, EUW1_0: 99 });
    assert.equal(h.games, 10);
    assert.equal(h.wins + h.losses, 10);
    assert.equal(h.lpChange, 5);
    assert.equal(h.lpTracked, 2);
    assert.equal(P.rankHeader(games, {}).lpChange, null);
});

// ── Per-role report (2026-10) ──────────────────────────────────────────────
const Roles = require(path.join(SRC, 'components', 'roleBenchmarks.js'));

test('report shows 4 general + 4 role stats for the role played that game', () => {
    const games = series(10, () => ({ kills: 3, deaths: 3, assists: 3 }));
    games[9].teamPosition = 'UTILITY';
    const r = P.lastGameReport(games, 9, cts);
    assert.equal(r.role, 'UTILITY');
    const ids = r.stats.map(s => s.id);
    for (const id of Roles.GENERAL_STATS) assert.ok(ids.includes(id), id);
    for (const id of ['vis_vs_min', 'vis_control', 'vis_killed']) assert.ok(ids.includes(id), id);
    assert.ok(!ids.includes('cs_10'), 'support report has no CS at 10');
});

test('"usual" means earlier games in the same role, falling back to all roles', () => {
    // 20 jungle games, then 6 mid games, then the mid game we look at
    const games = series(27, i => ({ teamPosition: i < 20 ? 'JUNGLE' : 'MIDDLE', kills: 3, deaths: 3, assists: 3 }));
    const r = P.lastGameReport(games, 26, cts);
    assert.equal(r.baselineByRole, true);
    assert.equal(r.baselineCount, 6);
    // only 2 earlier mid games → all roles
    const r2 = P.lastGameReport(games, 22, cts);
    assert.equal(r2.baselineByRole, false);
    assert.equal(r2.baselineCount, 20);
});

test('badges use role thresholds: support CS and jungle damage are judged by their role', () => {
    const supportCsm = Roles.benchmarkFor('avg_csm', 'UTILITY', () => null);
    assert.equal(Roles.tierFor(1.7, supportCsm, true), 'emerald');
    // falls back to the general ladder when the role has no override
    const general = window.getStatBenchmark;
    assert.deepEqual(Roles.benchmarkFor('gd_15', 'JUNGLE', general), general('gd_15'));
    // same >= / <= rule as the Analytics cards
    const t = Roles.ROLE_BENCHMARKS.TOP.dr_isolated;
    assert.equal(Roles.tierFor(t.gold, t, false), 'gold');
    assert.equal(Roles.tierFor(99, t, false), 'iron');
});

test('every role stat has a label, a tab and a tolerance', () => {
    for (const role of [...Roles.ROLES, 'UNKNOWN']) {
        for (const id of Roles.statsForRole(role)) {
            const i = Roles.STAT_INFO[id];
            assert.ok(i && i.tab && i.label && i.tol > 0, `${role} ${id}`);
        }
        assert.equal(Roles.statsForRole(role).length, 8, role);
    }
    for (const [role, stats] of Object.entries(Roles.ROLE_BENCHMARKS))
        for (const [id, l] of Object.entries(stats))
            assert.deepEqual(Object.keys(l), Roles.TIERS, `${role} ${id}`);
});

test('a trend switched to "all games" uses every game: newer half vs. older half', () => {
    // deaths fall steadily across 40 games
    const games = series(40, i => ({ kills: 3, deaths: Math.max(1, 8 - Math.floor(i / 6)), assists: 4,
        deathsBefore10: i < 20 ? 1 : 0, isolatedDeaths: i < 20 ? 3 : 1 }));
    const out = P.areaTrends(games, cts, 30, { all: ['Death Review'] });
    const dr = out.find(a => a.tab === 'Death Review');
    const lane = out.find(a => a.tab === 'Lane Phase');
    assert.equal(dr.mode, 'all');
    assert.equal(dr.games, 40);
    assert.equal(lane.mode, 'recent');
    assert.equal(lane.games, 10);
    // lead value = the Death Review card over ALL games
    const card = cts('Death Review', games).find(c => c.id === 'dr_avg_deaths');
    assert.equal(dr.lead.display, card.displayValue);
    assert.equal(dr.verdict, 'improving');
    assert.ok(dr.spark.length > 1 && dr.spark.length <= 30);
});

// ── Compared with the fetched players (sample games, 2026-11) ────────────────
const { sampleGroups } = require(path.join(SRC, 'services', 'sampleSelect.js'));
const GROUPS = sampleGroups({ tier: 'SILVER', rank: 'II' });
function sampleRows(tier, n, f = () => ({})) {
    return Array.from({ length: n }, (_, i) => makeMatch(Object.assign({
        matchId: `S-${tier}-${i}-${Math.random()}`, queueId: 420, teamPosition: 'JUNGLE', gameDuration: 1800,
        tier, division: 'I', dmgShare: 0.2,
    }, f(i))));
}

test('report: each stat also shows the fetched players\' value, per group, same role when 5+ games', () => {
    const games = series(26, i => ({ kills: 3, deaths: 5, assists: 5, win: i % 2 }));
    const silver = sampleRows('SILVER', 6, () => ({ kills: 6, deaths: 3, assists: 6 }));
    const goldJungle = sampleRows('GOLD', 6, () => ({ kills: 9, deaths: 3, assists: 9 }));
    const goldTop = sampleRows('GOLD', 3, () => ({ teamPosition: 'TOP', kills: 0, deaths: 9, assists: 0 }));
    const noStats = sampleRows('SILVER', 4, () => ({ dmgShare: undefined, kills: 50 }));   // stored before rows had stats
    const rows = [...silver, ...goldJungle, ...goldTop, ...noStats];

    const r = P.lastGameReport(games, 25, cts, { samples: { rows, groups: GROUPS } });
    const kda = r.stats.find(s => s.id === 'avg_kda');
    const level = kda.groups.find(g => g.key === 'level');
    const above = kda.groups.find(g => g.key === 'above');
    const value = list => cts('Overview', list).find(c => c.id === 'avg_kda').value;
    assert.equal(level.label, 'Silver I');
    assert.equal(level.value, value(silver), 'rows without stats are left out');
    assert.equal(level.games, 6);
    assert.equal(above.value, value(goldJungle), 'only the role played that game');
    assert.equal(above.byRole, true);
    assert.equal(P.lastGameReport(games, 25, cts).stats[0].groups, undefined, 'nothing new without sample games');

    // Fewer than 5 in the role: the group's games in every role
    const thin = P.lastGameReport(games, 25, cts, { samples: { rows: [...silver, ...goldTop], groups: GROUPS } });
    const thinAbove = thin.stats.find(s => s.id === 'avg_kda').groups.find(g => g.key === 'above');
    assert.equal(thinAbove.byRole, false);
    assert.equal(thinAbove.value, value(goldTop));
});

test('trends: each area card shows the fetched players\' value of its lead stat', () => {
    const games = series(20, i => ({ goldDiff15: 100 * i, win: i % 2 }));
    const silver = sampleRows('SILVER', 6, i => ({ goldDiff15: 500 + i }));
    const gold = sampleRows('GOLD', 6, i => ({ goldDiff15: 900 + i }));
    const areas = P.areaTrends(games, cts, 30, { samples: { rows: [...silver, ...gold], groups: GROUPS } });
    const lane = areas.find(a => a.tab === 'Lane Phase');
    const lead = list => cts('Lane Phase', list).find(c => c.id === 'gd_15');
    assert.equal(lane.groups.find(g => g.key === 'level').display, lead(silver).displayValue);
    assert.equal(lane.groups.find(g => g.key === 'above').value, lead(gold).value);
    assert.equal(P.areaTrends(games, cts, 30).find(a => a.tab === 'Lane Phase').groups, undefined);
});
