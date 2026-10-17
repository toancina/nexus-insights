const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { compressJson } = require('./compression');
const { userDataPath } = require('./paths');
const { ALLOWED_QUEUES } = require('./queues');
const { absoluteLp, attributeReadings, deltasByMatch } = require('./lpAttribution');

const dbPath = path.join(userDataPath, 'nexus_data.sqlite');
const db = new sqlite3.Database(dbPath);

// The main process and the window each open this file (both require this
// module). sqlite3 waits only 1 s for the other one's lock before failing
// with SQLITE_BUSY, and a migration can hold it longer (migration 6 rewrites
// every row while the window's startup backfill is writing) (#35).
const BUSY_TIMEOUT_MS = 5000;
db.configure('busyTimeout', BUSY_TIMEOUT_MS);

// Promisify db methods for migration
function dbRunAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAllAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/**
 * Run database migrations (called after schema setup).
 * Migration 1: Compress rawJson/timelineJson TEXT → gzip BLOB
 */
async function runMigrations() {
  // Create schema_version table if it doesn't exist
  await dbRunAsync(`
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )
    `);

  // Each migration is independent and self-skipping. Migration 1 used to
  // `return` when already applied, which silently prevented every later
  // migration from ever running.
  await migrateCompressJson();
  await migrateLpResolution();
  await migrateLpGameCounts();
  await migrateLpCheckpoints();
  await migrateRecomputePlatesAndObjectiveRate();
  await migrateUnsupportedQueues();
}

/**
 * Migration 7 — games from queues the app doesn't support (#68). Before sync
 * kept only ALLOWED_QUEUES, a few Arena games (queue 1700, 16 players) were
 * stored. Every page hides them, but Chat's "all queues" counted them, and
 * their team-impact ranks (14 and 15 "of 10") were meaningless. Removes them
 * and their match_teammates rows, once.
 */
async function migrateUnsupportedQueues() {
  const done = await dbGetAsync('SELECT version FROM schema_version WHERE version = 7');
  if (done) return;
  const allowed = [...ALLOWED_QUEUES].join(',');
  const gone = await dbAllAsync(`SELECT matchId, queueId FROM matches WHERE queueId IS NULL OR queueId NOT IN (${allowed})`);
  if (gone.length) {
    const tables = (await dbAllAsync("SELECT name FROM sqlite_master WHERE type = 'table'")).map(t => t.name);
    if (tables.includes('match_teammates')) {
      await dbRunAsync(`DELETE FROM match_teammates WHERE matchId IN (SELECT matchId FROM matches WHERE queueId IS NULL OR queueId NOT IN (${allowed}))`);
    }
    await dbRunAsync(`DELETE FROM matches WHERE queueId IS NULL OR queueId NOT IN (${allowed})`);
  }
  await dbRunAsync('INSERT INTO schema_version (version, applied_at) VALUES (7, ?)', [Date.now()]);
  const byQueue = {};
  for (const g of gone) byQueue[g.queueId] = (byQueue[g.queueId] || 0) + 1;
  console.log(`Migration 7 complete — removed ${gone.length} game(s) from unsupported queues${gone.length ? ' ' + JSON.stringify(byQueue) : ''}.`);
}

/**
 * Migration 6 — plates and objective rate were computed wrong (platesTaken
 * from Riot's counter, which includes plate events after 14:00; objectiveRate
 * from a dead/alive check that almost never said "dead"). Clearing the
 * computed-stats stamp makes the background backfill recompute every game
 * with the fixed rules (services/timelineRules.js). Until it reaches a game,
 * the analytics tabs fall back to reading its blobs.
 */
async function migrateRecomputePlatesAndObjectiveRate() {
  const done = await dbGetAsync('SELECT version FROM schema_version WHERE version = 6');
  if (done) return;
  const cols = (await dbAllAsync('PRAGMA table_info(matches)')).map(c => c.name);
  if (cols.includes('statsComputedAt')) {
    await dbRunAsync('UPDATE matches SET statsComputedAt = NULL');
  }
  await dbRunAsync('INSERT INTO schema_version (version, applied_at) VALUES (6, ?)', [Date.now()]);
  console.log('Migration 6 complete — plates and objective rate will be recomputed.');
}

/**
 * Migration 5 — LP checkpoints (#5). A checkpoint is an lp_history row you
 * entered by hand (`manual = 1`): a known rank on a date, which anchors the
 * LP estimates for games played before tracking. It replaces the hard-coded
 * SOLO_LP_SEED, which wrote the same kind of row (noon UTC, no wins/losses)
 * into every database it ran against; those rows become checkpoints too, so
 * they can be deleted where they don't belong.
 */
async function migrateLpCheckpoints() {
  const done = await dbGetAsync('SELECT version FROM schema_version WHERE version = 5');
  if (done) return;
  const cols = (await dbAllAsync('PRAGMA table_info(lp_history)')).map(c => c.name);
  if (!cols.includes('manual')) await dbRunAsync('ALTER TABLE lp_history ADD COLUMN manual INTEGER');
  await dbRunAsync(
    `UPDATE lp_history SET manual = 1
     WHERE manual IS NULL AND wins IS NULL AND recorded_at % 86400000 = 43200000`
  );
  await dbRunAsync('INSERT INTO schema_version (version, applied_at) VALUES (5, ?)', [Date.now()]);
  console.log('Migration 5 complete — LP checkpoints.');
}

/**
 * Migration 4 — store wins/losses with every LP reading, and redo every link.
 *
 * The old attribution blamed a reading on "the latest ranked game in the
 * previous 3 hours", so a reading taken before its game was synced landed on
 * the game before it (issue #1). W/L lets attributeReadings() tell how many
 * games a change covers; recomputing fixes the links already stored.
 */
async function migrateLpGameCounts() {
  const done = await dbGetAsync('SELECT version FROM schema_version WHERE version = 4');
  if (done) return;

  console.log('Running migration 4: wins/losses on LP readings...');
  const cols = (await dbAllAsync('PRAGMA table_info(lp_history)')).map(c => c.name);
  if (!cols.includes('wins'))   await dbRunAsync('ALTER TABLE lp_history ADD COLUMN wins INTEGER');
  if (!cols.includes('losses')) await dbRunAsync('ALTER TABLE lp_history ADD COLUMN losses INTEGER');

  const { linked } = await attachLpReadingsToMatches();
  await dbRunAsync(
    'INSERT INTO schema_version (version, applied_at) VALUES (4, ?)',
    [Date.now()]
  );
  console.log(`Migration 4 complete — ${linked} LP reading link(s) corrected.`);
}

/**
 * Migration 3 — let LP history hold more than one reading per day.
 *
 * The original table had a UNIQUE index on (queue, recorded_date) and wrote
 * with ON CONFLICT DO UPDATE, so a second reading on the same day overwrote
 * the first. That capped the LP chart at one point per day and made per-match
 * LP impossible. This drops the constraint and adds the matchId link.
 */
async function migrateLpResolution() {
  const done = await dbGetAsync('SELECT version FROM schema_version WHERE version = 3');
  if (done) return;

  console.log('Running migration 3: per-reading LP history...');

  await dbRunAsync('DROP INDEX IF EXISTS idx_lp_queue_date');

  const cols = await dbAllAsync('PRAGMA table_info(lp_history)');
  if (!cols.some(c => c.name === 'matchId')) {
    await dbRunAsync('ALTER TABLE lp_history ADD COLUMN matchId TEXT');
  }

  await dbRunAsync('CREATE INDEX IF NOT EXISTS idx_lp_queue_time ON lp_history(queue, recorded_at)');
  await dbRunAsync('CREATE INDEX IF NOT EXISTS idx_lp_match ON lp_history(matchId)');

  await dbRunAsync(
    'INSERT INTO schema_version (version, applied_at) VALUES (3, ?)',
    [Date.now()]
  );
  console.log('Migration 3 complete — LP history can now hold intra-day readings.');
}

async function migrateCompressJson() {
  // Check if migration 1 (compression) has already been applied
  const migrationDone = await dbGetAsync(
    'SELECT version FROM schema_version WHERE version = 1'
  );

  if (migrationDone) {
    console.log('Migration 1 (JSON compression) already applied.');
    return;
  }

  console.log('Running migration 1: Compressing rawJson/timelineJson...');

  // Backup the database file before migration
  const backupPath = dbPath.replace('.sqlite', '.backup.sqlite');
  try {
    fs.copyFileSync(dbPath, backupPath);
    console.log(`Database backup created at: ${backupPath}`);
  } catch (err) {
    console.error('Failed to create backup, aborting migration:', err.message);
    return;
  }

  // Row-by-row, ids first. The previous version selected every blob in one
  // query — >130MB of JSON strings in memory at once — which is what kept
  // this migration from ever completing on a real database. Only rows whose
  // blobs are still legacy TEXT are touched, so an interrupted run resumes
  // where it stopped.
  const ids = await dbAllAsync(`
    SELECT matchId FROM matches
    WHERE typeof(rawJson) = 'text' OR typeof(timelineJson) = 'text'
  `);

  let compressed = 0, failed = 0;
  for (const { matchId } of ids) {
    try {
      const row = await dbGetAsync(
        'SELECT rawJson, timelineJson FROM matches WHERE matchId = ?',
        [matchId]
      );
      const rawBuf = typeof row.rawJson === 'string' ? compressJson(row.rawJson) : row.rawJson;
      const tlBuf  = typeof row.timelineJson === 'string' ? compressJson(row.timelineJson) : row.timelineJson;

      await dbRunAsync(
        'UPDATE matches SET rawJson = ?, timelineJson = ? WHERE matchId = ?',
        [rawBuf, tlBuf, matchId]
      );
      compressed++;

      if (compressed % 50 === 0) {
        console.log(`  Compressed ${compressed}/${ids.length} matches...`);
      }
    } catch (err) {
      failed++;
      console.warn(`  Failed to compress match ${matchId}:`, err.message);
    }
  }

  console.log(`Compressed ${compressed}/${ids.length} matches (${failed} failed).`);

  // Only mark done when nothing was left behind — a partial run retries next
  // launch and skips the rows it already converted.
  if (failed > 0) {
    console.warn('Migration 1 incomplete — will retry the failed rows on next launch.');
    return;
  }

  await dbRunAsync(
    'INSERT INTO schema_version (version, applied_at) VALUES (1, ?)',
    [Date.now()]
  );

  // VACUUM to reclaim space
  console.log('Running VACUUM to reclaim disk space...');
  await dbRunAsync('VACUUM');
  console.log('Migration 1 complete!');
}

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
        objectiveRate REAL,
        -- Precomputed per-match values for the analytics tabs (see
        -- computeAdvancedStatsForMatch). Stored so the tabs never have to
        -- re-parse rawJson/timelineJson at render time.
        cs10 INTEGER,
        cs15 INTEGER,
        cs20 INTEGER,
        deathsBefore10 INTEGER,
        platesTaken INTEGER,
        platesLost INTEGER,
        soloKillDiff INTEGER,
        dmgShare REAL,
        killParticipation REAL,
        dmgTakenPerDeath REAL,
        multikills INTEGER,
        shutdownsClaimed INTEGER,
        shutdownsGiven INTEGER,
        shutdownBountyGiven INTEGER,
        enemyTeamKills INTEGER,
        visionAdvantage REAL,
        goldShare REAL,
        -- Set whenever the precomputed values above are written. Used as
        -- the "has this row been indexed?" marker: any individual stat can
        -- legitimately be NULL (a 2-minute remake has no damage share), so
        -- none of them is safe to test on its own.
        statsComputedAt INTEGER,
        -- 1 when the game ended in an early surrender (a remake). Riot's
        -- own gameEndedInEarlySurrender flag, with a duration fallback.
        isRemake INTEGER,
        -- Team impact (services/teamImpact.js): your score, rank of 10 and
        -- 'MVP'/'SVP' tag. impactRank NULL = not computed yet.
        impactScore REAL,
        impactRank INTEGER,
        impactTag TEXT,
        -- Lane opponent's champion (same teamPosition, other team) for the
        -- Champions page matchups. '' = none (no position); NULL = not computed.
        laneOpponent TEXT,
        -- Game patch, major.minor ('16.20'); '' = unknown, NULL = not computed
        patch TEXT,
        -- Issue #15. turretDamage NULL = not computed; firstDeathAt NULL = no death
        -- (ms into the game).
        turretDamage INTEGER,
        objectiveDamage INTEGER,
        firstDeathAt INTEGER,
        -- Issue #12: {"gold":[…],"xp":[…]} gap to the lane opponent per minute
        -- 0–20 (services/laneGaps.js). '' = none (no opponent / no timeline),
        -- NULL = not computed.
        laneGaps TEXT,
        -- Issue #7: your purchases "itemId:sec,…" after undos (services/itemBuild.js);
        -- issue #8: your deaths "x,y,sec;…" seen from the blue side
        -- (services/deathMap.js). '' = none / no timeline, NULL = not computed.
        itemPurchases TEXT,
        deathPositions TEXT
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

    // LP progression history — one row per *observed change*, not per day.
    // Riot only ever reports current LP, so a reading is a point-in-time
    // observation; the finer the readings, the closer we get to per-match LP.
    // `matchId` links a reading to the game that caused it once that game has
    // been synced (see attachLpReadingsToMatches).
    db.run(`
      CREATE TABLE IF NOT EXISTS lp_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue TEXT NOT NULL,
        tier TEXT,
        rank TEXT,
        lp INTEGER NOT NULL,
        recorded_date TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        matchId TEXT,
        wins INTEGER,
        losses INTEGER,
        manual INTEGER
      )
    `);
    // NOTE: deliberately NOT unique on (queue, recorded_date) any more — that
    // constraint is exactly what limited the chart to one point per day.
    // Migration 3 drops it for existing databases.
    //
    // Only index columns that are guaranteed to exist here. On a database
    // created before migration 3, CREATE TABLE IF NOT EXISTS is a no-op, so
    // `matchId` isn't there yet — indexing it at this point throws
    // "no such column: matchId" and, with no callback to absorb it, takes the
    // main process down. idx_lp_match is created by migration 3 instead,
    // immediately after the ALTER that adds the column.
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_lp_queue_time
      ON lp_history(queue, recorded_at)
    `, err => {
      if (err) console.warn('idx_lp_queue_time not created:', err.message);
    });

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

    // Coaching + queue-scoped queries filter on (queueId, gameCreation)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_queue_time
      ON matches(queueId, gameCreation)
    `, () => {
      console.log('Index idx_queue_time ensured');
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
      'objectiveRate REAL',
      // Precomputed analytics values
      'cs10 INTEGER',
      'cs15 INTEGER',
      'cs20 INTEGER',
      'deathsBefore10 INTEGER',
      'platesTaken INTEGER',
      'platesLost INTEGER',
      'soloKillDiff INTEGER',
      'dmgShare REAL',
      'killParticipation REAL',
      'dmgTakenPerDeath REAL',
      'multikills INTEGER',
      'shutdownsClaimed INTEGER',
      'shutdownsGiven INTEGER',
      'shutdownBountyGiven INTEGER',
      'enemyTeamKills INTEGER',
      'visionAdvantage REAL',
      'goldShare REAL',
      'statsComputedAt INTEGER',
      'isRemake INTEGER',
      'impactScore REAL',
      'impactRank INTEGER',
      'impactTag TEXT',
      'laneOpponent TEXT',
      'patch TEXT',
      'turretDamage INTEGER',
      'objectiveDamage INTEGER',
      'firstDeathAt INTEGER',
      'laneGaps TEXT',
      'itemPurchases TEXT',
      'deathPositions TEXT'
    ];
    // Only ALTER for columns that are actually missing — the old code fired
    // ~60 failing ALTERs on every launch. This also acts as the completion
    // sentinel: it runs after everything queued above, so migrations are
    // guaranteed to see the final schema (no timer race).
    db.all('PRAGMA table_info(matches)', (err, cols) => {
      const startMigrations = () => {
        console.log('Database initialized at:', dbPath);
        runMigrations().catch(e => console.error('Migration error:', e));
      };
      if (err) { console.error('PRAGMA table_info failed:', err); return startMigrations(); }

      const existing = new Set(cols.map(c => c.name));
      const missing  = newColumns.filter(def => !existing.has(def.split(' ')[0]));
      if (missing.length === 0) return startMigrations();

      let remaining = missing.length;
      for (const col of missing) {
        db.run(`ALTER TABLE matches ADD COLUMN ${col}`, alterErr => {
          if (alterErr) console.warn(`ALTER failed for ${col}:`, alterErr.message);
          if (--remaining === 0) startMigrations();
        });
      }
    });
  });
}

/**
 * Save (or overwrite) today's LP snapshot for a given queue.
 */
function saveLpSnapshot(queue, tier, rank, lp) {
  return recordLpReading(queue, tier, rank, lp);
}

/**
 * Record an LP observation, but only when it actually differs from the last
 * one we saw. The background watcher polls every few minutes; without this
 * guard an idle evening would write hundreds of identical rows.
 *
 * `wins`/`losses` (from League-V4) let attribution count the games a change
 * covers. A game that moved them but not the LP still counts as a change, so
 * the next reading isn't mistaken for covering two games.
 *
 * Resolves to { changed, delta, previous } so the caller can react to a real
 * LP movement (refresh the chart, attribute it to a match) without re-querying.
 */
function recordLpReading(queue, tier, rank, lp, { wins = null, losses = null } = {}) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id, tier, rank, lp, recorded_at, wins, losses FROM lp_history
       WHERE queue = ? ORDER BY recorded_at DESC LIMIT 1`,
      [queue],
      (err, prev) => {
        if (err) return reject(err);

        const sameLp = prev && prev.tier === tier && prev.rank === rank && prev.lp === lp;
        const playedSince = prev && prev.wins != null && wins != null &&
                            (wins + losses) !== (prev.wins + prev.losses);
        if (sameLp && !playedSince) {
          return resolve({ changed: false, delta: 0, previous: prev });
        }

        const now   = Date.now();
        const today = new Date().toISOString().slice(0, 10);
        db.run(
          `INSERT INTO lp_history (queue, tier, rank, lp, recorded_date, recorded_at, wins, losses)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [queue, tier, rank, lp, today, now, wins, losses],
          function (insErr) {
            if (insErr) return reject(insErr);
            const delta = prev
              ? absoluteLp(tier, rank, lp) - absoluteLp(prev.tier, prev.rank, prev.lp)
              : 0;
            resolve({ changed: true, delta, previous: prev || null, id: this.lastID });
          }
        );
      }
    );
  });
}

/**
 * Daily LP history for a queue, oldest first — the last reading of each day.
 * Keeps the LP progression chart on one point per day now that the table can
 * hold several.
 */
function getLpHistory(queue) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT recorded_date, tier, rank, lp FROM lp_history
       WHERE queue = ? AND recorded_at = (
         SELECT MAX(inner.recorded_at) FROM lp_history AS inner
         WHERE inner.queue = lp_history.queue
           AND inner.recorded_date = lp_history.recorded_date
       )
       ORDER BY recorded_date ASC`,
      [queue],
      (err, rows) => { if (err) reject(err); else resolve(rows || []); }
    );
  });
}

/**
 * Every individual reading for a queue, oldest first — the fine-grained series
 * behind per-match LP.
 */
function getLpReadings(queue) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, recorded_date, recorded_at, tier, rank, lp, matchId
       FROM lp_history WHERE queue = ? ORDER BY recorded_at ASC`,
      [queue],
      (err, rows) => { if (err) reject(err); else resolve(rows || []); }
    );
  });
}

/**
 * Link LP readings to the ranked game that caused them (rules in
 * lpAttribution.js). Every reading is recomputed on each call, not just the
 * unlinked ones: a reading can only be placed once its game is synced, and
 * recomputing also repairs links made by the old 3-hour rule.
 *
 * Resolves to { linked, considered }: `linked` = links that changed.
 */
async function attachLpReadingsToMatches() {
  const QUEUE_IDS = { solo: 420, flex: 440 };
  let linked = 0;
  let considered = 0;

  for (const [queue, queueId] of Object.entries(QUEUE_IDS)) {
    const readings = await dbAllAsync(
      `SELECT id, recorded_at, wins, losses, matchId FROM lp_history
       WHERE queue = ? AND recorded_at IS NOT NULL
       ORDER BY recorded_at ASC, id ASC`,
      [queue]
    );
    // A remake doesn't count toward W/L, so it can't be what moved the LP.
    // 300 s = REMAKE_MAX_SECONDS in matchService.js (not required here: circular)
    const games = await dbAllAsync(
      `SELECT matchId, gameCreation + gameDuration * 1000 AS endAt FROM matches
       WHERE queueId = ?
         AND COALESCE(isRemake, CASE WHEN gameDuration < 300 THEN 1 ELSE 0 END) = 0
       ORDER BY endAt ASC`,
      [queueId]
    );

    const links = attributeReadings(readings, games);
    considered += readings.length;
    for (const r of readings) {
      const want = links.get(r.id) ?? null;
      if (want === (r.matchId ?? null)) continue;
      await dbRunAsync('UPDATE lp_history SET matchId = ? WHERE id = ?', [want, r.id]);
      linked++;
    }
  }
  return { linked, considered };
}

/**
 * Per-match LP change: { matchId: delta }. Only covers matches that had a
 * reading credited to them AND a prior reading to measure from, so games
 * played before the watcher existed are simply absent.
 */
async function getLpDeltasByMatch() {
  const out = {};
  for (const queue of ['solo', 'flex']) {
    Object.assign(out, deltasByMatch(await getLpReadings(queue)));
  }
  return out;
}

const CHECKPOINT_TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND',
                          'MASTER', 'GRANDMASTER', 'CHALLENGER'];

/**
 * Add an LP checkpoint: your rank on a date, entered by hand. Stored at noon
 * UTC of that date, like the old seed rows. Rejects anything malformed.
 */
async function addLpCheckpoint(queue, tier, rank, lp, date) {
  const T = String(tier || '').toUpperCase();
  const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(T);
  if (queue !== 'solo' && queue !== 'flex') throw new Error('queue must be solo or flex');
  if (!CHECKPOINT_TIERS.includes(T)) throw new Error('unknown tier');
  if (!apex && !['I', 'II', 'III', 'IV'].includes(rank)) throw new Error('division must be I–IV');
  const n = Number(lp);
  if (!Number.isInteger(n) || n < 0 || (!apex && n > 99)) throw new Error(apex ? 'LP must be 0 or more' : 'LP must be 0–99');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(Date.parse(date))) throw new Error('date must be YYYY-MM-DD');

  const at = new Date(date + 'T12:00:00Z').getTime();
  const id = await new Promise((resolve, reject) => db.run(
    `INSERT INTO lp_history (queue, tier, rank, lp, recorded_date, recorded_at, manual)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [queue, T, apex ? 'I' : rank, n, date, at],
    function (err) { if (err) reject(err); else resolve(this.lastID); }
  ));
  await attachLpReadingsToMatches();
  return { id };
}

/** Delete a checkpoint. Never touches tracked readings. Resolves to rows deleted. */
async function deleteLpCheckpoint(id) {
  const changes = await new Promise((resolve, reject) => db.run(
    'DELETE FROM lp_history WHERE id = ? AND manual = 1', [id],
    function (err) { if (err) reject(err); else resolve(this.changes); }
  ));
  if (changes) await attachLpReadingsToMatches();
  return changes;
}

/** Every checkpoint, by queue then date. */
function getLpCheckpoints() {
  return dbAllAsync(
    `SELECT id, queue, recorded_date, tier, rank, lp FROM lp_history
     WHERE manual = 1 ORDER BY queue ASC, recorded_at ASC`
  );
}

module.exports = {
  initDatabase, db, dbPath,
  saveLpSnapshot, getLpHistory,
  recordLpReading, getLpReadings, attachLpReadingsToMatches,
  getLpDeltasByMatch, absoluteLp,
  migrateLpCheckpoints, migrateUnsupportedQueues, addLpCheckpoint, deleteLpCheckpoint, getLpCheckpoints
};
