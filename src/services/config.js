const fs = require('fs');
const path = require('path');
const { userDataPath } = require('./paths');

const configPath = path.join(userDataPath, 'config.json');
const tmpPath    = configPath + '.tmp';   // written first, then renamed over config.json
const backupPath = configPath + '.bak';   // the save before the current one

// Default config (empty - user must fill in)
const defaultConfig = {
    apiKey: '',
    gameName: '',
    tagLine: '',
    region: 'europe',      // Regional routing: europe, americas, asia
    platform: 'euw1',      // Platform: euw1, na1, kr, etc.

    // Background behaviour. Both default on because they're what make
    // per-match LP work: Riot exposes no LP history, so the app has to be
    // running to observe changes as they happen.
    closeToTray: true,     // X hides to the system tray instead of quitting
    startOnLogin: true,    // launch automatically when Windows starts

    // Watch the League client's local Live Client Data API (127.0.0.1:2999)
    // to detect when a game starts and ends, then log it automatically.
    autoLogGames: true
};

// Ensure userData directory exists
function ensureUserDataDir() {
    if (!fs.existsSync(userDataPath)) {
        fs.mkdirSync(userDataPath, { recursive: true });
    }
}

// In-memory cache — loadConfig() is called on every Riot API request, and a
// sync issues hundreds of them. Reading the file once and invalidating on
// save turns those into plain object reads.
let cachedConfig = null;

// Load config from file (cached after first read)
function loadConfig() {
    if (cachedConfig) return { ...cachedConfig };
    return readConfigFile();
}

/**
 * Read config.json (or its backup) from disk, bypassing the cache, and cache
 * the result. Writes start from this: the main process and the renderer each
 * have their own cache, so a cached copy can be older than the file (#72).
 */
function readConfigFile() {
    ensureUserDataDir();
    // config.json, or the copy kept from the save before it if that one is
    // missing or doesn't parse (#40)
    for (const file of [configPath, backupPath]) {
        try {
            if (fs.existsSync(file)) {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (data === null || typeof data !== 'object') throw new Error('not an object');
                if (file === backupPath) console.warn('config.json unreadable; using the previous save');
                cachedConfig = { ...defaultConfig, ...data };
                return { ...cachedConfig };
            }
        } catch (err) {
            console.error(`Error loading ${path.basename(file)}:`, err.message);
        }
    }
    cachedConfig = null;
    return { ...defaultConfig };
}

/** Forget the cached copy; the next loadConfig() reads the file. */
function clearConfigCache() {
    cachedConfig = null;
}

/**
 * Change some keys and keep everything else as it is **on disk**. Use this
 * rather than saveConfig({ ...loadConfig(), … }): the other process may have
 * saved since this one cached the file, and writing the cached copy back
 * would undo that save (#72). `remove` lists keys to delete.
 */
function updateConfig(patch, { remove = [] } = {}) {
    const config = { ...readConfigFile(), ...patch };
    for (const key of remove) delete config[key];
    return saveConfig(config);
}

// Save config to file: write a temp file, keep the current file as .bak, then
// rename the temp file over it. A crash mid-write can only ever leave a broken
// .tmp, never a half-written config.json (#40).
function saveConfig(config) {
    ensureUserDataDir();
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
        if (fs.existsSync(configPath)) {
            try { fs.copyFileSync(configPath, backupPath); } catch (e) { console.warn('Could not keep config backup:', e.message); }
        }
        try {
            fs.renameSync(tmpPath, configPath);
        } catch (err) {
            // Windows can refuse the rename while something (antivirus, a sync
            // client) has the file open; write it directly rather than not at all
            console.warn('Config rename failed, writing in place:', err.message);
            fs.writeFileSync(configPath, fs.readFileSync(tmpPath));
            fs.rmSync(tmpPath, { force: true });
        }
        cachedConfig = { ...defaultConfig, ...config };
        return true;
    } catch (err) {
        console.error('Error saving config:', err);
        return false;
    }
}

// Check if config is valid (has required fields)
function isConfigValid(config) {
    return config &&
           config.apiKey && config.apiKey.trim() !== '' &&
           config.gameName && config.gameName.trim() !== '' &&
           config.tagLine && config.tagLine.trim() !== '';
}

// Get a specific config value
function getConfigValue(key) {
    const config = loadConfig();
    return config[key];
}

// Set a specific config value
/**
 * Has `key` been saved to config.json (as opposed to coming from the
 * defaults)? Reads the file itself, since loadConfig() merges the defaults in.
 */
function hasSavedValue(key) {
    try {
        if (!fs.existsSync(configPath)) return false;
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return saved !== null && typeof saved === 'object' && Object.prototype.hasOwnProperty.call(saved, key);
    } catch {
        return false;
    }
}

function setConfigValue(key, value) {
    return updateConfig({ [key]: value });
}

module.exports = {
    loadConfig,
    saveConfig,
    updateConfig,
    clearConfigCache,
    isConfigValid,
    getConfigValue,
    setConfigValue,
    hasSavedValue,
    configPath,
    userDataPath
};
