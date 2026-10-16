const axios = require('axios');
const { getConfigValue, setConfigValue } = require('./config');

// A version that exists on the CDN (checked 2026-10-16). Used only when
// versions.json can't be reached and no version has worked before (#39).
const FALLBACK_VERSION = '16.20.1';
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Which version to use: the newest from versions.json, else the last one that
 * worked on this PC (its icons are likely in the browser cache), else the
 * built-in fallback. Anything that doesn't look like 16.20.1 is ignored.
 */
function pickVersion({ fetched, saved } = {}) {
    if (VERSION_RE.test(fetched || '')) return fetched;
    if (VERSION_RE.test(saved || '')) return saved;
    return FALLBACK_VERSION;
}

function savedVersion() {
    try { return getConfigValue('ddragonVersion'); } catch { return null; }
}

// Data Dragon version - fetched dynamically, with fallback
let DDRAGON_VERSION = pickVersion({ saved: savedVersion() });
let DDRAGON_BASE = `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}`;

// In-memory cache for game data
let gameDataCache = {
    items: null,
    runes: null,
    summonerSpells: null,
    summonerSpellsById: null, // Indexed by spell key (ID number)
    champions: null,          // champion.json data, by Data Dragon id
    loaded: false
};

/**
 * Fetch the latest Data Dragon version from Riot's versions endpoint
 */
async function fetchLatestVersion() {
    let fetched = null;
    try {
        // A stalled connection mustn't hold up loading the game data
        const response = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json', { timeout: 8000 });
        fetched = Array.isArray(response.data) ? response.data[0] : null;
    } catch (err) {
        console.warn('Could not fetch Data Dragon version:', err.message);
    }
    const saved = savedVersion();
    DDRAGON_VERSION = pickVersion({ fetched, saved });
    DDRAGON_BASE = `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}`;
    console.log(`Data Dragon version: ${DDRAGON_VERSION}${DDRAGON_VERSION === fetched ? '' : ' (fallback)'}`);
    // Remember it for a start without internet
    if (DDRAGON_VERSION === fetched && fetched !== saved) {
        try { setConfigValue('ddragonVersion', fetched); } catch { /* not important */ }
    }
}

/**
 * Load all game data from Data Dragon
 */
async function loadGameData() {
    try {
        // Fetch latest version first
        await fetchLatestVersion();

        console.log(`Loading game data from Data Dragon v${DDRAGON_VERSION}...`);

        // Fetch items, runes, summoner spells and champions in parallel
        const [itemsResponse, runesResponse, summonerSpellsResponse, championsResponse] = await Promise.all([
            axios.get(`${DDRAGON_BASE}/data/en_US/item.json`),
            axios.get(`${DDRAGON_BASE}/data/en_US/runesReforged.json`),
            axios.get(`${DDRAGON_BASE}/data/en_US/summoner.json`),
            axios.get(`${DDRAGON_BASE}/data/en_US/champion.json`)
        ]);

        gameDataCache.items = itemsResponse.data.data;
        gameDataCache.runes = runesResponse.data;
        gameDataCache.summonerSpells = summonerSpellsResponse.data.data;
        // id ("Chogath") → { key: "31", name: "Cho'Gath", … }: the Live page
        // needs the numeric key for champion mastery (#59)
        gameDataCache.champions = championsResponse.data.data;

        // Create lookup by spell key (the numeric ID used in match data)
        gameDataCache.summonerSpellsById = {};
        for (const spellName in gameDataCache.summonerSpells) {
            const spell = gameDataCache.summonerSpells[spellName];
            gameDataCache.summonerSpellsById[spell.key] = spell;
        }

        gameDataCache.loaded = true;

        console.log(`✓ Loaded ${Object.keys(gameDataCache.items).length} items`);
        console.log(`✓ Loaded ${gameDataCache.runes.length} rune trees`);
        console.log(`✓ Loaded ${Object.keys(gameDataCache.summonerSpells).length} summoner spells`);

        return gameDataCache;
    } catch (error) {
        console.error('Failed to load game data:', error.message);
        // Set empty objects so app doesn't crash
        gameDataCache.items = {};
        gameDataCache.runes = [];
        gameDataCache.summonerSpells = {};
        gameDataCache.summonerSpellsById = {};
        gameDataCache.champions = {};
        gameDataCache.loaded = false;
        throw error;
    }
}

/**
 * Get item data by ID
 */
function getItemData(itemId) {
    if (!gameDataCache.loaded || !itemId) return null;
    return gameDataCache.items[itemId] || null;
}

/**
 * Get rune data by ID
 * Searches through all rune trees to find the matching rune
 */
function getRuneData(runeId) {
    if (!gameDataCache.loaded || !runeId) return null;

    // Search through all rune trees
    for (const tree of gameDataCache.runes) {
        // Check if it's a tree style ID (8000, 8100, etc.)
        if (tree.id === runeId) {
            return {
                name: tree.name,
                icon: tree.icon,
                description: `${tree.name} - Rune Tree`
            };
        }

        // Search through slots for keystones and regular runes
        for (const slot of tree.slots) {
            for (const rune of slot.runes) {
                if (rune.id === runeId) {
                    return {
                        name: rune.name,
                        icon: rune.icon,
                        shortDesc: rune.shortDesc,
                        longDesc: rune.longDesc
                    };
                }
            }
        }
    }

    return null;
}

/**
 * Get summoner spell data by ID (the numeric key)
 */
function getSummonerSpellData(spellId) {
    if (!gameDataCache.loaded || !spellId) return null;
    return gameDataCache.summonerSpellsById[spellId] || null;
}

/**
 * Check if game data is loaded
 */
function isGameDataLoaded() {
    return gameDataCache.loaded;
}

/**
 * Get the full game data cache (for debugging)
 */
function getGameDataCache() {
    return gameDataCache;
}

/** Data Dragon champion.json `data` ({} until loadGameData has run). */
function getChampionList() {
    return gameDataCache.champions || {};
}

function getDDragonVersion() {
    return DDRAGON_VERSION;
}

function getDDragonBase() {
    return DDRAGON_BASE;
}

module.exports = {
    pickVersion,
    FALLBACK_VERSION,
    loadGameData,
    getItemData,
    getRuneData,
    getSummonerSpellData,
    isGameDataLoaded,
    getGameDataCache,
    getChampionList,
    getDDragonVersion,
    getDDragonBase
};
