/**
 * sampleGames.js — Settings → "Download sample games from other players".
 *
 * Off by default (config.sampleGames). It acts as soon as it's clicked, like
 * the other buttons at the bottom of Settings. While on, a download runs in the
 * background after every successful sync (services/sampleLoader.js) and is
 * held back while your own sync, a live game or the Live page needs Riot's
 * rate limit (holdSampleDownload / releaseSampleDownload).
 *
 * window.sampleRows / window.sampleGroupsNow are what the pages read: the
 * stored sample rows and your current two groups ([] / [] while off).
 */

const { loadConfig, updateConfig } = require('../services/config');
const riotApi = require('../services/riotApi');
const sampleStore = require('../services/sampleStore');
const { createSampleLoader } = require('../services/sampleLoader');
const { topChampions, sampleGroups, championKeyOf, groupOf, PLAYERS_PER_GROUP } = require('../services/sampleSelect');
const { getChampionList } = require('../services/dataDragon');
const { getLpReadings, statsRowFor } = require('../services/matchService');
const winCurve = require('../services/winCurve');
const { buildModel, needsRefit, MIN_GAMES } = require('../services/winModel');

const loader = createSampleLoader({ api: riotApi, store: sampleStore, statsOf: statsRowFor });
const holds = new Set();
let running = null;
let progress = '';
// Queued downloads: null = your top 3 champions (after a sync), [name] = one
// champion asked for from the Champions page
const requests = [];
let current = null;                 // the request being downloaded
let lastChampionRun = null;         // { name, found, stopped, message, stored } of the last button run

window.sampleRows = [];
window.sampleGroupsNow = [];

const enabled = () => loadConfig().sampleGames === true;
window.sampleGamesEnabled = enabled;
window.holdSampleDownload = (name) => { holds.add(name); };
window.releaseSampleDownload = (name) => { holds.delete(name); };

async function currentGroups() {
    const readings = await getLpReadings('solo');
    return sampleGroups(readings && readings.length ? readings[readings.length - 1] : null);
}

function timeAgo(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
}

const STOP_TEXT = {
    'no-rank': "No Solo/Duo rank yet, so there's no level to compare with.",
    'no-champions': 'No Solo/Duo games in the last 2 patches.',
    key: 'Riot rejected the API key; update it above.',
    paused: 'Paused for your own sync or a live game; it continues after the next sync.',
};

/** The status lines under the switch (plain text; the element uses white-space: pre-line). */
function statusText() {
    if (!enabled()) return '';
    if (running) return progress || 'Downloading sample games…';
    const last = loadConfig().sampleGamesLastRun;
    if (!last) return 'Waiting for the next sync to start the first download.';
    const lines = [];
    if (last.stopped && STOP_TEXT[last.stopped]) lines.push(STOP_TEXT[last.stopped]);
    else if (last.stopped === 'error') lines.push(`Download stopped: ${last.message || 'unknown error'}`);

    const groups = window.sampleGroupsNow || [];
    const counts = (last.champions || []).map(name => {
        const rows = (window.sampleRows || []).filter(r => r.championName === name);
        const parts = groups.map(g => `${g.label} ${rows.filter(r => groupOf(r, groups) === g.key).length}`);
        return `${name} — ${parts.join(' · ')}`;
    });
    if (counts.length) lines.push(`Last download ${timeAgo(last.at)}: ${counts.join('; ')}`);

    for (const name of last.champions || []) {
        for (const g of groups) {
            const n = last.found && last.found[name] && last.found[name][g.key];
            if (n != null && n < PLAYERS_PER_GROUP) lines.push(`Found ${n} of ${PLAYERS_PER_GROUP} ${g.label} ${name} players.`);
        }
    }
    if (typeof window.winModelStatusText === 'function') {
        const model = window.winModelStatusText();
        if (model) lines.push(model);
    }
    return lines.join('\n');
}

function renderStatus() {
    const el = document.getElementById('sampleGamesStatus');
    if (!el) return;
    const text = statusText();
    el.textContent = text;
    el.hidden = !text;
}
window.renderSampleStatus = renderStatus;

/** Reload the stored sample rows and your groups into window.* ([] while off). */
window.loadSampleRows = async function () {
    if (!enabled()) {
        window.sampleRows = [];
        window.sampleGroupsNow = [];
        renderStatus();
        return;
    }
    try {
        window.sampleGroupsNow = await currentGroups();
        // Games downloaded before rows carried stats get them from the stored blobs, once
        await sampleStore.fillMissingStats(statsRowFor);
        window.sampleRows = await sampleStore.getSampleRows();
    } catch (err) {
        console.warn('Loading sample games failed:', err.message);
        window.sampleRows = [];
    }
    renderStatus();
};

/** Delete sample games older than 90 days (runs at startup, switch on or off). */
window.pruneSampleGames = async function () {
    try { await sampleStore.prune(Date.now()); } catch (err) { console.warn('Pruning sample games failed:', err.message); }
};

async function downloadOnce(asked = null) {
    const groups = await currentGroups();
    const list = getChampionList();
    const champions = (asked || topChampions(window.matchesData || []))
        .map(name => ({ name, key: championKeyOf(name, list) }))
        .filter(c => c.key != null);

    let outcome;
    if (!groups.length) outcome = { stopped: 'no-rank' };
    else if (!champions.length) outcome = { stopped: 'no-champions' };
    else {
        let selfPuuid = null;
        try { selfPuuid = await window.currentAccountPuuid(); } catch { selfPuuid = null; }
        outcome = await loader.run({
            champions, groups, selfPuuid,
            shouldStop: () => (!enabled() ? 'off' : holds.size ? [...holds][0] : null),
            onProgress: (text) => {
                progress = text;
                renderStatus();
                // The Champions page shows the progress of a download it asked for
                const el = document.getElementById('chSampleStatus');
                if (el && asked && asked.includes(el.dataset.champ)) el.textContent = text;
            },
        });
    }
    if (asked) {
        lastChampionRun = { name: asked[0], found: outcome.found || {}, stopped: outcome.stopped || null,
            message: outcome.message || null, stored: outcome.stored || 0 };
    } else {
        updateConfig({
            sampleGamesLastRun: {
                at: Date.now(), stopped: outcome.stopped || null, message: outcome.message || null,
                found: outcome.found || {}, champions: champions.map(c => c.name),
            },
        });
    }
    console.log('Sample games:', asked || 'top 3', outcome);
    return outcome;
}

/**
 * Queue a download and run the queue unless it's running. No argument: your
 * top 3 champions (after every sync). { champions: [name] }: one champion,
 * from its button on the Champions page. A run paused for your sync or a live
 * game goes back to the front of the queue, and the sync's own request
 * starts the queue again.
 */
window.runSampleDownload = function ({ champions = null } = {}) {
    if (!enabled()) return Promise.resolve();
    const key = r => (r ? r.join(',') : '');
    if (!requests.some(r => key(r) === key(champions))) requests.push(champions);
    if (running) return running;
    running = (async () => {
        try {
            while (requests.length && enabled() && !holds.size) {
                current = requests.shift();
                const outcome = await downloadOnce(current);
                if (outcome && outcome.stopped === 'paused') { requests.unshift(current); break; }
                await window.loadSampleRows();
                if (typeof window.maybeRefitWinModel === 'function') await window.maybeRefitWinModel();
                if (current && typeof window.refreshSamplePages === 'function') window.refreshSamplePages();
            }
        } catch (err) {
            console.warn('Sample download failed:', err.message);
        } finally {
            running = null;
            current = null;
            progress = '';
            renderStatus();
            if (typeof window.refreshSamplePages === 'function') window.refreshSamplePages();
        }
    })();
    renderStatus();
    return running;
};

/** The Champions page's "Download sample games" button for one champion. */
window.downloadSampleChampion = function (name) {
    if (!enabled() || !name) return;
    window.runSampleDownload({ champions: [name] });
    if (typeof window.refreshSamplePages === 'function') window.refreshSamplePages();
};

/**
 * What the Champions page shows next to a champion's button:
 * { auto, busy, queued, text } (auto = one of your top 3, downloaded after every sync).
 */
window.sampleChampionState = function (name) {
    const auto = topChampions(window.matchesData || []).includes(name);
    const busy = !!(current && current.includes(name));
    const queued = requests.some(r => r && r.includes(name));
    let text = '';
    if (busy) text = progress || 'Downloading…';
    else if (queued) text = 'Waiting for the download that is running…';
    else if (lastChampionRun && lastChampionRun.name === name) {
        const r = lastChampionRun;
        const groups = window.sampleGroupsNow || [];
        if (r.stopped === 'no-champions') text = "This champion's Riot data isn't loaded yet; try again in a moment.";
        else if (r.stopped && STOP_TEXT[r.stopped]) text = STOP_TEXT[r.stopped];
        else if (r.stopped === 'error') text = `Download stopped: ${r.message || 'unknown error'}`;
        else {
            const short = groups.filter(g => (r.found[name] || {})[g.key] < PLAYERS_PER_GROUP)
                .map(g => `found ${(r.found[name] || {})[g.key] || 0} of ${PLAYERS_PER_GROUP} ${g.label} players`);
            text = `${r.stored} new game${r.stored === 1 ? '' : 's'}${short.length ? ` · ${short.join(', ')}` : ''}.`;
        }
    }
    return { auto, busy, queued, text };
};

// ── The fitted win-chance curve ─────────────────────────────────────────────

/** Point winCurve at the saved model while the switch is on (today's curve otherwise). */
window.applyWinCurveSetting = function () {
    const config = loadConfig();
    winCurve.configure({ enabled: config.sampleGames === true, model: config.winModel || null });
};

/** Every game with features and a result: yours (remakes out) and sample games, once each. */
function trainingGames() {
    const games = new Map();
    for (const m of window.matchesData || []) {
        if (!m.winFeatures || (typeof window.isRemake === 'function' && window.isRemake(m))) continue;
        games.set(m.matchId, { matchId: m.matchId, winFeatures: m.winFeatures, blueWin: (m.teamId === 100) === (m.win === 1) ? 1 : 0 });
    }
    for (const r of window.sampleRows || []) {
        if (r.winFeatures && !games.has(r.matchId)) games.set(r.matchId, { matchId: r.matchId, winFeatures: r.winFeatures, blueWin: r.blueWin ? 1 : 0 });
    }
    return [...games.values()];
}

/** Refit after 25 more games or a week (winModel.needsRefit); then re-point the curve. */
window.maybeRefitWinModel = async function () {
    if (!enabled()) return;
    const games = trainingGames();
    const saved = loadConfig().winModel;
    if (!needsRefit(saved, games.length, Date.now())) return;
    // Let the page paint first: a fit takes ~0.1–0.3 s
    await new Promise(r => setTimeout(r, 0));
    const model = buildModel(games, { now: Date.now() });
    const { bands, ...kept } = model;
    updateConfig({ winModel: kept });
    console.log('Win-chance model:', kept);
    window.applyWinCurveSetting();
    renderStatus();
    if (typeof window.refreshSamplePages === 'function') window.refreshSamplePages();
};

window.winModelStatusText = function () {
    const model = loadConfig().winModel;
    if (!enabled() || !model) return '';
    if (model.ok) return `Win chance fitted on ${model.games} games.`;
    if (model.reason === 'few-games') return `Win chance: not enough games to fit yet (needs ${MIN_GAMES}).`;
    return "Win chance: the fitted curve didn't pass its check; using the standard one.";
};

/**
 * The Settings switch: saved and applied at once. Turning it on runs a quiet
 * sync, which also indexes your games' win features and then starts the
 * download; turning it off puts today's curve back straight away.
 */
window.setSampleGames = async function (on) {
    updateConfig({ sampleGames: on === true });
    window.applyWinCurveSetting();
    await window.loadSampleRows();
    if (on && !window.isSyncing) {
        if (typeof window.handleSync === 'function') window.handleSync({ auto: true });
        else window.runSampleDownload();
    }
    if (typeof window.refreshSamplePages === 'function') window.refreshSamplePages();
};

window.applyWinCurveSetting();
