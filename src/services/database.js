const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const electron = require('electron');

// Get userData path - works in both main and renderer processes
// Main process: electron.app is defined
// Renderer process: electron.app is undefined, so compute path manually
let userDataPath;
if (electron.app) {
    // Main process
    userDataPath = electron.app.getPath('userData');
} else {
    // Renderer process - compute userData path manually
    // Windows: %APPDATA%/nexus-insights
    // Mac: ~/Library/Application Support/nexus-insights
    // Linux: ~/.config/nexus-insights
    const appName = 'nexus-insights';
    if (process.platform === 'win32') {
        userDataPath = path.join(process.env.APPDATA, appName);
    } else if (process.platform === 'darwin') {
        userDataPath = path.join(process.env.HOME, 'Library', 'Application Support', appName);
    } else {
        userDataPath = path.join(process.env.HOME, '.config', appName);
    }
}

const dbPath = path.join(userDataPath, 'nexus_data.sqlite');
const db = new sqlite3.Database(dbPath);

function initDatabase() {
  db.serialize(() => {
    // We use matchId as a UNIQUE primary key to prevent duplicates automatically
    db.run(`
      CREATE TABLE IF NOT EXISTS matches (
        matchId TEXT PRIMARY KEY,
        queueId INTEGER,
        gameCreation INTEGER,
        gameDuration INTEGER,
        championName TEXT,
        champLevel INTEGER,
        kills INTEGER,
        deaths INTEGER,
        assists INTEGER,
        win BOOLEAN,
        goldEarned INTEGER,
        totalMinionsKilled INTEGER,
        totalDamageDealtToChampions INTEGER,
        visionScore INTEGER,
        doubleKills INTEGER,
        tripleKills INTEGER,
        quadraKills INTEGER,
        pentaKills INTEGER,
        -- Objectives (player individual)
        turretKills INTEGER,
        inhibitorKills INTEGER,
        dragonKills INTEGER,
        baronKills INTEGER,
        objectivesStolen INTEGER,
        -- Detailed Vision
        wardsPlaced INTEGER,
        wardsKilled INTEGER,
        detectorWardsPlaced INTEGER,
        -- Position/Role
        teamPosition TEXT,
        lane TEXT,
        -- Items (final build)
        item0 INTEGER,
        item1 INTEGER,
        item2 INTEGER,
        item3 INTEGER,
        item4 INTEGER,
        item5 INTEGER,
        item6 INTEGER,
        -- Team objectives
        teamDragons INTEGER,
        enemyDragons INTEGER,
        teamBarons INTEGER,
        enemyBarons INTEGER,
        teamRiftHeralds INTEGER,
        enemyRiftHeralds INTEGER,
        teamTowers INTEGER,
        enemyTowers INTEGER,
        teamInhibitors INTEGER,
        enemyInhibitors INTEGER,
        teamId INTEGER,
        teamKills INTEGER,
        rawJson TEXT,
        timelineJson TEXT,
        -- Advanced stats (computed from rawJson/timelineJson)
        csDiff15 INTEGER,
        goldDiff15 INTEGER,
        xpDiff15 INTEGER,
        firstBlood INTEGER,
        dmgGoldRatio REAL,
        isolatedDeaths INTEGER,
        objectiveRate REAL
      )
    `);

    // Player ranks cache table
    db.run(`
      CREATE TABLE IF NOT EXISTS player_ranks (
        puuid TEXT PRIMARY KEY,
        soloTier TEXT,
        soloRank TEXT,
        soloLP INTEGER,
        flexTier TEXT,
        flexRank TEXT,
        flexLP INTEGER,
        fetchedAt INTEGER NOT NULL
      )
    `);

    // Add indexes for performance
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_gameCreation 
      ON matches(gameCreation DESC)
    `, () => {
      console.log('Index idx_gameCreation ensured');
    });

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_championName 
      ON matches(championName)
    `, () => {
      console.log('Index idx_championName ensured');
    });

    // Add new columns for existing databases (will silently fail if already exists)
    const newColumns = [
      'gameDuration INTEGER',
      'champLevel INTEGER',
      'totalDamageDealtToChampions INTEGER',
      'visionScore INTEGER',
      'doubleKills INTEGER',
      'tripleKills INTEGER',
      'quadraKills INTEGER',
      'pentaKills INTEGER',
      // Objectives
      'turretKills INTEGER',
      'inhibitorKills INTEGER',
      'dragonKills INTEGER',
      'baronKills INTEGER',
      'objectivesStolen INTEGER',
      // Detailed Vision
      'wardsPlaced INTEGER',
      'wardsKilled INTEGER',
      'detectorWardsPlaced INTEGER',
      // Position/Role
      'teamPosition TEXT',
      'lane TEXT',
      // Items
      'item0 INTEGER',
      'item1 INTEGER',
      'item2 INTEGER',
      'item3 INTEGER',
      'item4 INTEGER',
      'item5 INTEGER',
      'item6 INTEGER',
      // Team objectives
      'teamDragons INTEGER',
      'enemyDragons INTEGER',
      'teamBarons INTEGER',
      'enemyBarons INTEGER',
      'teamRiftHeralds INTEGER',
      'enemyRiftHeralds INTEGER',
      'teamTowers INTEGER',
      'enemyTowers INTEGER',
      'teamInhibitors INTEGER',
      'enemyInhibitors INTEGER',
      'teamId INTEGER',
      'teamKills INTEGER',
      // Runes
      'primaryRune INTEGER',
      'secondaryRuneStyle INTEGER',
      // Timeline
      'timelineJson TEXT',
      // Advanced stats
      'csDiff15 INTEGER',
      'goldDiff15 INTEGER',
      'xpDiff15 INTEGER',
      'firstBlood INTEGER',
      'dmgGoldRatio REAL',
      'isolatedDeaths INTEGER',
      'objectiveRate REAL'
    ];
    newColumns.forEach(col => {
      db.run(`ALTER TABLE matches ADD COLUMN ${col}`, () => {
        // Ignore errors (column already exists)
      });
    });
  });
  console.log("Database initialized at:", dbPath);
}

module.exports = { initDatabase, db };