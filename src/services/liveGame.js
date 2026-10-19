/**
 * liveGame.js — the Live page's rules (#59). Pure.
 *
 * The players come from the local Live Client Data API
 * (/liveclientdata/playerlist), which names each player by Riot ID and
 * champion display name. Everything else on the page (rank, mastery, recent
 * Solo/Duo games) comes from the Riot API through services/liveGameLoader.js;
 * this module only turns those answers into rows, form and tags.
 */

const RECENT_COUNT = 10;                     // last N games per player
const RECENT_QUEUE = 420;                    // ...of Solo/Duo
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;    // reuse looked-up data for a day
const FIRST_TIME_POINTS = 10000;             // below this, "First time" if no recent games on it
const STREAK_MIN = 3;
const MAIN_SHARE = 0.5;                      // "Main": at least half the recent games...
const MAIN_MIN_GAMES = 5;                    // ...out of at least this many
const POSITION_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const REMAKE_MAX_SECONDS = 300;

/**
 * Data Dragon champion for a Live Client player: { id, key } or null.
 * `rawChampionName` is "game_character_displayname_<internal name>", and the
 * internal name is the Data Dragon id apart from case (FiddleSticks). The
 * display name is the fallback, compared with the en_US name.
 */
function findChampion(rawChampionName, displayName, champions) {
    const list = Object.values(champions || {});
    const raw = /game_character_displayname_(.+)$/i.exec(rawChampionName || '');
    const byId = raw && list.find(c => c.id.toLowerCase() === raw[1].toLowerCase());
    const byName = !byId && displayName
        ? list.find(c => String(c.name).toLowerCase() === String(displayName).toLowerCase())
        : null;
    const c = byId || byName;
    return c ? { id: c.id, key: Number(c.key) } : null;
}

/**
 * "GeneratedTip_SummonerSpell_SummonerFlash_DisplayName" → "SummonerFlash".
 * Upgraded spells (Unleashed Teleport, Smite after its quest) carry a set
 * prefix and a suffix ("S12_SummonerTeleportUpgrade"); Data Dragon only has
 * the base icon.
 */
function spellId(rawDisplayName) {
    const m = /SummonerSpell_(\w+?)_DisplayName/.exec(rawDisplayName || '');
    if (!m) return null;
    const id = m[1].replace(/^S\d+_/, '').replace(/Upgrade$/, '');
    return id.startsWith('SummonerSmite') ? 'SummonerSmite' : id;
}

/** Riot ID parts, from riotIdGameName/riotIdTagLine or a "name#tag" string. */
function riotIdOf(p) {
    const full = p.riotId || p.summonerName || '';
    const hash = full.lastIndexOf('#');
    const gameName = p.riotIdGameName || (hash >= 0 ? full.slice(0, hash) : full);
    const tagLine = p.riotIdTagLine || (hash >= 0 ? full.slice(hash + 1) : '');
    return { gameName, tagLine, riotId: tagLine ? `${gameName}#${tagLine}` : gameName };
}

/**
 * The Live Client's player list as page rows: your team first, each team in
 * position order when every (non-bot) player has a position, otherwise in the
 * Live Client's order (ARAM and other modes have no positions).
 */
function parsePlayers(playerList, activeName, champions) {
    const active = String(activeName || '').toLowerCase();

    const players = (playerList || []).map(p => {
        const { gameName, tagLine, riotId } = riotIdOf(p);
        const champ = findChampion(p.rawChampionName, p.championName, champions);
        const isBot = !!p.isBot;
        const isYou = !!active && (riotId.toLowerCase() === active
            || (!active.includes('#') && gameName.toLowerCase() === active));
        return {
            index: 0,
            riotId, gameName, tagLine,
            puuid: p.puuid || null,
            championName: champ ? champions[champ.id].name : (p.championName || ''),
            championId: champ ? champ.id : null,
            championKey: champ ? champ.key : null,
            team: p.team,
            position: p.position || '',
            spells: [
                spellId(p.summonerSpells?.summonerSpellOne?.rawDisplayName),
                spellId(p.summonerSpells?.summonerSpellTwo?.rawDisplayName),
            ],
            keystoneId: p.runes?.keystone?.id ?? null,
            items: (p.items || []).filter(i => i && i.itemID > 0)
                .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0)).map(i => i.itemID),   // #90
            isBot,
            isYou,
            lookup: !isBot && !!gameName && !!tagLine,
        };
    });

    const you = players.find(p => p.isYou);
    const myTeam = you ? you.team : 'ORDER';
    const order = (list) => {
        const humans = list.filter(p => !p.isBot);
        if (!humans.length || !humans.every(p => POSITION_ORDER.includes(p.position))) return list;
        const rank = (p) => { const i = POSITION_ORDER.indexOf(p.position); return i < 0 ? POSITION_ORDER.length : i; };
        return [...list].sort((a, b) => rank(a) - rank(b));
    };

    return [
        ...order(players.filter(p => p.team === myTeam)),
        ...order(players.filter(p => p.team !== myTeam)),
    ].map((p, index) => ({ ...p, index }));
}

/** One row per player in a Match-V5 match, the shape player_games stores. */
function playerGameRows(match) {
    const info = match && match.info;
    if (!info) return [];
    const short = (info.gameDuration || 0) < REMAKE_MAX_SECONDS;
    return (info.participants || [])
        .filter(p => p.puuid && p.puuid !== 'BOT')
        .map(p => ({
            matchId: match.metadata?.matchId,
            puuid: p.puuid,
            queueId: info.queueId,
            gameCreation: info.gameCreation,
            championName: p.championName,
            win: p.win ? 1 : 0,
            kills: p.kills || 0,
            deaths: p.deaths || 0,
            assists: p.assists || 0,
            isRemake: (p.gameEndedInEarlySurrender || short) ? 1 : 0,
        }));
}

/**
 * Recent form over a player's newest RECENT_COUNT games (remakes left out):
 * W/L, KDA summed like the Champions page, a strip oldest → newest, the
 * current streak, and games on `championName` (case-insensitive).
 */
function recentForm(rows, championName) {
    const games = (rows || [])
        .filter(r => !r.isRemake)
        .sort((a, b) => b.gameCreation - a.gameCreation)
        .slice(0, RECENT_COUNT);

    const wins = games.filter(g => g.win).length;
    const sum = (k) => games.reduce((s, g) => s + (g[k] || 0), 0);
    const champ = String(championName || '').toLowerCase();
    const onChampGames = champ ? games.filter(g => String(g.championName).toLowerCase() === champ) : [];

    let streak = null;
    if (games.length) {
        const win = !!games[0].win;
        let count = 0;
        while (count < games.length && !!games[count].win === win) count++;
        streak = { win, count };
    }

    return {
        games: games.length,
        wins,
        losses: games.length - wins,
        winRate: games.length ? wins / games.length : null,
        kda: games.length ? (sum('kills') + sum('assists')) / Math.max(1, sum('deaths')) : null,
        strip: games.map(g => !!g.win).reverse(),
        streak,
        onChamp: { games: onChampGames.length, wins: onChampGames.filter(g => g.win).length },
    };
}

/** Tags for a row, in display order. Any input may be null (not loaded yet). */
function playerTags({ league, mastery, form }) {
    const tags = [];
    const solo = league && league.solo;

    if ((mastery?.points ?? 0) < FIRST_TIME_POINTS && (!form || form.onChamp.games === 0)) tags.push('First time');
    if (form && form.games >= MAIN_MIN_GAMES && form.onChamp.games / form.games >= MAIN_SHARE) tags.push('Main');

    const streak = form && form.streak;
    const winStreak = !!(streak && streak.win && streak.count >= STREAK_MIN);
    if (streak && streak.count >= STREAK_MIN) tags.push(`${streak.win ? 'Win' : 'Loss'} streak ${streak.count}`);
    if (solo && solo.hotStreak && !winStreak) tags.push('Hot streak');

    if (solo && solo.inactive) tags.push('Inactive');
    if (solo && solo.freshBlood) tags.push('Fresh blood');
    if (solo && solo.veteran) tags.push('Veteran');
    return tags;
}

/** The rank to show: Solo/Duo, else Flex, else null (unranked). */
function rankSummary(league) {
    const e = league && (league.solo || league.flex);
    if (!e) return null;
    const played = (e.wins || 0) + (e.losses || 0);
    return {
        queue: league.solo ? 'Solo/Duo' : 'Flex',
        tier: e.tier,
        rank: e.rank,
        lp: e.leaguePoints,
        wins: e.wins || 0,
        losses: e.losses || 0,
        winRate: played ? (e.wins || 0) / played : null,
    };
}

/** Your games with this player on your team (matchService loadTeammates map). */
function gamesTogether(teammatesByMatch, puuid) {
    if (!teammatesByMatch || !puuid) return 0;
    let n = 0;
    for (const list of teammatesByMatch.values()) {
        if ((list || []).some(t => t.puuid === puuid)) n++;
    }
    return n;
}

module.exports = {
    RECENT_COUNT, RECENT_QUEUE, CACHE_TTL_MS, FIRST_TIME_POINTS, STREAK_MIN, MAIN_SHARE, MAIN_MIN_GAMES,
    POSITION_ORDER,
    parsePlayers, findChampion, spellId, playerGameRows, recentForm, playerTags, rankSummary, gamesTogether,
};
