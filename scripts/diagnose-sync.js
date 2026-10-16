/**
 * diagnose-sync.js — "why isn't my latest match showing up?"
 *
 *   node scripts/diagnose-sync.js
 *
 * Read-only. Opens the live database, reports what is actually stored, and
 * flags the specific conditions that make a just-played game invisible.
 *
 * Needs Node 22.5+ for the built-in node:sqlite (the project's sqlite3 is
 * compiled against Electron and plain node usually can't load it).
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

function userDataPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'nexus-insights');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'nexus-insights');
  }
  return path.join(os.homedir(), '.config', 'nexus-insights');
}

const dbPath = process.argv[2] || path.join(userDataPath(), 'nexus_data.sqlite');

if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  process.exit(1);
}

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('Needs Node 22.5+ (built-in node:sqlite). Yours: ' + process.version);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const q  = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

const QUEUE = { 420: 'Ranked Solo/Duo', 440: 'Ranked Flex', 710: 'Ranked Premade', 400: 'Normal Draft',
                430: 'Blind', 480: 'Swiftplay', 490: 'Quickplay', 700: 'Clash' };
const ALLOWED = new Set(Object.keys(QUEUE).map(Number));

const ago = ms => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
};

console.log(`\nDatabase: ${dbPath}`);
console.log(`Size:     ${(fs.statSync(dbPath).size / 1048576).toFixed(1)} MB\n`);

// ── Schema state ────────────────────────────────────────────────────────────
const versions = q('SELECT version FROM schema_version ORDER BY version').map(r => r.version);
console.log(`Migrations applied: ${versions.length ? versions.join(', ') : 'none'}`);
const lpCols = q('PRAGMA table_info(lp_history)').map(c => c.name);
console.log(`lp_history has matchId column: ${lpCols.includes('matchId') ? 'yes' : 'NO  <-- migration 3 did not run'}`);

const idx = q("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lp_history'").map(r => r.name);
if (idx.includes('idx_lp_queue_date')) {
  console.log('WARNING: idx_lp_queue_date still present — LP is still capped at one reading per day');
}

// ── Matches ─────────────────────────────────────────────────────────────────
const total = one('SELECT COUNT(*) c FROM matches').c;
console.log(`\nMatches stored: ${total}`);

const newest = q(`SELECT matchId, queueId, championName, win, gameCreation, gameDuration, isRemake, statsComputedAt
                  FROM matches ORDER BY gameCreation DESC LIMIT 8`);

console.log('\nNewest 8 matches (this is exactly what the app reads, newest first):');
for (const m of newest) {
  const end = m.gameCreation + (m.gameDuration || 0) * 1000;
  console.log(
    `  ${m.matchId.padEnd(18)} ${(QUEUE[m.queueId] || 'queue ' + m.queueId).padEnd(17)} ` +
    `${(m.championName || '?').padEnd(12)} ${m.win ? 'W' : 'L'}  ended ${ago(end)}` +
    `${m.isRemake ? '  [REMAKE]' : ''}${m.statsComputedAt == null ? '  [not indexed]' : ''}`
  );
}

const latest = newest[0];
if (latest) {
  console.log(`\nForward-only sync will next ask Riot for games after ${new Date(latest.gameCreation).toISOString()}.`);
  console.log('If your missing game is OLDER than that, a normal sync will never find it.');
}

// ── Queue coverage ──────────────────────────────────────────────────────────
const queues = q('SELECT queueId, COUNT(*) c FROM matches GROUP BY queueId ORDER BY c DESC');
console.log('\nStored queues:');
for (const r of queues) {
  const known = ALLOWED.has(r.queueId);
  console.log(`  ${String(r.queueId).padEnd(6)} ${(QUEUE[r.queueId] || 'not synced by this app').padEnd(24)} ${r.c}${known ? '' : '   <-- filtered out at sync'}`);
}

// ── LP readings ─────────────────────────────────────────────────────────────
console.log('\nLP readings (most recent 10):');
const hasMatchId = lpCols.includes('matchId');
const lp = q(`SELECT queue, tier, rank, lp, recorded_at${hasMatchId ? ', matchId' : ''}
              FROM lp_history ORDER BY recorded_at DESC LIMIT 10`);
if (!lp.length) console.log('  none');
for (const r of lp) {
  console.log(`  ${r.queue.padEnd(5)} ${String(r.tier || '?').padEnd(10)} ${String(r.rank || '').padEnd(4)} ` +
              `${String(r.lp).padStart(3)} LP   ${ago(r.recorded_at)}` +
              `${hasMatchId ? (r.matchId ? `   -> ${r.matchId}` : '   (not linked to a match)') : ''}`);
}

const perDay = q(`SELECT recorded_date, COUNT(*) c FROM lp_history GROUP BY recorded_date
                  ORDER BY recorded_date DESC LIMIT 3`);
console.log('\nReadings per day (more than 1 means intra-day tracking is live):');
for (const r of perDay) console.log(`  ${r.recorded_date}: ${r.c}`);

console.log('');
db.close();
