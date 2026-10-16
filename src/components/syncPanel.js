/**
 * syncPanel.js — Sync button, progress bar, and rate-limit cooldown.
 *
 * Calls window.loadMatchHistory and window.fetchAndDisplayRankData
 * (defined in renderer.js) at runtime so there are no circular deps.
 */

const { getPuuidByRiotId }    = require('../services/riotApi');
const {
    syncMatches,
    fillGaps,
    backfillTimelines,
    backfillAdvancedStats,
    backfillComputedStats,
    attachLpReadingsToMatches
} = require('../services/matchService');
const { loadConfig } = require('../services/config');

let syncCooldownInterval = null;
let syncCooldownEnd      = 0;
const SYNC_COOLDOWN_SECONDS = 120; // matches Riot's 2-minute rate-limit window

// ---------------------------------------------------------------------------
// STATUS HELPER (forwards to renderer's showToast)
// ---------------------------------------------------------------------------
function updateStatus(type, title, message) {
    // Errors carry instructions (e.g. how to renew an expired key) — give them
    // long enough to actually be read.
    window.showToast(title, message, type === 'error' ? 9000 : 3000);
}

// ---------------------------------------------------------------------------
// BUTTON STATE
// ---------------------------------------------------------------------------
function setButtonLoading(loading) {
    const btn     = document.getElementById('syncBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnIcon = btn.querySelector('.btn-icon');
    btn.disabled  = loading;
    if (loading) {
        btnIcon.innerHTML   = '<div class="spinner"></div>';
        btnText.textContent = 'Syncing...';
    } else {
        btnIcon.innerHTML   = '&#8635;';
        btnText.textContent = 'Sync Matches';
    }
}

function startSyncCooldown() {
    const btn     = document.getElementById('syncBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnIcon = btn.querySelector('.btn-icon');

    syncCooldownEnd    = Date.now() + SYNC_COOLDOWN_SECONDS * 1000;
    btn.disabled       = true;
    btnIcon.innerHTML  = '&#9202;';

    function tick() {
        const remaining = Math.max(0, Math.ceil((syncCooldownEnd - Date.now()) / 1000));
        if (remaining <= 0) {
            clearInterval(syncCooldownInterval);
            syncCooldownInterval = null;
            btn.disabled         = false;
            btnIcon.innerHTML    = '&#8635;';
            btnText.textContent  = 'Sync Matches';
            return;
        }
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        btnText.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    tick();
    syncCooldownInterval = setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------
// PROGRESS BAR
// ---------------------------------------------------------------------------
function updateProgress(current, total, stats) {
    const container = document.getElementById('progressContainer');
    const fill      = document.getElementById('progressFill');
    const count     = document.getElementById('progressCount');
    const details   = document.getElementById('progressDetails');

    container.classList.add('visible');
    fill.style.width  = (total > 0 ? (current / total) * 100 : 0) + '%';
    count.textContent = `${current} / ${total}`;

    if (stats && details) {
        details.style.display = 'block';
        document.getElementById('progressNew').textContent      = stats.new           || 0;
        document.getElementById('progressFiltered').textContent = stats.queueFiltered || 0;
        document.getElementById('progressExisting').textContent = stats.alreadyInDB   || 0;
    }
}

function hideProgress() {
    const container = document.getElementById('progressContainer');
    const fill      = document.getElementById('progressFill');
    const details   = document.getElementById('progressDetails');
    container.classList.remove('visible');
    fill.style.width = '0%';
    if (details) details.style.display = 'none';
}

// ---------------------------------------------------------------------------
// MAIN SYNC HANDLER
// ---------------------------------------------------------------------------
/**
 * @param {object} [options]
 * @param {boolean} [options.auto] Triggered by the live-game watcher rather
 *   than the button. An auto sync pulls in one just-finished game, so it skips
 *   the manual-use guards: it doesn't complain when fields are blank (it falls
 *   back to the saved config), it isn't blocked by the cooldown, and it doesn't
 *   start one afterwards — a two-minute lockout after every game would make the
 *   button useless exactly when you want to press it.
 */
window.handleSync = async function (options = {}) {
    const auto   = options.auto === true;
    const config = loadConfig();
    const name = document.getElementById('gameName').value.trim() || (auto ? config.gameName : '');
    const tag  = document.getElementById('tagLine').value.trim()  || (auto ? config.tagLine  : '');

    if (!name || !tag) {
        if (!auto) updateStatus('error', 'Missing Information', 'Please enter both your game name and tag');
        return;
    }
    if (syncCooldownInterval && !auto) {
        updateStatus('error', 'Cooldown Active', 'Please wait for the cooldown to finish');
        return;
    }
    // Never run two syncs at once, however they were started.
    if (window.isSyncing) return;

    setButtonLoading(true);
    // The LP watcher polls the same endpoints; this tells it to stand down so
    // the two don't compete for the rate limiter.
    window.isSyncing = true;

    try {
        updateStatus('loading', 'Finding Account', `Looking up ${name}#${tag}...`);
        const puuid = await getPuuidByRiotId(name, tag);

        // Fetch rank before heavy API calls to avoid rate-limit issues
        await window.fetchAndDisplayRankData();

        // Fill gaps (#18, Settings): list every game since the season started
        // and store the missing ones. Same per-game path and follow-up steps.
        const gaps = options.fillGaps === true;
        let result;
        if (gaps) {
            updateStatus('loading', 'Filling Gaps', 'Listing every game since the season started...');
            result = await fillGaps(puuid, (current, total, status, stats) => {
                if (status === 'listing') {
                    updateStatus('loading', 'Filling Gaps', `Listing every game since the season started: ${stats.listed} so far...`);
                } else {
                    updateProgress(current, total, stats);
                }
            });
        } else {
            updateStatus('loading', 'Syncing Matches', 'Fetching your recent match history...');
            result = await syncMatches(puuid, (current, total, status, stats) => {
                updateProgress(current, total, stats);
            });
        }
        hideProgress();

        const backfillResult = await backfillTimelines((current, total) => {
            updateStatus('loading', 'Fetching Timelines', `${current}/${total} match timelines...`);
            updateProgress(current, total);
        });
        hideProgress();

        const advancedResult = await backfillAdvancedStats((current, total) => {
            updateStatus('loading', 'Computing Advanced Stats', `${current}/${total} matches...`);
            updateProgress(current, total);
        });
        hideProgress();

        // Fill the precomputed analytics columns for any match that predates
        // them. Once done, the analytics tabs never touch the JSON blobs.
        const computedResult = await backfillComputedStats((current, total) => {
            updateStatus('loading', 'Preparing Analytics', `${current}/${total} matches...`);
            updateProgress(current, total);
        });
        hideProgress();

        // Reload match history (skip rank fetch — already done above)
        await window.loadMatchHistory(true);

        const advancedMsg = advancedResult.total  > 0 ? `, ${advancedResult.updated} stats computed`   : '';
        const computedMsg = computedResult.total  > 0 ? `, ${computedResult.done} matches indexed`     : '';
        const timelineMsg = backfillResult.total   > 0 ? `, ${backfillResult.updated} timelines added`  : '';
        if (auto) {
            // Quieter wording — this one ran on its own, off the back of a
            // game the user just played.
            updateStatus('success', 'Game Logged',
                result.newMatches > 0
                    ? `${result.newMatches} new match added to your history`
                    : 'No new match found yet — it may still be publishing');
        } else if (gaps) {
            updateStatus('success', 'Gaps Filled', result.missing > 0
                ? `${result.missing} missing games found, ${result.newMatches} added${timelineMsg}${advancedMsg}${computedMsg}`
                : `Nothing missing: all ${result.listed} games since the season started are stored`);
        } else {
            updateStatus('success', 'Sync Complete', `${result.newMatches} new matches added${timelineMsg}${advancedMsg}${computedMsg}`);
        }

        // Every sync — manual click or the post-game auto-sync — is also a
        // chance to catch LP the watcher missed. The post-game retry loop can
        // give up early (a new game starting, a slow Riot response, a thrown
        // error mid-retry) and leave a game with no reading at all; the old
        // code here only re-linked readings that already existed, which does
        // nothing if the capture itself never happened. Fetching fresh here
        // means "Sync Matches" alone is enough to backfill a missed game.
        try {
            if (typeof window.captureLpReadings === 'function') await window.captureLpReadings();
        } catch (e) { console.warn('LP capture on sync failed:', e.message); }

        // Readings taken before their match was synced have no match to point
        // at yet. Now that the games are in the DB, they can be attributed.
        // (Also covers readings captureLpReadings() above didn't newly touch.)
        try {
            const { linked } = await attachLpReadingsToMatches();
            if (linked > 0) {
                if (typeof window.invalidateLpCache === 'function') window.invalidateLpCache();
                if (typeof window.renderLpCharts === 'function') window.renderLpCharts();
            }
        } catch (e) { console.warn('LP attribution failed:', e.message); }

        // An auto sync fetches a single new game — nowhere near the rate
        // limit, and locking the button for two minutes after every match
        // would be worse than useless.
        if (!auto) startSyncCooldown();

        // Let the caller see whether anything actually landed, so the
        // post-game watcher knows whether to try again.
        return { newMatches: result.newMatches || 0 };

    } catch (err) {
        console.error('Sync error:', err.message);
        hideProgress();

        let errorMessage = err.message;
        // Riot answers 401 for a malformed/unknown key (e.g. pasted with a
        // stray space) and 403 for an expired one. Development keys expire
        // every 24 hours, so this is the error a new user hits most — say
        // what to do, not just what went wrong.
        if (err.response?.status === 401 || err.response?.status === 403) {
            errorMessage = 'Riot API key invalid or expired. Development keys last 24 hours: ' +
                           'get a new one at developer.riotgames.com and paste it in Settings (⚙).';
        }
        else if (err.response?.status === 404) errorMessage = 'Player not found. Check your Riot ID';
        else if (err.response?.status === 429) errorMessage = 'Rate limited. Please wait a moment';

        // syncMatches stops at the first game it couldn't fetch (oldest
        // first), so the games before it are stored and the next sync
        // carries on from there. Show what did land.
        if (err.savedBeforeStop > 0) {
            errorMessage += ` (${err.savedBeforeStop} new games were saved; ${options.fillGaps ? 'run Fill gaps' : 'sync'} again for the rest)`;
            try { await window.loadMatchHistory(true); } catch (e) { console.warn('Reload after partial sync failed:', e.message); }
        }

        updateStatus('error', 'Sync Failed', errorMessage);
        return { newMatches: 0, error: errorMessage };
    } finally {
        window.isSyncing = false;
        if (!syncCooldownInterval) setButtonLoading(false);
    }
};

module.exports = { setButtonLoading, updateProgress, hideProgress };
