const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const {
    parsePlayers, findChampion, spellId, playerGameRows, recentForm, playerTags, rankSummary, gamesTogether,
} = require(path.join(SRC, 'services', 'liveGame.js'));

/** Data Dragon champion.json `data`, trimmed. */
const CHAMPS = {
    Aatrox:       { id: 'Aatrox',       key: '266', name: 'Aatrox' },
    Ahri:         { id: 'Ahri',         key: '103', name: 'Ahri' },
    Chogath:      { id: 'Chogath',      key: '31',  name: "Cho'Gath" },
    Fiddlesticks: { id: 'Fiddlesticks', key: '9',   name: 'Fiddlesticks' },
    LeeSin:       { id: 'LeeSin',       key: '64',  name: 'Lee Sin' },
    Jinx:         { id: 'Jinx',         key: '222', name: 'Jinx' },
    Thresh:       { id: 'Thresh',       key: '412', name: 'Thresh' },
    Zed:          { id: 'Zed',          key: '238', name: 'Zed' },
};

/** One player as /liveclientdata/playerlist returns it. */
function livePlayer(name, tag, team, position, champId, extra = {}) {
    const champ = CHAMPS[champId] || { name: champId };
    return {
        riotId: tag ? `${name}#${tag}` : name,
        riotIdGameName: name,
        riotIdTagLine: tag,
        summonerName: tag ? `${name}#${tag}` : name,
        championName: champ.name,
        rawChampionName: `game_character_displayname_${champId}`,
        team, position, isBot: false,
        summonerSpells: {
            summonerSpellOne: { displayName: 'Flash', rawDisplayName: 'GeneratedTip_SummonerSpell_SummonerFlash_DisplayName' },
            summonerSpellTwo: { displayName: 'Ignite', rawDisplayName: 'GeneratedTip_SummonerSpell_SummonerDot_DisplayName' },
        },
        runes: { keystone: { displayName: 'Electrocute', id: 8112 }, primaryRuneTree: { id: 8100 }, secondaryRuneTree: { id: 8300 } },
        ...extra,
    };
}

// Live Client order: blue side (ORDER) first, positions scrambled; you are on red.
const LIST10 = [
    livePlayer('B5', 'EUW', 'ORDER', 'UTILITY', 'Thresh'),
    livePlayer('B1', 'EUW', 'ORDER', 'TOP',     'Aatrox'),
    livePlayer('B3', 'EUW', 'ORDER', 'MIDDLE',  'Zed'),
    livePlayer('B2', 'EUW', 'ORDER', 'JUNGLE',  'LeeSin'),
    livePlayer('B4', 'EUW', 'ORDER', 'BOTTOM',  'Jinx'),
    livePlayer('R4', 'EUW', 'CHAOS', 'BOTTOM',  'Jinx'),
    livePlayer('Me', 'EUW', 'CHAOS', 'MIDDLE',  'Ahri'),
    livePlayer('R1', 'EUW', 'CHAOS', 'TOP',     'Chogath'),
    livePlayer('R5', 'EUW', 'CHAOS', 'UTILITY', 'Thresh'),
    livePlayer('R2', 'EUW', 'CHAOS', 'JUNGLE',  'FiddleSticks'),
];

test('parsePlayers puts your team first, marks you, sorts by position', () => {
    const ps = parsePlayers(LIST10, 'me#euw', CHAMPS);
    assert.equal(ps.length, 10);
    assert.ok(ps.slice(0, 5).every(p => p.team === 'CHAOS'));
    assert.ok(ps.slice(5).every(p => p.team === 'ORDER'));
    assert.deepEqual(ps.slice(0, 5).map(p => p.position), ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']);
    assert.deepEqual(ps.slice(5).map(p => p.gameName), ['B1', 'B2', 'B3', 'B4', 'B5']);
    assert.deepEqual(ps.filter(p => p.isYou).map(p => p.gameName), ['Me']);
    assert.deepEqual(ps.map(p => p.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('parsePlayers fills champion, spells, keystone and lookup fields', () => {
    const fiddle = parsePlayers(LIST10, 'Me#EUW', CHAMPS).find(p => p.gameName === 'R2');
    assert.equal(fiddle.championName, 'Fiddlesticks');
    assert.equal(fiddle.championId, 'Fiddlesticks');
    assert.equal(fiddle.championKey, 9);
    assert.deepEqual(fiddle.spells, ['SummonerFlash', 'SummonerDot']);
    assert.equal(fiddle.keystoneId, 8112);
    assert.equal(fiddle.riotId, 'R2#EUW');
    assert.equal(fiddle.tagLine, 'EUW');
    assert.equal(fiddle.puuid, null);
    assert.equal(fiddle.isBot, false);
    assert.equal(fiddle.lookup, true);
});

test('parsePlayers uses a puuid when the Live Client gives one', () => {
    const list = [livePlayer('A', 'EUW', 'ORDER', 'TOP', 'Ahri', { puuid: 'pu-1' })];
    assert.equal(parsePlayers(list, null, CHAMPS)[0].puuid, 'pu-1');
});

test('parsePlayers sorts by position only when positions exist', () => {
    const list = [
        livePlayer('C', 'EUW', 'ORDER', '', 'Zed'),
        livePlayer('A', 'EUW', 'ORDER', '', 'Ahri'),
        livePlayer('B', 'EUW', 'ORDER', '', 'Jinx'),
    ];
    assert.deepEqual(parsePlayers(list, 'A#EUW', CHAMPS).map(p => p.gameName), ['C', 'A', 'B']);
});

test('parsePlayers marks bots and untagged players as not lookup-able', () => {
    const list = [
        livePlayer('Me', 'EUW', 'ORDER', 'MIDDLE', 'Ahri'),
        livePlayer('Zed Bot', '', 'CHAOS', '', 'Zed', { isBot: true, riotId: 'Zed Bot', riotIdTagLine: '' }),
        livePlayer('NoTag', '', 'CHAOS', '', 'Jinx', { riotId: 'NoTag', riotIdTagLine: undefined }),
    ];
    const ps = parsePlayers(list, 'Me#EUW', CHAMPS);
    assert.deepEqual(ps.map(p => [p.gameName, p.isBot, p.lookup]),
        [['Me', false, true], ['Zed Bot', true, false], ['NoTag', false, false]]);
});

test('parsePlayers falls back to riotId / summonerName when riotIdGameName is missing', () => {
    const fromRiotId = livePlayer('x', 'y', 'ORDER', 'TOP', 'Ahri',
        { riotId: 'Alpha#EUW', riotIdGameName: undefined, riotIdTagLine: undefined });
    const fromSummoner = livePlayer('x', 'y', 'ORDER', 'JUNGLE', 'Zed',
        { riotId: undefined, riotIdGameName: undefined, riotIdTagLine: undefined, summonerName: 'Beta#NA1' });
    const ps = parsePlayers([fromRiotId, fromSummoner], null, CHAMPS);
    assert.deepEqual(ps.map(p => [p.gameName, p.tagLine, p.riotId]), [['Alpha', 'EUW', 'Alpha#EUW'], ['Beta', 'NA1', 'Beta#NA1']]);
});

test('parsePlayers with no active name marks nobody as you and keeps ORDER first', () => {
    const ps = parsePlayers(LIST10, null, CHAMPS);
    assert.equal(ps.filter(p => p.isYou).length, 0);
    assert.equal(ps[0].team, 'ORDER');
});

test('findChampion matches the raw name case-insensitively, then the display name', () => {
    assert.deepEqual(findChampion('game_character_displayname_FiddleSticks', 'Fiddlesticks', CHAMPS), { id: 'Fiddlesticks', key: 9 });
    assert.deepEqual(findChampion('', "Cho'Gath", CHAMPS), { id: 'Chogath', key: 31 });
    assert.equal(findChampion('game_character_displayname_Nobody', 'Nobody', CHAMPS), null);
    assert.equal(findChampion(undefined, undefined, {}), null);
});

test('spellId reads the spell out of rawDisplayName', () => {
    assert.equal(spellId('GeneratedTip_SummonerSpell_SummonerFlash_DisplayName'), 'SummonerFlash');
    assert.equal(spellId('GeneratedTip_SummonerSpell_SummonerSmite_DisplayName'), 'SummonerSmite');
    assert.equal(spellId(undefined), null);
    assert.equal(spellId('something else'), null);
});

test('playerGameRows: one row per participant, remake from early surrender or < 300 s', () => {
    const part = (puuid, championName, win, extra = {}) =>
        ({ puuid, championName, win, kills: 1, deaths: 2, assists: 3, gameEndedInEarlySurrender: false, ...extra });
    const match = {
        metadata: { matchId: 'EUW1_1' },
        info: { queueId: 420, gameCreation: 5000, gameDuration: 1800, participants: [part('a', 'Ahri', true), part('b', 'Zed', false)] },
    };
    assert.deepEqual(playerGameRows(match), [
        { matchId: 'EUW1_1', puuid: 'a', queueId: 420, gameCreation: 5000, championName: 'Ahri', win: 1, kills: 1, deaths: 2, assists: 3, isRemake: 0 },
        { matchId: 'EUW1_1', puuid: 'b', queueId: 420, gameCreation: 5000, championName: 'Zed', win: 0, kills: 1, deaths: 2, assists: 3, isRemake: 0 },
    ]);
    const short = { ...match, info: { ...match.info, gameDuration: 200 } };
    assert.ok(playerGameRows(short).every(r => r.isRemake === 1));
    const surrendered = { ...match, info: { ...match.info, participants: [part('a', 'Ahri', true, { gameEndedInEarlySurrender: true })] } };
    assert.equal(playerGameRows(surrendered)[0].isRemake, 1);
    assert.deepEqual(playerGameRows(null), []);
});

const row = (gameCreation, championName, win, k, d, a, isRemake = 0) =>
    ({ matchId: `M${gameCreation}`, puuid: 'p', queueId: 420, gameCreation, championName, win, kills: k, deaths: d, assists: a, isRemake });

test('recentForm counts wins, KDA (K+A)/max(1,D), strip oldest→newest, streak, champion games', () => {
    const rows = [
        row(4, 'Ahri', 1, 5, 1, 5),
        row(3, 'ahri', 1, 3, 0, 3),
        row(2, 'Zed', 0, 1, 4, 1),
        row(1, 'Ahri', 0, 0, 1, 0, 1),   // remake: left out
    ];
    const f = recentForm(rows, 'Ahri');
    assert.deepEqual([f.games, f.wins, f.losses], [3, 2, 1]);
    assert.equal(f.winRate, 2 / 3);
    assert.equal(f.kda, (5 + 5 + 3 + 3 + 1 + 1) / 5);
    assert.deepEqual(f.strip, [false, true, true]);
    assert.deepEqual(f.streak, { win: true, count: 2 });
    assert.deepEqual(f.onChamp, { games: 2, wins: 2 });
});

test('recentForm keeps only the newest 10 and finds a loss streak', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i, 'Zed', i < 9 ? 1 : 0, 1, 1, 1));
    const f = recentForm(rows, 'Zed');
    assert.equal(f.games, 10);
    assert.deepEqual(f.streak, { win: false, count: 3 });
});

test('recentForm of no games has nulls, not NaN', () => {
    assert.deepEqual(recentForm([], 'Ahri'),
        { games: 0, wins: 0, losses: 0, winRate: null, kda: null, strip: [], streak: null, onChamp: { games: 0, wins: 0 } });
    assert.deepEqual(recentForm([row(1, 'Ahri', 1, 1, 0, 1)], null).onChamp, { games: 0, wins: 0 });
});

const league = (flags = {}) => ({
    solo: { tier: 'SILVER', rank: 'II', leaguePoints: 13, wins: 11, losses: 10,
            hotStreak: false, veteran: false, freshBlood: false, inactive: false, ...flags },
    flex: null,
});
const form = (over = {}) => ({ games: 10, wins: 5, losses: 5, winRate: 0.5, kda: 2, strip: [], streak: null, onChamp: { games: 2, wins: 1 }, ...over });

test('playerTags: First time needs low mastery and no recent games on the champion', () => {
    assert.deepEqual(playerTags({ league: league(), mastery: null, form: null }), ['First time']);
    assert.deepEqual(playerTags({ league: league(), mastery: { points: 9999 }, form: form({ onChamp: { games: 0, wins: 0 } }) }), ['First time']);
    assert.deepEqual(playerTags({ league: league(), mastery: { points: 10000 }, form: form({ onChamp: { games: 0, wins: 0 } }) }), []);
    assert.deepEqual(playerTags({ league: league(), mastery: { points: 500 }, form: form({ onChamp: { games: 1, wins: 0 } }) }), []);
});

test('playerTags: Main needs 5+ games and half of them on the champion', () => {
    const m = { points: 50000 };
    assert.deepEqual(playerTags({ league: null, mastery: m, form: form({ games: 6, onChamp: { games: 3, wins: 2 } }) }), ['Main']);
    assert.deepEqual(playerTags({ league: null, mastery: m, form: form({ games: 4, onChamp: { games: 4, wins: 2 } }) }), []);
    assert.deepEqual(playerTags({ league: null, mastery: m, form: form({ games: 10, onChamp: { games: 4, wins: 2 } }) }), []);
});

test('playerTags: streaks of 3+, Hot streak only without a win streak tag', () => {
    const m = { points: 50000 };
    assert.deepEqual(playerTags({ league: null, mastery: m, form: form({ streak: { win: true, count: 4 } }) }), ['Win streak 4']);
    assert.deepEqual(playerTags({ league: null, mastery: m, form: form({ streak: { win: false, count: 3 } }) }), ['Loss streak 3']);
    assert.deepEqual(playerTags({ league: null, mastery: m, form: form({ streak: { win: true, count: 2 } }) }), []);
    assert.deepEqual(playerTags({ league: league({ hotStreak: true }), mastery: m, form: null }), ['Hot streak']);
    assert.deepEqual(playerTags({ league: league({ hotStreak: true }), mastery: m, form: form({ streak: { win: true, count: 3 } }) }), ['Win streak 3']);
});

test('playerTags: Inactive, Fresh blood and Veteran from the Solo/Duo flags, in order', () => {
    assert.deepEqual(
        playerTags({ league: league({ inactive: true, freshBlood: true, veteran: true }), mastery: { points: 50000 }, form: null }),
        ['Inactive', 'Fresh blood', 'Veteran']);
});

test('rankSummary prefers Solo/Duo, then Flex, then null', () => {
    assert.deepEqual(rankSummary(league()),
        { queue: 'Solo/Duo', tier: 'SILVER', rank: 'II', lp: 13, wins: 11, losses: 10, winRate: 11 / 21 });
    const flexOnly = { solo: null, flex: { tier: 'GOLD', rank: 'IV', leaguePoints: 0, wins: 0, losses: 0 } };
    assert.deepEqual(rankSummary(flexOnly), { queue: 'Flex', tier: 'GOLD', rank: 'IV', lp: 0, wins: 0, losses: 0, winRate: null });
    assert.equal(rankSummary({ solo: null, flex: null }), null);
    assert.equal(rankSummary(null), null);
});

test('gamesTogether counts games whose teammate list has that puuid', () => {
    const map = new Map([
        ['g1', [{ puuid: 'a' }, { puuid: 'b' }]],
        ['g2', [{ puuid: 'a' }]],
        ['g3', []],
    ]);
    assert.equal(gamesTogether(map, 'a'), 2);
    assert.equal(gamesTogether(map, 'z'), 0);
    assert.equal(gamesTogether(null, 'a'), 0);
});
