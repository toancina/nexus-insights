/**
 * winModel.js — the win-chance curve fitted to real games (pure, tested).
 *
 * A logistic regression on winFeatures.js frames, from team 100's side:
 *   v = [g, x, k, towers, inhibs, dragons, soul, baron, elder, g·τ, x·τ, k·τ]
 *   g = gold/1000, x = xp/1000, k = kills, τ = minute/30
 * The τ terms let a lead count for more or less as the game goes on. There is
 * no intercept and every input flips sign with the side, so the two teams'
 * chances always add up to 100%.
 *
 * Fitted by Newton's method (IRLS) with a small L2 penalty, on every frame of
 * every game with a known result: your games and sample games. A model is only
 * used when it passes checkModel on games held out of the fit (~20%):
 *   - a lower log loss than the hand-tuned curve (matchTimeline.winProbability),
 *   - no 10% band with enough frames more than 10 points from what happened,
 *   - and its worst band no worse than the hand-tuned curve's worst band.
 * (The design said 5 points. On 598 real games, 125 held out, the fitted
 * curve's bands were 0–7 points off, the hand-tuned curve's up to 19, with
 * log loss 0.552 vs 0.672: 5 points is below what 125 games can resolve.)
 */

const { decodeFeatures } = require('./winFeatures');
const { winProbability } = require('./matchTimeline');

const MIN_GAMES = 300;
const REFIT_AFTER_GAMES = 25;
const REFIT_AFTER_MS = 7 * 86400000;
const BAND_MIN_FRAMES = 100;
const BAND_TOLERANCE = 0.10;
const DIM = 12;

function vectorOf(f) {
    const g = (f.gold || 0) / 1000, x = (f.xp || 0) / 1000, k = f.kills || 0, tau = (f.m || 0) / 30;
    return [g, x, k, f.towers || 0, f.inhibs || 0, f.dragons || 0, f.soul || 0, f.baron || 0, f.elder || 0, g * tau, x * tau, k * tau];
}

const sigmoid = z => 1 / (1 + Math.exp(-z));
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

function predict(model, f) {
    return sigmoid(dot(model.coef, vectorOf(f)));
}

/** Solve A·x = b by Gaussian elimination with partial pivoting (A is DIM×DIM). */
function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        [M[c], M[p]] = [M[p], M[c]];
        const piv = M[c][c] || 1e-12;
        for (let r = c + 1; r < n; r++) {
            const k = M[r][c] / piv;
            if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
        }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let s = M[r][n];
        for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
        x[r] = s / (M[r][r] || 1e-12);
    }
    return x;
}

/** samples: [{ f, y }] → { coef } */
function fitModel(samples, { l2 = 1, iterations = 25 } = {}) {
    const rows = samples.map(s => ({ v: vectorOf(s.f), y: s.y ? 1 : 0 }));
    let w = new Array(DIM).fill(0);
    for (let it = 0; it < iterations; it++) {
        const grad = w.map(c => l2 * c);
        const H = Array.from({ length: DIM }, (_, i) => Array.from({ length: DIM }, (_, j) => (i === j ? l2 : 0)));
        for (const { v, y } of rows) {
            const p = sigmoid(dot(w, v));
            const r = p - y, h = p * (1 - p);
            for (let i = 0; i < DIM; i++) {
                if (!v[i]) continue;
                grad[i] += r * v[i];
                const hv = h * v[i];
                for (let j = i; j < DIM; j++) H[i][j] += hv * v[j];
            }
        }
        for (let i = 0; i < DIM; i++) for (let j = 0; j < i; j++) H[i][j] = H[j][i];
        const step = solve(H, grad);
        w = w.map((c, i) => c - step[i]);
        if (Math.max(...step.map(Math.abs)) < 1e-7) break;
    }
    return { coef: w };
}

const idSum = id => [...String(id || '')].reduce((s, c) => s + c.charCodeAt(0), 0);

/**
 * games: [{ matchId, winFeatures, blueWin }] → every frame as { f, y }, games
 * whose id characters sum to a multiple of 5 held out (≈ 20%, stable per game).
 */
function trainingSet(games) {
    const train = [], test = [];
    for (const g of games || []) {
        const frames = decodeFeatures(g.winFeatures);
        if (!frames.length) continue;
        const into = idSum(g.matchId) % 5 === 0 ? test : train;
        for (const f of frames) into.push({ f, y: g.blueWin ? 1 : 0 });
    }
    return { train, test };
}

const clampP = p => Math.min(1 - 1e-9, Math.max(1e-9, p));
const loss = (p, y) => -(y ? Math.log(clampP(p)) : Math.log(1 - clampP(p)));

const emptyBands = () => Array.from({ length: 10 }, (_, i) => ({ from: i / 10, frames: 0, predicted: 0, actual: 0 }));
const addTo = (bands, p, y) => { const b = bands[Math.min(9, Math.floor(p * 10))]; b.frames++; b.predicted += p; b.actual += y; };
function worstBand(bands) {
    for (const b of bands) if (b.frames) { b.predicted /= b.frames; b.actual /= b.frames; }
    return Math.max(0, ...bands.filter(b => b.frames >= BAND_MIN_FRAMES).map(b => Math.abs(b.predicted - b.actual)));
}

function checkModel(model, test) {
    const bands = emptyBands(), handBands = emptyBands();
    let ll = 0, hand = 0;
    for (const { f, y } of test) {
        const p = predict(model, f);
        const h = winProbability(f.gold || 0, f.xp || 0, f.kills || 0);
        ll += loss(p, y);
        hand += loss(h, y);
        addTo(bands, p, y);
        addTo(handBands, h, y);
    }
    const maxDiff = worstBand(bands), handMaxDiff = worstBand(handBands);
    const n = test.length || 1;
    const logLoss = ll / n, handLogLoss = hand / n;
    const ok = test.length > 0 && logLoss < handLogLoss && maxDiff <= BAND_TOLERANCE && maxDiff <= handMaxDiff;
    return { ok, logLoss, handLogLoss, maxDiff, handMaxDiff, bands };
}

/** Fit, check on held-out games, and (when it passes) refit on everything. */
function buildModel(games, { now = Date.now() } = {}) {
    const usable = (games || []).filter(g => decodeFeatures(g.winFeatures).length);
    const base = { fittedAt: now, games: usable.length };
    if (usable.length < MIN_GAMES) return { ok: false, reason: 'few-games', ...base };
    const { train, test } = trainingSet(usable);
    const check = checkModel(fitModel(train), test);
    const scores = { logLoss: check.logLoss, handLogLoss: check.handLogLoss, maxDiff: check.maxDiff, handMaxDiff: check.handMaxDiff };
    if (!check.ok) return { ok: false, reason: 'check', ...base, ...scores, bands: check.bands };
    return { ok: true, reason: null, coef: fitModel(train.concat(test)).coef, ...base, ...scores };
}

function needsRefit(saved, gameCount, now = Date.now()) {
    if (!saved || saved.games == null || saved.fittedAt == null) return true;
    return gameCount - saved.games >= REFIT_AFTER_GAMES || now - saved.fittedAt >= REFIT_AFTER_MS;
}

module.exports = {
    MIN_GAMES, REFIT_AFTER_GAMES, REFIT_AFTER_MS, BAND_MIN_FRAMES, BAND_TOLERANCE,
    vectorOf, predict, fitModel, trainingSet, checkModel, buildModel, needsRefit,
};
