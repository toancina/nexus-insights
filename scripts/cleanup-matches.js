/**
 * cleanup-matches.js — remove matches (and LP readings) that belong to the
 * wrong account, so they can be re-synced correctly.
 *
 * Why this is needed: the matches table stores YOUR row of a game — champion,
 * KDA, CS and so on — but it does not record which summoner it came from. Sync
 * while the Riot ID in Settings points at someone else and their games land in
 * your history looking exactly like yours. There is no way to tell them apart
 * after the fact except by knowing what you actually played.
 *
 * CLOSE THE APP BEFORE RUNNING. Electron holds the database open; writing to
 * it from a second process while it is live risks corruption.
 *
 * Usage
 *   node scripts/cleanup-matches.js --list
 *   node scripts/cleanup-matches.js --delete EUW1_1234567890 [more ids...]
 *   node scripts/cleanup-matches.js --delete-newest 1
 *   node scripts/cleanup-matches.js --delete-newest 1 --clean-lp 120
 *
 *   --clean-lp <minutes>   also drop LP readings recorded in the last N
 *                          minutes — use it when the app polled LP while
 *                          Settings pointed at the other account, otherwise
 *                          those readings poison your LP chart and deltas.
 *
 * Every write makes a timestamped backup first. Needs Node 22.5+.
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

const args   = process.argv.slice(2);
const dbPath = path.join(userDataPath(), 'nexus_data.sqlite');

function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] || true);
}

if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  process.exit(1);
}

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch { console.error('Needs Node 22.5+ (built-in node:sqlite). Yours: ' + process.version); process.exit(1); }

const QUEUE = { 420: 'Ranked Solo/Duo', 440: 'Ranked Flex', 710: 'Ranked Premade', 400: 'Normal Draft',
                430: 'Blind', 480: 'Swiftplay', 490: 'Quickplay', 700: 'Clash' };

const when = ms => new Date(ms).toLocaleString();

// ── List ────────────────────────────────────────────────────────────────────
function list(db) {
  const rows = db.prepare(`SELECT matchId, queueId, championName, win, kills, deaths, assists,
                                  gameCreation, isRemake
                           FROM matches ORDER BY gameCreation DESC LIMIT 12`).all();
  console.log('\nNewest 12 matches — find the ones that are not yours:\n');
  rows.forEach((m, i) => {
    console.log(
      `  [${String(i).padStart(2)}] ${m.matchId.padEnd(18)} ${(QUEUE[m.queueId] || m.queueId).padEnd(17)} ` +
      `${(m.championName || '?').padEnd(12)} ${m.win ? 'W' : 'L'} ${m.kills}/${m.deaths}/${m.assists}  ${when(m.gameCreation)}` +
      `${m.isRemake ? '  [REMAKE]' : ''}`
    );
  });
  console.log('\nDelete with:  node scripts/cleanup-matches.js --delete <matchId>\n');
}

// ── Delete ──────────────────────────────────────────────────────────────────
function backup() {
  const stamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const target = dbPath.replace('.sqlite', `.before-cleanup-${stamp}.sqlite`);
  fs.copyFileSync(dbPath, target);
  console.log(`Backup written to:\n  ${target}\n`);
  return target;
}

function remove(db, ids, lpMinutes) {
  const found = [];
  for (const id of ids) {
    const row = db.prepare('SELECT matchId, championName, queueId, gameCreation FROM matches WHERE matchId = ?').get(id);
    if (!row) { console.log(`  ${id} — not in the database, skipping`); continue; }
    found.push(row);
  }
  if (!found.length && !lpMinutes) { console.log('Nothing to do.'); return; }

  backup();

  for (const row of found) {
    db.prepare('DELETE FROM matches WHERE matchId = ?').run(row.matchId);
    // An LP reading pinned to a deleted match would keep a dangling link
    db.prepare('UPDATE lp_history SET matchId = NULL WHERE matchId = ?').run(row.matchId);
    console.log(`  deleted ${row.matchId}  (${row.championName}, ${QUEUE[row.queueId] || row.queueId}, ${when(row.gameCreation)})`);
  }

  if (lpMinutes) {
    const cutoff = Date.now() - Number(lpMinutes) * 60000;
    const doomed = db.prepare('SELECT COUNT(*) c FROM lp_history WHERE recorded_at >= ?').get(cutoff).c;
    db.prepare('DELETE FROM lp_history WHERE recorded_at >= ?').run(cutoff);
    console.log(`  deleted ${doomed} LP reading(s) from the last ${lpMinutes} minutes`);
  }

  const left = db.prepare('SELECT MAX(gameCreation) m FROM matches').get().m;
  console.log(`\nMatches remaining: ${db.prepare('SELECT COUNT(*) c FROM matches').get().c}`);
  if (left) {
    console.log(`Newest remaining match: ${when(left)}`);
    console.log('The next sync fetches everything after that, so your own games will come back.');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
const db = new DatabaseSync(dbPath);

try {
  if (args.includes('--list') || args.length === 0) {
    list(db);
  } else if (args.includes('--delete') || args.includes('--delete-newest')) {
    let ids = [];

    if (args.includes('--delete-newest')) {
      const n = Number(flag('--delete-newest')) || 1;
      ids = db.prepare('SELECT matchId FROM matches ORDER BY gameCreation DESC LIMIT ?')
              .all(n).map(r => r.matchId);
    } else {
      // Stop at the next flag — otherwise a following option's VALUE
      // (e.g. the 60 in `--clean-lp 60`) gets read as a match id.
      const rest = args.slice(args.indexOf('--delete') + 1);
      const stop = rest.findIndex(a => a.startsWith('--'));
      ids = stop === -1 ? rest : rest.slice(0, stop);
    }

    if (!ids.length) { console.error('No match ids given.'); process.exit(1); }

    console.log('\nRemoving:\n');
    remove(db, ids, flag('--clean-lp'));
    console.log('\nNow reopen the app, check Settings shows YOUR Riot ID, and press Sync.\n');
  } else {
    console.log('Unknown option. Try --list');
  }
} finally {
  db.close();
}
