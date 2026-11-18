# Live Matchup card — Implementation Plan

> Executed inline in the main session (owner's rule: no subagents, no per-task reviews).

**Goal / Architecture / Spec:** see `docs/superpowers/specs/2026-11-18-live-matchup-design.md`.

## Review Focus

- Live Client gives no positions → no section, Next item unchanged.
- Opponent champion spelled differently by Match-V5 (FiddleSticks) → still matches.
- Switch on but sample games off in Settings → your games only.
- Not the configured account → no section.
- Bots on the enemy team → never picked as opponent.

### Task 1: `matchupFor` (pure)
**Files:** `src/services/championStats.js`, `test/championStats.test.js`
**Produces:** `matchupFor(games: Array, opponent: string, { isCoreItem }) → row | null`, row = the Champions matchup row (`opponent, games, wins, losses, winRate, kda, gd15, csd15, sampleGames, sampleWins, items, runes`). Built by `matchupRow(opponent, list, isCoreItem)`, which `championDetail` also uses.
- [ ] Test `matchupFor: case-insensitive opponent, sample counts, null when none` (games vs 'FiddleSticks' found by 'Fiddlesticks'; one sample row → sampleGames 1; 'Zed' → null).
- [ ] Fail → implement → pass → commit.

### Task 2: the section on Live
**Files:** `src/components/liveGamePanel.js`, `src/components/championsPanel.js` (export `matchupSamplesOn()`), `src/styles/app.css`, `CLAUDE.md`
- [ ] `laneOpponentOf(p, players)`, `matchupCard(p, opponent, ownGames)` exported as `_internal`; `nextItemHtml` prepends the cached section.
- [ ] Check in the app: render `matchupCard` for Yorick vs Darius in the Live page via the debugging port, switch off and on.
- [ ] `npm test`; commit.
