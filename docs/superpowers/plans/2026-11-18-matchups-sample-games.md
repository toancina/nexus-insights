# Matchups: include other players' games — Implementation Plan

> Executed inline in the main session (owner's standing rule: no subagents, no per-task reviews).

**Goal:** A switch on the Champions page's Matchups card that adds sample games (other players on this champion) to the matchup numbers.

**Architecture:** The page already builds a pool of your games + sample rows (`samplePool.championPool`) for Rune pages and Build order. With the switch on, the Matchups card runs `championDetail` over that pool instead of your games; `championDetail` marks how many of each matchup's games are samples.

**Tech Stack:** vanilla JS, Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-18-matchups-sample-games-design.md`

## Global Constraints

- Off by default; localStorage key `nexus.matchupsSamples`; every read/write in try/catch.
- Sample games disabled, or none for this champion → the card is unchanged and the switch is hidden.
- Pool = `championPool` with the same role chip, period and current groups as Rune pages / Build order.
- External strings through `escapeHtml`.

## Review Focus

- Switch remembered on, then sample games turned off in Settings → card is exactly today's.
- Champion with no sample games → no switch; numbers are yours.
- Role chip / period change while on → the pool follows them.
- Open matchup that vanishes when switching off → nothing open, no error.
- localStorage unavailable → switch works for the session, defaults off.

---

### Task 1: sample counts per matchup

**Files:** Modify `src/services/championStats.js` (`championDetail`); Test `test/championStats.test.js`

**Produces:** each `championDetail(...).matchups[i]` gains `sampleGames: number`, `sampleWins: number` (rows with a truthy `sample` field). `0` when none.

- [ ] Test `detail: matchups count other players' games (sample rows)`: games Syndra ×3 (one with `sample: 'level'`, win 1; one `sample: 'above'`, win 0; one yours) and Zed ×1 yours → Syndra `games 3, sampleGames 2, sampleWins 1`; Zed `sampleGames 0, sampleWins 0`.
- [ ] Run `node --test test/championStats.test.js` → FAIL (undefined).
- [ ] Add the two counts in the matchup map.
- [ ] Run → PASS; commit.

### Task 2: the switch on the card

**Files:** Modify `src/components/championsPanel.js` (`renderMatchups`, `renderDetail`, `wire`), `src/styles/polish.css` (card header row), `CLAUDE.md` (Champions / Where sample games show).

**Consumes:** `samplePool(matches, champion, role)` (returns `{ games, counts }` or null), Task 1's counts.

- [ ] `renderMatchups(d, { pool, on })`: header row `.ch-card-head` = title + `label.coach-switch` (checkbox `data-matchup-samples`) shown when `pool && pool.counts.level + pool.counts.above > 0`. Subtitle when on: "vs the lane opponent · N of M games are other players' · click a row for builds". W–L cell `title="Yours a–b · others c–d"` when `sampleGames > 0`. "Items you built" → "Items built" when on.
- [ ] `renderDetail`: when on and the switch is shown, `dm = championDetail(pool.games, …)` feeds `renderMatchups` (matchups + unmatched); otherwise `d`.
- [ ] `wire`: a `change` listener on `[data-matchup-samples]` saves the state and re-renders.
- [ ] Manual check in the app: switch hidden with sample games off; on Yorick, toggling adds Gangplank/Teemo rows and changes Darius's count by 3.
- [ ] `npm test` passes; CLAUDE.md line; commit.
