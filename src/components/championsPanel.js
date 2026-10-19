/**
 * championsPanel.js — the Champions page (#4).
 *
 * Left: a sortable table of every champion you've played (current game-mode
 * filter, remakes excluded). Right: the selected champion's rune pages, core
 * items and matchups vs your lane opponent; a matchup row opens to show what
 * you built in that matchup.
 *
 * Numbers come from services/championStats.js (pure, tested). Rows read the
 * stored columns only, so the page touches no JSON blobs.
 */

const { championTable, championDetail, sortRows, roleLabel } = require('../services/championStats');
const { itemImg } = require('./itemIcon');
const { getItemData, getRuneData } = require('../services/dataDragon');
const { getChampionIcon, RUNE_ICONS } = require('./matchCard');
const { escapeHtml, formatInt } = require('./dom');
const { wrTextColor, LOW_SAMPLE } = require('./winRateColor');
const { decodePurchases, buildOrderTable, firstBackStats, firstBackAt } = require('../services/itemBuild');
const { itemWpa, winChancePoints } = require('../services/itemWpa');
const { formatClock } = require('../services/matchTimeline');

const COLUMNS = [
    { key: 'champion',   label: 'Champion', dir: 'asc' },
    { key: 'games',      label: 'Games' },
    { key: 'winRate',    label: 'Win rate' },
    { key: 'kda',        label: 'KDA' },
    { key: 'csPerMin',   label: 'CS/min' },
    { key: 'dmgPerMin',  label: 'DMG/min' },
    { key: 'kp',         label: 'KP' },
    { key: 'impactRank', label: 'Impact', dir: 'asc', title: 'Average team impact rank (1 = best of the 10 players)' },
];

const state = { sortKey: 'games', sortDir: 'desc', selected: null, role: null, openMatchup: null };

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const pct  = v => (v == null ? '–' : `${Math.round(v * 100)}%`);
const num  = (v, d = 1) => (v == null ? '–' : v.toFixed(d));
const int  = v => (v == null ? '–' : Math.round(v).toLocaleString('en-US'));
const diff = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('en-US')}`);
const rank = v => (v == null ? '–' : `#${v.toFixed(1)}`);

/** Win rate coloured on the shared scale; dimmed under LOW_SAMPLE games. */
function wrCell(winRate, games) {
    const low = games < LOW_SAMPLE;
    return `<span class="ch-wr${low ? ' is-low' : ''}" style="color:${wrTextColor(winRate)}"
        ${low ? `title="Only ${games} game${games === 1 ? '' : 's'}"` : ''}>${pct(winRate)}</span>`;
}

function champIcon(name, cls = 'ch-icon') {
    return `<img class="${cls}" src="${escapeHtml(getChampionIcon(name))}" alt="" onerror="this.style.visibility='hidden'">`;
}

function itemIcon(id) {
    // Many games, many patches: the current version, with the shared fallback (#67)
    return itemImg(id, { extra: 'class="ch-item"' });
}

function runeIcon(id, cls = 'ch-rune') {
    const data = getRuneData(id);
    const src = data && data.icon
        ? `https://ddragon.leagueoflegends.com/cdn/img/${data.icon}`
        : RUNE_ICONS[id] ? `https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${RUNE_ICONS[id]}` : '';
    return src ? `<img class="${cls}" src="${escapeHtml(src)}" data-rune-id="${Number(id)}" alt="">` : '';
}

const runeName = id => (getRuneData(id) || {}).name || `Rune ${id}`;
const itemName = id => (getItemData(id) || {}).name || `Item ${id}`;

/**
 * Finished items only: no consumables, trinkets or components. Boots count
 * once they're past basic Boots, even though tier-2 boots can still upgrade.
 * Without Data Dragon loaded, everything counts.
 */
function isCoreItem(id) {
    const it = getItemData(id);
    if (!it) return true;
    const tags = it.tags || [];
    const cost = (it.gold && it.gold.total) || 0;
    if (tags.includes('Consumable') || tags.includes('Trinket')) return false;
    if (tags.includes('Boots')) return cost >= 900;
    return !(it.into && it.into.length) && cost >= 1000;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
/** Same rows as the Analytics cards minus the champion filter. */
function pool() {
    if (Array.isArray(window.championPoolMatches)) return window.championPoolMatches;
    const all = window.matchesData || [];
    return typeof window.excludeRemakes === 'function' ? window.excludeRemakes(all) : all;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderList(rows) {
    const head = COLUMNS.map(c => {
        const on = state.sortKey === c.key;
        const arrow = on ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        return `<th class="${c.key === 'champion' ? '' : 'num'}${on ? ' sorted' : ''}" data-sort="${c.key}"
                    ${c.title ? `title="${escapeHtml(c.title)}"` : ''}>${c.label}${arrow}</th>`;
    }).join('');

    const body = sortRows(rows, state.sortKey, state.sortDir, { minGames: LOW_SAMPLE }).map(r => `
        <tr data-champ="${escapeHtml(r.champion)}" class="${r.champion === state.selected ? 'selected' : ''}">
            <td><div class="ch-name">${champIcon(r.champion)}<span>${escapeHtml(r.champion)}</span>
                <span class="ch-role">${escapeHtml(roleLabel(r.mainRole))}</span></div></td>
            <td class="num">${r.games}</td>
            <td class="num">${wrCell(r.winRate, r.games)}</td>
            <td class="num">${num(r.kda, 2)}</td>
            <td class="num">${num(r.csPerMin)}</td>
            <td class="num">${int(r.dmgPerMin)}</td>
            <td class="num">${pct(r.kp)}</td>
            <td class="num">${rank(r.impactRank)}</td>
        </tr>`).join('');

    return `<table class="ch-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function rateTable(title, rows, cellsOf, empty) {
    const body = rows.length ? rows.map(r => `
        <tr class="${r.games < LOW_SAMPLE ? 'is-low' : ''}">
            <td>${cellsOf(r)}</td>
            <td class="num">${r.games}</td>
            <td class="num">${pct(r.pickRate)}</td>
            <td class="num">${wrCell(r.winRate, r.games)}</td>
        </tr>`).join('') : `<tr><td colspan="4" class="ch-empty">${empty}</td></tr>`;
    return `
        <div class="ch-card">
            <div class="ch-card-title">${title}</div>
            <table class="ch-subtable">
                <thead><tr><th></th><th class="num">Games</th><th class="num">Pick</th><th class="num">Win rate</th></tr></thead>
                <tbody>${body}</tbody>
            </table>
        </div>`;
}

/** Trinkets and consumables never count as part of a build. */
function isExcludedItem(id) {
    const tags = (getItemData(id) || {}).tags || [];
    return tags.includes('Consumable') || tags.includes('Trinket');
}

/**
 * The numbered build slots are about the big item choices, so boots (which
 * nearly everyone buys first) stay out of them; they still show under First
 * back and in Core items.
 */
function isBuildItem(id) {
    return isCoreItem(id) && !((getItemData(id) || {}).tags || []).includes('Boots');
}

/**
 * Build order (#7): starting items, first back, then the 1st/2nd/3rd
 * finished item you kept, each with games, win rate and pick rate. Plus the
 * first-back timing line. From the stored purchases; no timelines parsed.
 */
function renderBuildOrder(matches, champion, role) {
    const games = matches
        .filter(m => m.championName === champion && (!role || (m.teamPosition || '') === role) && m.itemPurchases)
        .map(m => {
            const purchases = decodePurchases(m.itemPurchases);
            return {
                purchases, win: m.win === 1, firstBackAt: firstBackAt(purchases),
                finalItems: [m.item0, m.item1, m.item2, m.item3, m.item4, m.item5],
                wpa: itemWpa(purchases, winChancePoints(m.winChance, m.gameDuration)),   // #89
            };
        });
    if (!games.length) {
        return `<div class="ch-card ch-card--wide"><div class="ch-card-title">Build order</div>
            <div class="ch-empty">No purchase data yet. It's filled in while the app indexes games that have a timeline.</div></div>`;
    }

    const t = buildOrderTable(games, { isExcluded: isExcludedItem, isCompleted: isBuildItem });
    const cols = [['Start', t.start], ['First back', t.firstBack], ['1st item', t.core[0]], ['2nd item', t.core[1]], ['3rd item', t.core[2]]];
    const icons = key => String(key).split('+').map(id => itemIcon(Number(id))).join('');
    const names = key => String(key).split('+').map(id => itemName(Number(id))).join(' + ');
    // Average WPA (#89): "–" until LOW_SAMPLE of the row's games have a win-chance curve
    const wpaText = r => (r.wpaGames >= LOW_SAMPLE ? `${r.wpa > 0 ? '+' : r.wpa < 0 ? '\u2212' : ''}${Math.abs(r.wpa).toFixed(1)}` : '–');
    const wpaCell = r => {
        const color = r.wpaGames < LOW_SAMPLE || Math.abs(r.wpa) < 0.05 ? '' : r.wpa > 0 ? 'var(--success)' : 'var(--error)';
        return `<span class="ch-build-wpa"${color ? ` style="color:${color}"` : ''}>${wpaText(r)}</span>`;
    };
    const wpaTitle = r => (r.wpaGames >= LOW_SAMPLE ? ` · WPA ${wpaText(r)} over ${r.wpaGames} games` : '');
    const col = ([label, rows]) => `
        <div class="ch-build-col">
            <div class="ch-build-head">${label}</div>
            ${rows.slice(0, 3).map(r => `
                <div class="ch-build-row${r.games < LOW_SAMPLE ? ' is-low' : ''}" title="${escapeHtml(names(r.key))}: ${r.wins}W ${r.games - r.wins}L, in ${pct(r.pickRate)} of games${wpaTitle(r)}">
                    <span class="ch-build-icons">${icons(r.key)}</span>
                    <span class="ch-build-n">${r.games}</span>${wrCell(r.winRate, r.games)}${wpaCell(r)}
                </div>`).join('') || '<div class="ch-empty">–</div>'}
        </div>`;

    const fb = firstBackStats(games);
    const side = (s, word) => (s ? `<b style="color:${wrTextColor(s.winRate)}">${pct(s.winRate)}</b> when ${word} (${s.games})` : '');
    const back = fb.medianMs === null ? '' : `
        <div class="ch-note">First back: median <b>${formatClock(fb.medianMs)}</b>
            ${[side(fb.faster, 'earlier'), side(fb.slower, 'later')].filter(Boolean).map(x => '· ' + x).join(' ')}</div>`;

    return `
        <div class="ch-card ch-card--wide">
            <div class="ch-card-title">Build order <span>${formatInt(games.length)} games with a timeline · numbered items are finished items you kept, boots left out · under 5% of games hidden</span></div>
            <div class="ch-note ch-wpa-note">Last number: <b>WPA</b>, the average change in your team's estimated win chance from the purchase until your next trip to the shop (at most 5 min). It shows how games went while you had the item, not what the item caused.</div>
            <div class="ch-build-grid">${cols.map(col).join('')}</div>
            ${back}
        </div>`;
}

function renderMatchups(d) {
    if (!d.matchups.length) {
        return `<div class="ch-card ch-card--wide"><div class="ch-card-title">Matchups</div>
            <div class="ch-empty">No lane opponents recorded yet. They're filled in while the app indexes your games.</div></div>`;
    }
    const rows = d.matchups.map(m => {
        const open = state.openMatchup === m.opponent;
        const builds = open ? `
            <tr class="ch-matchup-detail"><td colspan="7">
                <div class="ch-builds">
                    <div class="ch-builds-row"><span class="ch-builds-label">Items you built</span><div class="ch-builds-items">
                        ${m.items.slice(0, 8).map(i => `<span class="ch-build" title="${escapeHtml(itemName(i.itemId))}: ${i.wins}W ${i.games - i.wins}L">
                            ${itemIcon(i.itemId)}<span>${i.games}</span>${wrCell(i.winRate, i.games)}</span>`).join('') || '<span class="ch-empty">No finished items</span>'}</div></div>
                    <div class="ch-builds-row"><span class="ch-builds-label">Keystones</span><div class="ch-builds-items">
                        ${m.runes.slice(0, 3).map(r => `<span class="ch-build" title="${escapeHtml(runeName(r.keystone))}: ${r.wins}W ${r.games - r.wins}L">
                            ${runeIcon(r.keystone)}<span>${r.games}</span>${wrCell(r.winRate, r.games)}</span>`).join('')}</div></div>
                </div>
            </td></tr>` : '';
        return `
            <tr class="ch-matchup${open ? ' open' : ''}${m.games < LOW_SAMPLE ? ' is-low' : ''}" data-matchup="${escapeHtml(m.opponent)}">
                <td><div class="ch-name"><span class="ch-caret">${open ? '▾' : '▸'}</span>${champIcon(m.opponent, 'ch-icon ch-icon--sm')}<span>${escapeHtml(m.opponent)}</span></div></td>
                <td class="num">${m.games}</td>
                <td class="num">${m.wins}–${m.losses}</td>
                <td class="num">${wrCell(m.winRate, m.games)}</td>
                <td class="num">${num(m.kda, 2)}</td>
                <td class="num" style="color:${m.gd15 > 0 ? 'var(--success)' : m.gd15 < 0 ? 'var(--error)' : ''}">${diff(m.gd15)}</td>
                <td class="num">${m.csd15 == null ? '–' : (m.csd15 > 0 ? '+' : '') + m.csd15.toFixed(1)}</td>
            </tr>${builds}`;
    }).join('');

    return `
        <div class="ch-card ch-card--wide">
            <div class="ch-card-title">Matchups <span>vs your lane opponent · click a row for your builds</span></div>
            <table class="ch-subtable ch-matchups">
                <thead><tr><th>Opponent</th><th class="num">Games</th><th class="num">W–L</th><th class="num">Win rate</th>
                    <th class="num">KDA</th><th class="num" title="Gold difference vs your lane opponent at 15 minutes">GD@15</th>
                    <th class="num" title="CS difference vs your lane opponent at 15 minutes">CSD@15</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            ${d.unmatched ? `<div class="ch-note">${d.unmatched} game${d.unmatched === 1 ? '' : 's'} without a lane opponent (no role, or not indexed yet) aren't in this table.</div>` : ''}
        </div>`;
}

function renderDetail(matches) {
    if (!state.selected) {
        return '<div class="ch-placeholder">Pick a champion to see your runes, items and matchups.</div>';
    }
    const d = championDetail(matches, state.selected, { role: state.role, isCoreItem });
    const s = d.summary;
    const allGames = d.roles.reduce((a, r) => a + r.games, 0);

    const roleChips = d.roles.length > 1 ? `
        <div class="ch-roles">
            <button type="button" class="ch-chip${state.role === null ? ' active' : ''}" data-role="">All roles <span>${allGames}</span></button>
            ${d.roles.map(r => `<button type="button" class="ch-chip${state.role === r.role ? ' active' : ''}" data-role="${escapeHtml(r.role)}">
                ${escapeHtml(roleLabel(r.role))} <span>${r.games}</span></button>`).join('')}
        </div>` : '';

    return `
        <div class="ch-detail-head">
            ${champIcon(d.champion, 'ch-icon ch-icon--lg')}
            <div class="ch-detail-title">
                <h3>${escapeHtml(d.champion)}</h3>
                <div class="ch-detail-sub">${formatInt(s.games)} games · ${s.wins}W ${s.losses}L · KDA ${num(s.kda, 2)} ·
                    CS/min ${num(s.csPerMin)} · Impact ${rank(s.impactRank)}</div>
            </div>
            <div class="ch-detail-wr" style="color:${wrTextColor(s.winRate)}">${pct(s.winRate)}<span>win rate</span></div>
        </div>
        ${roleChips}
        <div class="ch-cards">
            ${rateTable('Rune pages', d.runes.slice(0, 6), r =>
                `<div class="ch-cellrow">${runeIcon(r.keystone)}${runeIcon(r.secondary, 'ch-rune ch-rune--sm')}
                    <span>${escapeHtml(runeName(r.keystone))}</span></div>`, 'No rune data')}
            ${rateTable('Core items', d.items.slice(0, 8), i =>
                `<div class="ch-cellrow">${itemIcon(i.itemId)}<span>${escapeHtml(itemName(i.itemId))}</span></div>`, 'No finished items')}
            ${renderBuildOrder(matches, d.champion, d.role)}
            ${renderMatchups(d)}
        </div>
        <div class="ch-note">Items are each game's final build. Win rates under ${LOW_SAMPLE} games are dimmed.</div>`;
}

function render() {
    const list = document.getElementById('championsList');
    const detail = document.getElementById('championsDetail');
    if (!list || !detail) return;

    const matches = pool();
    const rows = championTable(matches);
    if (!rows.length) {
        list.innerHTML = '<div class="ch-placeholder">No games with the current filter.</div>';
        detail.innerHTML = '';
        return;
    }
    if (!state.selected || !rows.some(r => r.champion === state.selected)) {
        state.selected = rows[0].champion;
        state.role = null;
        state.openMatchup = null;
    }
    list.innerHTML = renderList(rows);
    detail.innerHTML = renderDetail(matches);
}

function wire() {
    const shell = document.getElementById('champions-tab');
    if (!shell || shell.dataset.wired) return;
    shell.dataset.wired = '1';
    shell.addEventListener('click', (e) => {
        const sort = e.target.closest('th[data-sort]');
        const champ = e.target.closest('tr[data-champ]');
        const role = e.target.closest('[data-role]');
        const matchup = e.target.closest('tr[data-matchup]');
        if (sort) {
            const col = COLUMNS.find(c => c.key === sort.dataset.sort);
            if (state.sortKey === col.key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
            else { state.sortKey = col.key; state.sortDir = col.dir || 'desc'; }
        } else if (champ) {
            if (champ.dataset.champ === state.selected) return;
            state.selected = champ.dataset.champ;
            state.role = null;
            state.openMatchup = null;
        } else if (role) {
            state.role = role.dataset.role || null;
            state.openMatchup = null;
        } else if (matchup) {
            state.openMatchup = state.openMatchup === matchup.dataset.matchup ? null : matchup.dataset.matchup;
        } else {
            return;
        }
        render();
    });
}

/** Called by switchTopTab('champions'), and by the filters when they change. */
function openChampionsPanel() {
    wire();
    render();
}

window.openChampionsPanel = openChampionsPanel;

module.exports = { openChampionsPanel, isCoreItem };
