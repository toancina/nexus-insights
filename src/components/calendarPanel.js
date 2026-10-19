/**
 * calendarPanel.js — Activity calendar, time-of-day insights, and LP progression charts.
 * Reads window.matchesData at call-time for match data.
 */

const { getLpReadings, getLpDeltasByMatch } = require('../services/matchService');
const { buildLpEstimates, nextDivision, rankLabel } = require('../services/lpEstimate');
const { wrColor, wrTextColor } = require('./winRateColor');
const { escapeHtml, formatInt } = require('./dom');

// ---------------------------------------------------------------------------
// CALENDAR NAVIGATION STATE  (module-scoped — only used by this file)
// ---------------------------------------------------------------------------
let calendarYear  = new Date().getFullYear();
let calendarMonth = new Date().getMonth(); // 0-11

const CAL_MONTHS = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
];

// ---------------------------------------------------------------------------
// LP PROGRESSION CONSTANTS
// ---------------------------------------------------------------------------

const { RANK_COLORS_UC: LP_TIER_COLORS } = require('./rankTiers');

const LP_TIER_NAMES = ['IRON','BRONZE','SILVER','GOLD','PLATINUM','EMERALD','DIAMOND'];
const LP_FALLBACK_COLOR = '#8a8a9a';

/** Which tier an absolute-LP value falls in (400 LP per tier, 4 divisions). */
function tierIndexForAbs(absLp) {
    return Math.max(0, Math.min(LP_TIER_NAMES.length - 1, Math.floor(absLp / 400)));
}

function tierColorForAbs(absLp) {
    return LP_TIER_COLORS[LP_TIER_NAMES[tierIndexForAbs(absLp)]] || LP_FALLBACK_COLOR;
}

/**
 * A vertical gradient that paints each tier's slice of the chart in its own
 * rank colour, with hard edges at the tier boundaries. Used for both the line
 * and the fill, so climbing through a tier visibly changes the line's colour.
 */
function makeTierGradient(ctx, top, height, minAbs, maxAbs, alpha) {
    const grad  = ctx.createLinearGradient(0, top, 0, top + height);
    const range = (maxAbs - minAbs) || 1;
    const paint = (hex) => (alpha === undefined ? hex : hexToRgba(hex, alpha));
    // y grows downward while LP grows upward, so offset 0 is the HIGHEST rank
    const offsetOf = (abs) => Math.min(1, Math.max(0, (maxAbs - abs) / range));

    const stops = [
        { at: 0, color: paint(tierColorForAbs(maxAbs)) },
        { at: 1, color: paint(tierColorForAbs(minAbs)) },
    ];

    for (let ti = 1; ti < LP_TIER_NAMES.length; ti++) {
        const boundary = ti * 400;
        if (boundary <= minAbs || boundary >= maxAbs) continue;
        const at = offsetOf(boundary);
        // Two stops at the same offset = a crisp line between tiers
        stops.push({ at, color: paint(LP_TIER_COLORS[LP_TIER_NAMES[ti]]     || LP_FALLBACK_COLOR) });
        stops.push({ at, color: paint(LP_TIER_COLORS[LP_TIER_NAMES[ti - 1]] || LP_FALLBACK_COLOR) });
    }

    stops.sort((a, b) => a.at - b.at);
    for (const s of stops) grad.addColorStop(s.at, s.color);
    return grad;
}
const LP_TIER_SHORT = { IRON:'I', BRONZE:'B', SILVER:'S', GOLD:'G', PLATINUM:'P', EMERALD:'E', DIAMOND:'D', MASTER:'M', GRANDMASTER:'GM', CHALLENGER:'C' };

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// CALENDAR HELPERS
// ---------------------------------------------------------------------------

function getDayColor(wins, losses) {
    const total = wins + losses;
    if (total === 0) return 'rgba(255,255,255,0.04)';
    // Shared win-rate scale (winRateColor.js). Busier days are a bit more
    // solid, so a 1-game day doesn't look as decisive as a 9-game one.
    const alpha = 0.45 + 0.45 * Math.min(total / 8, 1);
    return wrColor(wins / total, { alpha });
}

function updateCalPickerLabels() {
    const ml = document.getElementById('calMonthLabel');
    const yl = document.getElementById('calYearLabel');
    if (ml) ml.textContent = CAL_MONTHS[calendarMonth];
    if (yl) yl.textContent = calendarYear;
}

// Exposed on window so renderer.js can call it after filter changes
window.renderCalendarMonthView = function renderCalendarMonthView(matchesOverride) {
    // Fall back to the FILTERED set, not the raw one. The month/year pickers
    // re-render without passing an argument, and falling through to
    // window.matchesData there silently reverted the calendar to every game
    // mode — so changing month showed all-queue W/L while the filter bar still
    // claimed Solo/Duo only.
    const matchesData = matchesOverride
        || window._calendarFilteredMatches
        || window.matchesData
        || [];
    const grid        = document.getElementById('calendarMonthGrid');
    if (!grid) return;
    grid.innerHTML = '';
    updateCalPickerLabels();

    // Aggregate wins/losses per date for this month
    const matchesByDate = {};
    let totalWins = 0, totalLosses = 0;

    matchesData.forEach(m => {
        const d = new Date(m.gameCreation);
        if (d.getFullYear() !== calendarYear || d.getMonth() !== calendarMonth) return;
        const dateStr = `${calendarYear}-${String(calendarMonth+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        if (!matchesByDate[dateStr]) matchesByDate[dateStr] = { wins: 0, losses: 0, total: 0 };
        matchesByDate[dateStr].total++;
        if (m.win) { matchesByDate[dateStr].wins++; totalWins++; }
        else       { matchesByDate[dateStr].losses++; totalLosses++; }
    });

    const firstDayOfWeek = new Date(calendarYear, calendarMonth, 1).getDay();
    const daysInMonth    = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const totalCells     = Math.ceil((firstDayOfWeek + daysInMonth) / 7) * 7;

    for (let i = 0; i < totalCells; i++) {
        const dayNum = i - firstDayOfWeek + 1;
        const cell   = document.createElement('div');
        cell.className = 'cal-month-cell';

        if (dayNum < 1 || dayNum > daysInMonth) {
            cell.classList.add('cal-month-cell-empty');
        } else {
            const dateStr = `${calendarYear}-${String(calendarMonth+1).padStart(2,'0')}-${String(dayNum).padStart(2,'0')}`;
            const stats   = matchesByDate[dateStr];

            const numEl = document.createElement('span');
            numEl.className   = 'cal-month-cell-num';
            numEl.textContent = dayNum;
            cell.appendChild(numEl);

            if (stats) {
                cell.style.background = getDayColor(stats.wins, stats.losses);
                cell.title = `${dateStr}: ${stats.wins}W ${stats.losses}L (${stats.total} game${stats.total !== 1 ? 's' : ''})`;
                const badge = document.createElement('span');
                badge.className   = 'cal-month-cell-badge';
                badge.textContent = stats.total;
                cell.appendChild(badge);
            } else {
                cell.style.background = 'rgba(255,255,255,0.04)';
            }
        }
        grid.appendChild(cell);
    }

    const summaryEl = document.getElementById('calendarSummary');
    if (summaryEl) {
        const monthName = CAL_MONTHS[calendarMonth];
        summaryEl.textContent = totalWins + totalLosses > 0
            ? `${totalWins + totalLosses} matches in ${monthName} — ${totalWins}W / ${totalLosses}L`
            : `No matches in ${monthName} ${calendarYear}`;
        summaryEl.style.color = 'rgba(255,255,255,0.4)';
    }
}

// ---------------------------------------------------------------------------
// MONTH / YEAR PICKER  (exposed on window for inline onclick)
// ---------------------------------------------------------------------------

window.toggleCalPicker = function (type) {
    const matchesData = window._calendarFilteredMatches || window.matchesData || [];
    const monthDrop   = document.getElementById('calMonthDropdown');
    const yearDrop    = document.getElementById('calYearDropdown');
    if (!monthDrop || !yearDrop) return;

    const targetDrop = type === 'month' ? monthDrop : yearDrop;
    const isOpen     = targetDrop.style.display === 'block';
    monthDrop.style.display = 'none';
    yearDrop.style.display  = 'none';
    if (isOpen) return;

    targetDrop.innerHTML = '';
    if (type === 'month') {
        CAL_MONTHS.forEach((name, i) => {
            const item = document.createElement('div');
            item.className   = 'cal-picker-item' + (i === calendarMonth ? ' active' : '');
            item.textContent = name;
            item.onclick = e => { e.stopPropagation(); calendarMonth = i; renderCalendarMonthView(); targetDrop.style.display = 'none'; };
            targetDrop.appendChild(item);
        });
    } else {
        const years = new Set(matchesData.map(m => new Date(m.gameCreation).getFullYear()));
        years.add(new Date().getFullYear());
        Array.from(years).sort((a, b) => b - a).forEach(y => {
            const item = document.createElement('div');
            item.className   = 'cal-picker-item' + (y === calendarYear ? ' active' : '');
            item.textContent = y;
            item.onclick = e => { e.stopPropagation(); calendarYear = y; renderCalendarMonthView(); targetDrop.style.display = 'none'; };
            targetDrop.appendChild(item);
        });
    }
    targetDrop.style.display = 'block';
};

// Close pickers when clicking outside
document.addEventListener('click', e => {
    if (!e.target.closest('#calMonthPicker') && !e.target.closest('#calYearPicker')) {
        const md = document.getElementById('calMonthDropdown');
        const yd = document.getElementById('calYearDropdown');
        if (md) md.style.display = 'none';
        if (yd) yd.style.display = 'none';
    }
});

// ---------------------------------------------------------------------------
// INIT (called by renderer.js after matches load)
// ---------------------------------------------------------------------------

window.initCalendar = function (matchesOverride) {
    const matchesData = matchesOverride || window.matchesData || [];
    // Store so toggleCalPicker (year/month dropdown) uses the same filtered set
    window._calendarFilteredMatches = matchesData;
    const allDates    = matchesData.map(m => new Date(m.gameCreation));
    if (allDates.length > 0) {
        const mostRecent = new Date(Math.max(...allDates));
        calendarYear  = mostRecent.getFullYear();
        calendarMonth = mostRecent.getMonth();
    } else {
        calendarYear  = new Date().getFullYear();
        calendarMonth = new Date().getMonth();
    }
    const wrapper = document.getElementById('calendarWrapper');
    // .ta-panel is a block container (title stacked above .ta-body).
    // Setting 'flex' here turned it into a flex ROW, which pulled the panel
    // title into its own sidebar column and squeezed the body.
    if (wrapper) wrapper.style.display = 'block';
    window.renderCalendarMonthView(matchesData);
    if (matchesData.length > 0) window.calculateTimeInsights(matchesData);
    window.renderLpCharts().catch(e => console.warn('LP chart render failed:', e));
};

// ---------------------------------------------------------------------------
// LP PROGRESSION CHARTS — one point per ranked game (#5)
// ---------------------------------------------------------------------------

/**
 * LP for every ranked game: measured where a reading exists, estimated from
 * your usual gain/loss elsewhere and fitted between known readings and
 * checkpoints (services/lpEstimate.js). The Match History LP column and
 * these charts both read window.lpEstimates, so they always agree.
 */
window.refreshLpEstimates = async function () {
    const [deltas, solo, flex] = await Promise.all([
        getLpDeltasByMatch().catch(() => window.lpDeltas || {}),
        getLpReadings('solo'),
        getLpReadings('flex'),
    ]);
    window.lpDeltas = deltas;
    window.lpEstimates = buildLpEstimates(window.matchesData || [], { solo, flex }, deltas);
    return window.lpEstimates;
};

// Which queue/colour each canvas draws, so a resize can redraw it unattended
const LP_CHARTS = [
    { canvasId: 'lpChartSolo', queue: 'solo', tipId: 'lpTipSolo', summaryId: 'lpSummarySolo' },
    { canvasId: 'lpChartFlex', queue: 'flex', tipId: 'lpTipFlex', summaryId: 'lpSummaryFlex' },
];
const LP_CHART_GAMES = 40;           // newest games shown per chart
const lpChartGeometry = new Map();   // canvasId → [{ x, y, p }] for hover / click

/**
 * A canvas has two sizes: its CSS box and its bitmap. drawLpChart sizes the
 * bitmap from the CSS box at draw time — so if the box later gets wider (a
 * bigger window, a layout change, the panel appearing after charts drew), the
 * old bitmap is simply stretched to fit. That is what made the axis labels
 * look huge and blurry. Redrawing on resize keeps the two in step.
 */
let lpResizeObserver = null;

function observeLpChartResize() {
    if (lpResizeObserver || typeof ResizeObserver === 'undefined') return;

    const pending = new Map();

    lpResizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
            const spec = LP_CHARTS.find(c => c.canvasId === entry.target.id);
            if (!spec) continue;

            const width = Math.round(entry.contentRect.width);
            const height = Math.round(entry.contentRect.height);
            if (!width || !height) continue;

            // Ignore repeat notifications for a size we already drew
            const last = pending.get(spec.canvasId);
            if (last && last.width === width && last.height === height) continue;
            pending.set(spec.canvasId, { width, height });

            // Coalesce bursts of resize events into one redraw per frame
            if (spec._frame) cancelAnimationFrame(spec._frame);
            spec._frame = requestAnimationFrame(() => {
                spec._frame = null;
                drawLpChart(spec);
            });
        }
    });

    for (const spec of LP_CHARTS) {
        const canvas = document.getElementById(spec.canvasId);
        if (canvas) lpResizeObserver.observe(canvas);
    }
}

window.renderLpCharts = async function () {
    try {
        await window.refreshLpEstimates();
    } catch (e) {
        console.warn('LP estimates unavailable:', e.message);
    }
    LP_CHARTS.forEach(spec => { wireLpChart(spec); drawLpChart(spec); renderLpSummary(spec); });
    observeLpChartResize();
};

// Older callers drop a cache before redrawing; renderLpCharts now always
// reloads the readings, so there is nothing to drop.
window.invalidateLpCache = function () {};

/** +21 / −24 / 0, with a real minus sign (a hyphen next to "~" reads as "~~"). */
const signed = v => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0');

/** 1079 → "S2 79LP", 2945 → "M+ 145LP" (labels on the chart). */
function shortLpLabel(abs) {
    if (abs >= LP_TIER_NAMES.length * 400) return `M+ ${Math.round(abs - LP_TIER_NAMES.length * 400)}LP`;
    const v = Math.max(0, Math.round(abs));
    const tier = LP_TIER_NAMES[Math.floor(v / 400)];
    return `${LP_TIER_SHORT[tier]}${4 - Math.floor((v % 400) / 100)} ${v % 100}LP`;
}

function lpSeriesFor(queue) {
    const est = window.lpEstimates;
    const all = est && est.series ? (est.series[queue] || []) : [];
    return all.filter(p => !p.remake && Number.isFinite(p.lpAfter)).slice(-LP_CHART_GAMES);
}

function drawLpChart(spec) {
    const canvas = document.getElementById(spec.canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const series = lpSeriesFor(spec.queue);
    lpChartGeometry.set(spec.canvasId, []);

    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    // Nothing to draw into yet (panel still hidden, or zero-width layout)
    if (!rect.width || !rect.height) return;

    // Match the bitmap to the CSS box. Assigning width/height also resets the
    // context transform, so the dpr scale below is applied exactly once.
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.scale(dpr, dpr);

    const W = rect.width, H = rect.height;
    const PAD = {
        top:    Math.min(20, Math.round(H * 0.19)),
        right:  16,
        bottom: Math.min(28, Math.round(H * 0.26)),
        left:   34,
    };
    const cW = W - PAD.left - PAD.right;
    const cH = H - PAD.top  - PAD.bottom;

    ctx.clearRect(0, 0, W, H);

    if (series.length === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.font      = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        const hasGames = window.lpEstimates && (window.lpEstimates.series[spec.queue] || []).length;
        ctx.fillText(hasGames ? 'No LP reading yet. Add a checkpoint to estimate past games.' : 'No data yet',
            W / 2, H / 2 + 4);
        return;
    }

    const absLps = series.map(p => p.lpAfter);
    const minAbs = Math.max(0, Math.min(...absLps) - 30);
    const maxAbs = Math.max(...absLps) + 30;
    const range  = maxAbs - minAbs || 100;
    const n      = series.length;
    const toX    = i => PAD.left + (n > 1 ? (i / (n - 1)) * cW : cW / 2);
    const toY    = v => PAD.top  + cH - ((v - minAbs) / range) * cH;

    // ── Tier bands: a faint wash of each rank's colour behind its LP range ──
    for (let ti = 0; ti < LP_TIER_NAMES.length; ti++) {
        const bandLow  = Math.max(minAbs, ti * 400);
        const bandHigh = Math.min(maxAbs, (ti + 1) * 400);
        if (bandHigh <= bandLow) continue;
        const yTop    = toY(bandHigh);
        const yBottom = toY(bandLow);
        ctx.fillStyle = hexToRgba(LP_TIER_COLORS[LP_TIER_NAMES[ti]] || LP_FALLBACK_COLOR, 0.09);
        ctx.fillRect(PAD.left, yTop, cW, Math.max(0, yBottom - yTop));
    }

    // ── Tier / division grid lines ──
    ctx.lineWidth = 1;
    LP_TIER_NAMES.forEach((tier, ti) => {
        const tierColor = LP_TIER_COLORS[tier] || LP_FALLBACK_COLOR;
        [0, 1, 2, 3].forEach(ri => {
            const absLp = ti * 400 + ri * 100;
            if (absLp < minAbs || absLp > maxAbs) return;
            const y   = toY(absLp);
            const lbl = `${LP_TIER_SHORT[tier]}${4 - ri}`;
            const isTierStart = ri === 0;
            ctx.setLineDash(isTierStart ? [] : [3, 4]);
            ctx.strokeStyle = isTierStart ? hexToRgba(tierColor, 0.45) : hexToRgba(tierColor, 0.16);
            ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
            ctx.fillStyle = hexToRgba(tierColor, isTierStart ? 0.95 : 0.5);
            ctx.font      = `${isTierStart ? 'bold ' : ''}9px Inter, sans-serif`;
            ctx.textAlign = 'right';
            ctx.fillText(lbl, PAD.left - 4, y + 3.5);
        });
    });
    ctx.setLineDash([]);

    if (n > 1) {
        const fillGrad = makeTierGradient(ctx, PAD.top, cH, minAbs, maxAbs, 0.22);
        const lineGrad = makeTierGradient(ctx, PAD.top, cH, minAbs, maxAbs);
        ctx.beginPath();
        ctx.moveTo(toX(0), toY(absLps[0]));
        for (let i = 1; i < n; i++) ctx.lineTo(toX(i), toY(absLps[i]));
        ctx.lineTo(toX(n - 1), PAD.top + cH);
        ctx.lineTo(toX(0),     PAD.top + cH);
        ctx.closePath();
        ctx.fillStyle = fillGrad;
        ctx.fill();

        ctx.beginPath();
        ctx.strokeStyle = lineGrad;
        ctx.lineWidth   = 2;
        ctx.lineJoin    = 'round';
        ctx.lineCap     = 'round';
        ctx.moveTo(toX(0), toY(absLps[0]));
        for (let i = 1; i < n; i++) ctx.lineTo(toX(i), toY(absLps[i]));
        ctx.stroke();
        ctx.lineWidth = 1;
    }

    // Dots: filled = measured LP, hollow = estimated. Labels on the first,
    // the last and division changes, but never within LABEL_GAP px of another
    // label (estimates hovering at a division line would stack them).
    const LABEL_GAP = 60;
    let lastLabelX = -Infinity;
    const geo = [];
    series.forEach((p, i) => {
        const x = toX(i), y = toY(absLps[i]);
        const dotColor = tierColorForAbs(absLps[i]);
        ctx.beginPath();
        ctx.arc(x, y, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10,12,18,0.9)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, p.estimated ? 2.4 : 2.6, 0, Math.PI * 2);
        if (p.estimated) {
            ctx.strokeStyle = dotColor;
            ctx.lineWidth = 1.2;
            ctx.stroke();
            ctx.lineWidth = 1;
        } else {
            ctx.fillStyle = dotColor;
            ctx.fill();
        }
        geo.push({ x, y, p });

        const prevDiv = i > 0 ? Math.floor(absLps[i - 1] / 100) : null;
        const isLast = i === n - 1;
        const roomy = x - lastLabelX >= LABEL_GAP && (isLast || toX(n - 1) - x >= LABEL_GAP);
        if (isLast || (roomy && (i === 0 || prevDiv !== Math.floor(absLps[i] / 100)))) {
            lastLabelX = x;
            ctx.fillStyle = dotColor;
            ctx.font      = 'bold 9px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText((p.estimated ? '~' : '') + shortLpLabel(absLps[i]), x, y - 8);
        }
    });
    lpChartGeometry.set(spec.canvasId, geo);

    // X-axis date labels
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font      = '9px Inter, sans-serif';
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(cW / 50))));
    const day = t => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    series.forEach((p, i) => {
        if (i === 0 || i === n - 1 || i % step === 0) ctx.fillText(day(p.gameCreation), toX(i), H - PAD.bottom + 11);
    });
}

/** Hover: the game under the mouse. Click: open it in Match History. */
function wireLpChart(spec) {
    const canvas = document.getElementById(spec.canvasId);
    const tip = document.getElementById(spec.tipId);
    if (!canvas || !tip || canvas.dataset.wired) return;
    canvas.dataset.wired = '1';

    const nearest = (e) => {
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        let best = null, bestD = 14 * 14;
        for (const g of lpChartGeometry.get(spec.canvasId) || []) {
            const d = (g.x - x) ** 2 + (g.y - y) ** 2;
            if (d < bestD) { best = g; bestD = d; }
        }
        return best;
    };

    canvas.addEventListener('mousemove', (e) => {
        const g = nearest(e);
        canvas.style.cursor = g ? 'pointer' : '';
        if (!g) { tip.classList.remove('visible'); return; }
        const p = g.p;
        const when = new Date(p.gameCreation).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        tip.innerHTML =
            `<b>${escapeHtml(p.championName || '')}</b> · ${p.win ? 'Win' : 'Loss'} · ${when}<br>` +
            `${p.estimated ? '~' : ''}${signed(p.delta)} LP${p.estimated ? ' <span>(estimate)</span>' : ''} → ` +
            `${p.estimated ? '~' : ''}${escapeHtml(rankLabel(p.lpAfter))}`;
        tip.style.left = `${Math.min(g.x, canvas.clientWidth - 170)}px`;
        tip.style.top  = `${g.y + 12}px`;
        tip.classList.add('visible');
    });
    canvas.addEventListener('mouseleave', () => { tip.classList.remove('visible'); canvas.style.cursor = ''; });
    canvas.addEventListener('click', (e) => {
        const g = nearest(e);
        if (g) window.openMatchInHistory(g.p.matchId);
    });
}

/** "Net −46 LP · 2 wins to Silver I" under each chart. */
function renderLpSummary(spec) {
    const el = document.getElementById(spec.summaryId);
    if (!el) return;
    const est = window.lpEstimates;
    const series = est && est.series ? (est.series[spec.queue] || []) : [];
    const known = series.filter(p => Number.isFinite(p.lpAfter));
    if (!known.length) { el.textContent = ''; return; }

    // Net over the games the filters currently show (this queue only)
    const shown = new Set((window._calendarFilteredMatches || window.matchesData || []).map(m => m.matchId));
    const inView = series.filter(p => shown.has(p.matchId) && !p.remake);
    const net = inView.reduce((s, p) => s + p.delta, 0);
    const anyEstimate = inView.some(p => p.estimated);

    const typical = est.typical[spec.queue];
    const next = nextDivision(known[known.length - 1].lpAfter, typical.gain);
    const parts = [];
    if (inView.length) {
        parts.push(`<span title="Sum of the LP changes over the ${formatInt(inView.length)} games your filters show${anyEstimate ? ', some of them estimated' : ''}">Net ` +
            `<b class="${net > 0 ? 'lp-up' : net < 0 ? 'lp-down' : ''}">${anyEstimate ? '~' : ''}${signed(net)} LP</b></span>`);
    }
    if (next) {
        parts.push(`<span title="${typical.measured ? 'Your average over your last real wins' : 'Typical gain until 5 of your wins have been measured'}">` +
            `<b>${next.wins}</b> win${next.wins === 1 ? '' : 's'} to ${escapeHtml(next.label)} ` +
            `<span class="lp-dim">(+${typical.gain} per win)</span></span>`);
    }
    el.innerHTML = parts.join('<span class="lp-dot">·</span>');
}

/** Switch to Match History and open one game's row (from the LP chart). */
window.openMatchInHistory = async function (matchId) {
    const index = (window.matchesData || []).findIndex(m => m.matchId === matchId);
    if (index < 0) return;
    window.switchTopTab('history');
    const rowOf = () => document.querySelector(`.match-table tr[data-match-index="${index}"]`);
    if (!rowOf() && typeof window.renderFilteredMatches === 'function') {
        window.displayedMatchCount = Infinity;          // the game may be further down the list
        await window.renderFilteredMatches({ listOnly: true });
    }
    const row = rowOf();
    if (!row) {
        if (typeof window.showToast === 'function') {
            window.showToast('Game hidden', 'This game is hidden by the current filters.', 4000);
        }
        return;
    }
    if (!(row.nextElementSibling && row.nextElementSibling.classList.contains('expanded-row'))) {
        await window.toggleRowExpand(index);
    }
    row.scrollIntoView({ block: 'start', behavior: 'smooth' });
};

// ---------------------------------------------------------------------------
// TIME INSIGHTS
// ---------------------------------------------------------------------------

window.calculateTimeInsights = function (matches) {
    if (!matches || matches.length === 0) return;

    // ── Time-of-day buckets (4 broad slots) ──────────────────────────────────
    const timeBuckets = {
        'Morning':   { label: '6a – 12p', wins: 0, total: 0 },
        'Afternoon': { label: '12p – 5p', wins: 0, total: 0 },
        'Evening':   { label: '5p – 10p', wins: 0, total: 0 },
        'Night':     { label: '10p – 6a', wins: 0, total: 0 }
    };

    // ── Day-of-week ───────────────────────────────────────────────────────────
    const dayOrder = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const dayFull  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const dayMap   = {};
    dayOrder.forEach(d => { dayMap[d] = { wins: 0, total: 0 }; });

    // ── Game length buckets ───────────────────────────────────────────────────
    const lengthBuckets = [
        { label: '< 20m',  test: m => m.gameDuration < 1200,                                    wins: 0, total: 0 },
        { label: '20–25m', test: m => m.gameDuration >= 1200 && m.gameDuration < 1500,           wins: 0, total: 0 },
        { label: '25–30m', test: m => m.gameDuration >= 1500 && m.gameDuration < 1800,           wins: 0, total: 0 },
        { label: '30–35m', test: m => m.gameDuration >= 1800 && m.gameDuration < 2100,           wins: 0, total: 0 },
        { label: '35–40m', test: m => m.gameDuration >= 2100 && m.gameDuration < 2400,           wins: 0, total: 0 },
        { label: '> 40m',  test: m => m.gameDuration >= 2400,                                    wins: 0, total: 0 },
    ];

    // ── Session stamina ───────────────────────────────────────────────────────
    const chronMatches   = [...matches].reverse();
    let curWin = 0, curLoss = 0, maxWin = 0, maxLoss = 0;
    let currentSession   = [];
    const sessions       = [];

    chronMatches.forEach(m => {
        if (m.win) { curWin++; curLoss = 0; if (curWin  > maxWin)  maxWin  = curWin;  }
        else       { curLoss++; curWin = 0; if (curLoss > maxLoss) maxLoss = curLoss; }

        const d    = new Date(m.gameCreation);
        const hour = d.getHours();

        // Time bucket
        let slot = 'Night';
        if      (hour >= 6  && hour < 12) slot = 'Morning';
        else if (hour >= 12 && hour < 17) slot = 'Afternoon';
        else if (hour >= 17 && hour < 22) slot = 'Evening';
        timeBuckets[slot].total++;
        if (m.win) timeBuckets[slot].wins++;

        // Day of week (Mon=0 … Sun=6 in dayOrder)
        const jsDay   = d.getDay(); // 0=Sun
        const dayIdx  = jsDay === 0 ? 6 : jsDay - 1; // remap to Mon-first
        const dayKey  = dayOrder[dayIdx];
        dayMap[dayKey].total++;
        if (m.win) dayMap[dayKey].wins++;

        // Game length
        lengthBuckets.forEach(b => { if (b.test(m)) { b.total++; if (m.win) b.wins++; } });

        // Session grouping
        if (currentSession.length === 0) {
            currentSession.push(m);
        } else {
            const last    = currentSession[currentSession.length - 1];
            const lastEnd = last.gameCreation + last.gameDuration * 1000;
            if (m.gameCreation - lastEnd <= 2 * 60 * 60 * 1000) { currentSession.push(m); }
            else { sessions.push(currentSession); currentSession = [m]; }
        }
    });
    if (currentSession.length > 0) sessions.push(currentSession);

    // Stamina buckets
    let fresh = {w:0,t:0}, warm = {w:0,t:0}, fat = {w:0,t:0};
    sessions.forEach(sess => {
        sess.forEach((m, i) => {
            const idx = i + 1;
            if      (idx <= 3) { fresh.t++; if (m.win) fresh.w++; }
            else if (idx <= 6) { warm.t++;  if (m.win) warm.w++;  }
            else               { fat.t++;   if (m.win) fat.w++;   }
        });
    });

    // ── Determine best / worst time slot (min 5 games) ───────────────────────
    let bestSlot = null, worstSlot = null, bestWR = -1, worstWR = 2;
    for (const [key, v] of Object.entries(timeBuckets)) {
        if (v.total < 5) continue;
        const wr = v.wins / v.total;
        if (wr > bestWR)  { bestWR  = wr; bestSlot  = key; }
        if (wr < worstWR) { worstWR = wr; worstSlot = key; }
    }

    // ── Populate Time of Day (dual best/worst) ────────────────────────────────
    const el = id => document.getElementById(id);
    if (el('bestTimeOfDay')) {
        el('bestTimeOfDay').textContent  = bestSlot  || 'N/A';
        el('bestTimeOfDaySub').textContent  = bestSlot
            ? `${Math.round(bestWR  * 100)}% WR · ${timeBuckets[bestSlot].label}`
            : 'Not enough data';
        el('worstTimeOfDay').textContent = worstSlot || 'N/A';
        el('worstTimeOfDaySub').textContent = worstSlot
            ? `${Math.round(worstWR * 100)}% WR · ${timeBuckets[worstSlot].label}`
            : 'Not enough data';
    }

    // ── Populate Day-of-Week bar chart ────────────────────────────────────────
    const dayChart = el('dayBarChart');
    if (dayChart) {
        // Bars sit on a fixed 30%–70% axis with a dashed 50% line, and use the
        // shared win-rate colours — so a 48% day reads as "about even", not
        // as the worst day just because the others were slightly better.
        dayChart.innerHTML = dayOrder.map(day => {
            const v   = dayMap[day];
            const wr  = v.total > 0 ? v.wins / v.total : null;
            const pct = wr !== null ? Math.round(wr * 100) : null;
            const barH = wr !== null ? Math.round(Math.max(0.04, Math.min(1, (wr - 0.3) / 0.4)) * 100) : 0;
            const tip = wr !== null ? `${day}: ${pct}% WR over ${v.total} game${v.total !== 1 ? 's' : ''}` : `${day}: no games`;
            return `
                <div class="day-bar-col" title="${tip}">
                    <div class="day-bar-wr" style="color:${wrTextColor(wr)}">${pct !== null ? pct + '%' : ''}</div>
                    <div class="day-bar-fill-wrap">
                        <div class="day-bar-mid" aria-hidden="true"></div>
                        <div class="day-bar-fill" style="height:${barH}%;background:${wrColor(wr, { games: v.total })};"></div>
                    </div>
                    <div class="day-bar-label">${day}</div>
                </div>`;
        }).join('');
    }

    // ── Populate Game Length bar chart ────────────────────────────────────────
    const lenChart = el('lengthBarChart');
    if (lenChart) {
        lenChart.innerHTML = lengthBuckets.map(b => {
            const wr     = b.total > 0 ? b.wins / b.total : null;
            const pct    = wr !== null ? Math.round(wr * 100) : null;
            const barW   = pct !== null ? pct : 0;
            const color    = wrColor(wr, { games: b.total });
            const pctStr   = pct !== null ? pct + '%' : '--';
            const pctColor = wrTextColor(wr);
            return `
                <div class="length-bar-row">
                    <span class="length-bar-label">${b.label}</span>
                    <div class="length-bar-track">
                        <div class="length-bar-fill" style="width:${barW}%;background:${color};"></div>
                    </div>
                    <span class="length-bar-pct" style="color:${pctColor}">${pctStr}</span>
                    <span class="length-bar-games">${b.total}g</span>
                </div>`;
        }).join('');
    }

    // ── Win Rate by Patch (components/periodFilter.js, #6) ────────────────────
    if (typeof window.renderPatchWinRates === 'function') window.renderPatchWinRates(matches);

    // ── Stamina + Streaks ─────────────────────────────────────────────────────
    if (el('staminaFresh')) {
        el('staminaFresh').textContent    = fresh.t > 0 ? `${Math.round((fresh.w/fresh.t)*100)}% WR` : '--';
        el('staminaWarm').textContent     = warm.t  > 0 ? `${Math.round((warm.w/warm.t)*100)}% WR`  : '--';
        el('staminaFatigued').textContent = fat.t   > 0 ? `${Math.round((fat.w/fat.t)*100)}% WR`   : '--';
        el('longestWinStreak').textContent  = maxWin  > 0 ? maxWin  : '--';
        el('longestLossStreak').textContent = maxLoss > 0 ? maxLoss : '--';
    }
};

module.exports = {};

