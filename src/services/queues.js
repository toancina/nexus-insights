/**
 * queues.js — the queues the app syncs and counts.
 *
 * Ranked Solo, Ranked Flex, Ranked Premade, Normal Draft, Blind, Swiftplay,
 * Quickplay and Clash. 710 is the 5-stack ranked queue (League-V4
 * RANKED_PREMADE_5x5, its own LP); Riot's queues.json doesn't list it, so
 * check real games when adding a queue. Shared by sync, getMatches and the
 * migration that removed games from other queues (#68).
 */
const ALLOWED_QUEUES = new Set([420, 440, 710, 400, 430, 480, 490, 700]);

module.exports = { ALLOWED_QUEUES };
