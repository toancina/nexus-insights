const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/components/coachingEngine');
const Board = require('../src/components/coachingBoard');

let clock = new Date('2026-03-01T12:00:00Z').getTime();
/** A Solo/Duo game; each call is 30 minutes after the last. */
function game(overrides = {}) {
    clock += 30 * 60000;
    return Object.assign({
        matchId: 'M' + clock, gameCreation: clock, gameDuration: 1800, queueId: 420,
        win: 0, championName: 'Sejuani', teamPosition: 'JUNGLE',
        kills: 3, deaths: 4, assists: 8, teamKills: 25,
        deathsBefore10: 0, isolatedDeaths: 1, detectorWardsPlaced: 4, cs10: 62,
        goldDiff15: 0, xpDiff15: 0, soloKillDiff: 0, objectiveRate: 100, visionScore: 38,
        teamDragons: 2, teamBarons: 1, turretKills: 2, firstBlood: 0,
    }, overrides);
}
/** n games where `hit` of them (the last ones) die before 10 zero times. */
const block = (n, hits) => Array.from({ length: n }, (_, i) => game({ deathsBefore10: i >= n - hits ? 0 : 2 }));
const statusOf = (board, id) => board.tickets.concat(board.tooFew).find(t => t.id === id).status;

test('statusFor: each column, worst to best (#61)', () => {
    const s = (hit, of, bHit, bOf) => Board.statusFor({ hit, of }, bOf ? { hit: bHit, of: bOf } : null);
    assert.equal(s(7, 10, 2, 10), 'ontrack');      // 7 of 10 is on track, whatever came before
    assert.equal(s(10, 10, 10, 10), 'ontrack');
    assert.equal(s(6, 10, 8, 10), 'slipping');     // was on track, isn't now
    assert.equal(s(5, 10, 2, 10), 'improving');    // below target, more hits than before
    assert.equal(s(3, 10, 3, 10), 'needs');        // a tie isn't improving
    assert.equal(s(2, 10, 5, 10), 'needs');        // worse, but was never on track
    assert.equal(s(4, 10), 'needs');               // nothing before to compare with
    assert.equal(s(3, 4, 0, 0), null);             // too few games judged to place it
    assert.equal(Board.COLUMNS.map(c => c.id).join(), 'slipping,needs,improving,ontrack');
});

test('buildBoard places habits from real games and sorts by win rate at stake', () => {
    const games = [...block(10, 9), ...block(10, 4)];        // early deaths: 9/10 before, 4/10 now
    const inputs = Engine.analyse(games).allInputs;
    const board = Board.buildBoard(games, Engine, inputs);
    assert.equal(statusOf(board, 'earlyDeaths'), 'slipping');
    const t = board.tickets.find(x => x.id === 'earlyDeaths');
    assert.deepEqual([t.recent, t.before], [{ hit: 4, of: 10 }, { hit: 9, of: 10 }]);
    // Every column is sorted by win rate at stake, most first
    for (const c of board.columns) {
        for (let i = 1; i < c.tickets.length; i++) assert.ok(c.tickets[i - 1].stake >= c.tickets[i].stake);
    }
    // The circular "queueing after two losses" habit is never a ticket
    assert.ok(!board.tickets.concat(board.tooFew).some(x => x.id === 'tiltQueue'));
});

test('too few games: habits wait outside the board', () => {
    const board = Board.buildBoard(block(3, 3), Engine, []);
    assert.equal(board.tickets.length, 0);
    assert.ok(board.tooFew.length > 0);
});

test('each game is judged on the target for the role played in it', () => {
    const solo = Engine.METRICS.find(m => m.id === 'soloKillDiff');
    // Support games aren't judged on solo kills at all
    assert.equal(Board.markGame(solo, game({ teamPosition: 'UTILITY', soloKillDiff: -3 })), null);
    const cs = Engine.METRICS.find(m => m.id === 'csAt10');
    const roles = ['TOP', 'MIDDLE', 'BOTTOM'].filter(r => Board.targetFor(cs, r) !== undefined);
    for (const r of roles) {
        const t = Board.targetFor(cs, r);
        assert.equal(Board.markGame(cs, game({ teamPosition: r, cs10: t })), true, r);
        assert.equal(Board.markGame(cs, game({ teamPosition: r, cs10: t - 1 })), false, r);
    }
});

test('moves since the last visit', () => {
    const tickets = [{ id: 'a', status: 'improving' }, { id: 'b', status: 'needs' }, { id: 'c', status: 'ontrack' }];
    assert.deepEqual(Board.movesSince({ a: 'needs', b: 'needs' }, tickets), { a: { from: 'needs', to: 'improving' } });
    assert.deepEqual(Board.movesSince(null, tickets), {});
    assert.deepEqual(Board.statusMap(tickets), { a: 'improving', b: 'needs', c: 'ontrack' });
    assert.equal(Board.columnLabel('ontrack'), 'On track');
});
