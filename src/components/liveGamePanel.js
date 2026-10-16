/**
 * liveGamePanel.js — the Live page (#59).
 *
 * "Detect live game" asks the local Live Client Data API for the players in
 * the game running on this PC. With no game it says so and calls nothing
 * else. With one, every row is drawn at once from the Live Client's data,
 * then services/liveGameLoader fills in rank, mastery and recent Solo/Duo
 * games from the Riot API, row by row. Clicking again starts over; the
 * loader's caches make that nearly free for the same game.
 */

const { getPlayerList, getActivePlayerName } = require('../services/liveClient');
const { getChampionList } = require('../services/dataDragon');
const riotApi = require('../services/riotApi');
const liveGameStore = require('../services/liveGameStore');
const { createLiveGameLoader } = require('../services/liveGameLoader');
const { parsePlayers, playerTags, rankSummary, gamesTogether } = require('../services/liveGame');
const { loadTeammates } = require('../services/matchService');
const { getChampionIcon, timeAgo, RUNE_ICONS } = require('./matchCard');
const { tierColor } = require('./rankTiers');
const { wrTextColor } = require('./winRateColor');
const { escapeHtml, escapeAttr } = require('./dom');

const loader = createLiveGameLoader({ api: riotApi, store: liveGameStore });

const NO_GAME = 'No game found. Start a game, then click Detect live game. ' +
                'On the loading screen, wait until the game has started.';
const POSITION_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };
const NO_DIVISION = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const GOOD_TAGS = /^(Main|Win streak|Hot streak|Veteran)/;
const BAD_TAGS = /^(First time|Loss streak|Inactive)/;

let generation = 0;   // bumped by every click; an older load sees it and stops
let state = null;     // { players, entries, together }

const pct = (x) => `${Math.round(x * 100)}%`;
const titleCase = (s) => String(s || '').charAt(0) + String(s || '').slice(1).toLowerCase();

function setStatus(text, isError = false) {
    const el = document.getElementById('liveStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', isError);
}

function rankHtml(league) {
    const r = rankSummary(league);
    if (!r) return '<div class="live-line live-muted">Unranked</div>';
    const name = NO_DIVISION.has(r.tier) ? titleCase(r.tier) : `${titleCase(r.tier)} ${r.rank}`;
    const queue = r.queue === 'Flex' ? '<span class="live-muted">Flex </span>' : '';
    const wr = r.winRate == null ? '' :
        ` · <span style="color:${wrTextColor(r.winRate)}">${pct(r.winRate)}</span>`;
    return `<div class="live-line">${queue}<span style="color:${tierColor(r.tier)}">${escapeHtml(name)}</span> · ${Number(r.lp)} LP</div>
        <div class="live-line live-muted">${Number(r.wins)}W ${Number(r.losses)}L${wr}</div>`;
}

function masteryHtml(m) {
    if (!m) return '<div class="live-line live-muted">No mastery</div>';
    const points = m.points >= 1000 ? `${Math.round(m.points / 1000)}k` : String(Number(m.points));
    const last = m.lastPlayTime ? ` · ${timeAgo(m.lastPlayTime)}` : '';
    return `<div class="live-line live-muted">Mastery ${Number(m.level)} · ${points} pts${last}</div>`;
}

function formHtml(p, f) {
    if (!f.games) return '<div class="live-line live-muted">No recent Solo/Duo games</div>';
    const strip = `<div class="tm-strip" title="Last ${f.games} Solo/Duo games, oldest → newest">${
        f.strip.map(w => `<i class="${w ? 'w' : 'l'}"></i>`).join('')}</div>`;
    const champ = f.onChamp.games
        ? `${f.onChamp.games} game${f.onChamp.games === 1 ? '' : 's'} · <span style="color:${wrTextColor(f.onChamp.wins / f.onChamp.games)}">${pct(f.onChamp.wins / f.onChamp.games)}</span>`
        : '0 games';
    return `${strip}
        <div class="live-line live-muted">KDA ${f.kda.toFixed(1)} · <span style="color:${wrTextColor(f.winRate)}">${pct(f.winRate)}</span></div>
        <div class="live-line live-muted">${escapeHtml(p.championName)} ${champ}</div>`;
}

function rowHtml(p) {
    const entry = state.entries[p.index];
    const icon = p.championId ? getChampionIcon(p.championId) : '';
    const spells = p.spells.filter(Boolean)
        .map(s => `<img class="live-spell" src="${escapeAttr(`${window.DDRAGON_BASE}/img/spell/${s}.png`)}" alt="">`).join('');
    const keystone = RUNE_ICONS[p.keystoneId]
        ? `<img class="live-spell" src="https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${RUNE_ICONS[p.keystoneId]}" alt="">`
        : '';
    const tag = p.tagLine ? `<span class="tm-tag">#${escapeHtml(p.tagLine)}</span>` : '';
    const you = p.isYou ? '<span class="live-you">You</span>' : '';
    const position = POSITION_LABEL[p.position] || '';

    let stats;
    if (p.isBot) {
        stats = '<div class="live-stats"><div class="live-line live-muted">Bot</div></div>';
    } else if (!p.lookup) {
        stats = '<div class="live-stats"><div class="live-line live-muted">No Riot ID tag, can\'t look up</div></div>';
    } else if (!entry) {
        stats = '<div class="live-stats"><div class="live-line live-muted">Loading…</div></div>';
    } else if (entry.error && !entry.league) {
        stats = `<div class="live-stats"><div class="live-line live-muted" title="${escapeAttr(entry.error)}">Couldn't load this player</div></div>`;
    } else {
        const together = state.together && !p.isYou && state.allyTeam === p.team ? gamesTogether(state.together, entry.puuid) : 0;
        stats = `
            <div class="live-stats">${rankHtml(entry.league)}${masteryHtml(entry.mastery)}</div>
            <div class="live-stats">${entry.form ? formHtml(p, entry.form)
                : entry.error ? `<div class="live-line live-muted" title="${escapeAttr(entry.error)}">Couldn't load recent games</div>`
                : '<div class="live-line live-muted">Loading recent games…</div>'}
                ${together ? `<div class="live-line live-muted">${together} game${together === 1 ? '' : 's'} together</div>` : ''}</div>`;
    }

    const tags = entry && !p.isBot
        ? playerTags({ league: entry.league, mastery: entry.mastery, form: entry.form })
            .map(t => `<span class="live-tag${GOOD_TAGS.test(t) ? ' good' : BAD_TAGS.test(t) ? ' bad' : ''}">${escapeHtml(t)}</span>`).join('')
        : '';

    return `<div class="live-row${p.isYou ? ' you' : ''}" id="liveRow${p.index}">
        ${icon ? `<img class="live-champ" src="${escapeAttr(icon)}" alt="${escapeAttr(p.championName)}" title="${escapeAttr(p.championName)}">` : '<div class="live-champ"></div>'}
        <div class="live-who">
            <div class="live-name">${escapeHtml(p.gameName)}${tag}${you}</div>
            <div class="live-sub">${position ? `<span>${position}</span>` : ''}${spells}${keystone}</div>
            ${tags ? `<div class="live-tags">${tags}</div>` : ''}
        </div>
        ${stats}
    </div>`;
}

function renderRow(i) {
    const el = document.getElementById(`liveRow${i}`);
    const p = state && state.players[i];
    if (el && p) el.outerHTML = rowHtml(p);
}

function render() {
    const host = document.getElementById('liveGame');
    if (!host) return;
    if (!state) {
        host.innerHTML = '<div class="tm-empty">Click Detect live game while you\'re in a game.</div>';
        return;
    }
    const you = state.players.find(p => p.isYou);
    const teams = [...new Set(state.players.map(p => p.team))];
    const label = (team) => you ? (team === you.team ? 'Your team' : 'Enemy team') : (team === 'ORDER' ? 'Blue team' : 'Red team');
    host.innerHTML = `<div class="live-teams">${teams.map(team => `
        <section class="live-team">
            <h3>${label(team)}</h3>
            ${state.players.filter(p => p.team === team).map(rowHtml).join('')}
        </section>`).join('')}</div>`;
}

/** "N games together" for allies, from the Allies page's table (#11). */
async function loadTogether(gen) {
    try {
        const map = await loadTeammates();
        if (gen !== generation || !state) return;
        state.together = map;
        state.players.filter(p => p.team === state.allyTeam && !p.isYou).forEach(p => renderRow(p.index));
    } catch (err) {
        console.warn('Live game: games together unavailable:', err.message);
    }
}

async function detect() {
    const gen = ++generation;
    const btn = document.getElementById('liveDetectBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Detecting…'; }
    setStatus('');

    let players;
    try {
        const [list, active] = await Promise.all([getPlayerList(), getActivePlayerName()]);
        if (gen !== generation) return;
        if (!list) {
            state = null;
            document.getElementById('liveGame').innerHTML = '';   // the status line says it all
            setStatus(NO_GAME);
            return;
        }
        players = parsePlayers(list, active, getChampionList());
        const you = players.find(p => p.isYou);
        state = { players, entries: players.map(() => null), together: null, allyTeam: you ? you.team : null };
        render();
        setStatus('Looking up players…');
    } finally {
        if (btn && gen === generation) { btn.disabled = false; btn.textContent = 'Detect live game'; }
    }

    let togetherStarted = false;
    const result = await loader.load(players, {
        onUpdate: (i, entry) => {
            if (gen !== generation) return;
            state.entries[i] = entry;
            renderRow(i);
            if (!togetherStarted && state.allyTeam) { togetherStarted = true; loadTogether(gen); }
        },
        onProgress: ({ done, total }) => {
            if (gen === generation) setStatus(`Recent games: ${done} of ${total} players`);
        },
        isCancelled: () => gen !== generation,
        ownGames: window.matchesData || [],
    });
    if (gen !== generation) return;
    if (result.error) setStatus(result.error, true);
    else if (result.ok) setStatus('');
}

window.openLiveGamePanel = function () {
    const btn = document.getElementById('liveDetectBtn');
    if (btn && !btn.dataset.wired) {
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
            detect().catch(err => {
                console.error('Live game failed:', err);
                setStatus(`Live game failed: ${err.message}`, true);
            });
        });
    }
    if (!document.querySelector('#liveGame .live-teams')) render();
};
