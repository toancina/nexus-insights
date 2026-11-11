# Sample games and a better item WPA — design

Date: 2026-11-11 · Status: draft for approval · Builds on #89 (item WPA) and #90 (Next item)

## Why

The app's item WPA (`services/itemWpa.js`) is meant to help you decide which
item to buy and which rune page to take. Today it has three weaknesses:

1. **The win-chance curve is hand-tuned** (`matchTimeline.winProbability`:
   gold + ½·XP + 300·kills, scale 2500, no game time, no objectives). Nobody
   has checked that "70%" means teams in that spot win 70% of the time. Gold
   leads grow with game time, so the curve probably drifts towards whoever is
   ahead, which inflates items bought while ahead.
2. **It only uses your own games**, so per-champion numbers are thin and say
   nothing about what better players do.
3. **It measures a 5-minute window, not the result.** Coachless measures
   "won vs expected": the game's result minus the win chance just before the
   purchase. That estimates the item's effect, provided the curve is honest.

This feature downloads a small, fresh sample of other players' games on your
main champions, fits the win-chance curve to real games, and switches the item
and rune numbers to "won vs expected". Everything new sits behind a Settings
switch that is **off by default**.

## What the user decided

- Purpose: choosing an item to buy and a rune page to take on a champion.
- Small samples are fine.
- A Settings switch at the **bottom of Settings**, opt-in, **off by default**.
  With it off, the app shows **exactly what it shows today**.
- With it on, sample games are downloaded **on every sync**, and old ones are
  deleted to keep the data fresh. **Retention: 3 months.**
- **Champions:** your **top 3 champions by games over the last 2 patches**.
- **Players:** the **5 best players on that champion** at **your level** and
  the **level above**, **5 games each**. Your level = division I of your tier,
  the level above = division I of the next tier (Silver II today → Silver I
  and Gold I; once you reach Gold → Gold I and Platinum I).
- **Only games on that champion** are downloaded.
- **Who is best is checked again** regularly, not fixed once.
- Coaching and Chat compare you with **both groups**, separately.
- The new numbers show on the Champions page, the Live page's Next item card,
  Coaching and Chat.

## Goals

- Item and rune numbers that are honest about what they know: a fitted curve,
  "won vs expected", and a luck margin on every number.
- A view of what players at your level and one level above do on your
  champions, next to what you do.
- Small, fresh, automatic: about 50 games per champion, never older than
  3 months, downloaded in the background.

## Non-goals

- Sample games never appear in Match History, the Analytics cards, the
  Champions table or matchups, Teammates, Coaching's Habits/Trends, LP, or
  CSV export. They feed only the item/rune numbers, the fitted curve and the
  comparisons listed below.
- No sample games for champions outside your top 3 (any already stored stay
  usable until they expire).
- No other queues: Ranked Solo/Duo (420) only, for samples and for picking
  your top champions.
- No champ-select reading (Riot policy, see the Live page notes).

## Anti-goals (failure even if it "works")

- **Presenting noise as advice.** With ~50–300 games per champion, luck moves
  an item's number by several points. No surface may call one option better
  than another unless the gap is larger than the luck margin.
- **Changing the app for users who never turned it on.** Off = today's app,
  numbers included.
- **Getting in the way of your own data.** Your sync, the post-game retry and
  the Live page always come first; sample downloads yield to them.
- **Downloading the same thing twice**, or downloading games on other
  champions beyond the one-call check described below.

## With the switch off

Nothing new runs or shows: no downloads, no fitted curve, no curve backfill,
no new sections, labels or Chat parameters. (The new tables and columns may
exist in the database and sync may fill `winFeatures` for new games, since
that is cheap and invisible; nothing reads them.) The stored win chance, the current WPA
(`itemWpa.js` window rule) and every text stay as they are. Sample games
already stored stay in the database, hidden, and are deleted as they pass
3 months (the prune also runs when the switch is off). Turning the switch back
on reuses them.

## Settings

At the bottom of the Settings dialog, after "Fill gaps" and before the Riot
legal notice, a toggle in the existing `setup-toggle` style:

- Title: **Download sample games from other players**
- Hint: one line saying it downloads a few games from the best players on
  your 3 most-played champions at your rank and one rank above, uses your API
  key, and takes a while the first time.
- Saved as `config.sampleGames` (boolean, default `false`) through
  `updateConfig`, like the other toggles.
- A status line under it when on: last download, games stored per champion
  and group (e.g. "Yorick: Silver I 25 · Gold I 18"), or why nothing was
  downloaded (no Solo/Duo rank, key rejected, rate limited, no champions).
- Turning it on starts a download right after Save if no sync is running.

## Downloading sample games

### When

After every successful sync (normal, auto, catch-up, Fill gaps), once your own
games and backfills are done, in the background. It never delays the sync's
result or its toasts.

It **pauses** (stops and resumes on the next trigger) when a sync starts, when
the live watcher sees a game, or when the Live page starts loading. It stops on
401/403 (key) without a toast of its own; the Settings status says why. The
shared rate limiter in `riotApi` paces it like any other call.

### Which champions

Your top 3 champions by Solo/Duo games, remakes excluded, over the last
2 patches (`patches.filterByPeriod('patches:2')`, the same rule as the period
dropdown), configured account only. Ties: most recent game first. Fewer than
3 played → fewer. Recomputed on every run.

### Which groups

From your latest Solo/Duo rank (the latest `lp_history` 'solo' reading, as
Coaching's header uses, refreshed by sync's rank fetch):

| Your rank | Your level | Level above |
|---|---|---|
| Iron … Diamond, any division | division I of your tier | division I of the next tier (Diamond → Master) |
| Master | Master | Grandmaster |
| Grandmaster | Grandmaster | Challenger |
| Challenger | Challenger | none |
| Unranked in Solo/Duo | nothing is downloaded; the status says so | |

Riot calls: League-V4 `entries/RANKED_SOLO_5x5/{tier}/{division}?page=N`
(~205 players per page) and, for apex tiers,
`{master|grandmaster|challenger}leagues/by-queue/RANKED_SOLO_5x5`. Check that
entries carry `puuid`; if they don't, a Summoner-V4 lookup per player is
needed.

### Which players ("best on that champion")

For each group and each of the 3 champions: the 5 players with the **most
mastery points on that champion** among players in that division who **played
it in the last 3 months** (mastery `lastPlayTime`). You are never picked.

- One call per player covers all 3 champions: Champion-Mastery-V4
  `champion-masteries/by-puuid/{puuid}` (all champions). Mastery uses numeric
  champion keys; map Match-V5 names to them through
  `dataDragon.getChampionList()` (case-insensitive, as `liveGame.findChampion`
  does: Match-V5 says "FiddleSticks").
- Scan the division list page by page until every champion has 5 candidates
  or 3 pages have been scanned. Fewer than 5 found → use those, and the
  status says so ("found 3 of 5 Gold I Yorick players").
- **Re-checking who is best:** the division list is fetched again at most once
  a day; a player's mastery is looked up again only after 7 days. So a daily
  re-check costs a few list calls plus mastery for new arrivals, not the full
  scan again. The 5 picks are recomputed from that each run.

### Which games

For each picked player: their Solo/Duo match ids since 3 months ago
(Match-V5 `ids?queue=420&startTime=…`, newest first; `getMatchIds` takes ms and
converts). Walk the ids newest first:

1. Already stored, or already known to be on another champion → skip, no call.
2. Otherwise fetch the match (one call). Riot can't filter the id list by
   champion, so this check can't be avoided. If the player wasn't on that
   champion, or it was a remake, record "skip" for (matchId, puuid) and move
   on.
3. If they were: fetch the timeline (second call) and store the game.

Stop at 5 stored games for that player or when the ids run out. A per-player
cap on step-2 checks (e.g. 15) keeps a player who mostly plays other champions
from costing too much. Keep the ids list in memory for the run.

### Cost (development key: 100 calls / 2 min)

- First run: up to ~600 mastery calls (2 groups × up to 3 pages) plus ~300–450
  game calls → **roughly 15–25 minutes in the background**.
- Later runs: a few list calls, mastery for new arrivals, one id-list call per
  picked player, and only new games → **a few minutes a day at most**.

These are estimates; the caps (pages, checks per player) are constants so they
can be tuned after the first real run.

### Storage

Separate tables, created on first use like `liveGameStore.js` does, never
joined into `matches`:

- `sample_games`: `matchId` (PK), `gameCreation`, `gameDuration`, `patch`,
  `rawJson` and `timelineJson` (gzipped BLOBs, via `compression.js`, so the
  derived values can be recomputed when a rule changes without downloading
  again), `winFeatures` (see the curve section).
- `sample_rows`: one row per (matchId, puuid) that was downloaded for a pick:
  `championName`, `teamId`, `teamPosition`, `win`, `group` tier + division at
  download time, `itemPurchases` (same format as `matches.itemPurchases`),
  `primaryRune`, `secondaryRuneStyle`.
- `sample_skips`: (matchId, puuid) known to be on another champion or a remake.
- `sample_players`: puuid, tier, division, list page, mastery per champion,
  `checkedAt`.

A game counts in the group whose tier + division it was downloaded for, and
only while that is still one of your two current groups. After you climb,
games from groups you've left are ignored and expire.

**Retention:** every run (and once at startup, switch on or off) deletes
sample games, rows and skips with `gameCreation` older than 3 months, and
player rows not checked for 3 months.

## The win-chance curve (fitted)

Only with the switch on. Off = the hand-tuned curve, unchanged.

- **Inputs per timeline frame, from one team's side:** gold, XP and kill
  differences, towers and inhibitors destroyed, dragons taken, dragon soul,
  Baron and Elder buffs active, and the game minute. The exact shape (e.g.
  coefficients per game phase) is the builder's choice.
- **Symmetric:** the two teams' chances always add up to 100%; no blue/red
  side term.
- **Fitted** by logistic regression in plain JS (no new dependency) on every
  stored timeline frame with a known result: your games plus sample games.
  ~750 games × ~30 frames fits in well under a second.
- **Checked before use** on games held out of the fit: it beats the
  hand-tuned curve on log loss, no 10% band with enough frames is more than
  10 points from the actual win rate, and its worst band is no worse than the
  hand-tuned curve's. (Was 5 points; changed during the build: on 598 real
  games the fitted curve was 0–7 points off with 125 games held out, the
  hand-tuned one up to 19, so 5 points would have kept the worse curve.)
  If any of these fails, or there are
  fewer than 300 games, the hand-tuned curve stays in use and the Settings
  status says so.
- **Refit** after 25 new games (yours + samples) or after a week, whichever
  comes first. Coefficients are saved in config (`winModel`, with the date
  and game count).
- **Features stored, not recomputed from blobs:** a new computed column
  `winFeatures` on `matches` (written by `computeAdvancedStatsForMatch`,
  reset when a timeline arrives later) and on `sample_games`, one entry per
  frame from team 100's side, with the game's result for team 100. Older
  games are backfilled (NULL marker, like the other computed columns) only
  while the switch is on. Refits never read JSON blobs (the "Lazy JSON
  Loading" rule).
- **One curve for the whole app while on:** stored per-game win chance
  (`winChanceFit`, recomputed from `winFeatures` when the model changes), the
  timeline chart, the game report's blunders, item tooltips, Chat's win-chance
  tools. One helper decides which curve a surface reads, so no surface
  branches on the setting by itself.

## The item and rune numbers (switch on)

### Item: won vs expected

For each game with the purchase: result (1 win / 0 loss) minus the fitted win
chance at the moment of purchase (`chanceAt`, linear between frames), in
points. The number is the average over games. Which purchase counts is
unchanged: the opening shop's first purchase, otherwise that item's first
purchase after the opening shop, once per game.

**Luck margin:** 1.96 × √(Σ p·(1−p)) / n, where p is each game's pre-purchase
chance. Shown as "+4 ± 7". Rules:

- Under 5 games: "–", as today (`LOW_SAMPLE`).
- If the margin includes 0: the number is shown muted, never green or red.
- **"Better than" only beyond the margin:** one option is called better than
  another only when the gap exceeds √(m₁² + m₂²).

The name stays **WPA**; the explanatory notes change to say what it measures
now ("how much more often games with this purchase were won than the game
state at the purchase predicted").

The single-game tooltip ("Win chance 46% → 58% (+12) until your next trip to
the shop") stays as it is, read from the fitted curve while on.

### Rune page: won vs the champion's usual

Rune pages are chosen before the game, so there is no pre-choice game state.
Number = win rate with that page (keystone + secondary tree, as the Champions
page groups them) minus the champion's win rate over the same games, with a
binomial luck margin and the same muted / "better than" rules. It can't
account for which players pick which page; the note says so.

### Which games feed them

For a champion: your games on it (with the page's current filters) plus the
sample games on it, both groups together. Sample games follow the period and
role filters too (they carry `patch`, `gameCreation`, `teamPosition`). The
label says what went in: "From 412 games: yours 214 · Silver I 25 · Gold I 18".

## Where it shows (switch on)

### Champions page

- **Build order card:** the last number is the new WPA with its margin in the
  row tooltip; muted within the margin; the note under the title explains it.
- **Rune pages table:** a WPA column.
- The label above says which games went in. Everything else on the page
  (champion table, matchups, Core items) stays your games only.

### Live page, Next item card

`nextItem.championGames` takes your games plus sample games on the champion;
`nextItemOptions` keeps its "same finished items" matching and fallback, but
ranks by the new WPA. An option is marked as the pick only if it beats the
next one beyond the margin; otherwise the card says the top options are too
close to call.

### Coaching, Game Report tab

A **Build and runes** section for the game shown (Solo/Duo, like the page):

- Each finished item you bought: purchase time vs your usual time for it on
  that champion, and its WPA with margin.
- Your rune page and its number.
- **Compared with each group** (your level, level above), separately: their
  most common 1st / 2nd / 3rd item and keystone on that champion, with how
  often they pick it, next to yours.
- At most one "better option" line, only beyond the margin.
- Champion without sample games: one line explaining that sample games are
  downloaded for your top 3 champions.

### Chat

- `get_item_stats` (and `get_game_detail`'s items) return the new WPA and its
  margin while on. A new option, `pool`: `all` (default) · `mine` · `level` ·
  `above`, so "what do Gold I Yorick players build?" works. The result names
  the actual tiers. Rune pages come back in `get_item_stats` too, so no new
  tool is added.
- Sample games join an answer only when a champion filter names a champion
  that has sample games and the queue filter includes Solo/Duo; otherwise the
  answer is your games only, as today (mixing 3 champions' samples into an
  all-champion answer would skew it).
- The system prompt says numbers within the margin are not evidence for or
  against an option.
- With the switch off the tool schemas are exactly today's. Keep additions
  short: `test/chatTools.test.js` fails above 14,000 characters.

## Testing

`npm test` (Node runner), pure modules tested like the rest of `services/`:

- Champion pick (top 3, last 2 patches, ties, remakes, fewer than 3).
- Groups for every tier, apex tiers, Challenger, unranked.
- Picking the best players (mastery, 3-month window, you excluded, fewer
  than 5, page scanning stop rule, 7-day mastery cache).
- The downloader with a fake API and store (pattern: `liveGameLoader` tests):
  one call per checked game, timeline only on a match, skips remembered,
  5-game stop, per-player cap, pause on sync/live, stop on 401/403.
- Retention prune.
- Curve: fitting recovers known coefficients on synthetic frames; symmetry;
  the held-out check; fallback below 300 games or on a failed check.
- WPA "won vs expected", margin, muted rule, "better than" rule; rune number.
- Switch off: tool schemas unchanged; the curve helper returns the hand-tuned
  curve; no download runs.

UI files that need Electron (Settings, Champions, Coaching, Live) are checked
by hand, with the switch on and off.

## Stages

Each stage ends with tests passing and CLAUDE.md updated, and is usable on its
own.

1. **Download and storage:** Settings switch and status, champion/group/player
   selection, downloader, tables, retention. Nothing displayed yet beyond the
   status line.
2. **Curve and numbers:** `winFeatures` column + backfill, fitting and checks,
   the curve helper, WPA "won vs expected", margins, rune numbers.
3. **Showing it:** Champions page, Next item card, Coaching "Build and
   runes", Chat.

## Calls made in the conversation, not by the user

Please check these while reading:

- "Best" = most mastery points on the champion among players who played it in
  the last 3 months.
- "Their 5 games" = their 5 latest Solo/Duo games on that champion within
  3 months.
- Who is best is re-checked via a daily list fetch and a 7-day mastery cache,
  not a full scan on every sync (cost).
- Downloads run after each sync in the background, pause for your sync and
  live games, and start right after the switch is turned on.
- Turning the switch off keeps stored sample games hidden until they expire.
- The fitted curve, while on, replaces the hand-tuned one everywhere in the
  app.
- Item numbers blend both groups; comparisons show the groups separately.
- The name stays "WPA"; the single-game tooltip stays as it is.
- Unranked in Solo/Duo → no downloads.
- Sample games follow the Champions page's period and role filters.

## Left to the builder

- The curve's exact feature shape and fitting method, within the
  requirements above.
- Constants: pages scanned, checks per player, refit thresholds.
- Table and column details beyond those named, and the UI's exact wording and
  layout, following `polish.css` ("Pages" and panels) and the existing
  Champions/Coaching components.
