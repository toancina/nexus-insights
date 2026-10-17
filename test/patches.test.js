/**
 * Issue #6: patch per game, patch / time-window filters, win rate by patch.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { stubDatabase, makeMatch, SRC } = require('./helpers');

stubDatabase([]);
global.window = global.window || {};
const P = require(path.join(SRC, 'services', 'patches.js'));
const { computeAdvancedStatsForMatch } = require(path.join(SRC, 'services', 'matchService.js'));

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 16, 12);

test('patchOf: major.minor from Riot\'s gameVersion', () => {
    assert.equal(P.patchOf('16.20.719.1234'), '16.20');
    assert.equal(P.patchOf('16.3.1'), '16.3');
    assert.equal(P.patchOf(''), '');
    assert.equal(P.patchOf(undefined), '');
    assert.equal(P.patchOf('garbage'), '');
});

test('patches sort by number, not text (16.10 is newer than 16.9)', () => {
    assert.deepEqual(['16.9', '16.10', '15.24', '16.2'].sort(P.comparePatchDesc), ['16.10', '16.9', '16.2', '15.24']);
});

test('patchList: patches present, newest first, with game counts; unknown left out', () => {
    const ms = [makeMatch({ patch: '16.19' }), makeMatch({ patch: '16.20' }), makeMatch({ patch: '16.20' }),
                makeMatch({ patch: '' }), makeMatch({ patch: null })];
    assert.deepEqual(P.patchList(ms), [{ patch: '16.20', games: 2 }, { patch: '16.19', games: 1 }]);
});

test('filterByPeriod: last N patches, one patch, and time windows', () => {
    const ms = [
        makeMatch({ matchId: 'a', patch: '16.18', gameCreation: NOW - 40 * DAY }),
        makeMatch({ matchId: 'b', patch: '16.19', gameCreation: NOW - 20 * DAY }),
        makeMatch({ matchId: 'c', patch: '16.20', gameCreation: NOW - 6 * DAY }),
        makeMatch({ matchId: 'd', patch: '16.20', gameCreation: NOW - 1 * DAY }),
        makeMatch({ matchId: 'e', patch: null, gameCreation: NOW - 2 * DAY }),   // not indexed yet
    ];
    const ids = (period) => P.filterByPeriod(ms, period, { now: NOW }).map(m => m.matchId);
    assert.deepEqual(ids(''), ['a', 'b', 'c', 'd', 'e'], 'no period = everything');
    assert.deepEqual(ids('patches:1'), ['c', 'd']);
    assert.deepEqual(ids('patches:2'), ['b', 'c', 'd']);
    assert.deepEqual(ids('patch:16.19'), ['b']);
    assert.deepEqual(ids('days:7'), ['c', 'd', 'e']);
    assert.deepEqual(ids('days:30'), ['b', 'c', 'd', 'e']);
    assert.deepEqual(ids('nonsense'), ['a', 'b', 'c', 'd', 'e'], 'an unknown period filters nothing');
});

test('patchWinRates: newest first, capped, with win rate', () => {
    const ms = [
        makeMatch({ patch: '16.20', win: 1 }), makeMatch({ patch: '16.20', win: 0 }),
        makeMatch({ patch: '16.19', win: 1 }), makeMatch({ patch: '16.18', win: 0 }),
    ];
    const rows = P.patchWinRates(ms, 2);
    assert.deepEqual(rows.map(r => [r.patch, r.games, r.wins]), [['16.20', 2, 1], ['16.19', 1, 1]]);
    assert.equal(rows[0].winRate, 0.5);
});

test('periodLabel names every option the dropdown offers', () => {
    assert.equal(P.periodLabel('patches:2'), 'Last 2 patches');
    assert.equal(P.periodLabel('patch:16.20'), 'Patch 16.20');
    assert.equal(P.periodLabel('days:90'), 'Last 3 months');
    assert.equal(P.periodLabel(''), 'All time');
});

test('the patch is stored per game by the computed-stats pipeline', () => {
    const raw = { info: { gameDuration: 1800, gameVersion: '16.20.719.1234', participants: [
        { participantId: 1, teamId: 100, championName: 'Ahri', teamPosition: 'MIDDLE' },
    ] } };
    assert.equal(computeAdvancedStatsForMatch(raw, null, 'Ahri', 100).patch, '16.20');
    delete raw.info.gameVersion;
    assert.equal(computeAdvancedStatsForMatch(raw, null, 'Ahri', 100).patch, '', "'' when Riot didn't say");
});

test('ddragonVersionForPatch: the game patch\'s own Data Dragon version (#67)', () => {
    const { ddragonVersionForPatch } = require(path.join(SRC, 'services', 'patches.js'));
    const versions = ['16.20.1', '16.19.1', '16.10.1', '16.2.1', '15.24.1', '15.1.2', '15.1.1'];
    assert.equal(ddragonVersionForPatch('16.10', versions), '16.10.1');
    assert.equal(ddragonVersionForPatch('16.1', versions), '16.1.1');     // not listed: guess .1 (not "16.10.1")
    assert.equal(ddragonVersionForPatch('15.1', versions), '15.1.2');     // newest listed build of the patch
    assert.equal(ddragonVersionForPatch('16.2', []), '16.2.1');           // versions.json not loaded (offline)
    assert.equal(ddragonVersionForPatch('', versions), null);             // unknown patch: current version
    assert.equal(ddragonVersionForPatch(null, versions), null);
    assert.equal(ddragonVersionForPatch('16.2.1', versions), null);       // not a major.minor patch
});
