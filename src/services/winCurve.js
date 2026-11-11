/**
 * winCurve.js — the one place that decides which win-chance curve the app
 * shows (sample games, 2026-11).
 *
 * Switch off, or no model that passed its check: today's hand-tuned curve
 * (the stored `winChance` column, matchTimeline.teamSeries) and today's
 * window WPA (itemWpa.itemWpa). Switch on with a fitted model (winModel.js):
 * the model's chance from each game's `winFeatures`, and WPA as "won vs
 * expected" (itemWpa.wonVsExpected). Every surface reads through here, so
 * none of them branches on the setting itself.
 *
 * Module state, set by configure() at startup, when the switch changes and
 * after a refit. Per-game points are cached until the next configure().
 */

const { teamSeries, winProbability } = require('./matchTimeline');
const { winChancePoints, itemWpa, wonVsExpected } = require('./itemWpa');
const { decodeFeatures, flipFeatures, frameFeatures } = require('./winFeatures');
const { predict } = require('./winModel');

let state = { enabled: false, model: null };
let cache = new Map();

function configure({ enabled = false, model = null } = {}) {
    state = { enabled: !!enabled, model: model || null };
    cache = new Map();
}

function isFitted() {
    return state.enabled && !!(state.model && state.model.ok && Array.isArray(state.model.coef));
}

const sideOf = (teamId) => (teamId === 200 ? flipFeatures : f => f);
const pct = p => Math.round(p * 100);

/**
 * A game's win chance per frame for its team, [{t, p}] in percent, timed like
 * itemWpa.winChancePoints. `m` is a matches row or a sample row.
 */
function pointsFor(m) {
    if (!m) return [];
    const fitted = isFitted();
    if (!fitted && m.winChance) return winChancePoints(m.winChance, m.gameDuration);
    const key = `${m.matchId}:${m.teamId}:${fitted ? 1 : 0}`;
    if (cache.has(key)) return cache.get(key);
    const frames = decodeFeatures(m.winFeatures).map(sideOf(m.teamId));
    let points;
    if (!frames.length) points = winChancePoints(m.winChance, m.gameDuration);
    else if (fitted) points = winChancePoints(frames.map(f => pct(predict(state.model, f))).join(','), m.gameDuration);
    // A sample row has no stored hand-tuned curve: rebuild it from its features
    else points = winChancePoints(frames.map(f => pct(winProbability(f.gold, f.xp, f.kills))).join(','), m.gameDuration);
    cache.set(key, points);
    return points;
}

/** matchTimeline.teamSeries, with the fitted chance in `winProb` when fitted. */
function seriesFor(raw, timeline, teamId) {
    const series = teamSeries(raw, timeline, teamId);
    if (!isFitted() || !series.length) return series;
    const flip = sideOf(teamId);
    const features = frameFeatures(raw, timeline);
    return series.map((s, i) => (features[i] ? { ...s, winProb: predict(state.model, flip(features[i])) } : s));
}

/** WPA per purchase for aggregates: won vs expected when fitted, else today's window. */
function purchaseWpa(purchases, m) {
    const points = pointsFor(m);
    return isFitted() ? wonVsExpected(purchases, points, m && m.win) : itemWpa(purchases, points);
}

module.exports = { configure, isFitted, pointsFor, seriesFor, purchaseWpa };
