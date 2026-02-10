const axios = require('axios');
const { loadConfig } = require('./config');

// Get config values (loaded fresh each time to pick up changes)
function getApiKey() {
    return loadConfig().apiKey;
}

function getRegion() {
    return loadConfig().region || 'europe';
}

function getPlatform() {
    return loadConfig().platform || 'euw1';
}

// Fetch ALL match IDs with pagination support
// startTime: epoch timestamp in seconds (optional) - only fetch matches AFTER this time
// If startTime is provided, fetches ALL matches since that time (no limit)
// If startTime is null, fetches recent matches (up to 100)
async function getMatchIds(puuid, startTime = null, queue = null) {
    const API_KEY = getApiKey();
    const REGION = getRegion();
    const allMatchIds = [];
    const batchSize = 100; // Riot API max per request
    let start = 0;

    console.log(`Fetching match IDs${startTime ? ` since ${new Date(startTime * 1000).toISOString()}` : ' (recent)'}${queue ? ` (queue=${queue})` : ''}...`);

    while (true) {
        let url = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${start}&count=${batchSize}&api_key=${API_KEY}`;

        // Add startTime filter if provided
        if (startTime) {
            url += `&startTime=${startTime}`;
        }

        // Add queue filter if provided (required for special modes like ARAM Mayhem)
        if (queue) {
            url += `&queue=${queue}`;
        }

        console.log(`Fetching batch starting at index ${start}...`);
        const response = await axios.get(url);
        const matchIds = response.data;

        console.log(`Got ${matchIds.length} match IDs in this batch`);

        if (matchIds.length === 0) {
            // No more matches available
            console.log('No more matches found, pagination complete.');
            break;
        }

        allMatchIds.push(...matchIds);
        start += batchSize;

        // If we got less than batchSize, we've reached the end
        if (matchIds.length < batchSize) {
            console.log('Received partial batch, pagination complete.');
            break;
        }

        // Small delay between pagination requests to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    console.log(`Total match IDs fetched: ${allMatchIds.length}`);
    return allMatchIds;
}

async function getMatchData(matchId) {
    const API_KEY = getApiKey();
    const REGION = getRegion();
    const url = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}?api_key=${API_KEY}`;
    const response = await axios.get(url);
    return response.data;
}

async function getMatchTimeline(matchId) {
    const API_KEY = getApiKey();
    const REGION = getRegion();
    const url = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline?api_key=${API_KEY}`;
    const response = await axios.get(url);
    return response.data;
}

// Get PUUID from Riot ID (gameName#tagLine)
async function getPuuidByRiotId(gameName, tagLine) {
    const API_KEY = getApiKey();
    const REGION = getRegion();

    console.log('=== getPuuidByRiotId DEBUG ===');
    console.log('gameName received:', JSON.stringify(gameName));
    console.log('tagLine received:', JSON.stringify(tagLine));
    console.log('API_KEY present:', API_KEY ? 'YES (length: ' + API_KEY.length + ')' : 'NO - MISSING!');
    console.log('REGION:', REGION);

    // Account-v1 uses regional routing (americas, europe, or asia)
    const url = `https://${REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}?api_key=${API_KEY}`;
    console.log('Full URL (redacted key):', url.replace(API_KEY, 'REDACTED'));

    try {
        const response = await axios.get(url);
        console.log('API Response success! PUUID:', response.data.puuid);
        return response.data.puuid; // This returns the 78-character PUUID
    } catch (error) {
        console.error('API Error in getPuuidByRiotId:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', JSON.stringify(error.response.data));
        }
        throw error;
    }
}

// Get summoner info (needed for league endpoint)
async function getSummonerByPuuid(puuid) {
    const API_KEY = getApiKey();
    const PLATFORM = getPlatform();
    console.log('getSummonerByPuuid called with PUUID:', puuid);
    try {
        const url = `https://${PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}?api_key=${API_KEY}`;
        console.log('Fetching summoner by PUUID from:', url.replace(API_KEY, 'REDACTED'));
        const response = await axios.get(url, { timeout: 10000 });
        console.log('Summoner data received:', response.data);
        return response.data; // Returns: id, accountId, puuid, name, summonerLevel, etc.
    } catch (error) {
        console.error('ERROR in getSummonerByPuuid:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        throw error;
    }
}

// Get league/rank information by PUUID
async function getLeagueByPuuid(puuid) {
    const API_KEY = getApiKey();
    const PLATFORM = getPlatform();
    console.log('getLeagueByPuuid called');
    console.log('API_KEY loaded:', API_KEY ? 'YES (length: ' + API_KEY.length + ')' : 'NO - API KEY IS MISSING!');

    try {
        const url = `https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}?api_key=${API_KEY}`;
        console.log('Fetching league data from:', url.replace(API_KEY, 'REDACTED'));
        const response = await axios.get(url, { timeout: 10000 });

        // Returns array of league entries (one for each queue type)
        const leagues = response.data;
        console.log('League entries received:', leagues);

        // Find Solo/Duo and Flex queues
        const soloQueue = leagues.find(league => league.queueType === 'RANKED_SOLO_5x5');
        const flexQueue = leagues.find(league => league.queueType === 'RANKED_FLEX_SR');

        return {
            solo: soloQueue ? {
                tier: soloQueue.tier,
                rank: soloQueue.rank,
                leaguePoints: soloQueue.leaguePoints,
                wins: soloQueue.wins,
                losses: soloQueue.losses
            } : null,
            flex: flexQueue ? {
                tier: flexQueue.tier,
                rank: flexQueue.rank,
                leaguePoints: flexQueue.leaguePoints,
                wins: flexQueue.wins,
                losses: flexQueue.losses
            } : null
        };
    } catch (error) {
        console.error('Error fetching league data:', error.message);
        if (error.response) {
            console.error('API Response:', error.response.status, error.response.data);
        }
        throw error;
    }
}

module.exports = { getMatchIds, getMatchData, getMatchTimeline, getPuuidByRiotId, getSummonerByPuuid, getLeagueByPuuid };
