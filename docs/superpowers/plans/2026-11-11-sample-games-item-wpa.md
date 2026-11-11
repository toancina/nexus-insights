# Sample Games and Fitted WPA Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans, inline in the main
> session. The user does not allow subagent-driven development or per-task
> reviews (global CLAUDE.md). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in Settings switch that downloads a small sample of other
players' games on your top 3 champions (your level and one above), fits the
win-chance curve to real games, and turns item/rune WPA into "won vs expected"
with a luck margin, shown on Champions, Live, Coaching and Chat.

**Architecture:** Pure, tested services for selection (`sampleSelect`),
storage (`sampleStore`), downloading (`sampleLoader`), features
(`winFeatures`), the model (`winModel`), the one curve helper every surface
reads (`winCurve`), pools (`samplePool`) and Coaching's build report
(`buildReport`). One renderer component (`components/sampleGames.js`) wires
Settings, sync, pausing, refits and the in-memory sample rows. With the switch
off, `winCurve` returns today's curve and today's WPA, so no surface changes.

**Tech Stack:** Electron 40, vanilla JS (CommonJS, `window.*` side effects in
components), sqlite3, Node's built-in test runner (`npm test`).

**Spec:** `docs/superpowers/specs/2026-11-11-sample-games-item-wpa-design.md`

## Global Constraints

- Switch: `config.sampleGames`, default `false`. Off = today's app, numbers included.
- Champions: top **3** by Solo/Duo (queue **420**) games, remakes excluded, over `filterByPeriod(…, 'patches:2')`; ties → most recent game.
- Groups: division **I** of your tier and division **I** of the next tier; apex: Master → Grandmaster → Challenger → none; unranked → nothing.
- **5** players per champion per group, most mastery points among players who played it in the last 3 months; **5** games each, on that champion, Solo/Duo, not remakes; you are never picked.
- Retention **90 days** (`RETENTION_MS = 90 * 86400000`) for games, rows, skips; players not checked for 90 days are dropped.
- Division list re-fetched at most once a day; a player's mastery re-checked after **7 days**; scan at most **3** pages per division; at most **15** match checks per player.
- Timeline fetched only for games on the champion; game + row stored only after both calls succeed.
- Downloads yield to your sync, a live game and the Live page; stop on 401/403 with no toast.
- Curve: fit needs ≥ **300** games; held-out check: every 10% band with ≥ **100** frames within **5** points, and log loss below the hand-tuned curve's. Refit after **25** new games or **7 days**.
- WPA (fitted): `(win ? 100 : 0) − chance at purchase`; margin `1.96 · √Σp(100−p) / n`; "–" under **5** games; muted when the margin includes 0; "better" only when the gap > `√(m₁² + m₂²)`.
- Rune number: page win rate − champion win rate over the same games (points), binomial margin `1.96 · √(wr(1−wr)/n) · 100`.
- No JSON blobs read for refits or display (CLAUDE.md "Lazy JSON Loading").
- Chat tool schemas with the switch off must be byte-identical to today's; all schemas < 14,000 characters.
- Every external string through `escapeHtml`; layers via `--z-*` variables; colours via CSS variables (existing tests enforce).

## Plan decisions (not in the spec)

- The fitted per-game win chance is computed in memory from `winFeatures` (cached per match + model), instead of a stored `winChanceFit` column; ~600 games × 30 frames is a few milliseconds.
- Switch on but curve not usable (< 300 games or a failed check): sample games still join the pools and comparisons, but WPA keeps today's window rule, with no margins.

## Review Focus

1. **Riot key expires mid-download** (dev keys last 24 h): the run stops quietly, the status says the key was rejected, nothing half-stored, and the next run continues without downloading anything twice. Test in Task 4.
2. **Champion names that don't match Data Dragon ids** (`FiddleSticks`, `MonkeyKing` for Wukong): a top champion silently getting 0 players. Test in Task 5 (`championKeyOf`).
3. **Your rank changes tier** (Silver → Gold or a demotion): games from groups you left stop counting at once and expire later, and the Settings counts show only current groups. Test in Task 2 (`groupOf`) and Task 12 (`championPool`).
4. **App closed or crashed mid-download:** no game row without its timeline, and no skip recorded for a game that wasn't checked. Test in Task 4.
5. **No Solo/Duo games in the last 2 patches, or unranked:** nothing downloads, and the status says why instead of showing nothing. Test in Task 2 and Task 5.

---

## Stage 1 — Download and storage

### Task 1: Riot API calls for division lists and all masteries

**Files:**
- Modify: `src/services/riotApi.js` (after `getRecentMatchIds`, and `module.exports`)
- Test: `test/riotRouting.test.js` (append)

**Interfaces:**
- Produces:
  - `getLeagueEntries(tier: string, division: string, page: number) → Promise<Array<{ puuid, leaguePoints, wins, losses }>>`: `GET https://{platform}/lol/league/v4/entries/RANKED_SOLO_5x5/{tier}/{division}?page={page}`
  - `getApexLeague(tier: 'MASTER'|'GRANDMASTER'|'CHALLENGER') → Promise<Array<{ puuid, leaguePoints, wins, losses }>>`: `GET …/lol/league/v4/{master|grandmaster|challenger}leagues/by-queue/RANKED_SOLO_5x5`, returns `.entries`
  - `getAllMasteries(puuid) → Promise<Array<{ championId: number, championPoints: number, lastPlayTime: number }>>`: `GET …/lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}`

- [ ] **Step 1: Write the failing test** `riotApi exposes the sample-game calls`: assert `typeof riotApi.getLeagueEntries`, `getApexLeague` and `getAllMasteries` are `'function'`, and that `getApexLeague('DIAMOND')` rejects with a message containing `apex`.
- [ ] **Step 2:** Run `node --test test/riotRouting.test.js`. Expected: FAIL (`not a function`).
- [ ] **Step 3:** Implement the three calls with `riotGet` (labels `league I page 1`, `apex MASTER`, `masteries`). If an entry lacks `puuid`, log once and drop it (the spec asks to check this; Riot's DTO has carried `puuid` since 2024).
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Commit** `Sample games: Riot calls for division lists and masteries`.

### Task 2: Selection rules (pure)

**Files:**
- Create: `src/services/sampleSelect.js`
- Test: `test/sampleSelect.test.js`

**Interfaces:**
- Consumes: `patches.filterByPeriod`, `queues` (420).
- Produces:
  - Constants: `TOP_CHAMPIONS = 3`, `PLAYERS_PER_GROUP = 5`, `GAMES_PER_PLAYER = 5`, `RETENTION_MS`, `DAY_MS`.
  - `topChampions(matches, { now }) → string[]` (championName as stored).
  - `sampleGroups(reading: { tier, rank } | null) → Array<{ key: 'level'|'above', tier: string, division: string|null, label: string }>`. Labels: `"Silver I"`, `"Master"`.
  - `pickBestPlayers(candidates: Array<{ puuid, masteries: Object<number, { points, lastPlayTime }> }>, championKey: number, { now, exclude: string|null, count = 5 }) → string[]`.
  - `groupOf(row: { tier, division }, groups) → 'level'|'above'|null`.

- [ ] **Step 1: Write the failing tests:**
  - `topChampions counts Solo/Duo only, skips remakes, last 2 patches, ties by most recent`: 16.21 Yorick ×2, Poppy ×2 (Poppy newer), Shen ×1, Flex Ahri ×5, a 16.19 Malphite ×9 → `['Poppy', 'Yorick', 'Shen']`.
  - `topChampions returns [] with no Solo/Duo games in the last 2 patches`.
  - `sampleGroups`: `SILVER II` → `[{level SILVER I 'Silver I'}, {above GOLD I 'Gold I'}]`; `GOLD IV` → Gold I + Platinum I; `DIAMOND I` → Diamond I + `{above MASTER null 'Master'}`; `MASTER` → Master + Grandmaster; `CHALLENGER` → `[level Challenger]`; `null` → `[]`; `IRON III` → Iron I + Bronze I; `EMERALD` → Emerald I + Diamond I.
  - `pickBestPlayers`: picks the 5 highest `points` with `lastPlayTime ≥ now − RETENTION_MS`, drops players without the champion, drops `exclude`, returns fewer than 5 when fewer qualify.
  - `groupOf`: matches on tier + division; a `GOLD I` row is `'above'` for a Silver II reading and `'level'` for Gold III; a `SILVER I` row is `null` for a Gold reading (Review Focus 3).
- [ ] **Step 2:** Run `node --test test/sampleSelect.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement. Tier order constant `TIERS = ['IRON','BRONZE','SILVER','GOLD','PLATINUM','EMERALD','DIAMOND','MASTER','GRANDMASTER','CHALLENGER']`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `Sample games: choose champions, groups and players`.

### Task 3: Sample store (SQLite)

**Files:**
- Create: `src/services/sampleStore.js`
- Test: `test/sampleStore.test.js` (temp-folder pattern of `test/liveGameStore.test.js`)

**Interfaces:**
- Consumes: `database.db`, `compression.compressJson`, `sampleSelect.RETENTION_MS`.
- Produces:
  - Tables (created on first use): `sample_games (matchId PK, gameCreation, gameDuration, patch, blueWin INTEGER, winFeatures TEXT, rawJson BLOB, timelineJson BLOB)`; `sample_rows (matchId, puuid, championName, teamId, teamPosition, win, tier, division, itemPurchases, item0…item6, primaryRune, secondaryRuneStyle, PRIMARY KEY(matchId, puuid))`; `sample_skips (matchId, puuid, gameCreation, PRIMARY KEY(matchId, puuid))`; `sample_players (puuid, tier, division, page, masteries TEXT JSON, checkedAt, PRIMARY KEY(puuid, tier, division))`; `sample_lists (tier, division, page, fetchedAt, PRIMARY KEY(tier, division, page))`.
  - `saveGame({ game, row }) → Promise<void>`: one transaction, both tables.
  - `saveSkip(matchId, puuid, gameCreation) → Promise<void>`.
  - `knownMatchIds(puuid) → Promise<Set<string>>`: stored rows + skips for that puuid.
  - `storedCount(puuid, championName) → Promise<number>`.
  - `getPlayers(tier, division) → Promise<Array<{ puuid, page, masteries, checkedAt }>>`; `savePlayers(rows)`.
  - `listFetchedAt(tier, division, page) → Promise<number|null>`; `saveListFetched(tier, division, page, at)`.
  - `getSampleRows() → Promise<Array<row & { gameCreation, gameDuration, patch, winFeatures, blueWin, isRemake: 0 }>>`: every row joined with its game, no blobs.
  - `prune(now) → Promise<{ games, rows, skips, players }>`.

- [ ] **Step 1: Write the failing tests:**
  - `saveGame / getSampleRows round-trip without blobs` (row fields equal; no `rawJson` key).
  - `knownMatchIds includes stored and skipped ids for that player only`.
  - `prune deletes games, rows and skips older than 90 days and players unchecked for 90 days, keeps newer`.
  - `saveGame writes nothing when the row insert fails` (row missing `puuid` → rejects; `getSampleRows()` is empty) (Review Focus 4).
- [ ] **Step 2:** Run `node --test test/sampleStore.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement following `liveGameStore.js` (promisified `run/all/get`, `ensureSchema` memoised and reset on failure); transaction via `BEGIN`/`COMMIT`/`ROLLBACK` on `db.serialize`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `Sample games: store and retention`.

### Task 4: Downloader

**Files:**
- Create: `src/services/sampleLoader.js`
- Test: `test/sampleLoader.test.js` (fake API + in-memory fake store, pattern of `test/liveGameLoader.test.js`)

**Interfaces:**
- Consumes: Task 1 API shape, Task 2 `pickBestPlayers`, `GAMES_PER_PLAYER`, `RETENTION_MS`, Task 3 store methods, `riotErrors.isKeyError`, `itemBuild.purchasesFromTimeline/encodePurchases`, `patches.patchOf`.
- Produces:
  - Constants: `MAX_PAGES = 3`, `LIST_TTL_MS = DAY_MS`, `MASTERY_TTL_MS = 7 * DAY_MS`, `MAX_CHECKS_PER_PLAYER = 15`.
  - `sampleGameFrom(raw, timeline, puuid) → { game, row } | null` (null for a remake: `gameEndedInEarlySurrender` or `gameDuration < 300`). Runes as in matchService (`perks.styles[0].selections[0].perk`, `perks.styles[1].style`). `game.winFeatures = null` until Task 7.
  - `createSampleLoader({ api, store, now = Date.now }) → { run(opts) }`.
  - `run({ champions: Array<{ name, key }>, groups, selfPuuid, shouldStop: () => string|null, onProgress?: (text) => void }) → Promise<{ stored, checked, calls, found: { [name]: { [groupKey]: number } }, stopped: null|'paused'|'key'|'error', message: string|null }>`.

Order per group: scan list pages (cached by `listFetchedAt`) and masteries (re-fetched only when `checkedAt` is older than `MASTERY_TTL_MS`) until every champion has 5 candidates or `MAX_PAGES` are scanned. Then per champion, per picked player: `getMatchIds(puuid, now − RETENTION_MS, 420)`, newest first, skipping `knownMatchIds`, until `storedCount` reaches 5 or `MAX_CHECKS_PER_PLAYER` matches were fetched. `shouldStop()` is checked before every API call.

- [ ] **Step 1: Write the failing tests:**
  - `fetches the timeline only for games on the champion and records a skip for the rest` (calls counted).
  - `stops a player at 5 stored games`, and `at 15 checks`.
  - `never downloads a known id again` (second run: 0 match calls for the same ids).
  - `reuses a division list fetched today and masteries checked within 7 days` (second run: 0 list calls, 0 mastery calls).
  - `scans a second page only while a champion has fewer than 5 candidates, never more than 3 pages`.
  - `never picks selfPuuid`.
  - `a 401 stops with stopped 'key', stores nothing for the game in flight` (timeline call throws 401 → no `saveGame`, no `saveSkip` for that id) (Review Focus 1 and 4).
  - `shouldStop returning 'paused' stops before the next call with stopped 'paused'`.
  - `sampleGameFrom builds the row: items, purchases, runes, win, patch; null for a remake`.
- [ ] **Step 2:** Run `node --test test/sampleLoader.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. Apex groups use `getApexLeague` as a single page.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `Sample games: downloader`.

### Task 5: Settings switch, status and wiring

**Files:**
- Create: `src/components/sampleGames.js`
- Modify: `src/index.html` (Settings: new `setup-toggle` after the "Fill gaps" `.setup-datadir`, before `.setup-legal`; status `<p id="sampleGamesStatus">`); `src/renderer.js` (`showSetupModal` reads `config.sampleGames === true`; `saveSetup` adds `sampleGames` to `updateConfig`, then calls `window.runSampleDownload({ reason: 'settings' })` when it was turned on; require the new component; startup: `window.pruneSampleGames()` then, when on, `window.loadSampleRows()` and a run after `catchUpSync`; `pollLiveClient` sets `window.sampleStopReason = 'live'` on game start); `src/components/syncPanel.js` (set `window.sampleStopReason = 'sync'` at start of `handleSync`; after a successful sync clear it and call `window.runSampleDownload({ reason: 'sync' })` without awaiting); `src/components/liveGamePanel.js` (set `window.sampleStopReason = 'live'` when a load starts, clear when it ends).
- Test: `test/sampleSelect.test.js` (append `championKeyOf`)

**Interfaces:**
- Consumes: Tasks 1–4, `dataDragon.getChampionList()`, `getLpReadings('solo')` (latest reading, as `coachingPanel.renderCoachingPanel`), `currentAccountPuuid()`.
- Produces (on `window`):
  - `sampleGamesEnabled() → boolean`
  - `runSampleDownload({ reason }) → Promise<void>`: single-flight; no-op when off; writes the status line; afterwards `loadSampleRows()` (and, from Task 11, `maybeRefitWinModel()`).
  - `loadSampleRows() → Promise<void>` → `window.sampleRows` (array) and `window.sampleGroupsNow` (Task 2 groups).
  - `pruneSampleGames() → Promise<void>`
- Produces (pure, in `sampleSelect.js`): `championKeyOf(name: string, championList) → number|null`, case-insensitive on Data Dragon `id` (`FiddleSticks` → Fiddlesticks, `MonkeyKing` → 62).

Status text (exact copy): off: empty. On: `"Last download {timeAgo}: Yorick — Silver I 25 · Gold I 18; Poppy — …"`, or one of `"No Solo/Duo rank yet, so there's no level to compare with."`, `"No Solo/Duo games in the last 2 patches."`, `"Riot rejected the API key; update it above."`, `"Paused for your own sync or a live game; it continues after the next sync."`, `"Found {n} of 5 {label} {champion} players."`.

- [ ] **Step 1: Write the failing test** `championKeyOf maps Match-V5 names to Data Dragon keys` (`FiddleSticks` → 9, `MonkeyKing` → 62, `Nobody` → null) (Review Focus 2).
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement `championKeyOf`, the component and the wiring above. Toggle copy: title `Download sample games from other players`; hint `Downloads a few games from the best players on your 3 most-played champions, at your rank and one rank above, to compare with and to sharpen WPA. Uses your API key; the first download takes 15–25 minutes in the background.`
- [ ] **Step 4:** Run `npm test`. Expected: all pass. Then check by hand (`npm start`, `ELECTRON_RUN_AS_NODE` unset): switch off → no Riot calls after a sync (devtools Network/console); switch on → status fills in, `sample_games` rows appear (`sqlite3 -readonly … "SELECT COUNT(*) FROM sample_games"`); start a sync mid-download → status says paused.
- [ ] **Step 5:** Add a "Sample games (2026-11)" section to `CLAUDE.md` (tables, switch, rules, cost) and the new files to the directory list.
- [ ] **Step 6: Commit** `Sample games: Settings switch and background download`.

## Stage 2 — Curve and numbers

### Task 6: Win features per frame (pure)

**Files:**
- Create: `src/services/winFeatures.js`
- Test: `test/winFeatures.test.js`

**Interfaces:**
- Produces:
  - `frameFeatures(raw, timeline) → Array<{ m, gold, xp, kills, towers, inhibs, dragons, soul, baron, elder }>`: one per timeline frame, **team 100 minus team 200**. `m` = frame minute (float). Kills by players only (as `teamSeries`). Towers/inhibitors: `BUILDING_KILL` (`teamId` = the team that lost it); inhibitors count only while down (`INHIB_RESPAWN_MS = 300000`). Dragons: `ELITE_MONSTER_KILL` `monsterType 'DRAGON'` excluding `ELDER_DRAGON`, by `killerTeamId`. `soul` = +1/−1 once a team has 4. `baron` / `elder` = +1/−1 while that team's buff is up (`BARON_BUFF_MS = 180000`, `ELDER_BUFF_MS = 150000`), else 0.
  - `encodeFeatures(list) → string`: `"m,g,x,k,t,i,d,s,b,e;…"`, `m` with 2 decimals, the rest integers. `''` for none.
  - `decodeFeatures(text) → list`: `[]` for empty or malformed.
  - `flipFeatures(f) → f` with every difference negated (`m` unchanged).

- [ ] **Step 1: Write the failing tests** on a hand-built 4-frame timeline: gold/xp/kill differences per frame; a tower and an inhibitor (inhibitor back to 0 after 5 min); 4 dragons → `soul` 1; baron buff 1 for 3 minutes, then 0; an elder kill counts as `elder`, not `dragons`; `encode`/`decode` round-trip; `decode('x,y')` → `[]`; `flipFeatures` negates.
- [ ] **Step 2:** Run `node --test test/winFeatures.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement (reuse `matchTimeline.rosterOf`).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `Win features per timeline frame`.

### Task 7: Store `winFeatures` for your games and sample games

**Files:**
- Modify: `src/services/database.js` (`newColumns`: `'winFeatures TEXT'`); `src/services/matchService.js` (`computeAdvancedStatsForMatch`: `result.winFeatures = ''` without a timeline, else `encodeFeatures(frameFeatures(info, timeline))`; add to `COMPUTED_STAT_COLUMNS`; `getMatches` selects `winFeatures`; `backfillTimelines` resets `winFeatures = NULL`; `backfillComputedStats(onProgress, { winFeatures = false } = {})` adds `OR winFeatures IS NULL` only when true); `src/renderer.js` (`backfillAnalyticsInBackground`: `m.winFeatures == null` counts as pending only when `sampleGamesEnabled()`, and passes `{ winFeatures: sampleGamesEnabled() }`); `src/services/sampleLoader.js` (`sampleGameFrom` fills `game.winFeatures` and `game.blueWin`).
- Test: `test/advancedStats.test.js`, `test/sampleLoader.test.js`

**Interfaces:**
- Produces: `matches.winFeatures` / `sample_games.winFeatures` (Task 6 text, team 100 side) and `sample_games.blueWin` (1/0).

- [ ] **Step 1: Write the failing tests:** `computeAdvancedStatsForMatch writes winFeatures from team 100's side` (the hand-built game in `advancedStats.test.js`, team 200 player: features still team-100 positive when blue leads), `'' without a timeline`; `sampleGameFrom sets winFeatures and blueWin`.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement the changes listed.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `Store win features for the fitted curve`.

### Task 8: The model (pure)

**Files:**
- Create: `src/services/winModel.js`
- Test: `test/winModel.test.js`

**Interfaces:**
- Consumes: Task 6 `decodeFeatures`, `flipFeatures`; `matchTimeline.winProbability` (hand-tuned baseline).
- Produces:
  - Constants: `MIN_GAMES = 300`, `REFIT_AFTER_GAMES = 25`, `REFIT_AFTER_MS = 7 * 86400000`, `BAND_MIN_FRAMES = 100`, `BAND_TOLERANCE = 0.05`.
  - `vectorOf(f) → number[12]`: `[g, x, k, t, i, d, s, b, e, g·τ, x·τ, k·τ]` with `g = gold/1000`, `x = xp/1000`, `τ = m/30`. No intercept, so p(team 200) = 1 − p(team 100).
  - `predict(model: { coef: number[] }, f) → number` (0–1, logistic).
  - `fitModel(samples: Array<{ f, y: 0|1 }>, { l2 = 1, iterations = 25 }) → { coef }`: Newton–Raphson (IRLS) on the L2-penalised log loss; solve the 12×12 system by Gaussian elimination.
  - `trainingSet(games: Array<{ matchId, winFeatures: string, blueWin: 0|1 }>) → { train, test }`: every frame of every game is a sample `{ f, y: blueWin }`; a game goes to `test` when its `matchId`'s character-code sum % 5 === 0.
  - `checkModel(model, test) → { ok, logLoss, handLogLoss, bands: Array<{ from, frames, predicted, actual }> }`.
  - `buildModel(games, { now }) → { ok, reason: null|'few-games'|'check', coef?, fittedAt, games, logLoss, handLogLoss }`: under `MIN_GAMES` → `few-games`; fit on `train`, check on `test`; on pass, refit on all samples.
  - `needsRefit(saved, gameCount, now) → boolean`.

- [ ] **Step 1: Write the failing tests:**
  - `fitModel recovers known coefficients` (5,000 synthetic frames from a known `coef`, labels drawn with a seeded PRNG; each coefficient within 0.15).
  - `predict is symmetric`: `predict(m, f) + predict(m, flipFeatures(f)) ≈ 1`.
  - `checkModel passes a calibrated model and fails one off by 10 points` (bands rule and log-loss rule each tested).
  - `buildModel refuses under 300 games with reason 'few-games'`.
  - `needsRefit`: true with no saved model, after 25 more games, after 7 days; false otherwise.
- [ ] **Step 2:** Run `node --test test/winModel.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `Fitted win-chance model`.

### Task 9: One curve helper and "won vs expected"

**Files:**
- Create: `src/services/winCurve.js`
- Modify: `src/services/itemWpa.js`, `src/services/itemBuild.js` (`rateRows`, `buildOrderTable`), `src/services/nextItem.js` (`tally`, `rankOptions`, `championGames`)
- Test: `test/winCurve.test.js`, `test/itemWpa.test.js`, `test/itemBuild.test.js`, `test/nextItem.test.js`

**Interfaces:**
- Consumes: Tasks 6, 8; `matchTimeline.teamSeries`; `itemWpa.winChancePoints`.
- Produces:
  - `winCurve.configure({ enabled: boolean, model: object|null })`; `isFitted() → boolean` (enabled and `model.ok`).
  - `winCurve.pointsFor(m: { matchId, teamId, winChance, winFeatures, gameDuration }) → Array<{ t, p }>`: fitted → from `winFeatures` (flipped for team 200), same timing rule as `winChancePoints`; else `winChancePoints(m.winChance, m.gameDuration)`. Cached per `matchId:teamId` until `configure` is called again.
  - `winCurve.seriesFor(raw, timeline, teamId) → teamSeries output` with `winProb` from the model when fitted.
  - `winCurve.purchaseWpa(purchases, m) → Array<entry|null>`: fitted → `itemWpa.wonVsExpected(purchases, pointsFor(m), m.win)`; else `itemWpa.itemWpa(purchases, pointsFor(m))`.
  - `itemWpa.wonVsExpected(purchases, points, win) → Array<{ itemId, t, from, wpa, v } | null>`: `wpa = (win ? 100 : 0) − from`, `v = from · (100 − from)`.
  - `itemWpa.marginOf(vSum, n) → number|null` = `1.96 · √vSum / n`; null when `n === 0` or `vSum` isn't finite.
  - `itemWpa.beatsBeyondMargin(a, b) → boolean`: `a.wpa − b.wpa > √(a.margin² + b.margin²)`; false when either margin is null.
  - `itemTable` rows, `itemBuild.rateRows` rows and `nextItem` options gain `margin` (sum of entry `v` over the games that have one); window entries carry no `v` → `margin` null.
  - `nextItem.championGames(matches, champion, position, { minRoleGames, extra = [] })`: `extra` rows (sample rows) join the pool after the role rule; each game's `wpa` from `winCurve.purchaseWpa`.

- [ ] **Step 1: Write the failing tests:**
  - `winCurve off returns today's points and window WPA` (deep-equal to `winChancePoints`/`itemWpa` output).
  - `winCurve fitted reads winFeatures, flips for team 200` (a model with `coef = [1,0,…]`: `p(100) + p(200) = 100` at every point).
  - `wonVsExpected: a win from 40% is +60 with v 2400; a loss from 40% is −40`.
  - `marginOf(2400·100, 100)` ≈ 9.6; `marginOf(0, 0)` → null.
  - `beatsBeyondMargin` true/false around √(m₁² + m₂²).
  - `buildOrderTable rows carry margin when entries have v, null otherwise`; `itemTable` same; `nextItemOptions` same.
  - `championGames adds extra rows after the role rule`.
- [ ] **Step 2:** Run the four files. Expected: FAIL.
- [ ] **Step 3:** Implement. `buildOrderTable`'s `firstWpa` returns the entry; `rateRows` sums `e.wpa` and `e.v`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass (existing WPA tests unchanged with the curve off).
- [ ] **Step 5: Commit** `One win-chance curve helper; WPA as won vs expected when fitted`.

### Task 10: Every curve reader goes through `winCurve`

**Files:**
- Modify: `src/components/matchModal.js:139`, `src/components/matchTimelineChart.js:266,303`, `src/services/gameReport.js:133`, `src/components/chatTools.js:294-296,353,462`, `src/components/championsPanel.js:141`, `src/components/tableRenderer.js:132`, `src/services/nextItem.js:125`
- Test: `test/gameReport.test.js`

**Interfaces:**
- Consumes: Task 9. `teamSeries(...)` → `winCurve.seriesFor(...)`; `winChancePoints(m.winChance, m.gameDuration)` → `winCurve.pointsFor(m)`; aggregate `itemWpa(purchases, …)` → `winCurve.purchaseWpa(purchases, m)`. `tableRenderer` keeps `lastPurchaseWpa(purchases, winCurve.pointsFor(match))` (tooltip stays a window). `matchService.js:753` keeps the hand-tuned `teamSeries` (the stored `winChance` column is today's curve).

- [ ] **Step 1: Write the failing test** `game report blunders use the fitted curve when configured` (configure a model that inverts the hand-tuned sign; the "biggest drop" death changes).
- [ ] **Step 2:** Run `node --test test/gameReport.test.js`. Expected: FAIL.
- [ ] **Step 3:** Replace the calls listed. `grep -rn "teamSeries\|winChancePoints" src` must then show only `matchTimeline.js`, `itemWpa.js`, `winCurve.js` and `matchService.js:753`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `Every win-chance reader uses the one curve helper`.

### Task 11: Refits and rune numbers

**Files:**
- Modify: `src/components/sampleGames.js` (`maybeRefitWinModel`); `src/renderer.js` (at startup `winCurve.configure({ enabled: sampleGamesEnabled(), model: config.winModel || null })`; `saveSetup` re-configures when the switch changes); `src/services/championStats.js` (`championDetail` rune rows gain `edge`, `edgeMargin`)
- Test: `test/championStats.test.js`

**Interfaces:**
- Produces:
  - `window.maybeRefitWinModel() → Promise<void>`: when on and `needsRefit(config.winModel, n, now)`, builds training games from `window.matchesData` (`blueWin = teamId === 100 ? win : 1 − win`, non-remake, `winFeatures` non-empty) plus `window.sampleRows` (deduplicated by `matchId`), runs `buildModel`, saves `config.winModel` via `updateConfig`, re-configures `winCurve`, and re-renders an open Champions/Coaching page. The Settings status gets one line: `"Win chance fitted on {n} games."`, or `"Win chance: not enough games to fit yet (needs 300)."`, or `"Win chance: the fitted curve didn't pass its check; using the standard one."`.
  - Rune rows: `edge = (winRate − summary.winRate) · 100`, `edgeMargin = 1.96 · √(winRate(1−winRate)/games) · 100`.

- [ ] **Step 1: Write the failing test** `championDetail rune rows carry edge and edgeMargin` (10 games, 6 wins; a page 4/5 → edge +20, margin ≈ 35.1).
- [ ] **Step 2:** Run `node --test test/championStats.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the refit wiring and the rune numbers.
- [ ] **Step 4:** Run `npm test`, then by hand: switch on, after the first download the status says the curve was fitted; `config.json` has `winModel.ok === true`; switch off → the expanded row's chart matches today's.
- [ ] **Step 5:** Update CLAUDE.md (curve, features, model, `winCurve`, WPA rules).
- [ ] **Step 6: Commit** `Refit the win-chance curve; rune numbers`.

## Stage 3 — Showing it

### Task 12: Pools and the Champions page

**Files:**
- Create: `src/services/samplePool.js`
- Modify: `src/components/championsPanel.js` (`renderBuildOrder`, `rateTable` for runes, the detail render)
- Test: `test/samplePool.test.js`

**Interfaces:**
- Consumes: Task 2 `groupOf`, `patches.filterByPeriod`, `window.sampleRows`, `window.sampleGroupsNow`, `window.periodFilterValue` (whatever `renderFilteredMatches` uses for the period; read it there).
- Produces:
  - `championPool(myMatches, sampleRows, champion, { role = null, period = '', groups, now }) → { games: rows[], counts: { mine, level, above } }`: sample rows matched case-insensitively on champion, `groupOf` non-null, the same role and period rules; each sample row gets `sample: 'level'|'above'`.
  - `poolLabel(counts, groups) → string`: `"From 412 games: yours 214 · Silver I 25 · Gold I 18"`; omits zero groups.

With the switch on, the Champions page:
- `renderBuildOrder` and the rune table use `championPool(...)` instead of the page's own filter;
- the WPA cell shows `formatWpa(r.wpa)` with `±{round(margin)}` in its title, muted (no colour) when `|wpa| ≤ margin`;
- the note under "Build order" says: `Last number: WPA, how much more often games with this purchase were won than the game state at the purchase predicted (± is the luck margin).`;
- the rune table gets a WPA column from `edge` / `edgeMargin`, same muting;
- `poolLabel` above the cards.
With it off, nothing on the page changes (the pool is `matches` as today).

- [ ] **Step 1: Write the failing tests:** `championPool joins your games and current-group sample rows, with counts`; `drops sample rows from groups you left` (Review Focus 3); `applies role and period to sample rows`; `poolLabel`.
- [ ] **Step 2:** Run `node --test test/samplePool.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `samplePool.js` and the page changes.
- [ ] **Step 4:** Run `npm test`, then by hand: switch on → label, ± in tooltips, muted numbers; switch off → page identical to before.
- [ ] **Step 5: Commit** `Champions page: sample games and WPA with a luck margin`.

### Task 13: Live page Next item card

**Files:**
- Modify: `src/components/liveGamePanel.js:123-127`, `src/services/nextItem.js`
- Test: `test/nextItem.test.js`

**Interfaces:**
- Consumes: Task 9 `championGames(..., { extra })`, `beatsBeyondMargin`; Task 12 `championPool` (sample rows for the champion).
- Produces: `nextItemOptions(...)` result gains `clearPick: boolean`: true when fitted and the first option `beatsBeyondMargin` the second (or is the only one with ≥ 5 games). Card copy when false: `Too close to call: the top options are within the luck margin.`

- [ ] **Step 1: Write the failing test** `clearPick is false when the top two are within the margin, true beyond it, false with the curve off`.
- [ ] **Step 2:** Run `node --test test/nextItem.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement; the panel passes sample rows as `extra` only when the switch is on, and shows the copy above when `clearPick` is false.
- [ ] **Step 4:** Run `npm test`. Check by hand with the fake Live Client server (CLAUDE.md "Testing without a game").
- [ ] **Step 5: Commit** `Next item: sample games and a too-close-to-call rule`.

### Task 14: Coaching "Build and runes"

**Files:**
- Create: `src/services/buildReport.js`
- Modify: `src/components/coachingPanel.js` (`renderReport`: section after `.coach-tiles`, only when `sampleGamesEnabled()`), `src/styles/polish.css` (panel classes per "Pages")
- Test: `test/buildReport.test.js`

**Interfaces:**
- Consumes: Tasks 9, 11, 12; `itemBuild.decodePurchases`, `itemKinds.isBuildItem` (passed in).
- Produces: `buildReport(game, myGames, sampleRows, groups, { isBuildItem, now }) → { items, rune, groups, better, noSamples }`:
  - `items`: `[{ itemId, t, usualT: number|null, wpa: number|null, margin: number|null }]`, your finished items in purchase order; `usualT` = average first-purchase time of that item in your other games on the champion; `wpa`/`margin` from the Build-order-style pool (`championPool` games, first purchase after the opening shop).
  - `rune`: `{ keystone, secondary, edge, edgeMargin }` for your page.
  - `groups`: per current group `{ key, label, players: number, games: number, core: [{ itemId, share }] × up to 3, keystone: { id, share } | null }` (most common 1st/2nd/3rd finished item and keystone among that group's sample rows on the champion).
  - `better`: `{ itemId, insteadOf, gap }` for at most one slot where another item `beatsBeyondMargin` yours; else null.
  - `noSamples`: true when the champion has no sample rows (copy: `No sample games for {champion} yet: they're downloaded for your 3 most-played champions.`).

- [ ] **Step 1: Write the failing tests:** usual time from other games only; group core items and keystone shares; `better` only beyond the margin and never when the curve is off; `noSamples`.
- [ ] **Step 2:** Run `node --test test/buildReport.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the calculator and the section (items with icons via `itemImg`, times `m:ss`, "Silver I players" / "Gold I players" columns, the one `better` line).
- [ ] **Step 4:** Run `npm test`; by hand: Coaching → Game Report with the switch on and off.
- [ ] **Step 5: Commit** `Coaching: build and runes compared with your level and the level above`.

### Task 15: Chat

**Files:**
- Modify: `src/components/chatTools.js` (`toolSchemas({ samples = false } = {})`, `itemStats`, `gameDetail` items), `src/components/chatPanel.js:602` (`toolSchemas({ samples: sampleGamesEnabled() })`; tool context gets `sampleRows: window.sampleRows || []` and `sampleGroups: window.sampleGroupsNow || []` when on), `src/components/chatAgent.js` (system prompt line when samples are on)
- Test: `test/chatTools.test.js`

**Interfaces:**
- Consumes: Tasks 9, 11, 12.
- Produces:
  - `get_item_stats` gains `pool` (`all` | `mine` | `level` | `above`, description `Whose games: all (default), mine, level (players at your level), above (one level up).`) only when `samples` is true.
  - Sample rows join only with a `champion` filter naming a champion that has sample rows, and a `queue` filter that includes Solo/Duo.
  - Item rows add `wpa_margin` (rounded) when fitted; output adds `rune_pages: [{ keystone, secondary, games, win_rate_pct, wpa, wpa_margin }]` with a champion, and `pool: { yours, [label]: n, … }`.
  - `get_game_detail` items add `wpa_margin` when fitted.
  - System prompt line: `Numbers whose ± margin includes 0 are not evidence for or against an option; say so instead of recommending.`

- [ ] **Step 1: Write the failing tests:** `toolSchemas() is identical to before with samples off` (`JSON.stringify` equals a saved copy taken before the change); `with samples on, get_item_stats has pool and all schemas stay under 14,000 characters`; `sample rows join only with a champion filter and Solo/Duo`; `pool 'above' uses only that group`.
- [ ] **Step 2:** Run `node --test test/chatTools.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`; by hand with the fake Ollama (CLAUDE.md "Checking the Chat page without a model"): the request carries `pool` only with the switch on.
- [ ] **Step 5: Commit** `Chat: sample games, WPA margins and rune pages`.

### Task 16: Docs and final check

**Files:**
- Modify: `CLAUDE.md` (Champions, Live, Coaching, Chat sections; directory list; "Updated" header line)

- [ ] **Step 1:** Update CLAUDE.md for Stage 3.
- [ ] **Step 2:** Run `npm test`. Expected: all pass.
- [ ] **Step 3:** By hand, switch off: Champions, Live card, Coaching, Chat and an expanded match row look and read as before. Switch on: each shows the new numbers; the status line is correct; a sync during a download pauses it.
- [ ] **Step 4: Commit** `CLAUDE.md: sample games and fitted WPA`.
