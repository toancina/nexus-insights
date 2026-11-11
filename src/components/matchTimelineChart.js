/**
 * matchTimelineChart.js — the timeline chart in an expanded match row (#3).
 *
 * Win chance, gold lead or XP lead over the game, from one player's side,
 * with markers for kills, epic monsters and structures. Clicking a player in
 * the 10-player table below views the game from their side instead.
 *
 * The numbers come from services/matchTimeline.js (pure, tested); this file
 * only draws them on a Canvas, like statHistory.js.
 */

const T = require('../services/matchTimeline');
const winCurve = require('../services/winCurve');
const { escapeHtml } = require('./dom');

const METRICS = {
    win:  { label: 'Win chance', value: p => p.winProb * 100 },
    gold: { label: 'Gold lead',  value: p => p.goldDiff },
    xp:   { label: 'XP lead',    value: p => p.xpDiff },
};
const TOGGLES = [
    ['mine',       'Kills & deaths'],
    ['kills',      'All kills'],
    ['objectives', 'Objectives'],
    ['structures', 'Structures'],
];

// Metric + toggles survive collapsing a row and opening another (and restarts)
const PREFS_KEY = 'nexus.timelinePrefs';
let prefs = { metric: 'win', show: { mine: true, kills: false, objectives: true, structures: false } };
try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (saved && METRICS[saved.metric]) prefs = { metric: saved.metric, show: { ...prefs.show, ...saved.show } };
} catch { /* storage unavailable: defaults */ }
function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* not important */ }
}

const states = new WeakMap();      // host element → chart state
const liveHosts = new Set();       // for redrawing on window resize

// ---------------------------------------------------------------------------
// Colours: read from the theme at draw time so skins apply
// ---------------------------------------------------------------------------
function cssVar(name, fallback) {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    } catch { return fallback; }
}
function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function colors() {
    return {
        accent: cssVar('--accent-primary', '#00cfbc'),
        good:   cssVar('--success', '#22c55e'),
        bad:    cssVar('--error', '#ef4444'),
    };
}

function formatValue(metric, v) {
    if (metric === 'win') return `${Math.round(v)}%`;
    const sign = v > 0 ? '+' : v < 0 ? '−' : '';
    const a = Math.abs(v);
    return sign + (a >= 1000 ? `${(a / 1000).toFixed(1)}k` : String(Math.round(a)));
}

/** Round, evenly spaced ticks covering [lo, hi]. */
function ticks(lo, hi, count = 4) {
    const raw = (hi - lo) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
    return out;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const PAD = { top: 26, right: 16, bottom: 24, left: 48 };

function marker(ctx, m, x, y, c) {
    const fill = m.style === 'my-death' || m.style === 'enemy' ? c.bad : c.good;
    const big = m.style === 'my-kill' || m.style === 'my-death';
    const r = big ? 4.5 : 3.5;
    ctx.fillStyle = big ? fill : rgba(fill, 0.75);
    ctx.beginPath();
    if (m.kind === 'objective') {            // diamond
        ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y); ctx.lineTo(x, y + r + 1); ctx.lineTo(x - r - 1, y);
        ctx.closePath();
    } else if (m.kind === 'structure') {     // square
        ctx.rect(x - r, y - r, r * 2, r * 2);
    } else {
        ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    if (big) { ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1; ctx.stroke(); }
}

/**
 * The match table scrolls sideways and is much wider than the window; an
 * expanded row is as wide as the table. Keep the chart to the visible width
 * so the end of the game isn't off-screen.
 */
function fitWidth(host) {
    const scroller = host.closest('.match-table-container');
    if (!scroller || !host.parentElement) return;
    const cs = getComputedStyle(host.parentElement);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    host.style.width = `${Math.max(480, scroller.clientWidth - pad)}px`;
}

function draw(state) {
    fitWidth(state.host);
    const { canvas, series, metric, hover } = state;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    const cW = W - PAD.left - PAD.right, cH = H - PAD.top - PAD.bottom;
    const c = colors();
    ctx.clearRect(0, 0, W, H);

    const value = METRICS[metric].value;
    const vals = series.map(value);
    let lo, hi, base;
    if (metric === 'win') { lo = 0; hi = 100; base = 50; }
    else {
        const m = Math.max(1000, ...vals.map(Math.abs)) * 1.15;
        lo = -m; hi = m; base = 0;
    }
    const tEnd = series[series.length - 1].t || 1;
    const xOf = t => PAD.left + (t / tEnd) * cW;
    const yOf = v => PAD.top + cH - ((v - lo) / (hi - lo)) * cH;
    state.geo = { xOf, plotLeft: PAD.left, plotRight: PAD.left + cW, tEnd };

    // grid + y labels
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    const yTicks = metric === 'win' ? [0, 25, 50, 75, 100] : ticks(lo, hi, 4);
    for (const v of yTicks) {
        const y = yOf(v);
        ctx.strokeStyle = v === base ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.06)';
        ctx.setLineDash(v === base ? [4, 4] : []);
        ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText(formatValue(metric, v), PAD.left - 8, y + 3.5);
    }
    ctx.setLineDash([]);

    // x labels every 5 minutes
    ctx.textAlign = 'center';
    for (let m = 0; m * 60000 <= tEnd; m += 5) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText(`${m}m`, xOf(m * 60000), H - 7);
    }

    // area: green where your side leads, red where it trails
    const pts = series.map((p, i) => [xOf(p.t), yOf(vals[i])]);
    const yBase = yOf(base);
    for (const [above, col] of [[true, c.good], [false, c.bad]]) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(PAD.left, above ? PAD.top : yBase, cW, above ? yBase - PAD.top : PAD.top + cH - yBase);
        ctx.clip();
        ctx.beginPath();
        ctx.moveTo(pts[0][0], yBase);
        pts.forEach(([x, y]) => ctx.lineTo(x, y));
        ctx.lineTo(pts[pts.length - 1][0], yBase);
        ctx.closePath();
        ctx.fillStyle = rgba(col, 0.16);
        ctx.fill();
        ctx.restore();
    }

    // event lines + markers in the lane above the plot
    for (const m of state.markers) {
        const x = xOf(m.t);
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + cH); ctx.stroke();
    }
    for (const m of state.markers) marker(ctx, m, xOf(m.t), PAD.top - 12, c);

    // the line
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.lineWidth = 1;

    // hover crosshair
    if (hover !== null && pts[hover]) {
        const [x, y] = pts[hover];
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + cH); ctx.stroke();
        ctx.fillStyle = c.accent;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.stroke();
    }
}

// ---------------------------------------------------------------------------
// Hover tooltip: the minute's values and what happened in it
// ---------------------------------------------------------------------------
const GLYPH = { kill: '●', objective: '◆', structure: '■' };

function showTip(state) {
    const { tip, series, hover } = state;
    if (hover === null) { tip.classList.remove('visible'); return; }
    const p = series[hover];
    const from = hover > 0 ? series[hover - 1].t : -1;
    const happened = state.markers.filter(m => m.t > from && m.t <= p.t);

    const row = (k) => `<div class="mt-tip-row${k === state.metric ? ' is-main' : ''}">
        <span>${METRICS[k].label}</span><b>${formatValue(k, METRICS[k].value(p))}</b></div>`;
    tip.innerHTML =
        `<div class="mt-tip-time">${T.formatClock(p.t)}</div>` +
        ['win', 'gold', 'xp'].map(row).join('') +
        (happened.length ? `<div class="mt-tip-events">${happened.map(m =>
            `<div class="mt-ev mt-ev--${m.style}"><span>${GLYPH[m.kind]}</span> ${T.formatClock(m.t)} ${escapeHtml(m.label)}</div>`
        ).join('')}</div>` : '');

    const x = state.geo.xOf(p.t);
    const flip = x > state.geo.plotRight - 180;
    tip.style.left = `${flip ? x - 12 : x + 12}px`;
    tip.style.transform = flip ? 'translateX(-100%)' : '';
    tip.classList.add('visible');
}

function onMove(state, e) {
    const rect = state.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const g = state.geo;
    if (!g || x < g.plotLeft - 6 || x > g.plotRight + 6) return onLeave(state);
    const t = ((x - g.plotLeft) / (g.plotRight - g.plotLeft)) * g.tEnd;
    let best = 0;
    state.series.forEach((p, i) => { if (Math.abs(p.t - t) < Math.abs(state.series[best].t - t)) best = i; });
    if (best === state.hover) return;
    state.hover = best;
    draw(state);
    showTip(state);
}

function onLeave(state) {
    if (state.hover === null) return;
    state.hover = null;
    draw(state);
    showTip(state);
}

// ---------------------------------------------------------------------------
// Rendering + state
// ---------------------------------------------------------------------------
function refresh(state) {
    const v = state.viewer;
    state.series = winCurve.seriesFor(state.raw, state.timeline, v.teamId);
    state.markers = T.visibleMarkers(state.events, { participantId: v.participantId, teamId: v.teamId, show: prefs.show });
    state.metric = prefs.metric;
    state.hover = null;

    const host = state.host;
    host.querySelector('.mt-viewer').innerHTML =
        `viewing as <b>${escapeHtml(v.championName)}</b>${v.isYou ? ' (you)' : ''}`;
    host.querySelectorAll('[data-mt-metric]').forEach(b =>
        b.classList.toggle('active', b.dataset.mtMetric === prefs.metric));
    host.querySelectorAll('[data-mt-toggle]').forEach(b =>
        b.classList.toggle('active', !!prefs.show[b.dataset.mtToggle]));
    const mineLabel = host.querySelector('[data-mt-toggle="mine"] .mt-chip-label');
    if (mineLabel) mineLabel.textContent = `${v.isYou ? 'Your' : `${v.championName}'s`} kills & deaths`;

    // highlight the viewed player's row in the table below
    const expanded = host.closest('.expanded-row');
    if (expanded) {
        expanded.querySelectorAll('tr[data-pid]').forEach(tr =>
            tr.classList.toggle('mt-viewing', Number(tr.dataset.pid) === v.participantId));
    }
    draw(state);
    showTip(state);
}

/**
 * Draw the timeline into `host` (inside an expanded row) for a full match row
 * (rawJson + timelineJson parsed, as getMatchById returns it).
 */
function renderMatchTimeline(host, match) {
    if (!host || !match) return;
    const raw = typeof match.rawJson === 'string' ? JSON.parse(match.rawJson) : match.rawJson;
    const timeline = typeof match.timelineJson === 'string' ? JSON.parse(match.timelineJson) : match.timelineJson;
    const roster = T.rosterOf(raw);
    const youId = Number(Object.keys(roster).find(id =>
        roster[id].championName === match.championName && roster[id].teamId === match.teamId));

    if (!timeline || !youId || winCurve.seriesFor(raw, timeline, match.teamId).length < 2) {
        host.innerHTML = '<div class="mt-empty">No timeline stored for this game.</div>';
        return;
    }

    host.innerHTML = `
        <div class="mt-header">
            <div class="mt-title">Game timeline <span class="mt-viewer"></span></div>
            <div class="mt-metrics">${Object.entries(METRICS).map(([k, m]) =>
                `<button type="button" class="mt-metric" data-mt-metric="${k}">${m.label}</button>`).join('')}</div>
        </div>
        <div class="mt-chart"><canvas class="mt-canvas"></canvas><div class="mt-tip"></div></div>
        <div class="mt-footer">
            <div class="mt-chips">${TOGGLES.map(([k, label]) =>
                `<button type="button" class="mt-chip mt-chip--${k}" data-mt-toggle="${k}"><span class="mt-chip-dot"></span><span class="mt-chip-label">${label}</span></button>`).join('')}</div>
            <div class="mt-note">Win chance is an estimate from team gold, XP and kills. Click a player below to see the game from their side.</div>
        </div>`;

    const state = {
        host, raw, timeline,
        canvas: host.querySelector('.mt-canvas'),
        tip: host.querySelector('.mt-tip'),
        events: T.timelineEvents(raw, timeline),
        viewer: { participantId: youId, teamId: match.teamId, championName: match.championName, isYou: true },
    };
    states.set(host, state);
    liveHosts.add(host);

    host.addEventListener('click', (e) => {
        const metric = e.target.closest('[data-mt-metric]');
        const toggle = e.target.closest('[data-mt-toggle]');
        if (metric) prefs.metric = metric.dataset.mtMetric;
        else if (toggle) prefs.show[toggle.dataset.mtToggle] = !prefs.show[toggle.dataset.mtToggle];
        else return;
        e.stopPropagation();
        savePrefs();
        refresh(state);
    });
    state.canvas.addEventListener('mousemove', e => onMove(state, e));
    state.canvas.addEventListener('mouseleave', () => onLeave(state));

    // Click a player row → view the game from their side
    const expanded = host.closest('.expanded-row');
    if (expanded) {
        expanded.addEventListener('click', (e) => {
            const tr = e.target.closest('tr[data-pid]');
            if (!tr) return;
            const pid = Number(tr.dataset.pid);
            const r = roster[pid];
            if (!r || pid === state.viewer.participantId) return;
            state.viewer = { participantId: pid, teamId: r.teamId, championName: r.championName, isYou: pid === youId };
            refresh(state);
        });
    }

    refresh(state);
}

window.addEventListener('resize', () => {
    for (const host of [...liveHosts]) {
        if (!host.isConnected) { liveHosts.delete(host); continue; }
        const s = states.get(host);
        if (s) draw(s);
    }
});

window.renderMatchTimeline = renderMatchTimeline;

module.exports = { renderMatchTimeline, fitWidth };
