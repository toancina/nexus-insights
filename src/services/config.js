const fs = require('fs');
const path = require('path');
const electron = require('electron');

// Get userData path - works in both main and renderer processes
let userDataPath;
if (electron.app) {
    userDataPath = electron.app.getPath('userData');
} else {
    const appName = 'nexus-insights';
    if (process.platform === 'win32') {
        userDataPath = path.join(process.env.APPDATA, appName);
    } else if (process.platform === 'darwin') {
        userDataPath = path.join(process.env.HOME, 'Library', 'Application Support', appName);
    } else {
        userDataPath = path.join(process.env.HOME, '.config', appName);
    }
}

const configPath = path.join(userDataPath, 'config.json');

// Default config (empty - user must fill in)
const defaultConfig = {
    apiKey: '',
    gameName: '',
    tagLine: '',
    region: 'europe',      // Regional routing: europe, americas, asia
    platform: 'euw1'       // Platform: euw1, na1, kr, etc.
};

// Ensure userData directory exists
function ensureUserDataDir() {
    if (!fs.existsSync(userDataPath)) {
        fs.mkdirSync(userDataPath, { recursive: true });
    }
}

// Load config from file
function loadConfig() {
    console.log('=== loadConfig DEBUG ===');
    console.log('userDataPath:', userDataPath);
    console.log('configPath:', configPath);
    console.log('Config file exists:', fs.existsSync(configPath));

    ensureUserDataDir();
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            const config = { ...defaultConfig, ...JSON.parse(data) };
            console.log('Config loaded successfully:', JSON.stringify({
                ...config,
                apiKey: config.apiKey ? '[PRESENT - length: ' + config.apiKey.length + ']' : '[MISSING]'
            }));
            return config;
        } else {
            console.log('Config file does not exist, returning defaults');
        }
    } catch (err) {
        console.error('Error loading config:', err);
    }
    return { ...defaultConfig };
}

// Save config to file
function saveConfig(config) {
    ensureUserDataDir();
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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
function setConfigValue(key, value) {
    const config = loadConfig();
    config[key] = value;
    return saveConfig(config);
}

module.exports = {
    loadConfig,
    saveConfig,
    isConfigValid,
    getConfigValue,
    setConfigValue,
    configPath,
    userDataPath
};
