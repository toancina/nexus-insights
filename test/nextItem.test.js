const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const { nextItemOptions, championGames } = require(path.join(SRC, 'services', 'nextItem.js'));

const S = 1000;
const MIN = 60 * S;

// Finished items in these tests: 3000–3999. Anything else (1000s components,
// 3006 Berserker's Greaves standing in for boots) is not a build item.
const BOOTS = 3006;
const isCompleted = id => id >= 3000 && id < 4000 && id !== BOOTS;

/**
 * A game from a compact build: [[itemId, minute, wpa?], …]. `wpa` is given
 * per purchase, aligned the way itemWpa returns it; a missing value means no
 * win-chance curve for that purchase.
 */
function game(win, build) {
    return {
        win,
        purchases: build.map(([itemId, minute]) => ({ itemId, t: minute * MIN })),
        wpa: build.map(([itemId, minute, wpa]) => (wpa === undefined ? null
            : { itemId, t: minute * MIN, from: 50, to: 50 + wpa, wpa })),
    };
}

const byId = (options) => Object.fromEntries(options.map(o => [o.itemId, o]));

test('the next item is what you bought right after having exactly the items you own', () => {
    const games = [
        game(true,  [[3071, 12], [3053, 20], [3026, 28]]),
        game(false, [[3071, 11], [3074, 19]]),
        game(true,  [[3071, 13], [3053, 21]]),
    ];
    const r = nextItemOptions(games, [3071], { isCompleted, minGames: 1 });
    assert.deepEqual(r.basis, [3071]);
    assert.equal(r.games, 3);
    const o = byId(r.options);
    assert.deepEqual(Object.keys(o).map(Number).sort(), [3053, 3074]);
    assert.deepEqual([o[3053].games, o[3053].wins], [2, 2]);
    assert.deepEqual([o[3074].games, o[3074].wins], [1, 0]);
    assert.equal(o[3053].winRate, 1);
    assert.equal(o[3074].winRate, 0);
});

test('components, boots and repeat purchases do not change which items you had', () => {
    const games = [
        // component, the finished item, boots, the finished item again (sold and rebought), then the next one
        game(true, [[1036, 3], [3071, 12], [BOOTS, 14], [3071, 16], [1037, 17], [3053, 21]]),
    ];
    const r = nextItemOptions(games, [3071, BOOTS, 1036], { isCompleted, minGames: 1 });
    assert.deepEqual(r.basis, [3071]);
    assert.deepEqual(r.options.map(o => o.itemId), [3053]);
});

test('buying an item twice does not count as having two of your items', () => {
    const games = [game(true, [[3071, 12], [3071, 15], [3053, 20]])];   // had {3071}, then {3071, 3053}
    const r = nextItemOptions(games, [3071, 3074], { isCompleted, minGames: 1 });
    assert.deepEqual(r.basis, [3071]);
    assert.deepEqual(r.options.map(o => o.itemId), [3053]);
});

test('a game that had other finished items alongside yours does not match', () => {
    const games = [
        game(true,  [[3071, 12], [3053, 20]]),
        game(true,  [[3074, 10], [3071, 18], [3026, 25]]),   // {3074} then {3074, 3071}: never exactly {3071}
    ];
    const r = nextItemOptions(games, [3071], { isCompleted, minGames: 1 });
    assert.equal(r.games, 1);
    assert.deepEqual(r.options.map(o => o.itemId), [3053]);
});

test('owning nothing finished recommends your usual first item', () => {
    const games = [
        game(true,  [[1055, 0], [3071, 12]]),
        game(false, [[1055, 0], [3074, 11]]),
        game(true,  [[3071, 13]]),
    ];
    const r = nextItemOptions(games, [], { isCompleted, minGames: 1 });
    assert.deepEqual(r.basis, []);
    assert.equal(byId(r.options)[3071].games, 2);
    assert.equal(byId(r.options)[3074].games, 1);
});

test('a game that ends before another finished item is not counted', () => {
    const games = [game(true, [[3071, 12]]), game(true, [[3071, 12], [3053, 20]])];
    const r = nextItemOptions(games, [3071], { isCompleted, minGames: 1 });
    assert.equal(r.games, 1);
});

test('average WPA comes from that purchase; purchases with no curve are left out of it', () => {
    const games = [
        game(true,  [[3071, 12, 9], [3053, 20, 4]]),
        game(true,  [[3071, 12, 9], [3053, 20, -2]]),
        game(false, [[3071, 12],    [3053, 20]]),        // no win-chance curve
    ];
    const o = nextItemOptions(games, [3071], { isCompleted, minGames: 1 }).options[0];
    assert.equal(o.itemId, 3053);
    assert.equal(o.games, 3);
    assert.equal(o.wpaGames, 2);
    assert.equal(o.wpa, 1);
});

test('items with enough games are ranked by WPA, ahead of items with too few', () => {
    const repeat = (n, build, win = true) => Array.from({ length: n }, () => game(win, build));
    const games = [
        ...repeat(5, [[3071, 12], [3053, 20, 1]]),     // 5 games, +1
        ...repeat(6, [[3071, 12], [3074, 20, 4]]),     // 6 games, +4
        ...repeat(2, [[3071, 12], [3026, 20, 10]]),    // 2 games, +10: too few to rank by
        ...repeat(3, [[3071, 12], [3065, 20]]),        // 3 games, no curve
    ];
    const r = nextItemOptions(games, [3071], { isCompleted, minGames: 5 });
    assert.deepEqual(r.options.map(o => o.itemId), [3074, 3053, 3065, 3026]);
});

test('with too few games for your exact items, it uses the subset of them with the most games', () => {
    const games = [
        game(true,  [[3071, 12], [3053, 20], [3026, 27]]),   // the one game with exactly {3071, 3053}
        game(true,  [[3071, 12], [3074, 20]]),
        game(false, [[3071, 13], [3074, 21]]),
        game(true,  [[3071, 11], [3065, 19]]),
        game(true,  [[3053, 14], [3026, 22]]),
    ];
    const r = nextItemOptions(games, [3071, 3053], { isCompleted, minGames: 3 });
    assert.deepEqual(r.basis, [3071]);
    assert.equal(r.games, 4);
    const o = byId(r.options);
    assert.equal(o[3074].games, 2);
    assert.equal(o[3065].games, 1);
    // The {3071, 3053} game skips 3053, which you own, and counts what came after it
    assert.equal(o[3026].games, 1);
    assert.equal(o[3053], undefined);
});

test('the exact items are kept when they have enough games', () => {
    const games = [
        game(true, [[3071, 12], [3053, 20], [3026, 27]]),
        game(true, [[3071, 12], [3053, 20], [3026, 27]]),
        game(true, [[3071, 12], [3074, 20]]),
        game(true, [[3071, 12], [3074, 20]]),
        game(true, [[3071, 12], [3074, 20]]),
    ];
    const r = nextItemOptions(games, [3053, 3071], { isCompleted, minGames: 2 });
    assert.deepEqual(r.basis, [3053, 3071]);
    assert.deepEqual(r.options.map(o => o.itemId), [3026]);
});

test('with too few games everywhere, the items with the most games are used', () => {
    const games = [
        game(true, [[3071, 12], [3053, 20]]),
        game(true, [[3074, 12], [3053, 20]]),
    ];
    const r = nextItemOptions(games, [3071], { isCompleted, minGames: 5 });
    assert.deepEqual(r.basis, []);
    assert.equal(r.games, 2);
    // Still never the item you own: game 1 counts what came after it
    assert.deepEqual(r.options.map(o => o.itemId).sort(), [3053, 3074]);
});

test('no games: no options', () => {
    const r = nextItemOptions([], [3071], { isCompleted });
    assert.equal(r.games, 0);
    assert.deepEqual(r.options, []);
});

// ---------------------------------------------------------------------------
// championGames: stored rows → games for nextItemOptions
// ---------------------------------------------------------------------------

/** A stored match row, only the columns championGames reads. */
function row(championName, teamPosition, extra = {}) {
    return {
        championName, teamPosition, win: 1, gameDuration: 1200,
        itemPurchases: '3071:600', winChance: Array.from({ length: 21 }, (_, m) => 40 + m).join(','),
        ...extra,
    };
}

test('championGames uses your games in that role when there are enough of them', () => {
    const rows = [
        row('Irelia', 'TOP'), row('Irelia', 'TOP'), row('Irelia', 'MIDDLE'), row('Ahri', 'TOP'),
    ];
    const r = championGames(rows, 'Irelia', 'TOP', { minRoleGames: 2 });
    assert.equal(r.role, 'TOP');
    assert.equal(r.games.length, 2);
});

test('championGames falls back to every role with too few games in yours', () => {
    const rows = [row('Irelia', 'TOP'), row('Irelia', 'MIDDLE'), row('Irelia', 'MIDDLE')];
    const r = championGames(rows, 'Irelia', 'TOP', { minRoleGames: 2 });
    assert.equal(r.role, null);
    assert.equal(r.games.length, 3);
});

test('championGames matches the champion id case-insensitively', () => {
    // Match-V5 says "FiddleSticks"; Data Dragon's id is "Fiddlesticks"
    const r = championGames([row('FiddleSticks', 'JUNGLE')], 'Fiddlesticks', 'JUNGLE', { minRoleGames: 1 });
    assert.equal(r.games.length, 1);
});

test('championGames skips games with no purchase data', () => {
    const rows = [row('Irelia', 'TOP'), row('Irelia', 'TOP', { itemPurchases: '' }), row('Irelia', 'TOP', { itemPurchases: null })];
    assert.equal(championGames(rows, 'Irelia', 'TOP', { minRoleGames: 1 }).games.length, 1);
});

test('championGames decodes purchases, the result and each purchase\'s WPA', () => {
    const [g] = championGames([row('Irelia', 'TOP', { win: 0 })], 'Irelia', 'TOP', { minRoleGames: 1 }).games;
    assert.equal(g.win, false);
    assert.deepEqual(g.purchases, [{ itemId: 3071, t: 10 * MIN }]);
    // Bought at 10:00, no later trip: the window ends 5 min later. Win chance 50% → 55%.
    assert.equal(g.wpa[0].wpa, 5);
});

test('championGames gives no WPA without a win-chance curve', () => {
    const [g] = championGames([row('Irelia', 'TOP', { winChance: '' })], 'Irelia', 'TOP', { minRoleGames: 1 }).games;
    assert.deepEqual(g.wpa, [null]);
});
