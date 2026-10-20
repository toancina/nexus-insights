const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { stubDatabase, makeMatch, makeRawJson, makeTimelineJson, SRC } = require('./helpers');

stubDatabase([]);
global.window = {};
require(path.join(SRC, 'components', 'analyticsEngine.js'));
const statHistory = require(path.join(SRC, 'components', 'statHistory.js'));
const T = require(path.join(SRC, 'components', 'chatTools.js'));

const at = (y, m, d) => new Date(y, m, d, 20, 0, 0).getTime();

const matches = [
    makeMatch({ championName: 'Ahri',      teamPosition: 'MIDDLE', queueId: 420, win: 1, kills: 9, deaths: 2, assists: 7,  gameCreation: at(2026, 8, 3), patch: '16.17', laneOpponent: 'Zed' }),
    makeMatch({ championName: 'Ahri',      teamPosition: 'MIDDLE', queueId: 420, win: 0, kills: 3, deaths: 7, assists: 4,  gameCreation: at(2026, 8, 5), gameDuration: 2400, patch: '16.17', laneOpponent: 'Syndra' }),
    makeMatch({ championName: 'LeeSin',    teamPosition: 'JUNGLE', queueId: 440, win: 1, kills: 6, deaths: 3, assists: 11, gameCreation: at(2026, 8, 7), patch: '16.18', laneOpponent: 'Elise' }),
    makeMatch({ championName: 'MonkeyKing',teamPosition: 'TOP',    queueId: 400, win: 0, kills: 2, deaths: 5, assists: 1,  gameCreation: at(2026, 9, 1), patch: '16.19', laneOpponent: 'Darius' }),
    makeMatch({ championName: 'Kaisa',     teamPosition: 'BOTTOM', queueId: 420, win: 1, kills: 12,deaths: 1, assists: 5,  gameCreation: at(2026, 9, 2), teamKills: 0, patch: '16.20', laneOpponent: 'Jinx' }),
];

const ctx = {
    matches,
    computeTabStats: window.computeTabStats,
    statHistory,
    now: () => new Date(2026, 9, 8),
    lpDeltas: {},
};

test('filters: queue, champion (incl. spaces and display names), role, dates, last N', () => {
    const { applyFilters } = T._internal;
    assert.equal(applyFilters(matches, { queue: 'solo' }).matches.length, 3);
    assert.equal(applyFilters(matches, { queue: 'ranked' }).matches.length, 4);
    assert.equal(applyFilters(matches, { champion: 'lee sin' }).matches.length, 1);
    assert.equal(applyFilters(matches, { champion: 'Wukong' }).matches.length, 1, 'Wukong is MonkeyKing internally');
    assert.equal(applyFilters(matches, { champion: "Kai'Sa" }).matches.length, 1);
    assert.equal(applyFilters(matches, { role: 'adc' }).matches.length, 1);
    assert.equal(applyFilters(matches, { role: 'mid' }).matches.length, 2);
    assert.equal(applyFilters(matches, { since: '2026-10-01' }).matches.length, 2);
    assert.equal(applyFilters(matches, { until: '2026-09-05' }).matches.length, 2, 'until includes that whole day');
    const last2 = applyFilters(matches, { last_n_games: 2 }).matches;
    assert.deepEqual(last2.map(m => m.championName), ['Kaisa', 'MonkeyKing'], 'newest first');
});

test('filters: every game mode, patch and period, lane opponent, result, game length', () => {
    const { applyFilters } = T._internal;
    const n = args => applyFilters(matches, args, { now: new Date(2026, 9, 8).getTime() }).matches.length;
    assert.equal(n({ queue: 'draft' }), 1);
    assert.equal(n({ queue: 'blind' }), 0);
    assert.equal(n({ queue: 'normal' }), 1);
    assert.equal(n({ patch: 'latest' }), 1);
    assert.equal(n({ patch: '16.17' }), 2);
    assert.equal(n({ patch: '16.17.1' }), 2, 'a full version works too');
    assert.equal(n({ last_n_patches: 2 }), 2);
    assert.equal(n({ last_n_patches: 2, queue: 'solo' }), 1, 'the newest patches over every game, as in the app');
    assert.equal(n({ last_n_days: 10 }), 2);
    assert.equal(n({ lane_opponent: 'zed' }), 1);
    assert.equal(n({ result: 'loss' }), 2);
    assert.equal(n({ result: 'win', queue: 'solo' }), 2);
    assert.equal(n({ min_minutes: 35 }), 1);
    assert.equal(n({ max_minutes: 30 }), 4);
    const f = applyFilters(matches, { queue: 'solo', champion: 'ahri', lane_opponent: 'Syndra', result: 'loss', patch: '16.17' });
    assert.equal(f.matches.length, 1);
    assert.equal(f.description, 'patch 16.17, Ranked Solo/Duo, Ahri, vs Syndra, losses');
});

test('bad filter input comes back as an error the model can relay, not an exception', async () => {
    for (const args of [{ queue: 'aram' }, { champion: 'Teemo' }, { role: 'goalkeeper' }, { since: 'last week' },
                        { patch: '15.1' }, { patch: 'soon' }, { result: 'draw' }, { lane_opponent: 'Teemo' },
                        { queue: 'constructor' }, { result: 'constructor' }]) {
        const out = await T.executeTool('get_overview', args, ctx);
        assert.ok(out.error, `expected an error for ${JSON.stringify(args)}`);
    }
    assert.ok((await T.executeTool('no_such_tool', {}, ctx)).error);
    // arguments arriving as a JSON string (some models do this) still work
    const out = await T.executeTool('get_overview', '{"queue":"solo"}', ctx);
    assert.equal(out.games, 3);
});

test('chat numbers match the Overview cards exactly', async () => {
    const out = await T.executeTool('get_overview', { queue: 'solo' }, ctx);
    const solo = matches.filter(m => m.queueId === 420);
    const card = id => window.computeTabStats('Overview', solo, []).find(c => c.id === id).value;
    assert.equal(out.win_rate_pct, Number(card('win_rate').toFixed(1)));
    assert.equal(out.kda, Number(card('avg_kda').toFixed(2)));
    assert.equal(out.cs_per_min, Number(card('avg_csm').toFixed(2)));
    assert.equal(out.damage_per_min, Number(card('dmg_min').toFixed(0)));
    // includes the game with zero team kills as 0%, like the card
    assert.equal(out.kill_participation_pct, Number(card('avg_kp').toFixed(1)));
    assert.ok(out.rank_tiers && out.rank_tiers['Win Rate'], 'tiers come from the cards');
});

test('category stats are the tab\'s own cards', async () => {
    const out = await T.executeTool('get_category_stats', { category: 'vision' }, ctx);
    assert.equal(out.category, 'Vision');
    const labels = window.computeTabStats('Vision', matches, []).map(c => c.label);
    assert.deepEqual(out.stats.map(s => s.stat), labels);
});

test('stat trend resolves a stat by its display name and returns 12 months', async () => {
    const out = await T.executeTool('get_stat_trend', { stat: 'avg kda' }, ctx);
    assert.equal(out.stat, 'Avg KDA');
    assert.equal(out.months.length, 12);
    assert.equal(out.months[11].month, '2026-10');
    assert.equal(out.months[11].partial_month, true);
    assert.equal(out.months.find(m => m.month === '2026-09').games, 3);
    assert.ok((await T.executeTool('get_stat_trend', { stat: 'Total Matches' }, ctx)).error,
        'stats without a monthly trend are refused');
});

test('breakdowns by champion, role, lane opponent, patch and queue', async () => {
    const champs = await T.executeTool('get_breakdown', { by: 'champion', min_games: 1 }, ctx);
    assert.equal(champs.rows[0].champion, 'Ahri');
    assert.equal(champs.rows[0].games, 2);
    const ahri = matches.filter(m => m.championName === 'Ahri');
    assert.equal(champs.rows[0].kda, Number(window.computeTabStats('Overview', ahri, []).find(c => c.id === 'avg_kda').value.toFixed(2)),
        'same numbers as the Overview cards');
    assert.equal((await T.executeTool('get_breakdown', { by: 'champion' }, ctx)).rows.length, 0, 'champions need 3 games by default');

    const roles = await T.executeTool('get_breakdown', { by: 'role' }, ctx);
    assert.equal(roles.rows.reduce((s, r) => s + r.games, 0), matches.length);
    const opp = await T.executeTool('get_breakdown', { by: 'lane_opponent', min_games: 1, sort_by: 'win_rate_low' }, ctx);
    assert.equal(opp.rows[0].win_rate_pct, 0);
    assert.equal(opp.rows[0].gold_diff_at_15, 300);
    const patches = await T.executeTool('get_breakdown', { by: 'patch' }, ctx);
    assert.deepEqual(patches.rows.map(r => r.patch), ['16.20', '16.19', '16.18', '16.17'], 'newest patch first');
    const queues = await T.executeTool('get_breakdown', { by: 'queue', queue: 'ranked' }, ctx);
    assert.deepEqual(queues.rows.map(r => r.queue).sort(), ['Ranked Flex', 'Ranked Solo']);
    assert.ok((await T.executeTool('get_breakdown', { by: 'mood' }, ctx)).error);
    assert.match((await T.executeTool('get_breakdown', { by: 'constructor' }, ctx)).error, /^Unknown breakdown/);
    assert.equal((await T.executeTool('get_breakdown', { by: 'Lane Opponent', min_games: 1 }, ctx)).rows.length, 5);
});

test('filter options list what has games', async () => {
    const out = await T.executeTool('get_filter_options', {}, ctx);
    assert.deepEqual(out.queues, { solo: 3, flex: 1, ranked: 4, normal: 1, draft: 1 });
    assert.deepEqual(Object.keys(out.patches_newest_first), ['16.20', '16.19', '16.18', '16.17']);
    assert.equal(out.champions.Ahri, 2);
    assert.equal(out.most_faced_lane_opponents.Zed, 1);
    assert.equal((await T.executeTool('get_filter_options', { queue: 'solo' }, ctx)).total_games, 3);
});

// --- One game, items and win chance -----------------------------------------

const ITEM_NAMES = { 1056: "Doran's Ring", 6655: "Luden's Companion", 3020: "Sorcerer's Shoes", 3089: "Rabadon's Deathcap" };
const itemCtx = {
    itemName: id => ITEM_NAMES[id] || `Item ${id}`,
    runeName: id => ({ 8112: 'Electrocute', 8200: 'Sorcery' })[id] || null,
    isCoreItem: id => [6655, 3020, 3089].includes(id),
    isBuildItem: id => [6655, 3089].includes(id),
    isExcludedItem: () => false,
};

// Win chance per frame: −15 at 5:00, where the timeline has Ahri's deaths; peaks at 74% (21:00) and is lost
const THROWN = [50, 50, 50, 50, 50, 35, 36, 38, 40, 42, 45, 48, 50, 52, 55, 60, 62, 64, 66, 70, 72, 74, 60, 40, 30, 20];
const detailGame = makeMatch({
    championName: 'Ahri', teamPosition: 'MIDDLE', queueId: 420, win: 0, gameDuration: 1530, gameCreation: at(2026, 9, 7),
    laneOpponent: 'Zed', patch: '16.20', impactRank: 3, impactTag: 'SVP',
    winChance: THROWN.join(','),
    itemPurchases: '1056:5,3802:480,6655:900,3020:960',
    deathPositions: '7000,7000,300;7000,7000,300;7000,7000,300',
});
const earlier = [1, 2, 3].map(d => makeMatch({ championName: 'Ahri', teamPosition: 'MIDDLE', queueId: 420, gameCreation: at(2026, 9, 2 + d) }));
const detailCtx = {
    ...ctx, ...itemCtx,
    matches: [detailGame, ...earlier, ...matches],
    lpDeltas: { [detailGame.matchId]: -18 },
    getMatchById: async id => (id === detailGame.matchId
        ? { ...detailGame, rawJson: makeRawJson(detailGame), timelineJson: makeTimelineJson(detailGame, { earlyDeaths: 3 }) }
        : null),
};

test('game detail: the newest matching game, in full', async () => {
    const out = await T.executeTool('get_game_detail', { champion: 'Ahri' }, detailCtx);
    assert.equal(out.match_id, detailGame.matchId);
    assert.equal(out.result, 'Loss');
    assert.equal(out.length, '25:30');
    assert.equal(out.impact, '#3 of 10 (SVP)');
    assert.equal(out.lp_change, -18);
    assert.equal(out.lane_opponent, 'Zed');

    // Win chance from the stored column, swings explained from the timeline
    assert.equal(out.win_chance.by_minute['5'], 35);
    assert.equal(out.win_chance.at_end, 20);
    assert.equal(out.win_chance.peak, '74% at 21:00');
    const first = out.win_chance.biggest_swings[0];
    assert.deepEqual([first.from, first.to, first.win_chance], ['4:00', '5:00', '50% → 35%']);
    assert.ok(first.what_happened.includes('kills: your team 0, enemy 3'));
    assert.ok(first.what_happened.includes('you died at 5:00 (Zed killed Ahri) ×3'), 'repeats are counted, not listed');
    assert.ok(out.win_chance.biggest_swings.some(s => s.win_chance === '74% → 30%'));

    // Items: finished ones with their WPA until the next trip to the shop
    assert.deepEqual(out.items.finished_items_bought[0], { item: "Luden's Companion", at: '15:00', win_chance: '60% → 62%', wpa: 2 });
    assert.equal(out.items.finished_items_bought[1].wpa, 12, "boots at 16:00: no later trip, so 5 min");
    assert.equal(out.items.first_back, '8:00');
    assert.deepEqual(out.runes, { keystone: 'Electrocute', secondary_tree: 'Sorcery' });

    assert.ok(out.blunders.some(b => /Died to Zed three times/.test(b)));
    assert.deepEqual(out.deaths, Array(3).fill('5:00, mid-map, Zed killed Ahri'));
    assert.equal(out.your_team.length, 5);
    assert.equal(out.enemy_team.length, 5);
    assert.ok(out.your_team.some(l => l.startsWith('Ahri (Mid)') && l.endsWith('(you)')));
    assert.equal(out.compared_games.season, 5, 'other Solo/Duo games as Mid');
    assert.ok(out.stats_vs_your_usual.some(r => r.stat === 'KDA' && /\((better|worse|similar)\)$/.test(r.season)));
    assert.equal(out.missing, undefined);
});

test('game detail: nth, match_id, and a game without a timeline', async () => {
    const second = await T.executeTool('get_game_detail', { champion: 'Ahri', nth: 2 }, detailCtx);
    assert.equal(second.match_id, earlier[2].matchId);
    assert.ok(second.missing, 'no timeline and no stored win chance');
    assert.equal(second.win_chance, undefined);
    const byId = await T.executeTool('get_game_detail', { match_id: matches[2].matchId }, detailCtx);
    assert.equal(byId.champion, 'LeeSin');
    assert.ok((await T.executeTool('get_game_detail', { match_id: 'EUW1_0' }, detailCtx)).error);
    assert.ok((await T.executeTool('get_game_detail', { champion: 'Ahri', nth: 50 }, detailCtx)).error);
});

const itemGames = Array.from({ length: 6 }, (_, i) => makeMatch({
    championName: 'Ahri', teamPosition: 'MIDDLE', queueId: 420, win: i % 2, gameDuration: 1530,
    gameCreation: at(2026, 9, 1) + i * 3600000,
    item0: 6655, item1: 3020, item2: 3089, item3: 0, item4: 0, item5: 0,
    itemPurchases: '1056:5,6655:600,3020:700,3089:1200',
    winChance: Array.from({ length: 26 }, (_, m) => 40 + m).join(','),   // +1 a minute
}));
const itemsCtx = { ...ctx, ...itemCtx, matches: [...itemGames, detailGame] };

test('item stats: win rate, WPA and when you buy each finished item', async () => {
    const out = await T.executeTool('get_item_stats', {}, itemsCtx);
    const luden = out.items.find(r => r.item === "Luden's Companion");
    assert.equal(luden.games, 7);
    assert.equal(luden.usually_bought_at, '10:43');
    assert.equal(out.items.some(r => r.item === "Doran's Ring"), false, 'the opening shop is not a finished item');
    // 10:00 → next trip at 11:40 is +1.7 a game; 15:00 → 16:00 in the detail game is +2
    assert.equal(luden.avg_wpa, Number(((6 * (100 / 60) + 2) / 7).toFixed(1)));
    const byWpa = await T.executeTool('get_item_stats', { sort_by: 'wpa' }, itemsCtx);
    assert.equal(byWpa.items[0].item, "Sorcerer's Shoes");
    const few = await T.executeTool('get_item_stats', { last_n_games: 3, min_games: 1 }, itemsCtx);
    assert.equal(few.items[0].avg_wpa, undefined, 'no average WPA under 5 games');
    assert.match(out.note, /not what the item caused/);
});

test('item stats with a champion add the build order and first back', async () => {
    const out = await T.executeTool('get_item_stats', { champion: 'Ahri', queue: 'solo' }, itemsCtx);
    assert.equal(out.build_order.first_item[0].items, "Luden's Companion");
    assert.equal(out.build_order.second_item[0].items, "Rabadon's Deathcap");
    assert.equal(out.build_order.starting_items[0].items, "Doran's Ring");
    assert.equal(out.first_back.median, '10:00');
    assert.equal((await T.executeTool('get_item_stats', {}, itemsCtx)).build_order, undefined);
    assert.ok((await T.executeTool('get_item_stats', {}, ctx)).error, 'no purchase data');
});

test('win chance stats: throws, comebacks and where games stand at 15', async () => {
    const out = await T.executeTool('get_win_chance_stats', {}, itemsCtx);
    assert.equal(out.games_with_win_chance, 7);
    assert.equal(out.throws.games, 1);
    assert.equal(out.throws.newest[0], '2026-10-07 Ahri: 74% at 21:00');
    assert.equal(out.comebacks.games, 0);
    assert.equal(out.by_win_chance_at_15_min.even.games, 6, '55% at 15');
    assert.deepEqual(out.by_win_chance_at_15_min.ahead, { games: 1, win_rate_pct: 0 }, 'the thrown game: 60% at 15');
    assert.equal(out.average_win_chance_pct.at_10_min, Math.round((6 * 50 + 45) / 7));
    assert.ok((await T.executeTool('get_win_chance_stats', {}, ctx)).error, 'no win-chance data');
});

test('recent games are newest first and capped', async () => {
    const out = await T.executeTool('get_recent_games', { count: 2 }, ctx);
    assert.equal(out.games.length, 2);
    assert.equal(out.games[0].champion, 'Kaisa');
    assert.equal(out.games[0].result, 'Win');
    assert.equal(out.games[0].kda, '12/1/5');
});

test('every tool has a schema the model can read', () => {
    for (const s of T.toolSchemas()) {
        assert.equal(s.type, 'function');
        assert.ok(s.function.name && s.function.description.length > 20);
        assert.equal(s.function.parameters.type, 'object');
    }
    assert.equal(T.describeCall('get_breakdown', { by: 'lane_opponent', queue: 'solo', champion: 'Ahri' }),
        'results by lane opponent (solo, Ahri)');
    assert.equal(T.describeCall('get_game_detail', {}), 'latest game');
    assert.equal(T.describeCall('get_game_detail', { nth: 2, result: 'loss', patch: 'latest' }), 'game 2 back (losses, patch latest)');
    // Schemas go with every request: keep them inside the context MODEL_OPTIONS sets in chatPanel.js
    assert.ok(JSON.stringify(T.toolSchemas()).length < 14000);
});
