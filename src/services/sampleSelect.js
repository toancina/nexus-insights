/**
 * sampleSelect.js — which sample games to download (pure, tested).
 *
 * Sample games are other players' Solo/Duo games on your 3 most-played
 * champions: the 5 players with the most mastery on that champion at your
 * level (division I of your tier) and one level above (division I of the next
 * tier), 5 games each, kept for 90 days. They feed item/rune WPA, the fitted
 * win-chance curve and Coaching's comparisons; never your own statistics.
 */

const { filterByPeriod } = require('./patches');

const DAY_MS = 86400000;
const TOP_CHAMPIONS = 3;
const PLAYERS_PER_GROUP = 5;
const GAMES_PER_PLAYER = 5;
const RETENTION_MS = 90 * DAY_MS;
const SOLO_QUEUE = 420;

const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

const isRemake = m => (m.isRemake != null ? m.isRemake === 1 || m.isRemake === true : (m.gameDuration || 0) < 300);
const cap = s => s.charAt(0) + s.slice(1).toLowerCase();

/** Your top 3 champions by Solo/Duo games over the last 2 patches; ties → most recent game. */
function topChampions(matches, { now = Date.now() } = {}) {
    const recent = filterByPeriod(matches || [], 'patches:2', { now });
    const byChamp = new Map();
    for (const m of recent) {
        if (m.queueId !== SOLO_QUEUE || isRemake(m) || !m.championName) continue;
        const c = byChamp.get(m.championName) || { name: m.championName, games: 0, last: 0 };
        c.games++;
        c.last = Math.max(c.last, m.gameCreation || 0);
        byChamp.set(m.championName, c);
    }
    return [...byChamp.values()]
        .sort((a, b) => b.games - a.games || b.last - a.last)
        .slice(0, TOP_CHAMPIONS)
        .map(c => c.name);
}

function group(key, tier) {
    const apex = APEX.has(tier);
    return { key, tier, division: apex ? null : 'I', label: apex ? cap(tier) : `${cap(tier)} I` };
}

/**
 * Your level and the level above, from a Solo/Duo reading ({ tier, rank }).
 * [] when unranked; Challenger has no level above.
 */
function sampleGroups(reading) {
    const tier = reading && String(reading.tier || '').toUpperCase();
    const i = TIERS.indexOf(tier);
    if (i < 0) return [];
    const out = [group('level', tier)];
    if (i + 1 < TIERS.length) out.push(group('above', TIERS[i + 1]));
    return out;
}

/**
 * The `count` players with the most mastery points on `championKey` among
 * those who played it within RETENTION_MS. `masteries` is keyed by champion key.
 */
function pickBestPlayers(candidates, championKey, { now = Date.now(), exclude = null, count = PLAYERS_PER_GROUP } = {}) {
    const since = now - RETENTION_MS;
    return (candidates || [])
        .filter(c => c && c.puuid !== exclude)
        .map(c => ({ puuid: c.puuid, m: c.masteries && c.masteries[championKey] }))
        .filter(c => c.m && c.m.points > 0 && c.m.lastPlayTime >= since)
        .sort((a, b) => b.m.points - a.m.points)
        .slice(0, count)
        .map(c => c.puuid);
}

/** 'level' / 'above' when a stored row's tier + division is one of your current groups, else null. */
function groupOf(row, groups) {
    const tier = String(row && row.tier || '').toUpperCase();
    const division = row && row.division ? String(row.division) : null;
    const g = (groups || []).find(x => x.tier === tier && (x.division || null) === division);
    return g ? g.key : null;
}

/**
 * Match-V5 champion name → Data Dragon numeric key, case-insensitive on the id
 * ("FiddleSticks" → Fiddlesticks). Wukong is "MonkeyKing" in both.
 * `championList`: dataDragon.getChampionList() output ({ Aatrox: { id, key }, … })
 * or an array of the same objects.
 */
function championKeyOf(name, championList) {
    const n = String(name || '').toLowerCase();
    const list = Array.isArray(championList) ? championList : Object.values(championList || {});
    const hit = list.find(c => String(c && c.id || '').toLowerCase() === n);
    return hit ? Number(hit.key) : null;
}

module.exports = {
    DAY_MS, TOP_CHAMPIONS, PLAYERS_PER_GROUP, GAMES_PER_PLAYER, RETENTION_MS, TIERS,
    topChampions, sampleGroups, pickBestPlayers, groupOf, championKeyOf,
};
