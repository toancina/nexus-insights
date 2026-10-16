# Nexus Insights — Project Context

> **Last updated**: 2026-10-15
> **Status**: Active development
>
> **2026-10 changes** (details in the Notes section): fixed left nav rail,
> Chat page (local Ollama), self-update from GitHub Releases (⟳ button),
> shareable installer + `Publish Update.bat`, UI polish layer (`polish.css`),
> Skins page with background dim, Coaching page rewritten again around
> game-to-game progress (`coachingProgress.js`), stat-history charts,
> win-rate colour scale. macOS/Linux builds via `npm run dist` on that OS
> (no auto-update there).
>
> **2026-08 changes**: left nav drawer replaces the top tab bar; game-mode
> filters moved onto the summoner row; per-match LP tracking (intra-day
> `lp_history` readings + `matchId` links, migration 3) driven by the League
> client's Live Client Data API on `127.0.0.1:2999`; close-to-tray and
> start-with-Windows; **Coaching tab rewritten** around `coachingEngine.js`
> (input-vs-outcome metric split, role-aware benchmarks, win-rate-gap ranking).
>
> **2026-07 refactor**: config caching, async gunzip, row-by-row migration,
> remake filters in coaching/getStats, shared rank palette
> `components/rankTiers.js`, shared `services/paths.js`, dead code pruned
> including the old match modal. The audit that drove it (`AUDIT_ACTION_PLAN.md`)
> was fully executed and the file removed; it is in git history if needed.

## What Is This?

A **League of Legends personal analytics desktop app** built with **Electron + vanilla JS + SQLite**. It syncs your match history from the Riot Games API, stores it locally, and provides deep performance analytics across 9 statistical categories, an AI-style coaching board, and an achievement badge system — all offline after the first sync.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | Electron 40.1.0 |
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| Database | SQLite3 (`sqlite3` npm package — not `better-sqlite3`) |
| HTTP | Axios 1.6.0 |
| Compression | Node.js built-in zlib (gzip) |
| Build | electron-builder 25.1.8 (Windows NSIS x64; macOS dmg and Linux AppImage, host arch, built on that OS) |
| Font | Inter (Google Fonts) |

---

## Directory Structure

```
src/
├── main.js                    # Electron main process, creates window, inits DB
├── index.html                 # Single-page UI shell (~404 lines)
├── renderer.js                # Entry point: imports, global state, toast, setup modal (~526 lines)
├── assets/
│   ├── ranks/                 # Rank emblem PNGs (Iron → Challenger)
│   ├── backgrounds/           # 13 region-themed backgrounds
│   └── badges/Badges.csv      # 39 badge definitions
├── components/
│   ├── analyticsEngine.js     # 9-tab stat calculator + rank benchmark system (699 lines)
│   ├── badgeEvaluator.js      # Badge evaluation engine (39 badges)
│   ├── calendarPanel.js       # Activity calendar, time insights, LP progression charts (441 lines)
│   ├── coachingPanel.js       # Coaching page UI
│   ├── coachingProgress.js    # Coaching calculations (pure, tested)
│   ├── coachingEngine.js      # Picks the focus metric
│   ├── chatPanel.js / chatAgent.js / chatTools.js / markdown.js  # Chat page (Ollama)
│   ├── championsPanel.js      # Champions page (numbers: services/championStats.js)
│   ├── skins.js / skinsPanel.js   # Skins data + Skins page
│   ├── statHistory.js         # Click-a-card history chart
│   ├── winRateColor.js        # Win-rate colour scale
│   ├── updateButton.js        # ⟳ title-bar update button
│   ├── filtersPanel.js        # Queue/champion filter logic
│   ├── matchCard.js           # Match card HTML helpers (icons, runes, spells, duration)
│   ├── matchModal.js          # Inline expanded rows — 10-player table + badges
│   ├── syncPanel.js           # Sync button handler + progress bar UI
│   ├── tableRenderer.js       # Match history table rendering + ranked stats
│   └── tooltipSystem.js       # Item/rune tooltip on hover
├── services/
│   ├── riotApi.js             # Riot Games API wrapper (all endpoints)
│   ├── matchService.js        # Match sync, advanced stats, DB read/write (31k)
│   ├── database.js            # SQLite schema, migrations, init (368 lines)
│   ├── config.js              # Config load/save (%APPDATA%/nexus-insights/)
│   ├── dataDragon.js          # Data Dragon CDN: items, runes, spells, champions
│   ├── compression.js         # JSON gzip compress/decompress
│   ├── updater.js             # electron-updater wrapper (GitHub Releases)
│   ├── ollama.js              # Local Ollama client
│   ├── liveClient.js          # League Live Client Data API
│   └── paths.js / rateLimiter.js
└── styles/
    ├── app.css                # Main stylesheet (dark theme, gold/teal accents)
    ├── polish.css             # Consistency layer, loaded after app.css
    └── toast.css              # Toast notification styles
```

**Root files**: `package.json` (no `.env` — the API key lives in the user config; the DB lives in `%APPDATA%/nexus-insights/`)

---

## How the App Looks

- **Dark theme** throughout, with gold/teal CSS custom property accents
- **Title bar**: Nexus logo + name on the left, ⟳ update button and ⚙ settings (SVG) top-right
- **Left nav rail** (always visible): Analytics (default), Match History, Champions, Allies (the Teammates page; the full word wraps in the 78px rail), Coaching, Chat, Skins
- **Analytics tab**:
  - Summoner Name # Tag input + "Sync Matches" button at the top
  - Progress bar with new/filtered/existing counters during sync
  - 9 analytical sub-tabs (pill-button row): Overview · Lane Phase · Combat · Death Review · Objectives · Vision · Economy · Macro · Consistency
  - Stat cards grid below the sub-tabs — each card shows value, rank benchmark colour, and a trend arrow vs. the previous period
  - Ranked Solo/Duo and Ranked Flex cards (rank emblem image + tier text + W-L-WR%)
  - Activity Calendar (month grid, green-heat intensity) + Time Analytics side panel
  - LP Progression line charts (Canvas) for Solo/Duo and Flex
  - Time-insight mini-cards: Best Time of Day, Best Day of Week, Session Stamina (games 1-3/4-6/7+), Win/Loss Streaks
  - Match History list (filterable by queue type + champion dropdown), paginated with "Load 20 More / Load All"
- **Coaching tab**: Solo/Duo only. Rank header, last-game report (‹ › to step back), focus metric with hit/miss dots, area trends with sparklines, collapsed Details. See "Coaching page (rewritten 2026-10)" below.
- **Match table**: no Result column (the row colour says win/loss; MVP/SVP sits next to the champion). KDA is (K + A) / max(1, D) everywhere: no "Perfect".
- **Expanded Match Rows**: clicking a match-table row expands an inline game timeline chart, a game report (#9) (win chance / gold lead / XP lead with event markers) and a full 10-player breakdown (both teams): team impact rank with MVP/SVP, items, runes, summoner spells, KDA, CS/min, damage, GD@15/XPD@15, pings, tower damage. Badge awards shown at the top. (The old full-screen Match Detail Modal was removed 2026-07 — it had become unreachable.)
- **Setup Modal**: First-run flow — API key (password field), Summoner Name # Tag, Region (select), Platform (select). Accessible anytime via the settings button.
- **Item/Rune Tooltip**: Hover over any item icon or rune to see name + description.

---

## UI Tabs & Features Detail

### Analytics Tab — 9 Statistical Sub-Tabs

Each sub-tab renders stat cards benchmarked against rank tiers (Iron → Challenger) using colour-coded rank colours. Cards also show a trend indicator (vs. the previous comparison period).

| Sub-tab | Key Stats |
|---------|-----------|
| **Overview** | Win Rate, Avg KDA, KP%, CS/min, Avg CS, Avg Damage, Damage/Min |
| **Lane Phase** | CSD@15, GD@15, XPD@15, CS@10/15/20, Deaths <10m, Plates Taken/Lost, Solo Kill Diff; chart of the gold/XP gap per minute 0–20 |
| **Combat** | Damage Share%, Damage/Min, Damage/Gold, Kill Participation, Shutdowns Claimed/Given, Multikills, Avg Impact Rank, MVP/SVP Rate |
| **Death Review** | Deaths/Game, Deaths <10m, Isolated Deaths, Shutdown Gold Given, Death Share%, Avg First Death |
| **Objectives** | Dragon/Baron/Tower Control%, Heralds/Game, Inhibitors/Game, Obj Steals, Alive for Objectives, Objective DMG/Min, Turret DMG/Min |
| **Vision** | Vision Score, VS/Min, Wards Placed/Killed, Control Wards, Vision Advantage |
| **Economy** | Gold/Game, Gold/Min, CS/Game, CS/Min, Gold Share% |
| **Macro** | Avg Game Length, First Blood Rate, Alive for Objectives, Dragon/Baron Control%, Short/Long game WR |
| **Consistency** | KDA Consistency%, KDA Std Dev, Overall WR, Last 10 WR, Best Win/Worst Loss Streak, Current Streak |

### Coaching Tab

Solo/Duo only; organised around "am I improving game to game?". Sections: rank
header, game-by-game report, your focus, area trends, details. All numbers come
from `computeTabStats`. Full description: "Coaching page (rewritten 2026-10)" in Notes.

### Activity Calendar

- Month-grid calendar with green heat-map colouring per day (less → more games)
- Month/Year pickers (dropdown)
- Time Analytics side panel: best time of day, best day of week, session stamina buckets, win/loss streaks

### LP Progression Charts

- Canvas line charts for Solo/Duo and Flex, **one point per ranked game** (newest 40): filled = measured LP, hollow = estimated. Hover for the game, click to open it in Match History. See "LP history and estimates" in Notes.
- Built from `lp_history` readings plus hand-entered **checkpoints** (no hard-coded history any more)
- LP is normalised to an absolute scale (Iron IV 0 = 0, 400 per tier, Master+ = 2800 + LP) for continuous charting

### Match History

- Cards list, newest first, showing: champion icon, position, mode, result (Win/Loss), KDA, CS, damage, vision, items strip, time ago
- Filters: queue type checkboxes (Ranked Solo, Ranked Flex, Premade, Normal) + champion dropdown
- Pagination: 50 shown initially, "Load 20 More" or "Load All" buttons
- Click any row → expands the inline 10-player breakdown

---

## External APIs

### Riot Games API
- **Account-v1**: PUUID lookup from `gameName#tagLine`
- **Summoner-v4**: Summoner info by PUUID
- **League-v4**: Ranked tier, rank, LP, win/loss
- **Match-v5**: Match IDs (paginated), match details, match timelines
- **Rate limits**: 20 req/sec, 100 req/2min — app uses 150ms delay between every API call

### Data Dragon CDN
- `ddragon.leagueoflegends.com/cdn/{version}/...`
- Fetches: items, runes, summoner spells, champion icons
- Version fetched dynamically (8 s timeout). Fallback: the last version that worked (saved as `config.ddragonVersion`), else `FALLBACK_VERSION` (`16.20.1`) in `dataDragon.js` (#39; it used to be `25.S1.1`, which 404s)

---

## Database Schema (SQLite)

DB path: `%APPDATA%/nexus-insights/nexus_data.sqlite`

### `matches` table (~60 columns)
| Category | Columns |
|----------|---------|
| Identity | `matchId` (PK), `queueId`, `gameCreation`, `gameDuration` |
| Champion | `championName`, `champLevel`, `teamPosition`, `lane` |
| KDA | `kills`, `deaths`, `assists` |
| Economy | `goldEarned`, `totalMinionsKilled`, `neutralMinionsKilled` |
| Damage | `totalDamageDealtToChampions` |
| Vision | `visionScore`, `wardsPlaced`, `wardsKilled`, `detectorWardsPlaced` |
| Multi-kills | `doubleKills`, `tripleKills`, `quadraKills`, `pentaKills` |
| Objectives | `turretKills`, `inhibitorKills`, `dragonKills`, `baronKills`, `objectivesStolen` |
| Team obj. | `teamDragons`, `enemyDragons`, `teamBarons`, `enemyBarons`, `teamRiftHeralds`, `enemyRiftHeralds`, `teamTowers`, `enemyTowers`, `teamInhibitors`, `enemyInhibitors` |
| Team | `teamId` (100=blue, 200=red), `teamKills` |
| Items | `item0`–`item6` |
| Runes | `primaryRune`, `secondaryRuneStyle` |
| Raw data | `rawJson` (BLOB, gzip), `timelineJson` (BLOB, gzip) |
| Advanced | `csDiff15`, `goldDiff15`, `xpDiff15`, `firstBlood`, `dmgGoldRatio`, `isolatedDeaths`, `objectiveRate` |
| Team impact | `impactScore`, `impactRank` (1–10, NULL = not computed yet), `impactTag` (`MVP`/`SVP`/NULL) |
| Lane opponent | `laneOpponent`: their champion (same `teamPosition`, other team); `''` = none, NULL = not computed yet |

**Indexes**: `idx_gameCreation` (DESC), `idx_championName`

### `player_ranks` table
- `puuid` (PK), `soloTier`, `soloRank`, `soloLP`, `flexTier`, `flexRank`, `flexLP`, `fetchedAt`

### `lp_history` table
- `id`, `queue` (SOLO/FLEX), `date`, `tier`, `rank`, `lp`, `recorded_at`, `matchId`, `wins`, `losses` (migration 4)
- Used by LP progression charts in the calendar panel

### `schema_version` table
- `version` (PK), `applied_at` — tracks migrations

---

## Key Architecture Patterns

### Match Sync Strategy
- **First sync**: All matches since January 1 (UTC) of the current year (`seasonStart()` in `services/syncOrder.js`, #38; it used to be a fixed 2026-01-01), paginated (100/request)
- **Subsequent syncs**: Forward-only — only after latest stored match timestamp
- **Oldest first, stop on failure** (issue #13): new games are stored oldest
  first (`services/syncOrder.js`, tested), and a game that fails for a reason
  that may pass (network, 401/403, 429/5xx after retries, SQLite write) stops
  the sync, so no newer game is stored past a missing one. 404s and bad match
  data are skipped, since stopping on them would block every sync.
- **Fill gaps** (issue #18, Settings): `fillGaps(puuid, onProgress, { since })`
  lists every game since season start (or `since`) in the allowed queues,
  calling `getMatchIds` with `existingIds = null` so it doesn't stop at the
  first stored game (that early stop is why a normal sync never fills old
  holes), and stores the missing ones through `storeGames`, the per-game
  loop it shares with `syncMatches` (oldest first, same stop rule). Runs as
  `handleSync({ fillGaps: true })`, so the backfills, rank fetch, LP capture
  and reload after it are the normal sync's. Progress: `'listing'` with the
  count, then the usual per-game progress.
- **No other players' ranks** (issue #29): sync used to call League-V4 for
  every player in every new game (~12,000 calls, ~4 h on a dev key for a
  1,740-game first sync) and nothing read them. Removed; the `player_ranks`
  table stays. If ranks are shown later, fetch them when a game is opened
- **Queue filter**: Only stores 420 (Solo), 440 (Flex), 710 (Ranked Premade: the 5-stack ranked queue, League-V4 `RANKED_PREMADE_5x5`; not in Riot's queues.json), 400 (Normal Draft), 430 (Blind), 480 (Swiftplay), 490 (Quickplay), 700 (Clash)
- **Rate limiting**: Sequential processing, 150ms delay between every API call
- **Timestamp format**: the app stores **milliseconds** (`gameCreation`, 13 digits) everywhere, and `riotApi.getMatchIds()` converts to **seconds** (`Math.floor(ms / 1000)`) for Match-V5's `startTime`, which Riot defines in seconds. Pass `getMatchIds` milliseconds; don't remove the conversion (#41: this note used to say Riot takes milliseconds)

### JSON Compression
- `compression.js` gzips `rawJson`/`timelineJson` on **write**, and `decompressJson()` transparently handles both gzip Buffers and legacy uncompressed TEXT
- Migration 1 converts legacy TEXT rows to gzip BLOBs **row-by-row** (rewritten 2026-07: the old version loaded all ~131MB in one query and never completed). It resumes where it stopped, only marks `schema_version` when nothing is left, then VACUUMs (~131MB → ~15MB)
- `getMatches()` does **not** select the blob columns (see Lazy JSON Loading below)

### Advanced Stats (computed from timeline data)
| Stat | Description |
|------|-------------|
| CSD@15 | CS difference vs lane opponent at 15 min |
| GD@15 | Gold difference at 15 min |
| XPD@15 | XP difference at 15 min |
| First Blood | Participated in first kill |
| Dmg/Gold Ratio | Total damage / total gold earned |
| Isolated Deaths | Deaths without nearby teammates (1500 units) or objectives |
| Objective Rate | % of your team's epic monsters taken while you were alive (dead = death → respawn timer) |

### Analytics Engine — Rank Benchmark System
- Every stat card is benchmarked against 10 rank tiers (Iron → Challenger) using `STAT_BENCHMARKS` thresholds in `analyticsEngine.js`
- Card colour is set to the rank-tier colour that the value corresponds to
- Trend arrows compare current filtered period vs. the previous equal-length period (e.g. last 20 games vs the 20 before that)
- `window.computeTabStats(tabName, matches, prevMatches)` is the main export — called by `renderer.js` when switching sub-tabs or changing filters

### Badge System (39 badges, 13 regions)
- Defined in `Badges.csv`, evaluated in `badgeEvaluator.js`
- Regions: Bandle City, Noxus, Demacia, Bilgewater, Freljord, Ionia, Piltover, Zaun, Targon, Shurima, Shadow Isles, Ixtal, The Void
- Some badges disabled (API limitations) — `evaluate: () => false`
- Badge results shown in the expanded match row

### Module Architecture
- Each component file registers functions on `window.*` as side-effects (no ES module `export`)
- `renderer.js` uses `window.require()` (Electron's Node integration) to load all modules
- Global shared state lives on `window.*` (e.g. `window.matchesData`, `window.DDRAGON_BASE`, `window.activeAnalyticsTab`)
- No virtual DOM — all rendering is direct DOM manipulation with template literal strings

---

## Config & Environment

### User config (`%APPDATA%/nexus-insights/config.json`)
```json
{
  "apiKey": "RGAPI-...",
  "gameName": "SummonerName",
  "tagLine": "EUW",
  "region": "europe",
  "platform": "euw1"
}
```

### Region → Platform mapping
| Region | Platforms |
|--------|----------|
| europe | euw1, eun1, tr1, ru |
| americas | na1, br1, la1, la2 |
| asia | kr, jp1 |
| sea | oc1, ph2, sg2, th2, tw2, vn2 |

---

## App Startup Sequence

1. `main.js` → init DB (run migrations) → create Electron BrowserWindow
2. `index.html` loads → `renderer.js` runs
3. Load Data Dragon assets (items, runes, spells, champion list)
4. Check config validity → show setup modal if invalid
5. Load match history from DB → render match cards + ranked stats + analytics cards
6. Init calendar + LP charts; seed LP history snapshots (INSERT OR IGNORE)
7. User can: sync new matches, switch analytical sub-tabs, filter by queue/champion, open match detail modal, switch to Coaching tab

---

## Key Functions Quick Reference

### renderer.js
| Function | Purpose |
|----------|---------|
| `showToast(title, msg, duration)` | Toast notification (exposed on `window`) |
| `showSetupModal(isFirstTime)` | First-time config / Settings modal |
| `saveSetup()` | Validate + persist config, reload app |
| `switchTopTab(tab)` | Switch between Analytics and Coaching |
| `loadMatchHistory()` | Load + render matches from DB |
| `renderMatchHistory()` | Render match card list |
| `loadMoreMatches()` / `loadAllMatches()` | Pagination controls |
| `openSettings()` | Re-open setup modal from gear button |

### analyticsEngine.js
| Function | Purpose |
|----------|---------|
| `window.computeTabStats(tab, matches, prev)` | Main entry — returns array of stat card objects |
| `calcOverview / calcLanePhase / calcCombat / ...` | Per-tab calculators |
| `evaluateBenchmark(value, statId, higherIsBetter)` | Returns rank tier string for a value |
| `buildCard(...)` | Constructs a stat card data object with benchmark + trend |

### coachingPanel.js / coachingProgress.js
| Function | Purpose |
|----------|---------|
| `window.renderCoachingPanel()` | Main entry — renders from `window.matchesData` (Solo/Duo, remakes excluded) |
| `window.coachingStep(n)` | Step the game-by-game report back/forward |
| `window.coachingSetFocus/ClearFocus` | Pin or release the focus metric |
| `rankHeader / lastGameReport / focusHits / areaTrends` | Pure calculators in `coachingProgress.js` (tested) |

### calendarPanel.js
| Function | Purpose |
|----------|---------|
| `window.initCalendar(matches)` | Render the monthly activity calendar |
| `window.renderLpCharts()` | Draw Canvas LP progression charts |
| `window.calculateTimeInsights(matches)` | Compute + display time-of-day, day-of-week, stamina, streaks |
| `window.toggleCalPicker(type)` | Show/hide month or year dropdown |

### matchService.js
| Function | Purpose |
|----------|---------|
| `syncMatches(puuid, onProgress)` | Full sync pipeline |
| `getMatches(limit)` | Load matches from DB — **scalar columns only**, no JSON blobs |
| `loadRawJson(ids)` / `loadTimelineJson(ids)` | Batch-fetch + parse blobs into the module cache (await before reading) |
| `getCachedRawJson(id)` / `getCachedTimelineJson(id)` | Synchronous cache read; returns `null` if not prefetched |
| `clearJsonCache()` | Drop cached blobs (called on every `loadMatchHistory`) |
| `getStats()` | Aggregate stats query |
| `computeAdvancedStatsForMatch()` | CSD@15, GD@15, isolated deaths, etc. |
| `backfillTimelines(onProgress)` | Download missing timelines |
| `backfillAdvancedStats(onProgress)` | Recalculate advanced stats |
| `saveLpSnapshot / getLpHistory` | LP history table CRUD |
| `addLpCheckpoint / deleteLpCheckpoint / getLpCheckpoints` | Hand-entered LP checkpoints (`manual = 1`) |
| `attachLpReadingsToMatches / getLpDeltasByMatch` | Per-game LP (rules in `services/lpAttribution.js`) |

### riotApi.js
| Function | Purpose |
|----------|---------|
| `getPuuidByRiotId()` | Name#Tag → PUUID |
| `getMatchIds()` | Paginated match ID list |
| `getMatchData()` | Full match JSON |
| `getMatchTimeline()` | Frame-by-frame timeline |
| `getLeagueByPuuid()` | Ranked tier/LP |

---

## Notes

### Distribution (shareable installer) — 2026-10

- **Build with `npm run dist` / `Build Installer.bat`, never plain `npm run build`.**
  The owner's LP history used to be hard-coded (`SOLO_LP_SEED` in
  `calendarPanel.js`) and stripped for every build. It now lives in the
  database as checkpoints (#5), so nothing is stripped; `build-installer.js`
  refuses to build if dated LP snapshots, `SOLO_LP_SEED` or `seedLpSnapshot(`
  show up in that file again, or if an old `calendarPanel.js.build-backup`
  (from an interrupted build of the old script; it holds the seed) is lying
  around.
- Build config: `npmRebuild: false` (sqlite3 in node_modules is already built for
  this Electron; rebuilding needs Python + MSVC), `electronDist` = the local
  Electron, `asarUnpack` `**/*.node`, NSIS `include: installer/installer.nsh`.
- `installer/installer.nsh` removes the HKCU `Run` value **"Nexus Insights"** on
  uninstall (not on upgrade). That name must match `LOGIN_ITEM_NAME` in main.js,
  which is passed as `name` to `setLoginItemSettings` in the packaged branch.
- `paths.js` creates the data folder on require. `database.js` opens SQLite at
  require time — in the main process that is before `ready`, so on a fresh PC
  the folder didn't exist yet. Main also builds the path from
  `appData + 'nexus-insights'` (not `getPath('userData')`) so it can never drift
  from the renderer's hardcoded name.
- **Region is derived from the server, not chosen.** `riotApi.PLATFORM_ROUTING`
  maps platform → Match-V5 cluster (incl. `sea` for OCE/PH/SG/TH/TW/VN, which the
  old dropdown lacked). Account-V1 has no `sea`, so `accountRoutingFor` uses
  `asia` there. The setup Region box is disabled and just mirrors the server.
  `test/riotRouting.test.js` fails if a server is added to the dropdown without
  a routing.
- Sync shows an actionable message for 401 *and* 403 (dev keys expire every
  24h — the most common error a new user hits).
- The sandbox the assistant runs in **cannot** build the NSIS installer: GitHub's
  release-asset CDN is firewalled, so electron-builder can't fetch nsis /
  winCodeSign. Build on Windows. A portable zip can be assembled by hand there
  (asar CLI + raw Electron copy + `resedit` for the exe icon).

### macOS / Linux builds — 2026-10

`npm run dist` builds for the OS it runs on (`TARGETS` in
`scripts/build-installer.js`): `Nexus-Insights-mac-<arch>.dmg` or
`Nexus-Insights-linux-<arch>.AppImage`, host arch.

- **No cross-builds.** `npmRebuild: false` + `electronDist` mean the sqlite3
  `.node` and Electron are whatever `npm install` fetched for this machine.
  An x64 Mac build made on Apple Silicon would ship an arm64 sqlite3.
- **`--publish` refuses outside Windows.** A release is what installed copies
  update from: a Mac-made one would lack `latest.yml` and break Windows
  updates. Mac/Linux copies get no self-update. `main.js` only loads
  electron-updater on win32, and elsewhere `updater.js` reports `manual`, so the ⟳
  button opens `/releases/latest`.
- **`scripts/after-pack.js` ad-hoc signs the .app** (`codesign --deep -s -`).
  Without a Developer ID, electron-builder skips signing and the bundle seal
  is broken. Apple Silicon then calls a downloaded copy "damaged" (only fixable
  with `xattr -cr`). With ad-hoc signing users get "Open Anyway" in Privacy &
  Security instead. `spctl` still says "rejected", which is expected.
- `main.js` platform branches:
  - **macOS menu:** App/Edit/Window menu (`setMacMenu`). With no menu,
    Cmd+C/V/Q do nothing, so you couldn't even paste the API key.
  - **Tray icon:** `trayImage()` scales `icon-256.png` (.ico is Windows-only).
  - **Shortcuts:** Cmd instead of Ctrl.
  - **Window lifetime:** `showMainWindow` rebuilds a closed window, since macOS
    keeps the app running.
  - **Login items:** not registered from source on macOS (that would launch
    bare Electron at login), and not on Linux at all. Settings relabels the
    toggle "Open at login" on macOS and hides it on Linux.
- Running the app binary from a shell spawned by the VS Code / Claude
  extension: unset `ELECTRON_RUN_AS_NODE`, or Electron runs as plain Node
  (silent, no window).
- Packaged macOS "Open at login" is untested: it can't be checked without
  editing the machine's login items.

### General

- DB file (`nexus_data.sqlite`) is ~131MB with compressed JSON blobs
- The app uses `nodeIntegration: true` in Electron (no context isolation)
  — any HTML injection would have Node access, so every external string goes
  through `escapeHtml()` (`components/dom.js`, tested). Moving to
  contextIsolation is parked: it needs analytics extraction moved to main first.
- All rendering is DOM manipulation — no virtual DOM or framework
- CSS uses custom properties for theming (dark theme, gold/teal accents)
- `electron-builder` targets: Windows NSIS x64, macOS dmg, Linux AppImage (see "macOS / Linux builds")
- `coachingPanel.js` opens its **own** SQLite connection (read-only) because it is lazily loaded and needs a direct DB handle separate from the main `database.js` singleton

### Lazy JSON Loading (perf-critical)

`rawJson`/`timelineJson` total >130MB. Loading them for every row on startup blocked the renderer for seconds and pinned ~1GB of heap, so they are now fetched **on demand**:

- `getMatches()` returns scalar columns only. `window.matchesData` rows have **no** `rawJson`/`timelineJson` properties
- `matchService.js` owns the blob cache (`loadRawJson` / `loadTimelineJson` → `getCachedRawJson` / `getCachedTimelineJson`)
- `analyticsEngine.TAB_JSON_NEEDS` declares which sub-tabs need which blob. Only Lane Phase / Combat / Death Review need timelines; Vision / Economy need rawJson; Overview, Objectives, Macro and Consistency need neither and parse nothing
- `window.prefetchTabJson(tab, ...matchLists)` is awaited by `renderAnalyticsTab()` **before** any DOM mutation, with a staleness guard so a slower render can't overwrite a newer one
- `renderFilteredMatches()` prefetches rawJson for the **visible page only** (match cards read summoner spells out of it)
- `getMatchById()` still does `SELECT *`, so the match modal / expanded row / badge evaluator get full blobs for a single match. `toggleRowExpand` must pass that full row to `createExpandedRow`, not the light `matchesData` row

**If you add a stat that reads rawJson or timelineJson, add its tab to `TAB_JSON_NEEDS` or it will silently compute from `null`.**

### Role filter + Roles table (2026-10, issue #10)

- **Role dropdown** (`#roleFilter`) next to the champion filter, filled by
  `updateRoleDropdown` (filtersPanel.js) with the roles present and their
  counts. It narrows everything the champion filter does (cards, calendar,
  time insights, Match History). The Champions page ignores it; it has its
  own role chips.
- `renderFilteredMatches` sets `window.analyticsRoleFilter` (the picked role
  or null) and `window.rolePoolMatches` (the list before the role filter).
- **Roles table** (`components/roleBreakdown.js`, `#roleBreakdown`) under
  the Overview cards: games, play rate, win rate, KDA, CS/min, DMG/min, KP
  per role, from `rolePoolMatches` minus remakes, so it always compares every
  role. Click a row to filter to it; click it again to clear. "No role"
  games are listed but can't be picked ('' means "all" in the dropdown).
- **Role benchmarks:** `computeTabStats(tab, matches, prev, { role })` ranks
  cards on that role's thresholds from `roleBenchmarks.js`, falling back to
  `STAT_BENCHMARKS`. The role lives in a module variable set only for the
  length of that call (try/finally), so Coaching and chat (which pass no
  role) always get the general ladder. `getStatBenchmark(id, role)` and the
  stat-history chart pass the same role, so a month's tier matches the card.

### Stat history chart (click a card) — 2026-10

Cards with a green dot open a slide-down chart (`#statHistoryPanel`, between
the card grid and Time Analytics) showing that stat **per month for the last 12
calendar months, ending with the current month** (current month = "so far").

- `components/statHistory.js`. Each month's value comes from running
  `window.computeTabStats` over just that month's games, so the chart can never
  disagree with what the card would show for that month. No second formula.
- Input is exactly what the cards got (current filters, remakes excluded):
  `renderAnalyticsTab` calls `window.syncStatHistory(tab, matches)` after
  drawing cards. That recomputes an open chart on filter change and closes it
  on sub-tab change.
- Not clickable (`isChartable`): `count` cards (Total Matches, the three streak
  cards), `none`, and `con_last10_wr` (no per-month meaning). Ranked Solo/Flex
  boxes are separate elements and never get the dot.
- Rank bands use `window.getStatBenchmark(id)` (exposes `STAT_BENCHMARKS`);
  `benchmarkBands` mirrors `evaluateBenchmark`'s >= / <= rule (tested).
- Months with < 5 games (`LOW_SAMPLE`) are hollow/dashed and **don't set the
  y-scale**: a 2-game 0% month would otherwise flatten a year of real data. If
  off-scale it is pinned to the edge, labelled with its true value.
- `readable()` lightens dark tier colours (Iron, Bronze) for text and dots.
- Slide animation is `grid-template-rows: 0fr → 1fr` on `.stat-history-panel`.
- Real data: 58 chartable cards, slowest 12 ms to compute.

### Champions page (2026-10, issue #4)

`components/championsPanel.js` (UI) + `services/championStats.js` (pure,
tested). Nav rail button between Match History and Coaching.

- Left: sortable table of every champion played: games, win rate, KDA,
  CS/min, DMG/min, KP, average impact rank. Formulas match `calcOverview`
  (KDA summed, the rest averaged per game) so it agrees with Analytics.
  Sorting a stat column sinks champions with < `LOW_SAMPLE` (5) games below
  the rest, so 1-game 100% rows don't top the win-rate sort.
- Right: the picked champion: role chips (when played in several roles),
  rune pages (keystone + secondary tree), core items, matchups vs the lane
  opponent (games, W–L, win rate, KDA, GD@15, CSD@15). A matchup row expands
  to the items and keystones you used in it.
- Input: `window.championPoolMatches`, set in `renderFilteredMatches`: the
  game-mode filter with remakes excluded, but **not** the champion filter
  (the page lists every champion). Re-renders when filters change while open.
- Items = each game's final build (item0–5, counted once per game).
  `isCoreItem` keeps finished items via Data Dragon: no consumables or
  trinkets, boots from 900 g, otherwise no `into` and ≥ 1000 g. Build order
  needs purchase events (issue #7).
- `laneOpponent` is a computed-stats column (sync + backfill). The backfill
  and `backfillAnalyticsInBackground` also pick rows where it is NULL; "no
  lane opponent" is stored as '' so those rows aren't re-indexed forever.
  Indexing 562 games took ~6 s.
- No JSON blobs are read; everything comes from scalar columns.

### Patch + period filter (2026-10, issue #6)

- `patch` column (major.minor from `info.gameVersion`, e.g. `16.20`; ''
  unknown, NULL not computed), written by the computed-stats pipeline and
  backfilled like the other computed columns (`patch IS NULL`).
- **Period dropdown** (`#periodFilter`, before the champion dropdown):
  All time · Last patch / 2 / 3 patches · a single patch (12 newest, with
  counts) · Last 7 / 30 days, 3 / 6 months, year. Values are strings
  (`''`, `patches:N`, `patch:16.20`, `days:N`) handled by
  `services/patches.js` `filterByPeriod` (pure, tested). Games with no
  patch yet drop out of patch periods only, never out of time windows.
- `renderFilteredMatches` applies it **first** (`periodMatches`, before the
  game-mode filter), so the cards, calendar, time insights, champion list,
  Match History and the Champions page all follow it. Coaching does not:
  it is about your last games and reads `window.matchesData` directly.
- `components/periodFilter.js`: the dropdown (rebuilt only when the set of
  patches changes) and the **Win Rate by Patch** card, which sits beside
  Win Rate by Game Length (one `ta-right-row`, so the section's height
  doesn't change).

### Teammates page (2026-10, issue #11)

- `components/teammatesPanel.js` (page) + `services/teammates.js` (pure,
  tested): players you had on your team in 3+ games, with games together,
  win rate, last played and a win/loss strip of the last 30. Same games as
  the Champions page (`window.championPoolMatches`: game-mode + period
  filters, remakes out); re-renders when filters change while open.
- **Data:** a separate table, `match_teammates (matchId, teammates JSON)`,
  not a computed-stats column. `matchService.loadTeammates()` creates it if
  needed, fills only games not in it yet (25 rawJson blobs at a time, then
  dropped, so the "Lazy JSON Loading" rule holds) and returns matchId →
  [{ puuid, name }]. Players are keyed by PUUID (survives renames); the name
  shown is the newest. First open on 566 games reads them all once.
- **Columns and sorting (#30):** Win rate, Wins and Losses are separate
  columns. Player, Games together, Win rate, Wins and Losses sort on click
  (again = reverse; Enter/Space too); Last played and Recent games don't.
  `sortTeammates` (services/teammates.js): ties → more games, then most
  recent; for Win rate, players under `LOW_SAMPLE` (5) games sink either
  way. The sort is a module variable, so it survives filter changes until
  the app restarts.

### Game report (2026-10, issue #9)

In every expanded match row, under the timeline (`components/gameReportPanel.js`,
`services/gameReport.js`, pure, tested). Skipped for remakes.

- **Table:** 9 stats (KDA, KP, CS/min, damage/min, gold/min, vision/min,
  deaths, GD@15, CSD@15) for this game against your season, this patch and
  the 7 days before it, same queue and role, never the game itself.
  **Every value comes from `computeTabStats`** run over [this game] and over
  each pool, so it can't disagree with the Analytics cards. A cell is green
  / red when this game is ≥ 10% better / worse than that average (direction
  from the card's `higherIsBetter`); GD/CSD measure 10% against at least
  1000 gold / 10 CS, since their averages sit near 0. Pools under 3 games
  show "–".
- **Went well / went wrong:** the biggest differences from your season.
- **Blunders** (timeline): a death in the first 3 min, 3+ deaths to the same
  champion, two deaths within 3 min, deaths while win chance was ≥ 60%, and
  the death with the biggest win-chance drop over the next minute (≥ 10
  points; `matchTimeline.teamSeries`).
- At most three points per section. The report uses `fitWidth` from
  matchTimelineChart.js, like the chart, because the expanded row is as
  wide as the sideways-scrolling table.
### Item builds (2026-10, issue #7)

- `itemPurchases` column: your purchases as `"itemId:seconds,…"`, oldest
  first, after `ITEM_UNDO` (undoing a buy removes it; undoing a sale changes
  nothing). '' = no timeline / nothing bought, NULL = not computed. Written by
  the computed-stats pipeline; reset to NULL with `laneGaps` when a timeline
  is downloaded later. Rules in `services/itemBuild.js` (pure, tested).
- **"Bought at m:ss" in item tooltips:** icons carry `data-bought`;
  `tooltipSystem.showItemTooltip` adds the line (digits/colon only). Match
  table from the stored column; expanded row from the full timeline, for all
  10 players. Items with no purchase event (transformed/upgraded) show none.
- **Champions page Build order card:** Start (item combos bought in the first
  60 s), First back (everything within 60 s of the first purchase after
  that), 1st / 2nd / 3rd item (finished items you still held at the end, in
  purchase order; **boots left out** of the numbered slots since nearly
  everyone buys them first). Games, win rate, pick rate; under 5% hidden.
  Plus "First back: median 3:56 · 49% when earlier · 55% when later".
- **Economy: Median First Back** card (m:ss). Not benchmarked, and no trend
  arrow: an earlier back isn't simply better.
- Win-probability change per item (the optional #3 link) is not done.

### Death map (2026-10, issue #8)

- `deathPositions` column: your deaths as `"x,y,seconds;…"`, turned to the
  blue side: red-side positions go through `(x, y) → (M − y, M − x)` (M =
  14980), a reflection across the other diagonal, so top lane stays top
  lane (flipping both axes would swap top and bottom). '' = none / no
  timeline. Rules in `services/deathMap.js` (pure, tested).
- **Death Review → "Where you die"** (`components/deathMapPanel.js`,
  `#deathMap`, rendered from `renderAnalyticsTab` with the tab's filtered
  games): Data Dragon's `img/map/map11.png` dimmed, one dot per death, amber
  → red by how many deaths are within 600 units. "Dense" is relative to the
  95th percentile, and dots shrink/fade with the count, so hundreds of games
  still show the map's shape.
- **Zones by phase:** along the base-to-base diagonal ((x + y) / 2M): < 0.35
  near your base, > 0.65 enemy territory, else mid-map; phases ≤ 14:00, ≤
  25:00, later. The takeaway names the biggest change (near-base or
  enemy-territory share) between the first and last phase, if ≥ 5 points.
  Coarse by design: the outer parts of the side lanes count as mid-map, so
  early-game deaths are mostly "mid-map". The panel says so.

### Remakes are excluded from statistics

Games abandoned in the first minutes (someone failed to connect) are stored and
displayed, but never counted in a statistic.

- `isRemake` column, written at sync/backfill from Riot's own
  `gameEndedInEarlySurrender`, falling back to `gameDuration < 300`
- `window.isRemake(match)` / `window.excludeRemakes(list)` in renderer.js are
  the single source of truth; they fall back to duration for un-backfilled rows
- `renderFilteredMatches` passes the filtered list to the analytics engine, the
  calendar, and the time-insight pass — but the **unfiltered** list to the match
  table, so remakes stay visible
- `displayRankedStats` also excludes them: a remake is neither a win nor a loss
- Remake rows render dimmed with a `REMAKE` tag, and the match-count badge says
  how many were excluded, so the numbers never look unexplained

### Per-game LP attribution (fixed 2026-10, issue #1)

Riot only reports current LP, so the tracker stores readings and a reading's
change belongs to a game only when it covers exactly one game.
`services/lpAttribution.js` (pure, tested) holds the rules; database.js loads
rows and writes the links.

- Readings store `wins`/`losses` from League-V4 (migration 4). The change in
  wins + losses = games covered. 0 (refund, decay) or 2+ (missed game): not
  credited to any game, still on the LP chart.
- A reading links only when exactly one stored, non-remake game of that queue
  ended between the previous reading and this one. None stored yet (Riot slow
  to publish) → stays unlinked until the next sync. Old readings without W/L
  use this rule alone.
- `attachLpReadingsToMatches()` **recomputes every link** each call, so a late
  sync can't leave a stale one. Migration 4 ran it once to repair links made by
  the old rule (latest game in the previous 3 h), which credited back-to-back
  games with each other's LP.
- `recordLpReading` also records a reading when W/L moved but LP didn't (a
  0-LP game), otherwise the next reading would look like it covered 2 games.
- `getLpDeltasByMatch()` sums per match instead of overwriting.
- `test/lpAttribution.test.js` includes a test against a real temporary SQLite
  file (it stubs `services/paths` before requiring database.js).

### LP history and estimates (2026-10, issue #5)

- **No hard-coded history.** `SOLO_LP_SEED` and the "Gold I 78" Flex starter
  are gone from `calendarPanel.js`. They used to be written into *every*
  database the app ran against from source, so contributors got the owner's
  rank history. Migration 5 adds `lp_history.manual` and marks rows that look
  like those seeds (noon UTC exactly, no wins/losses) as checkpoints, so
  anyone can delete them from the LP card's Checkpoints popover
  (`components/lpCheckpoints.js`).
- **Checkpoints:** `addLpCheckpoint(queue, tier, rank, lp, date)` stores a
  reading at noon UTC of that date with `manual = 1` (validated: tier,
  division I–IV, LP 0–99 below Master, YYYY-MM-DD). `deleteLpCheckpoint` only
  deletes manual rows. Both re-run `attachLpReadingsToMatches`.
- **Estimates** (`services/lpEstimate.js`, pure, tested): every ranked game
  gets a delta: measured if there's a reading, 0 for a remake, otherwise your
  own average gain/loss over your last 20 measured wins/losses (once you have
  5 of each), else +22/−20. Absolute LP after each game: walk back from the
  first reading, forward from the last, and between two readings shift the
  estimates evenly so they land exactly on the later one (running-total
  rounding, so no game soaks up the rounding error). If that shift would be
  more than 12 LP per game the two readings can't both be right, so the
  estimates keep their usual values and walk back from the later reading.
- `window.refreshLpEstimates()` (calendarPanel.js) loads readings + real
  deltas and sets `window.lpEstimates = { byMatch, series, typical }`.
  loadMatchHistory calls it before the first render; `renderLpCharts` calls
  it every time, so anything that changes readings just calls renderLpCharts.
- **Match History LP column:** measured deltas as before; estimates as `~+22`
  (muted, italic, with a tooltip). Coaching and chat still use measured
  deltas only (`window.lpDeltas`).
- **Under each chart:** net LP over the games the filters show (`~` when it
  includes estimates) and wins to the next division at your average gain
  (`nextDivision`; none in Master+).
- `window.openMatchInHistory(matchId)` switches to Match History, loads all
  rows if needed, and expands that game (toast if the filters hide it).
- `getLpReadings` deliberately doesn't select `manual`: the renderer can read
  readings before the main process has run migration 5.

### Team impact (2026-10, issue #2)

`services/teamImpact.js` (pure, tested): each player's share of their own
team's total in 8 areas (kills+assists, damage, gold, vision, objective damage
excl. structures, structure damage, heals on teammates, damage taken),
averaged; an area with a team total of 0 is skipped. All 10 ranked (ties:
damage, K+A, gold, vision, id); best winner = MVP, best loser = SVP.

- Stored per match through the computed-stats pipeline (`impactScore`,
  `impactRank`, `impactTag`). The backfill also picks rows with
  `impactRank IS NULL`, and so does `backfillAnalyticsInBackground`, so
  existing databases index once after updating.
- Expanded row: Impact column (`#rank` + tag, area breakdown in the title).
  Match row: MVP/SVP tag under the result. Combat: Avg Impact Rank (lower is
  better) and MVP/SVP Rate. Neither is benchmarked (no rank-tier data); both
  show "--" with no impact data and fall back to prefetched rawJson for rows
  not indexed yet.
- Known bias: a player who is the team's only healer gets a 100% healing share
  even for a few hundred HP, which lifts their score a lot.

### Match timeline chart (2026-10, issue #3)

Top of every expanded match row. `services/matchTimeline.js` (pure, tested)
turns rawJson + timelineJson into per-frame series and events;
`components/matchTimelineChart.js` draws them on a Canvas.

- Metrics: Win chance, Gold lead, XP lead, from the viewed player's team.
  Win chance is an estimate: sigmoid((gold + 0.5·XP + 300·kills) / 2500) of
  the team differences, hand-tuned. Only kills by a player count (executions
  don't add to the enemy score).
- Markers in a lane above the plot: circle = kill, diamond = epic monster,
  square = tower/inhibitor. Green = the viewed side got it, red = the other
  side; the viewed player's own kills/deaths are larger with a white ring.
  Toggles: Your kills & deaths, All kills, Objectives, Structures.
- Click a player in the table below to view the game from their side
  (`tr[data-pid]`, highlighted with `.mt-viewing`).
- Metric + toggles persist in localStorage (`nexus.timelinePrefs`).
- No new data: `toggleRowExpand` already loads the full row with
  `getMatchById`. Games without a stored timeline show a one-line note.
- The match table scrolls sideways and an expanded row is as wide as the
  table, so `fitWidth()` sizes the chart to the table's visible width (on draw
  and on window resize). `position: sticky` doesn't work there: the expanded
  content has `overflow: hidden`.

### Precomputed analytics columns

Every per-match value the analytics tabs used to derive by re-parsing the blobs
is now computed once and stored as a column:

`cs10`, `cs15`, `cs20`, `deathsBefore10`, `platesTaken`, `platesLost`,
`soloKillDiff`, `dmgShare`, `killParticipation`, `dmgTakenPerDeath`,
`multikills`, `shutdownsClaimed`, `shutdownsGiven`, `shutdownBountyGiven`,
`enemyTeamKills`, `visionAdvantage`, `goldShare`, `turretDamage`,
`objectiveDamage`, `firstDeathAt` (#15)

- Written by `computeAdvancedStatsForMatch()` → `saveComputedStats()`, on both
  the sync path and the backfill path, so they can't diverge
- `backfillComputedStats()` fills them for older rows. It runs on sync and once
  in the background at startup (`backfillAnalyticsInBackground` in renderer.js)
- `analyticsEngine.isPrecomputed(match)` uses `dmgShare != null` as the marker.
  Rows without it fall back to parsing the blobs, so the app is correct
  mid-migration
- `prefetchTabJson` only loads blobs for rows that are *not* precomputed —
  once backfilled, the analytics tabs touch no JSON at all

Two traps, both found by the parity harness:

1. **`saveComputedStats` must not rewrite the six legacy columns**
   (`csDiff15`, `goldDiff15`, `xpDiff15`, `firstBlood`, `dmgGoldRatio`,
   `isolatedDeaths`) — they are already written at sync time. (`objectiveRate`
   was the seventh; it moved to the computed list when its rule was fixed.)
   That's why `LEGACY_STAT_COLUMNS` is a separate list behind an opt-in flag.
2. **Watch the scale.** `dmgShare`/`goldShare` are stored as fractions, but
   `calcEconomy` builds its array in percent and `calcCombat` in fractions.
   Death share is stored as `enemyTeamKills` rather than a ratio, so the
   calculator keeps dividing the authoritative `deaths` column.

**The repo must be public** for the download link and ⟳ updates to work; a private repo shows 404 to everyone but the owner. Never paste the token in chat — write it straight into the token file.

### Lane gap chart (#12) — 2026-10

Under the Lane Phase cards: average gold and XP minus your lane opponent's
(same `teamPosition`) at each minute 0–20, over the games the filters show.

- `laneGaps` column: JSON `{"gold":[…],"xp":[…]}`, index = minute, stopping at
  the last full minute the game reached. Written by
  `computeAdvancedStatsForMatch` (`services/laneGaps.js`, pure, tested). `''` =
  no lane opponent or no timeline, NULL = not computed (re-index marker).
  `backfillTimelines` resets it to NULL when a timeline arrives later.
- `averageLaneGaps` averages each minute over the games that lasted that long.
  Minutes from under 5 games are hollow and don't set the y-range.
- `components/laneGapChart.js` draws it (Canvas, hover tooltip), like the
  Roles table on Overview: `renderAnalyticsTab` calls
  `window.renderLaneGapChart(matches)` on Lane Phase and `null` elsewhere.

### Small stats + CSV export (#15) — 2026-10

- Columns: `turretDamage` (= `damageDealtToBuildings`), `objectiveDamage`
  (`damageDealtToObjectives − damageDealtToBuildings`, i.e. epic monsters),
  `firstDeathAt` (ms, from the timeline; NULL = no death). `turretDamage` is
  always a number once indexed, so `turretDamage IS NULL` is the re-index
  marker in `backfillComputedStats` and `backfillAnalyticsInBackground`.
- Cards: Objective DMG/Min, Turret DMG/Min (Objectives), Avg First Death
  (Death Review, m:ss, games with a death only). **Not benchmarked**: on real
  data objective damage/min is ~1000 for jungle vs ~35 for top, turret ~220
  for laners vs ~50 jungle/support, and bot lane dies first ~3 min earlier
  than mid. Rows not indexed yet are left out; with none, the card shows "--".
- Settings → **Export matches to CSV**: `services/csvExport.js` (pure,
  tested) builds the text from `window.exportableMatches` (current period,
  game-mode, champion, role and calendar filters, remakes included, scalar
  columns, oldest first, `date` column first, formula-looking text prefixed with `'`).
  Main's `csv:save` IPC shows the save dialog and writes it with a BOM.
- `test/advancedStats.test.js` (#14) covers `computeAdvancedStatsForMatch`
  on a hand-built game: @15 diffs, CS@10/15/20, early/isolated deaths,
  shutdowns, objective rate, shares, remakes, short games, no timeline.

### Left nav rail — 2026-10

The sliding drawer is gone. `#navDrawer` carries `nav-rail` and is always
visible (78px, `--nav-rail-width`; `body` is padded by that). Buttons stack
icon over label. `openNavDrawer/closeNavDrawer/toggleNavDrawer` in renderer.js
are kept as no-ops so older callers don't break. Pages: Analytics, Match
History, Champions, Coaching, Chat, Skins (`TOP_TABS` in renderer.js).

### Chat page (Ollama) — 2026-10

Chat with your match data using a **local** Ollama model (default `qwen3:8b`)
at `http://127.0.0.1:11434`. The model never computes a number: it calls tools
and the app answers with values from the same formulas as the stat cards.

| File | Role |
|------|------|
| `services/ollama.js` | Node `http` client (no CORS): `listModels()`, streaming `chat()` with tools/think/abort. ECONNREFUSED → `OLLAMA_DOWN` |
| `components/chatTools.js` | 8 tools (`get_overview`, `get_category_stats`, `get_stat_trend`, `get_champion_stats`, `get_role_stats`, `get_recent_games`, `get_rank_and_lp`, `get_coaching_focus`); shared filters queue/champion/role/since/until/last_n_games. `executeTool` never throws |
| `components/chatAgent.js` | Tool-calling loop (`MAX_ROUNDS` 5, repeated calls cached, last round forces an answer), system prompt, `trimHistory` |
| `components/markdown.js` | Escape-first Markdown → HTML (model output can't inject tags) |
| `components/chatPanel.js` | UI; `window.openChatPanel()` called by `switchTopTab('chat')`, re-checks Ollama each open |

- Tool context uses `excludeRemakes(window.matchesData)`, so the chat sees
  exactly what the cards see. "Ranked" means Solo/Duo unless Flex is asked.
- `options: { num_ctx: 8192, temperature: 0.4 }` — the default context
  silently drops the system prompt once tool results pile up.
- `think`: qwen3 gets `false` unless "Think harder" is ticked (much faster).
- Model choice + think toggle persist in localStorage (`nexus.chatModel`,
  `nexus.chatThink`). Cloud models (`…:cloud` / `-cloud`) are listed last and
  the footer warns that data leaves the PC.
- Tests: `chatTools`, `ollama` (fake HTTP server), `chatAgent`, `markdown` (XSS).
  `chatPanel.js` itself needs Electron + sqlite and is checked by hand.
- **If you add a tool**, add its schema to `TOOLS` and a `describeCall` label.

### Updates from GitHub (titlebar ⟳ button) — 2026-10

Installed copies update themselves from **GitHub Releases** of the public repo
`toancina/nexus-insights` (`build.publish` in package.json; electron-builder
writes it into the app as `resources/app-update.yml` on every build).

- `services/updater.js` (main) wraps `electron-updater` with `autoDownload =
  false`. Click → check → if newer: download → `ready` → after 2.5 s
  `quitAndInstall(true, true)` (silent install, relaunch). `beforeRestart` sets
  `isQuitting` so close-to-tray can't swallow the restart. Status goes to the
  renderer on `update:status` `{state, version, percent, message}`; states:
  checking / available / downloading / ready / none / dev / error.
- A **quiet check 8 s after launch** only lights the green dot; it never
  downloads, and stays silent when offline or up to date.
- From source (`!app.isPackaged`) electron-updater isn't loaded; the button
  says to use `git pull`.
- `components/updateButton.js` = the button (spinner while busy, % in tooltip).
- Tests: `test/updater.test.js` (fake autoUpdater).

**Automatic releases:** `.github/workflows/release.yml` runs on every push to
`main` that isn't Markdown-only, and on demand (Actions → Release → Run
workflow). On `windows-latest`: `npm ci`, `npm test` (a failure publishes
nothing), version = `scripts/next-version.js` (one patch above the higher of
package.json and the newest release tag, so a lagging package.json can't
re-use a version), then `build-installer.js --publish --version X` with
`GH_TOKEN` = `GITHUB_TOKEN`. Its "Release vX" commit back to main is by
github-actions[bot]; GitHub never starts a workflow from a `GITHUB_TOKEN`
push, so it can't loop. One release at a time (`concurrency: release`). With
`CI` set, a run whose commit is no longer the newest on main exits quietly
(the newer run releases it), and a push rejected because main moved is
rebased once and retried. `sqlite3` 5.1.7 is a Node-API module, so the
prebuilt binary `npm ci` downloads works in Electron without rebuilding.

**Releasing:** `Publish Update.bat` / `npm run release` → bumps the patch
version (`--version X.Y.Z` to override), checks for hard-coded LP history, builds, uploads
`Nexus Insights Setup X.exe` + `.blockmap` + `latest.yml` to release `vX`
(`releaseType: release`, not draft — drafts are invisible to the updater),
then commits only `package.json` + `package-lock.json` as "Release vX" and
pushes. On failure the version bump is reverted. **It refuses to start**
unless you're on `main`, with no uncommitted changes, and level with
`origin/main` (`scripts/releaseChecks.js`, tested, #42): v1.0.4 was once
published from a feature branch and main kept the old version. `build-installer.js` first calls the GitHub API with the token and stops with a
clear message on 401. Token: `GH_TOKEN` env or
`%APPDATA%\nexus-insights\github-token.txt` (fine-grained, this repo only,
Contents read/write). The installer is unsigned: SmartScreen warns on first
install, updates still work. The portable zip cannot self-update.

**First-time install from GitHub.** The installer is named
`Nexus-Insights-Setup.exe` with no version in it (`nsis.artifactName`), so
`/releases/latest/download/Nexus-Insights-Setup.exe` is a permanent download
link (README top + release page). Differential updates still work, because
electron-updater swaps the version inside the tag part of the URL. After uploading,
`build-installer.js` PATCHes the GitHub release body (electron-builder leaves
it empty): "What's new" = commit subjects since the last `Release v…` commit,
then `installer/release-notes.md` (install guide). Edit that file to change
the guide. Links that would navigate the app window or open a new one are
sent to the browser (`setWindowOpenHandler` / `will-navigate` in main.js).

### UI polish + Skins — 2026-10

- `styles/polish.css` (loaded after app.css) is the consistency layer: spacing
  scale `--s1…--s6`, `--gutter` 12px, radii `--r-ctl/--r-card/--r-panel`,
  surfaces `--surface/--line/--line-strong`, type `--t-label/--t-small/--t-body/--t-value`.
  Floating glass nav rail, filters styled as tabs, rank cards 1 column wide
  (`balanceStatsGrid` counts every card as 1 unit, max 8 columns).
- **Never hard-code the accent.** Use `var(--accent-primary)`,
  `rgba(var(--accent-rgb), a)`, `--accent-deep`, `--on-accent`, `var(--gold)`,
  `rgba(var(--gold-rgb), a)`. `test/skins.test.js` fails if `#00cfbc` or
  `rgba(0,207,188,…)` reappears in the stylesheets. Canvas code reads the
  accent with `getComputedStyle` at draw time (see statHistory `accentColor`).
- Win-rate colours: `components/winRateColor.js` (50% = grey, ±12 points
  saturates). Not skinnable, nor are rank tier colours.
- Skins: `components/skins.js` = data (`vars`, `overlay`, `background`),
  `components/skinsPanel.js` = Skins page + `applySavedSkin()` at startup
  (replaced the old random-background code in renderer.js). Saved as
  `config.skin`; a custom background image is copied into the data folder
  (`config.customBackground`). "Background dim" slider = `config.bgDim[skinId]`
  (0–1; unset = skin default: region/image 0.85 or the skin overlay alpha,
  gradients 0). Region image is picked once per app run (`sessionRegion`).
  To add a skin, add an entry to `SKINS`.
- `saveConfig` writes `config.json.tmp`, copies the old file to `config.json.bak`, then renames the temp file over it; `loadConfig` falls back to `.bak` if `config.json` is missing or broken (#40).
- `saveSetup` now merges into the existing config (it used to replace it and
  wipe skin/coaching keys).
- Page footer removed; Riot's legal notice lives in the Settings dialog.

### Coaching page (rewritten 2026-10)

Solo/Duo only, organised around "am I improving game to game?". Uses
`window.matchesData` (remakes excluded) — **not** its own DB query any more —
and re-renders on every open.

- `components/coachingProgress.js` (pure, tested): `rankHeader` (W-L + LP over
  last 10 via `window.lpDeltas`), `lastGameReport` (one game vs the 20 before
  it, ‹ › steps back), `focusHits` (focus metric hit/missed per game, last 10 vs
  the 10 before), `areaTrends` (each Analytics area last 10 vs prev 10 +
  rolling-10 sparkline of a lead stat).
- Every value comes from `computeTabStats` — for the report it's run over a
  one-game list — so Coaching can't disagree with the Analytics cards.
- **Per-role report** (`components/roleBenchmarks.js`): 4 general stats (KDA,
  KP, deaths before 10, isolated deaths) + 4 for the role played that game
  (`ROLE_STATS`). "Usual" = the 20 earlier games in the same role (fewer than
  5 → all roles, and the summary says so). Tile badges use `ROLE_BENCHMARKS`
  overrides, falling back to the general `STAT_BENCHMARKS`; lane-opponent
  diffs (GD/CSD/XPD@15) always use the general ladder. Analytics cards keep
  the general values over mixed roles, and switch to a role's thresholds only
  when the Analytics role filter picks that role (see "Role filter").
  Role thresholds are estimates; tune them in that file.
- **Trend switches**: each Trends card has a "Last 10 / All games" switch
  (saved as `config.coachingTrendsAll`, an array of area tabs). All-games mode
  (`areaTrendAll`): value over every Solo/Duo game, verdict/highlights = newer
  half vs older half, sparkline = rolling 20-game average sampled across the
  whole history (≤30 points). Cards are `div role=button` so the switch isn't
  a nested button; the switch stops click propagation. A master switch above
  the cards (`coachingToggleAllTrends`) sets every card to all games, or back
  to last 10 if they're all on already; it shows "N of 6" when mixed.
- `plates_taken` and `obj_rate` are still left out of the report. Both were
  wrong until the data-bug fix below; plates could come back now. Control
  wards run above the general scale (6–7/game).
- `coachingEngine.js` still picks the focus (input vs outcome split,
  recoverable win rate); its tilt / watch / outcome evidence moved under a
  collapsed "Details".
- Rank in the header = latest `lp_history` reading for 'solo' (no API call).
- Objectives' sparkline follows `obj_tower`: "Alive for Objectives" sits at
  93–98% for everyone, so it barely moves.

### Data bugs fixed — 2026-10 (plates, objective rate)

`services/timelineRules.js` (pure, tested); migration 6 clears
`statsComputedAt` so the background backfill recomputes every game.

- **Plates Taken/Lost** came from Riot's `challenges.turretPlatesTaken`
  (6–10 a game). The timeline keeps sending `TURRET_PLATE_DESTROYED` after
  14:00 (~40 a game) and Riot's counter includes them. Now: your (or your lane
  opponent's) plate events before 14:00, a repeated event counted once. Real
  data: ~1.5 a game for laners, ~0.1 for jungle. Needs the timeline (NULL
  without one), also in the analytics fallback.
- **Objective Rate** = share of your team's epic monsters taken while you were
  alive. "Dead" used to need a death in the last 30 s *and* a fountain position
  in that minute's frame, so it was 100 in ~98% of games. Now dead = death →
  respawn timer (base by level, +time factor after 15:00, max +50%). Real data:
  93–98% average in every role, 100 in ~3 games of 4. So the cards are renamed
  "Alive for Objectives" and **not benchmarked** (the old 35–70% ladder made
  everyone Challenger), and Coaching's target is 100% in every role.
  `objectiveRate` moved from `LEGACY_STAT_COLUMNS` to `COMPUTED_STAT_COLUMNS`
  so the backfill rewrites it.
