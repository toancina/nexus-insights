/**
 * tooltipSystem.js — Hover tooltip subsystem.
 * Call initTooltips() once after DOMContentLoaded to attach global listeners.
 */

const { getItemData, getRuneData, getSummonerSpellData } = require('../services/dataDragon');
const { itemDescriptionHtml } = require('./itemDescription');
const { escapeHtml, formatInt } = require('./dom');
const { wpaLine } = require('../services/itemWpa');

function tooltip() {
    return document.getElementById('gameTooltip');
}

function positionTooltip(x, y) {
    const el     = tooltip();
    const offset = 15;
    let left = x + offset;
    let top  = y + offset;
    if (left + el.offsetWidth  > window.innerWidth)  left = x - el.offsetWidth  - offset;
    if (top  + el.offsetHeight > window.innerHeight) top  = y - el.offsetHeight - offset;
    el.style.left = left + 'px';
    el.style.top  = top  + 'px';
}

function hideTooltip() {
    tooltip().style.display = 'none';
}

// ---------------------------------------------------------------------------
// TOOLTIP CONTENT BUILDERS
// ---------------------------------------------------------------------------

function showItemTooltip(itemId, boughtAt, wpa) {
    const itemData = getItemData(itemId);
    if (!itemData) return;

    const el    = tooltip();
    const title = el.querySelector('.tooltip-title');
    const desc  = el.querySelector('.tooltip-description');

    const totalCost = Number(itemData.gold?.total) || 0;
    const baseCost  = Number(itemData.gold?.base)  || 0;
    const costText  = baseCost > 0
        ? `<span class="item-cost">Cost: <span class="gold-value">${formatInt(totalCost)}</span> (<span class="gold-value">${formatInt(baseCost)}</span>)</span>`
        : `<span class="item-cost">Cost: <span class="gold-value">${formatInt(totalCost)}</span></span>`;

    // Escaped, with only Riot's known tags turned back into markup (#37)
    const description = itemDescriptionHtml(itemData.description);

    // "Bought at 14:32" from the match timeline (#7); only digits and ':' get here
    const bought = /^\d+:\d\d$/.test(boughtAt || '') ? `<br><span class="item-bought">Bought at ${boughtAt}</span>` : '';
    // "Win chance 46% → 58% (+12) …" for that purchase (#89); data-wpa is "from,to"
    const fromTo = /^(\d{1,3}),(\d{1,3})$/.exec(wpa || '');
    const change = fromTo ? `<br><span class="item-wpa">${escapeHtml(wpaLine(Number(fromTo[1]), Number(fromTo[2])))}</span>` : '';
    title.innerHTML = `${escapeHtml(itemData.name || 'Unknown Item')}<br>${costText}${bought}${change}`;
    desc.innerHTML  = description;
    el.style.display = 'block';
}

function showRuneTooltip(runeId) {
    const runeData = getRuneData(runeId);
    if (!runeData) return;
    const el = tooltip();
    el.querySelector('.tooltip-title').textContent       = runeData.name || 'Unknown Rune';
    el.querySelector('.tooltip-description').textContent = runeData.shortDesc || runeData.description || 'No description available';
    el.style.display = 'block';
}

function showBadgeTooltip(badgeEl) {
    const el     = tooltip();
    const nameEl = badgeEl.querySelector('.badge-name');
    el.querySelector('.tooltip-title').textContent       = nameEl ? nameEl.textContent : '';
    el.querySelector('.tooltip-description').textContent = badgeEl.dataset.badgeTooltip || '';
    el.style.display = 'block';
}

function showInsightTooltip(labelEl) {
    const description = labelEl.dataset.insightTooltip || '';
    if (!description) return;
    const el = tooltip();
    el.querySelector('.tooltip-title').textContent       = labelEl.textContent;
    el.querySelector('.tooltip-description').textContent = description;
    el.style.display = 'block';
}

function showSummonerSpellTooltip(spellId) {
    const spellData = getSummonerSpellData(spellId);
    if (!spellData) return;
    const el = tooltip();
    el.querySelector('.tooltip-title').textContent       = spellData.name        || 'Unknown Spell';
    el.querySelector('.tooltip-description').textContent = spellData.description || 'No description available';
    el.style.display = 'block';
}

function showColumnTooltip(labelEl) {
    const description = labelEl.dataset.columnTooltip || '';
    if (!description) return;
    const el = tooltip();
    el.querySelector('.tooltip-title').textContent       = labelEl.textContent;
    el.querySelector('.tooltip-description').textContent = description;
    el.style.display = 'block';
}

// ---------------------------------------------------------------------------
// EVENT HANDLERS
// ---------------------------------------------------------------------------

function handleTooltipShow(e) {
    if (e.target.dataset?.itemId)         { showItemTooltip(e.target.dataset.itemId, e.target.dataset.bought, e.target.dataset.wpa); return; }
    if (e.target.dataset?.runeId)         { showRuneTooltip(parseInt(e.target.dataset.runeId));             return; }
    if (e.target.dataset?.spellId)        { showSummonerSpellTooltip(parseInt(e.target.dataset.spellId));   return; }
    const badgeEl = e.target.closest('.badge-pill');
    if (badgeEl?.dataset?.badgeTooltip)   { showBadgeTooltip(badgeEl);                                     return; }
    if (e.target.dataset?.insightTooltip) { showInsightTooltip(e.target);                                  return; }
    if (e.target.dataset?.columnTooltip)  { showColumnTooltip(e.target);                                   return; }
}

function handleTooltipHide(e) {
    const r = e.relatedTarget;
    if (!r || (
        !r.dataset?.itemId &&
        !r.dataset?.runeId &&
        !r.dataset?.spellId &&
        !r.closest?.('.badge-pill') &&
        !r.dataset?.insightTooltip &&
        !r.dataset?.columnTooltip
    )) {
        hideTooltip();
    }
}

function handleTooltipMove(e) {
    if (tooltip().style.display === 'block') positionTooltip(e.clientX, e.clientY);
}

function initTooltips() {
    document.addEventListener('mouseover', handleTooltipShow);
    document.addEventListener('mouseout',  handleTooltipHide);
    document.addEventListener('mousemove', handleTooltipMove);
}

module.exports = { initTooltips, hideTooltip, positionTooltip };
