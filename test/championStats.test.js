const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { makeMatch, SRC } = require('./helpers');

const C = require(path.join(SRC, 'services', 'championStats.js'));

/** A game on `champ`; items default to none so tests name the ones they mean. */
const game = (champ, extra = {}) => makeMatch({
    championName: champ, teamPosition: 'MIDDLE',
    item0: 0, item1: 0, item2: 0, item3: 0, item4: 0, item5: 0, item6: 3340,
    laneOpponent: 'Zed', ...extra,
});

test('summary uses the Overview formulas (summed KDA, per-game CS/min, KP)', () => {
    const s = C.summarize([
        game('Ahri', { win: 1, kills: 10, deaths: 2, assists: 6, teamKills: 32, totalMinionsKilled: 240, gameDuration: 1800, totalDamageDealtToChampions: 30000 }),
        game('Ahri', { win: 0, kills: 2, deaths: 6, assists: 4, teamKills: 12, totalMinionsKilled: 150, gameDuration: 1500, totalDamageDealtToChampions: 15000 }),
    ]);
    assert.equal(s.games, 2);
    assert.equal(s.wins, 1);
    assert.equal(s.winRate, 0.5);
    assert.equal(s.kda, (10 + 2 + 6 + 4) / (2 + 6));
    assert.equal(s.csPerMin, (8 + 6) / 2);
    assert.equal(s.dmgPerMin, (1000 + 600) / 2);
    assert.equal(s.kp, (0.5 + 0.5) / 2);
    assert.equal(s.impactRank, null, 'no impact stored yet');
    assert.equal(C.summarize([]).games, 0);
});

test('champion table: one row per champion, most played first, with roles', () => {
    const rows = C.championTable([
        game('Ahri'), game('Ahri', { teamPosition: 'TOP' }), game('Ahri'),
        game('Zed', { impactRank: 2 }), game('Zed', { impactRank: 4 }),
        game('Lux', { teamPosition: 'UTILITY' }),
    ]);
    assert.deepEqual(rows.map(r => [r.champion, r.games]), [['Ahri', 3], ['Zed', 2], ['Lux', 1]]);
    assert.deepEqual(rows[0].roles, [{ role: 'MIDDLE', games: 2 }, { role: 'TOP', games: 1 }]);
    assert.equal(rows[0].mainRole, 'MIDDLE');
    assert.equal(rows[1].impactRank, 3);
});

test('sortRows: by any column, nulls always last, ties by games', () => {
    const rows = [
        { champion: 'A', games: 5, winRate: 0.4, impactRank: null },
        { champion: 'B', games: 9, winRate: 0.6, impactRank: 3 },
        { champion: 'C', games: 2, winRate: 0.6, impactRank: 5 },
    ];
    assert.deepEqual(C.sortRows(rows, 'winRate', 'desc').map(r => r.champion), ['B', 'C', 'A']);
    assert.deepEqual(C.sortRows(rows, 'winRate', 'asc').map(r => r.champion), ['A', 'B', 'C']);
    assert.deepEqual(C.sortRows(rows, 'impactRank', 'asc').map(r => r.champion), ['B', 'C', 'A']);
    assert.deepEqual(C.sortRows(rows, 'impactRank', 'desc').map(r => r.champion), ['C', 'B', 'A']);
    assert.deepEqual(C.sortRows(rows, 'champion', 'asc').map(r => r.champion), ['A', 'B', 'C']);
    assert.notEqual(C.sortRows(rows, 'winRate', 'desc'), rows, 'returns a new array');
});

test('sortRows with minGames: small samples sink below the rest on stat columns', () => {
    const rows = [
        { champion: 'OneGame', games: 1, winRate: 1 },
        { champion: 'Main', games: 40, winRate: 0.55 },
        { champion: 'Second', games: 12, winRate: 0.48 },
        { champion: 'Few', games: 3, winRate: 0.67 },
    ];
    assert.deepEqual(C.sortRows(rows, 'winRate', 'desc', { minGames: 5 }).map(r => r.champion),
        ['Main', 'Second', 'OneGame', 'Few']);
    assert.deepEqual(C.sortRows(rows, 'winRate', 'asc', { minGames: 5 }).map(r => r.champion),
        ['Second', 'Main', 'Few', 'OneGame']);
    // Name and game-count sorts are about the list itself, not a rate: no sinking
    assert.deepEqual(C.sortRows(rows, 'champion', 'asc', { minGames: 5 }).map(r => r.champion),
        ['Few', 'Main', 'OneGame', 'Second']);
    assert.deepEqual(C.sortRows(rows, 'games', 'asc', { minGames: 5 }).map(r => r.champion),
        ['OneGame', 'Few', 'Second', 'Main']);
});

test('detail: rune pages and core items with pick and win rates', () => {
    const games = [
        game('Ahri', { win: 1, primaryRune: 8112, secondaryRuneStyle: 8200, item0: 3020, item1: 6655, item2: 1056 }),
        game('Ahri', { win: 1, primaryRune: 8112, secondaryRuneStyle: 8200, item0: 6655, item1: 3089, item2: 6655 }),
        game('Ahri', { win: 0, primaryRune: 8369, secondaryRuneStyle: 8300, item0: 3020, item1: 3089 }),
        game('Ahri', { win: 0, primaryRune: 8112, secondaryRuneStyle: 8300, item0: 6655 }),
        game('Zed',  { win: 1, primaryRune: 8112, secondaryRuneStyle: 8200, item0: 6655 }),
    ];
    const isCore = id => id !== 1056 && id !== 3340;          // Doran's Ring + trinket aren't
    const d = C.championDetail(games, 'Ahri', { isCoreItem: isCore });

    assert.equal(d.summary.games, 4);
    assert.deepEqual(d.runes.map(r => [r.keystone, r.secondary, r.games, r.wins]),
        [[8112, 8200, 2, 2], [8369, 8300, 1, 0], [8112, 8300, 1, 0]]);
    assert.equal(d.runes[0].pickRate, 0.5);
    assert.equal(d.runes[0].winRate, 1);

    // Counted once per game even when bought twice; the trinket slot is ignored
    assert.deepEqual(d.items.map(i => [i.itemId, i.games, i.wins]),
        [[6655, 3, 2], [3020, 2, 1], [3089, 2, 1]]);
    assert.equal(d.items[0].pickRate, 0.75);
});

test('detail: role filter narrows everything, role list still covers all roles', () => {
    const games = [game('Ahri'), game('Ahri'), game('Ahri', { teamPosition: 'TOP', win: 0 })];
    const d = C.championDetail(games, 'Ahri', { role: 'TOP' });
    assert.equal(d.summary.games, 1);
    assert.equal(d.summary.winRate, 0);
    assert.deepEqual(d.roles.map(r => r.role), ['MIDDLE', 'TOP']);
});

test('detail: matchups vs lane opponent, with lane diffs and what you built', () => {
    const games = [
        game('Ahri', { laneOpponent: 'Syndra', win: 0, goldDiff15: -800, csDiff15: -12, item0: 3165, primaryRune: 8112 }),
        game('Ahri', { laneOpponent: 'Syndra', win: 0, goldDiff15: -400, csDiff15: -4, item0: 3165, primaryRune: 8112 }),
        game('Ahri', { laneOpponent: 'Syndra', win: 1, goldDiff15: null, csDiff15: null, item0: 6655, primaryRune: 8369 }),
        game('Ahri', { laneOpponent: 'Zed', win: 1, goldDiff15: 300, csDiff15: 6, item0: 6655 }),
        game('Ahri', { laneOpponent: '', win: 1 }),           // no lane opponent (no position)
        game('Ahri', { laneOpponent: null, win: 1 }),         // not indexed yet
    ];
    const d = C.championDetail(games, 'Ahri');
    assert.deepEqual(d.matchups.map(m => [m.opponent, m.games, m.wins]), [['Syndra', 3, 1], ['Zed', 1, 1]]);
    const syndra = d.matchups[0];
    assert.equal(syndra.gd15, -600, 'averaged over games that have it');
    assert.equal(syndra.csd15, -8);
    assert.deepEqual(syndra.items.map(i => [i.itemId, i.games]), [[3165, 2], [6655, 1]]);
    assert.deepEqual(syndra.runes.map(r => [r.keystone, r.games]), [[8112, 2], [8369, 1]]);
    assert.equal(d.unmatched, 2, 'games without a known lane opponent are counted, not hidden');
});

test('roleLabel', () => {
    assert.equal(C.roleLabel('UTILITY'), 'Support');
    assert.equal(C.roleLabel('BOTTOM'), 'ADC');
    assert.equal(C.roleLabel(''), 'No role');
});

test('championDetail rune rows carry edge and edgeMargin (points vs the champion\'s win rate)', () => {
    const g = (win, primaryRune, i) => makeMatch({ matchId: `R${primaryRune}-${i}`, championName: 'Yorick', win, primaryRune, secondaryRuneStyle: 8400 });
    const games = [
        ...[1, 1, 1, 1, 0].map((w, i) => g(w, 8010, i)),    // 4/5
        ...[1, 1, 0, 0, 0].map((w, i) => g(w, 8021, i)),    // 2/5
    ];
    const d = C.championDetail(games, 'Yorick');
    const page = d.runes.find(r => r.keystone === 8010);
    assert.ok(Math.abs(page.edge - 20) < 1e-9);
    assert.ok(Math.abs(page.edgeMargin - 1.96 * Math.sqrt(0.8 * 0.2 / 5) * 100) < 1e-9);
    assert.ok(Math.abs(d.runes.find(r => r.keystone === 8021).edge + 20) < 1e-9);
    // A page that always won still has a margin
    const perfect = C.championDetail([...[1, 1, 1].map((w, i) => g(w, 8010, i)), g(0, 8021, 9)], 'Yorick').runes.find(r => r.keystone === 8010);
    assert.ok(perfect.edgeMargin > 0);
});
