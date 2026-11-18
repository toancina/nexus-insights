# Live page: Matchup card — design (short)

**Date:** 2026-11-18 · **Size:** small change · **Approved in conversation**

## Intent

In a live game, show how your champion has done against the enemy in your
position, using the same numbers as the Champions page's Matchups card, and
include other players' games when that card's switch is on.

## Approaches

- A Matchup section in the Next item box on your row (picked: no layout change).
- A separate card next to it: rejected, the Live row grid has no room for it.
- Its own switch on Live: rejected by the owner; it follows the Champions switch.

## Design

- Opponent = the enemy (non-bot) player with your Live Client `position`. No
  position (ARAM etc.) or no such player → no section.
- Games = `championPool(yourGames, switchOn && samplesOn ? sampleRows : [],
  yourChampion, { role: yourPosition, groups })`, then
  `championStats.matchupFor(games, opponent, { isCoreItem })`: case-insensitive
  `laneOpponent` match (Match-V5 "FiddleSticks"), same row as the Champions card
  (games, W–L, win rate, KDA, GD@15, CSD@15, items, keystones, sampleGames/Wins).
- Shows: "Matchup vs <icon> Darius", one stats line (W–L tooltip "Yours a–b ·
  others c–d"), source line ("Your games" / "+ N of other players'"), top 5
  items and top 3 keystones with games + win rate. Under 5 games dimmed with a
  note; 0 games → "No games vs X stored yet".
- Only for the configured account (`state.ownGames`), like Next item. Cached
  by champion + position + opponent + sample/switch state.
- No Riot calls, no JSON blobs.
