/**
 * statHistory.js — "how has this stat changed?" chart for the analytics cards.
 *
 * Click a stat card (the ones with the green dot) and a panel slides open
 * between the card grid and Time Analytics, showing that stat month by month
 * for the last 12 calendar months, ending with the current one.
 *
 * Each month's value is produced by running the SAME calculator the card uses
 * (window.computeTabStats) over just that month's games. So a month on the
 * chart always means exactly what the card would say if you filtered to that
 * month — no second, subtly different formula to drift out of sync.
 *
 * The matches passed in are the ones the cards are using: current queue and
 * champion filters applied, remakes already excluded.
 */

const { RANK_COLORS } = require('./rankTiers');
const { escapeHtml }  = require('./dom');

const MONTH_COUNT = 12;
/** A month with fewer games than this is drawn faded — 3 games can swing an average a lot. */
const LOW_SAMPLE  = 5;

// Cards with no meaningful monthly trend:
//   count  — Total Matches (only goes up; the calendar shows activity) and the
//            streak cards (a streak doesn't average into a trend)
//   none   — placeholder cards
//   con_last10_wr — "your last 10 games" means nothing per month
const NON_CHARTABLE_AGG = new Set(['count', 'none']);
const NON_CHARTABLE_IDS = new Set(['con_last10_wr']);

/** Tiers from worst to best, matching evaluateBenchmark's thresholds. */
const TIERS_ASC = ['iron', 'bronze', 'silver', 'gold', 'platinum',
                   'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];

// Line colour for stats with no rank benchmark: the skin's accent colour,
// read when drawing so a skin change is picked up on the next draw.
const ACCENT_FALLBACK = '#00cfbc';
function accentColor() {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
        return /^#[0-9a-f]{6}$/i.test(v) ? v : ACCENT_FALLBACK;
    } catch { return ACCENT_FALLBACK; }
}

// ---------------------------------------------------------------------------
// PURE HELPERS (tested in test/statHistory.test.js)
// ---------------------------------------------------------------------------

function isChartable(card) {
    return !!(card && card.id &&
        !NON_CHARTABLE_AGG.has(card.aggregationType) &&
        !NON_CHARTABLE_IDS.has(card.id));
}

/**
 * The last `count` calendar months ending with the month containing `now`,
 * oldest first. Boundaries are local-time midnights on the 1st, the same way
 * the activity calendar groups games.
 */
function monthBuckets(now = new Date(), count = MONTH_COUNT) {
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
        const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const end   = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
        out.push({
            start: start.getTime(),
            end:   end.getTime(),
            year:  start.getFullYear(),
            month: start.getMonth(),
            short: start.toLocaleString('en-US', { month: 'short' }),
            long:  start.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
            isCurrent: i === 0,
        });
    }
    return out;
}

/**
 * One point per month: { ...bucket, games, value, display, tier }.
 * value is null for a month with no games (or where the stat can't be
 * computed, e.g. "Short game WR" in a month with no short games).
 */
function computeMonthlyHistory({ tabName, statId, matches, computeTabStats, now = new Date() }) {
    const buckets = monthBuckets(now);
    const groups  = buckets.map(() => []);

    for (const m of matches || []) {
        const t = m.gameCreation;
        // buckets are contiguous, so a binary search would do — but 12 is tiny
        for (let i = 0; i < buckets.length; i++) {
            if (t >= buckets[i].start && t < buckets[i].end) { groups[i].push(m); break; }
        }
    }

    let meta = null;
    const points = buckets.map((b, i) => {
        const ms = groups[i];
        const p  = { ...b, games: ms.length, value: null, display: null, tier: null };
        if (!ms.length) return p;

        const card = (computeTabStats(tabName, ms, []) || []).find(c => c.id === statId);
        if (!card) return p;
        meta = meta || card;  // any month's card carries the formatting metadata
        if (Number.isFinite(card.value)) {
            p.value   = card.value;
            p.display = card.displayValue;
            p.tier    = card.benchmarkable && card.benchmarkRank && card.benchmarkRank !== 'unrated'
                ? card.benchmarkRank : null;
        }
        return p;
    });

    return {
        points,
        totalGames: groups.reduce((s, g) => s + g.length, 0),
        higherIsBetter:  meta ? meta.higherIsBetter  : true,
        aggregationType: meta ? meta.aggregationType : 'average',
        benchmarkable:   meta ? !!meta.benchmarkable : false,
    };
}

/**
 * Rank bands for a stat: [{ tier, lo, hi }] covering the whole number line.
 * Mirrors evaluateBenchmark: higher-is-better means value >= threshold reaches
 * that tier; lower-is-better means value <= threshold does.
 */
function benchmarkBands(thresholds, higherIsBetter) {
    if (!thresholds) return [];
    const bands = [];
    for (let i = 0; i < TIERS_ASC.length; i++) {
        const tier = TIERS_ASC[i];
        const next = TIERS_ASC[i + 1];
        if (thresholds[tier] === undefined) continue;
        if (higherIsBetter) {
            bands.push({
                tier,
                lo: i === 0 ? -Infinity : thresholds[tier],
                hi: next ? thresholds[next] : Infinity,
            });
        } else {
            bands.push({
                tier,
                hi: i === 0 ? Infinity : thresholds[tier],
                lo: next ? thresholds[next] : -Infinity,
            });
        }
    }
    return bands;
}

/** Axis/tick label for a value, by the card's aggregation type. */
function axisLabel(v, aggregationType) {
    if (!Number.isFinite(v)) return '';
    if (aggregationType === 'percentage') return `${Math.round(v)}%`;
    const sign = aggregationType === 'differential' && v > 0 ? '+' : '';
    const a = Math.abs(v);
    let s;
    if (a >= 1000)      s = (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    else if (a >= 100)  s = String(Math.round(v));
    else if (a >= 10)   s = v.toFixed(1).replace(/\.0$/, '');
    else                s = v.toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
    return sign + s;
}

/** ~`count` round-number ticks across [min, max]. */
function niceTicks(min, max, count = 4) {
    const span = max - min;
    if (!(span > 0)) return [min];
    const raw  = span / count;
    const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out  = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
        out.push(Number(v.toFixed(10)));
    }
    return out;
}

function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * A version of a tier colour that is legible as text on the dark background.
 * Iron (#5A4A44) and Bronze are close to the panel colour, so their labels
 * disappeared; dark colours are mixed halfway toward white.
 */
function readable(hex) {
    const h = hex.replace('#', '');
    const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    if (lum >= 0.42) return hex;
    const mixed = c.map(v => Math.round(v + (255 - v) * 0.5));
    return '#' + mixed.map(v => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// CHART DRAWING
// ---------------------------------------------------------------------------

/**
 * Draw the monthly chart into `canvas`. Returns the geometry needed for hover
 * hit-testing: { slotW, left, points: [{ x, y } | null] }.
 */
function drawChart(canvas, history, thresholds, hoverIndex) {
    const ctx  = canvas.getContext('2d');
    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.scale(dpr, dpr);

    const W = rect.width, H = rect.height;
    const PAD = { top: 26, right: 74, bottom: 40, left: 48 };
    const cW = W - PAD.left - PAD.right;
    const cH = H - PAD.top  - PAD.bottom;
    const n  = history.points.length;
    const slotW = cW / n;
    const xOf = i => PAD.left + (i + 0.5) * slotW;

    ctx.clearRect(0, 0, W, H);
    ctx.font = '10px Inter, sans-serif';

    const values = history.points.map(p => p.value).filter(Number.isFinite);
    if (!values.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '12px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No games in the last 12 months with the current filters',
            PAD.left + cW / 2, PAD.top + cH / 2);
        return null;
    }

    // ── y domain: the data, padded so the line never touches the edges ──
    // Only months with a real sample set the scale. A 2-game month at 0% win
    // rate would otherwise drag the axis to zero and flatten a year of real
    // data into a sliver; such a month is pinned to the edge instead (it is
    // drawn hollow and labelled with its true value).
    const reliable = history.points
        .filter(p => Number.isFinite(p.value) && p.games >= LOW_SAMPLE)
        .map(p => p.value);
    const scaleVals = reliable.length ? reliable : values;
    let lo = Math.min(...scaleVals), hi = Math.max(...scaleVals);
    const pad = hi > lo ? (hi - lo) * 0.28 : (Math.abs(lo) * 0.15 || 1);
    lo -= pad; hi += pad;
    if (history.aggregationType === 'percentage') {
        lo = Math.max(0, lo); hi = Math.min(100, hi);
        if (hi <= lo) { lo = Math.max(0, lo - 5); hi = Math.min(100, hi + 5); }
    }
    const yRaw = v => PAD.top + cH - ((v - lo) / (hi - lo)) * cH;
    // Clamped to the plot so an off-scale low-sample month sits on the edge
    const yOf  = v => Math.max(PAD.top, Math.min(PAD.top + cH, yRaw(v)));

    // ── hovered month column ──
    if (hoverIndex !== null && hoverIndex >= 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        ctx.fillRect(PAD.left + hoverIndex * slotW, PAD.top, slotW, cH);
    }

    // ── rank bands behind everything (benchmarked stats only) ──
    const bands = history.benchmarkable ? benchmarkBands(thresholds, history.higherIsBetter) : [];
    for (const b of bands) {
        const bLo = Math.max(b.lo, lo), bHi = Math.min(b.hi, hi);
        if (bHi <= bLo) continue;
        const color = RANK_COLORS[b.tier] || RANK_COLORS.unrated;
        const yTop = yOf(bHi), yBot = yOf(bLo);

        ctx.fillStyle = hexToRgba(color, 0.10);
        ctx.fillRect(PAD.left, yTop, cW, yBot - yTop);

        // Boundary line (skip the plot edges, and bands too thin to read —
        // stats with tightly spaced tiers, like win rate on a wide axis, would
        // otherwise stack these into a rainbow stripe)
        if (b.hi < hi && b.hi > lo && yBot - yTop >= 6) {
            ctx.strokeStyle = hexToRgba(color, 0.35);
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(PAD.left, yTop); ctx.lineTo(PAD.left + cW, yTop); ctx.stroke();
        }
        // tier name in the right gutter, if the band is tall enough to hold it
        if (yBot - yTop >= 13) {
            ctx.fillStyle = readable(color);
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(b.tier.charAt(0).toUpperCase() + b.tier.slice(1),
                PAD.left + cW + 8, (yTop + yBot) / 2 + 3.5);
        }
    }

    // ── y ticks ──
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    for (const t of niceTicks(lo, hi, 4)) {
        const y = yOf(t);
        ctx.strokeStyle = t === 0 && history.aggregationType === 'differential'
            ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.06)';
        ctx.setLineDash(t === 0 ? [] : [3, 4]);
        ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.38)';
        ctx.fillText(axisLabel(t, history.aggregationType), PAD.left - 7, y + 3.5);
    }

    // ── x labels: month, then game count ──
    history.points.forEach((p, i) => {
        const x = xOf(i);
        const isHover = i === hoverIndex;
        ctx.textAlign = 'center';
        ctx.font = `${p.isCurrent || isHover ? 'bold ' : ''}10px Inter, sans-serif`;
        ctx.fillStyle = p.isCurrent ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.5)';
        const showYear = i === 0 || p.month === 0;
        ctx.fillText(showYear ? `${p.short} '${String(p.year).slice(2)}` : p.short, x, H - PAD.bottom + 15);
        ctx.font = '9px Inter, sans-serif';
        ctx.fillStyle = p.games === 0 ? 'rgba(255,255,255,0.18)'
                      : p.games < LOW_SAMPLE ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.42)';
        ctx.fillText(p.games === 0 ? '—' : `${p.games}g`, x, H - PAD.bottom + 28);
    });

    // ── the line, broken across empty months ──
    const lineColor = history.benchmarkable ? 'rgba(232,237,245,0.9)' : hexToRgba(accentColor(), 0.95);
    const geo = history.points.map((p, i) => Number.isFinite(p.value) ? { x: xOf(i), y: yOf(p.value) } : null);

    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    for (let i = 1; i < geo.length; i++) {
        const a = geo[i - 1], b = geo[i];
        if (!a || !b) continue;
        const faint = history.points[i - 1].games < LOW_SAMPLE || history.points[i].games < LOW_SAMPLE;
        ctx.strokeStyle = faint ? 'rgba(232,237,245,0.3)' : lineColor;
        ctx.setLineDash(faint ? [4, 4] : []);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // ── dots + value labels ──
    history.points.forEach((p, i) => {
        const g = geo[i];
        if (!g) return;
        // Dark tiers (Iron) are lightened so the dot doesn't vanish into the panel
        const color = p.tier ? readable(RANK_COLORS[p.tier] || accentColor()) : (history.benchmarkable ? '#e8edf5' : accentColor());
        const low   = p.games < LOW_SAMPLE;
        const r     = i === hoverIndex ? 6 : 4.5;

        ctx.beginPath(); ctx.arc(g.x, g.y, r + 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10,12,18,0.9)'; ctx.fill();
        ctx.beginPath(); ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
        if (low) {
            ctx.strokeStyle = hexToRgba(color.startsWith('#') ? color : '#e8edf5', 0.75);
            ctx.lineWidth = 1.5; ctx.stroke();
        } else {
            ctx.fillStyle = color; ctx.fill();
        }

        ctx.font = 'bold 10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = low ? 'rgba(255,255,255,0.45)' : (p.tier ? readable(color) : 'rgba(255,255,255,0.85)');
        const labelY = g.y - 10 < PAD.top - 6 ? g.y + 18 : g.y - 10;
        ctx.fillText(p.display ?? axisLabel(p.value, history.aggregationType), g.x, labelY);
    });

    return { slotW, left: PAD.left, plotRight: PAD.left + cW, geo };
}

// ---------------------------------------------------------------------------
// PANEL (DOM)
// ---------------------------------------------------------------------------

const state = {
    open: false,
    tab: null,
    statId: null,
    label: null,
    matches: [],
    history: null,
    geometry: null,
    hoverIndex: null,
};

const $ = id => document.getElementById(id);

function cleanLabel(label) {
    // "Short (<25m) WR (12g)" → "Short (<25m) WR": the count belongs to the
    // currently-filtered total, not to any one month.
    return String(label || '').replace(/\s*\(\d+g\)\s*$/, '');
}

function highlightSelectedCard() {
    document.querySelectorAll('#analyticsCardsContainer .stat-card--clickable').forEach(el => {
        const on = state.open && el.dataset.statId === state.statId;
        el.classList.toggle('is-selected', on);
        el.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
}

function renderPanel() {
    const panel = $('statHistoryPanel');
    if (!panel) return;

    state.history = computeMonthlyHistory({
        tabName: state.tab,
        statId: state.statId,
        matches: state.matches,
        // Same rule as the cards (role filter, role-weighted ranks), so a
        // month's tier matches the card's (#10, #56)
        computeTabStats: (tab, ms, prev) => window.computeTabStats(tab, ms, prev, { role: window.analyticsRoleFilter || null, roleWeighted: true }),
    });

    const h   = state.history;
    const pts = h.points;
    $('statHistoryTitle').textContent = cleanLabel(state.label);
    $('statHistorySub').textContent =
        `Monthly · ${pts[0].short} ${pts[0].year} – ${pts[pts.length - 1].short} ${pts[pts.length - 1].year}` +
        ` · ${h.totalGames} game${h.totalGames === 1 ? '' : 's'} with current filters`;

    redraw();
}

function redraw() {
    const canvas = $('statHistoryCanvas');
    if (!canvas || !state.history) return;
    // Rank bands need one ladder, so only with one role picked: across roles
    // each role has its own ladder and the dots carry the combined tier (#56)
    const role = window.analyticsRoleFilter || null;
    const thresholds = role && typeof window.getStatBenchmark === 'function'
        ? window.getStatBenchmark(state.statId, role) : null;
    state.geometry = drawChart(canvas, state.history, thresholds, state.hoverIndex);
}

function hideTip() {
    const tip = $('statHistoryTip');
    if (tip) tip.classList.remove('visible');
}

function showTip(i) {
    const tip = $('statHistoryTip');
    const g   = state.geometry;
    if (!tip || !g || !state.history) return;
    const p = state.history.points[i];

    let html = `<div class="sh-tip-month">${escapeHtml(p.long)}${p.isCurrent ? ' <span>(so far)</span>' : ''}</div>`;
    if (p.games === 0) {
        html += `<div class="sh-tip-meta">No games this month</div>`;
    } else if (!Number.isFinite(p.value)) {
        html += `<div class="sh-tip-meta">${p.games} game${p.games === 1 ? '' : 's'} · not enough data for this stat</div>`;
    } else {
        const color = p.tier ? readable(RANK_COLORS[p.tier] || '#ffffff') : '#fff';
        const tierTxt = p.tier ? ` · ${p.tier.charAt(0).toUpperCase() + p.tier.slice(1)}` : '';
        html += `<div class="sh-tip-value" style="color:${color}">${escapeHtml(p.display ?? axisLabel(p.value, state.history.aggregationType))}</div>`;
        html += `<div class="sh-tip-meta">${p.games} game${p.games === 1 ? '' : 's'}${tierTxt}</div>`;
        if (p.games < LOW_SAMPLE) html += `<div class="sh-tip-warn">Only ${p.games} game${p.games === 1 ? '' : 's'} — treat with caution</div>`;
    }
    tip.innerHTML = html;

    const pt = g.geo[i];
    const x  = g.left + (i + 0.5) * g.slotW;
    const y  = pt ? pt.y : 60;
    tip.style.left = `${x}px`;
    tip.style.top  = `${y}px`;
    tip.classList.add('visible');
}

function onMouseMove(e) {
    const g = state.geometry;
    if (!g) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let i = Math.floor((x - g.left) / g.slotW);
    if (x < g.left || x > g.plotRight) i = null;
    else i = Math.max(0, Math.min(state.history.points.length - 1, i));
    if (i === state.hoverIndex) return;
    state.hoverIndex = i;
    redraw();
    if (i === null) hideTip(); else showTip(i);
}

function onMouseLeave() {
    state.hoverIndex = null;
    hideTip();
    redraw();
}

function openPanel() {
    const panel = $('statHistoryPanel');
    if (!panel) return;
    const wasOpen = state.open;
    state.open = true;
    state.hoverIndex = null;
    hideTip();
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    renderPanel();
    highlightSelectedCard();

    // Bring the chart into view on first open, once the slide has finished
    if (!wasOpen) {
        setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 340);
    }
}

function closePanel() {
    const panel = $('statHistoryPanel');
    state.open = false;
    state.statId = null;
    state.hoverIndex = null;
    hideTip();
    if (panel) {
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
    }
    highlightSelectedCard();
}

/** Card click: open, switch to another stat, or close if it's already showing. */
function toggleStatHistory(tabName, statId, label) {
    if (state.open && state.statId === statId && state.tab === tabName) {
        closePanel();
        return;
    }
    state.tab = tabName;
    state.statId = statId;
    state.label = label;
    openPanel();
}

/**
 * Called by renderAnalyticsTab after it draws the cards — on every filter
 * change and every sub-tab switch.
 *  - switched to another sub-tab → that stat isn't on screen any more: close
 *  - filters changed             → recompute the open chart from the new games
 */
function syncStatHistory(tabName, matches) {
    state.matches = matches || [];
    if (!state.open) return;
    if (tabName !== state.tab) { closePanel(); return; }

    // Pick up the current label (e.g. its game count) if the card still exists
    const el = document.querySelector(
        `#analyticsCardsContainer .stat-card--clickable[data-stat-id="${state.statId}"]`);
    if (el && el.dataset.label) state.label = el.dataset.label;

    state.hoverIndex = null;
    hideTip();
    renderPanel();
    highlightSelectedCard();
}

let wired = false;
function wirePanel() {
    if (wired || typeof document === 'undefined') return;
    const canvas = $('statHistoryCanvas');
    if (!canvas) return;
    wired = true;

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    const close = $('statHistoryClose');
    if (close) close.addEventListener('click', closePanel);

    // Keep the bitmap sharp when the window is resized
    if (typeof ResizeObserver !== 'undefined') {
        let frame = null;
        new ResizeObserver(() => {
            if (!state.open) return;
            if (frame) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => { frame = null; redraw(); });
        }).observe(canvas);
    }
}

if (typeof window !== 'undefined') {
    window.isStatChartable   = isChartable;
    window.toggleStatHistory = (...a) => { wirePanel(); toggleStatHistory(...a); };
    window.syncStatHistory   = (...a) => { wirePanel(); syncStatHistory(...a); };
    window.closeStatHistory  = closePanel;
}

module.exports = {
    isChartable, monthBuckets, computeMonthlyHistory, benchmarkBands, axisLabel, niceTicks,
    drawChart, LOW_SAMPLE, MONTH_COUNT,
};
