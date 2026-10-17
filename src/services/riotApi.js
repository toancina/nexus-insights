const axios = require('axios');
const { loadConfig } = require('./config');
const { RateLimiter, DEFAULT_WINDOWS } = require('./rateLimiter');

// Every outbound Riot call goes through this one limiter so the windows are
// enforced across the whole app, not per-function.
const limiter = new RateLimiter(DEFAULT_WINDOWS, {
    log: msg => console.warn(`[riot] ${msg}`),
});

// Get config values (loaded fresh each time to pick up changes)
function getApiKey() {
    return loadConfig().apiKey;
}

/**
 * Which regional cluster serves Match-V5 for each platform (server).
 *
 * This is fixed by Riot, so it is derived from the platform rather than asked
 * for separately. Asking separately let the two disagree — an NA player who
 * changed the server to NA but left the region on the default Europe got an
 * empty match list with no error — and the old region list had no "sea" at
 * all, so OCE/PH/SG/TH/TW/VN players could never sync.
 */
const PLATFORM_ROUTING = {
    na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
    euw1: 'europe',  eun1: 'europe',  tr1: 'europe',   ru: 'europe', me1: 'europe',
    kr: 'asia',      jp1: 'asia',
    oc1: 'sea', ph2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', vn2: 'sea',
};

function getPlatform() {
    return loadConfig().platform || 'euw1';
}

/** Pure: Match-V5 routing for a platform, or `fallback` if it's unknown. */
function routingFor(platform, fallback = 'europe') {
    return PLATFORM_ROUTING[platform] || fallback;
}

/**
 * Pure: Account-V1 routing for a platform. Account-V1 is served from
 * americas/asia/europe only (not sea), and any of them can look up any
 * account — so SEA players use asia.
 */
function accountRoutingFor(platform, fallback = 'europe') {
    const r = routingFor(platform, fallback);
    return r === 'sea' ? 'asia' : r;
}

/** Match-V5 routing: derived from the platform; config.region only as a fallback. */
function getRegion() {
    return routingFor(getPlatform(), loadConfig().region || 'europe');
}

function getAccountRegion() {
    return accountRoutingFor(getPlatform(), loadConfig().region || 'europe');
}

/**
 * Single entry point for Riot HTTP calls.
 *
 * The key goes in the X-Riot-Token header rather than an api_key query
 * parameter — query strings end up in proxy logs, crash reports and browser
 * history, headers generally don't.
 */
function riotGet(url, { params, label, timeout = 15000, apiKey: keyOverride = null, retries } = {}) {
    // keyOverride: Settings checks a key before it is saved (#74)
    const apiKey = keyOverride || getApiKey();
    if (!apiKey) throw new Error('No Riot API key configured — open Settings and add one.');

    return limiter.request(
        () => axios.get(url, {
            params,
            timeout,
            headers: { 'X-Riot-Token': apiKey },
        }),
        { label, retries }
    ).then(res => res.data);
}

// Fetch ALL match IDs with pagination support.
// startTime: epoch milliseconds (optional) — only fetch matches after this time.
// existingIds: Set of match IDs already in the DB; hitting one stops pagination.
async function getMatchIds(puuid, startTime = null, queue = null, existingIds = null) {
    const REGION = getRegion();
    const allMatchIds = [];
    const batchSize = 100; // Riot API max per request
    let start = 0;

    console.log(`Fetching match IDs${startTime ? ` since ${new Date(startTime).toISOString()}` : ' (recent)'}${queue ? ` (queue=${queue})` : ''}...`);

    while (true) {
        const url = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`;
        const params = { start, count: batchSize };

        // Riot expects startTime in SECONDS; the app stores milliseconds
        if (startTime) params.startTime = Math.floor(startTime / 1000);
        if (queue) params.queue = queue;

        const matchIds = await riotGet(url, { params, label: `match ids start=${start}` });

        if (matchIds.length === 0) break;

        // If we hit a match we already have, everything older is already stored
        let stopFetching = false;
        for (const id of matchIds) {
            if (existingIds && existingIds.has(id)) {
                console.log(`Encountered existing match ID ${id}, stopping pagination.`);
                stopFetching = true;
                break;
            }
            allMatchIds.push(id);
        }

        if (stopFetching) break;
        if (matchIds.length < batchSize) break; // partial batch = end of history

        start += batchSize;
        // No manual sleep here — the limiter paces every request.
    }

    console.log(`Total NEW match IDs fetched: ${allMatchIds.length}`);
    return allMatchIds;
}

async function getMatchData(matchId) {
    const REGION = getRegion();
    return riotGet(
        `https://${REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}`,
        { label: `match ${matchId}` }
    );
}

async function getMatchTimeline(matchId) {
    const REGION = getRegion();
    return riotGet(
        `https://${REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline`,
        { label: `timeline ${matchId}`, timeout: 30000 }
    );
}

// Get PUUID from Riot ID (gameName#tagLine)
async function getPuuidByRiotId(gameName, tagLine) {
    // Account-v1 uses regional routing, but only americas/europe/asia exist
    const REGION = getAccountRegion();
    const url = `https://${REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/`
        + `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;

    try {
        const data = await riotGet(url, { label: `account ${gameName}#${tagLine}`, timeout: 10000 });
        return data.puuid; // 78-character PUUID
    } catch (error) {
        console.error(`Could not resolve ${gameName}#${tagLine}:`, describeError(error));
        throw error;
    }
}

/**
 * Check what Settings is about to save (#74): the key works, the Riot ID
 * exists, and it has a League account on that server. Two calls, with the
 * key from the dialog rather than the saved one, and no retries, so an
 * offline check fails fast. Resolves to the PUUID; a failure carries
 * `step` ('account' | 'summoner') for riotErrors.verifyProblem().
 */
async function verifyAccount({ apiKey, gameName, tagLine, platform }) {
    const opts = { apiKey, timeout: 10000, retries: 0 };
    let puuid;
    try {
        const data = await riotGet(
            `https://${accountRoutingFor(platform)}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/`
            + `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
            { ...opts, label: 'check account' });
        puuid = data.puuid;
    } catch (err) { err.step = 'account'; throw err; }
    try {
        await riotGet(`https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`,
            { ...opts, label: 'check server' });
    } catch (err) { err.step = 'summoner'; throw err; }
    return puuid;
}

// Get summoner info (needed for the league endpoint)
async function getSummonerByPuuid(puuid) {
    const PLATFORM = getPlatform();
    try {
        return await riotGet(
            `https://${PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`,
            { label: 'summoner', timeout: 10000 }
        );
    } catch (error) {
        console.error('Error fetching summoner:', describeError(error));
        throw error;
    }
}

// Get league/rank information by PUUID
async function getLeagueByPuuid(puuid) {
    const PLATFORM = getPlatform();
    try {
        const leagues = await riotGet(
            `https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`,
            { label: 'league', timeout: 10000 }
        );

        const pick = (entry) => entry ? {
            tier: entry.tier,
            rank: entry.rank,
            leaguePoints: entry.leaguePoints,
            wins: entry.wins,
            losses: entry.losses,
            hotStreak: !!entry.hotStreak,
            veteran: !!entry.veteran,
            freshBlood: !!entry.freshBlood,
            inactive: !!entry.inactive,
        } : null;

        return {
            solo: pick(leagues.find(l => l.queueType === 'RANKED_SOLO_5x5')),
            flex: pick(leagues.find(l => l.queueType === 'RANKED_FLEX_SR')),
        };
    } catch (error) {
        console.error('Error fetching league data:', describeError(error));
        throw error;
    }
}

/**
 * A player's mastery on one champion (Live page, #59): { level, points,
 * lastPlayTime } or null when they have never played it (Riot answers 404).
 */
async function getChampionMastery(puuid, championKey) {
    const PLATFORM = getPlatform();
    try {
        const m = await riotGet(
            `https://${PLATFORM}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/by-champion/${championKey}`,
            { label: `mastery ${championKey}`, timeout: 10000 }
        );
        return { level: m.championLevel, points: m.championPoints, lastPlayTime: m.lastPlayTime };
    } catch (error) {
        if (error.response?.status === 404) return null;
        console.error('Error fetching champion mastery:', describeError(error));
        throw error;
    }
}

/**
 * A player's newest match ids in one queue, one call (Live page, #59).
 * getMatchIds pages through a whole history; this only wants the last few.
 */
async function getRecentMatchIds(puuid, { queue = 420, count = 10 } = {}) {
    const REGION = getRegion();
    return riotGet(
        `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`,
        { params: { start: 0, count, queue }, label: `recent ids q=${queue}` }
    );
}

/** Error summary that never includes the API key. */
function describeError(error) {
    if (error.response) {
        return `HTTP ${error.response.status} ${JSON.stringify(error.response.data)}`;
    }
    return error.message;
}

module.exports = {
    verifyAccount,
    getMatchIds, getMatchData, getMatchTimeline,
    getPuuidByRiotId, getSummonerByPuuid, getLeagueByPuuid,
    getChampionMastery, getRecentMatchIds,
    limiter,
    PLATFORM_ROUTING, routingFor, accountRoutingFor,
};
