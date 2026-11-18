# Matchups card: include other players' games — design (short)

**Date:** 2026-11-18 · **Size:** small change · **Approved in conversation**

## Intent

On the Champions page, the Matchups card ("vs your lane opponent") shows only
your games. The app already downloads sample games (other players on this
champion, at your rank and one rank up). The owner wants a switch that adds
those games to the matchup numbers.

## Approaches considered

- **A. Combined (picked by the owner):** the switch turns each row into your
  games plus theirs, one set of numbers.
- **B. Side by side:** extra "Others" columns next to yours. Not picked.
- Build: one sensible way, the same pool the Rune pages and Build order
  cards use (`samplePool.championPool`), fed to `championDetail`.

## Design

- **Switch** in the Matchups card header: "Include other players' games".
  Shown only while the sample-games setting is on and this champion has
  sample games in the current pool. Off by default; remembered in
  localStorage (`nexus.matchupsSamples`).
- **On:** every matchup row (games, W–L, win rate, KDA, GD@15, CSD@15) and its
  expanded items/keystones are computed over the pool: your games + current
  two groups' sample rows, same role chip and period filter. Opponents only
  others faced get rows too. The unmatched-games note counts the pool.
- **Telling them apart (builder's call, stated to the owner):** W–L tooltip
  "Yours 7–6 · others 2–1"; the card subtitle says how many games are other
  players'; "Items you built" becomes "Items built".
- **Off, or sample games disabled:** the card is unchanged.
- `championDetail` matchup rows gain `sampleGames` / `sampleWins` (rows marked
  `sample` by `championPool`); tested.

## Non-goals

- Downloading more sample games (most matchups gain only 0–3 games today:
  54 Yorick samples over 32 opponents).
- Side-by-side comparison columns.
