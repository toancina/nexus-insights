const axios = require('axios');

// Data Dragon version - fetched dynamically, with fallback
let DDRAGON_VERSION = '25.S1.1';
let DDRAGON_BASE = `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}`;

// In-memory cache for game data
let gameDataCache = {
    items: null,
    runes: null,
    summonerSpells: null,
    summonerSpellsById: null, // Indexed by spell key (ID number)
    loaded: false
};

/**
 * Fetch the latest Data Dragon version from Riot's versions endpoint
 */
async function fetchLatestVersion() {
    try {
        const response = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json');
        const versions = response.data;
        if (versions && versions.length > 0) {
            DDRAGON_VERSION = versions[0];
            DDRAGON_BASE = `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}`;
            console.log('Data Dragon version set to:', DDRAGON_VERSION);
        }
    } catch (err) {
        console.warn('Could not fetch Data Dragon version, using fallback:', DDRAGON_VERSION);
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

        // Fetch items, runes, and summoner spells in parallel
        const [itemsResponse, runesResponse, summonerSpellsResponse] = await Promise.all([
            axios.get(`${DDRAGON_BASE}/data/en_US/item.json`),
            axios.get(`${DDRAGON_BASE}/data/en_US/runesReforged.json`),
            axios.get(`${DDRAGON_BASE}/data/en_US/summoner.json`)
        ]);

        gameDataCache.items = itemsResponse.data.data;
        gameDataCache.runes = runesResponse.data;
        gameDataCache.summonerSpells = summonerSpellsResponse.data.data;

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

function getDDragonVersion() {
    return DDRAGON_VERSION;
}

function getDDragonBase() {
    return DDRAGON_BASE;
}

module.exports = {
    loadGameData,
    getItemData,
    getRuneData,
    getSummonerSpellData,
    isGameDataLoaded,
    getGameDataCache,
    getDDragonVersion,
    getDDragonBase
};
