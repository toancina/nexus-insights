# Chat: compare your stats with other players' — design (short)

**Date:** 2026-11-18 · **Size:** small change · **Approved in conversation** (option B)

## Intent

Chat could only see other players' items and runes. The owner wants it to
compare how they play a champion with the sample players: everything the app
usually tracks, not just builds.

## Approaches

- A: a `pool` option on get_overview / get_category_stats / get_breakdown /
  get_win_chance_stats. Rejected: a three-way comparison of every area needs
  more calls than the agent's 5 rounds.
- **B (picked):** one tool, `compare_with_players(champion, area = all, role,
  last_n_days, last_n_patches)`: yours vs each sample group, every Analytics
  category (Consistency left out: streaks and spread over several players'
  games mean nothing) plus win-chance patterns, each value with its tier,
  games/players/dates per pool. Only registered while sample games are on.

## Found while building

Sample rows lacked `statsComputedAt`, so the analytics engine recomputed every
timeline stat from blobs they don't have (all 0), also in Coaching. Fixed in
`statsRowFor`; `sampleStore.STATS_VERSION` 2 recomputes stored rows once
(which also moves their impact rank to the new score).
