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
const { getLpReadings } = require('../services/matchService');

const loader = createSampleLoader({ api: riotApi, store: sampleStore });
const holds = new Set();
let running = null;
let runAgain = false;
let progress = '';

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

async function downloadOnce() {
    const groups = await currentGroups();
    const list = getChampionList();
    const champions = topChampions(window.matchesData || [])
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
            onProgress: (text) => { progress = text; renderStatus(); },
        });
    }
    updateConfig({
        sampleGamesLastRun: {
            at: Date.now(), stopped: outcome.stopped || null, message: outcome.message || null,
            found: outcome.found || {}, champions: champions.map(c => c.name),
        },
    });
    console.log('Sample games:', outcome);
}

/**
 * Start a download unless one is running; a request during a run starts
 * another one after it (a sync that paused the run asks for the next one).
 */
window.runSampleDownload = function () {
    if (!enabled()) return Promise.resolve();
    if (running) { runAgain = true; return running; }
    running = (async () => {
        try {
            do {
                runAgain = false;
                if (holds.size) break;
                await downloadOnce();
                await window.loadSampleRows();
                if (typeof window.maybeRefitWinModel === 'function') await window.maybeRefitWinModel();
            } while (runAgain && enabled());
        } catch (err) {
            console.warn('Sample download failed:', err.message);
        } finally {
            running = null;
            progress = '';
            renderStatus();
        }
    })();
    renderStatus();
    return running;
};

/** The Settings switch: saved and applied at once. */
window.setSampleGames = async function (on) {
    updateConfig({ sampleGames: on === true });
    if (typeof window.applyWinCurveSetting === 'function') window.applyWinCurveSetting();
    await window.loadSampleRows();
    if (on && !window.isSyncing) window.runSampleDownload();
    if (typeof window.refreshSamplePages === 'function') window.refreshSamplePages();
};
