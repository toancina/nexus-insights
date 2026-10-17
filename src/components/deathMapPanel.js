/**
 * deathMapPanel.js — "Where you die" under the Death Review cards (#8).
 *
 * Every death in the filtered games as a dot on the Summoner's Rift minimap
 * (Data Dragon's map11.png), red-side games turned so you always play from
 * the bottom-left. Dots go from amber (alone) to red (a cluster). Next to it:
 * the share of deaths near your base / mid-map / in enemy territory for the
 * early, mid and late game, and the biggest change between them.
 *
 * Positions come from the stored `deathPositions` column; the rules are in
 * services/deathMap.js (pure, tested).
 */

const D = require('../services/deathMap');
const { escapeHtml } = require('./dom');

const PHASE_WORDS = { early: 'early game', mid: 'mid game', late: 'late game' };
const pct = v => `${Math.round(v * 100)}%`;

let mapImg = null;
function mapImage(onLoad) {
    const src = `${window.DDRAGON_BASE}/img/map/map11.png`;
    if (!mapImg || mapImg.dataset.src !== src) {
        mapImg = new Image();
        mapImg.dataset.src = src;
        mapImg.src = src;
    }
    if (!mapImg.complete) mapImg.addEventListener('load', onLoad, { once: true });
    return mapImg;
}

let lastDeaths = [];
// Dots for lastDeaths, sorted by density: a redraw (map image loaded, window
// resized) reuses them instead of recomputing (#66)
let cachedDots = null;


function draw() {
    const canvas = document.querySelector('#deathMap .dm-canvas');
    if (!canvas) return;
    const size = canvas.getBoundingClientRect().width;
    if (!size) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const img = mapImage(draw);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, size, size);
    else { ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(0, 0, size, size); }
    ctx.fillStyle = 'rgba(8, 10, 16, 0.45)';               // dim the map so dots stand out
    ctx.fillRect(0, 0, size, size);

    if (!cachedDots) cachedDots = D.densityDots(lastDeaths).sort((a, b) => a.density - b.density);
    const dots = cachedDots;
    // "Dense" is measured against the 95th percentile, not the single busiest
    // spot, so one hot spot doesn't wash every other cluster out to amber.
    // Dots get smaller and fainter as the count grows, so hundreds of games
    // still show their shape instead of a solid blanket.
    const p95 = dots.length ? dots[Math.floor((dots.length - 1) * 0.95)].density : 1;
    const many = dots.length > 1000 ? 2 : dots.length > 300 ? 1 : 0;
    const radius = [3.5, 2.8, 2.2][many];
    const alpha = [0.6, 0.38, 0.22][many];
    for (const d of dots) {
        const k = Math.min(1, (d.density - 1) / Math.max(1, p95 - 1));   // 0 alone … 1 dense
        const x = (d.x / D.MAP_SIZE) * size;
        const y = size - (d.y / D.MAP_SIZE) * size;          // game y grows up, canvas y down
        ctx.beginPath();
        ctx.arc(x, y, radius + k * 2, 0, Math.PI * 2);
        // amber → red as deaths pile up in the same spot
        ctx.fillStyle = `rgba(${Math.round(250 - k * 11)}, ${Math.round(204 - k * 136)}, ${Math.round(21 + k * 47)}, ${(alpha + k * (0.9 - alpha)).toFixed(2)})`;
        ctx.fill();
    }
}

/**
 * @param {Array|null} matches  the Death Review tab's (filtered) games; null hides the panel
 */
function renderDeathMap(matches) {
    const host = document.getElementById('deathMap');
    if (!host) return;
    if (!matches) { host.hidden = true; host.innerHTML = ''; lastDeaths = []; cachedDots = null; return; }
    host.hidden = false;

    const withData = matches.filter(m => m.deathPositions != null);
    lastDeaths = withData.flatMap(m => D.decodeDeaths(m.deathPositions));
    cachedDots = null;
    const head = `<div class="dm-head"><span class="dm-title">Where you die</span>`;
    if (!lastDeaths.length) {
        host.innerHTML = `${head}</div><div class="dm-empty">${withData.length
            ? 'No deaths with a position in these games.'
            : 'Death positions are filled in while the app indexes games that have a timeline.'}</div>`;
        return;
    }

    const phases = D.zonesByPhase(lastDeaths);
    const shift = D.biggestShift(phases);
    const keyOf = label => (D.PHASES.find(p => p.label === label) || {}).key;
    const tip = shift ? `${pct(shift.to)} of your ${PHASE_WORDS[keyOf(shift.toPhase)]} deaths happen ${escapeHtml(shift.label)},
        ${shift.to > shift.from ? 'up' : 'down'} from ${pct(shift.from)} in the ${PHASE_WORDS[keyOf(shift.fromPhase)]}.` : '';

    host.innerHTML = `
        ${head}<span class="dm-sub">${lastDeaths.length} deaths in ${withData.length} games · red-side games are turned so you always start bottom-left</span></div>
        <div class="dm-body">
            <div class="dm-map"><canvas class="dm-canvas" aria-label="Map of where you died"></canvas></div>
            <div class="dm-side">
                <table class="dm-table">
                    <thead><tr><th>Phase</th><th class="num">Deaths</th><th class="num">Near your base</th>
                        <th class="num">Mid-map</th><th class="num">Enemy territory</th></tr></thead>
                    <tbody>${phases.map(p => `
                        <tr><td>${escapeHtml(p.label)}</td><td class="num">${p.deaths}</td><td class="num">${pct(p.own)}</td>
                            <td class="num">${pct(p.middle)}</td><td class="num">${pct(p.enemy)}</td></tr>`).join('')}
                    </tbody>
                </table>
                ${tip ? `<div class="dm-tip">${tip}</div>` : ''}
                <div class="dm-legend"><span class="dm-dot dm-dot--one"></span>one death
                    <span class="dm-dot dm-dot--many"></span>several in the same spot</div>
                <div class="dm-note">Zones are measured along the line from your base to theirs, so "mid-map" includes the river and the middle of every lane.</div>
            </div>
        </div>`;
    draw();
}

window.addEventListener('resize', () => {
    const host = document.getElementById('deathMap');
    if (host && !host.hidden && lastDeaths.length) draw();
});

window.renderDeathMap = renderDeathMap;

module.exports = { renderDeathMap };
