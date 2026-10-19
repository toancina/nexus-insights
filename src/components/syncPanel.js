/**
 * syncPanel.js — Sync button, progress bar, and rate-limit cooldown.
 *
 * Calls window.loadMatchHistory and window.fetchAndDisplayRankData
 * (defined in renderer.js) at runtime so there are no circular deps.
 */

const {
    syncMatches,
    fillGaps,
    backfillTimelines,
    backfillAdvancedStats,
    backfillComputedStats,
    attachLpReadingsToMatches
} = require('../services/matchService');
const { loadConfig } = require('../services/config');
const { formatInt } = require('./dom');
const { friendlyRiotError, rateLimitWaitSeconds } = require('../services/riotErrors');

// Only after a 429 the rate limiter couldn't absorb (#75): every call goes
// through riotApi's limiter, so a sync that wasn't rate limited leaves the
// button usable straight away.
let syncCooldownInterval = null;
let syncCooldownEnd      = 0;

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

function startSyncCooldown(seconds) {
    const btn     = document.getElementById('syncBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnIcon = btn.querySelector('.btn-icon');

    syncCooldownEnd    = Date.now() + seconds * 1000;
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
    count.textContent = `${formatInt(current)} / ${formatInt(total)}`;

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
 *   the manual-use guards: no message when no account is set or a sync is
 *   already running, no rate-limit cooldown before or after it.
 * @param {boolean} [options.fillGaps] Settings → Fill gaps (#18).
 */
window.handleSync = async function (options = {}) {
    const auto   = options.auto === true;
    // Always the configured account: the top bar only shows it (#73). Typing
    // someone else's Riot ID there used to store their games as yours.
    const config = loadConfig();
    const name = (config.gameName || '').trim();
    const tag  = (config.tagLine  || '').trim();

    if (!name || !tag) {
        if (!auto) {
            updateStatus('error', 'No Account Set', 'Add your Riot ID in Settings first');
            if (typeof window.openSettings === 'function') window.openSettings();
        }
        return;
    }
    if (syncCooldownInterval && !auto) {
        updateStatus('error', 'Rate Limited', 'Riot asked to wait: the button counts down until it can sync again');
        return;
    }
    // Never run two syncs at once, however they were started. Say so when
    // it was a click (a post-game auto sync just skips: one is running).
    if (window.isSyncing) {
        if (!auto) updateStatus('error', 'Sync Already Running',
            options.fillGaps === true ? 'Run Fill gaps again once the current sync has finished'
                                      : 'Wait for the current sync to finish');
        return;
    }

    setButtonLoading(true);
    // The LP watcher polls the same endpoints; this tells it to stand down so
    // the two don't compete for the rate limiter.
    window.isSyncing = true;

    try {
        updateStatus('loading', 'Finding Account', `Looking up ${name}#${tag}...`);
        const puuid = await window.currentAccountPuuid();

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
            updateStatus('loading', 'Fetching Timelines', `${formatInt(current)}/${formatInt(total)} match timelines...`);
            updateProgress(current, total);
        });
        hideProgress();

        const advancedResult = await backfillAdvancedStats((current, total) => {
            updateStatus('loading', 'Computing Advanced Stats', `${formatInt(current)}/${formatInt(total)} matches...`);
            updateProgress(current, total);
        });
        hideProgress();

        // Fill the precomputed analytics columns for any match that predates
        // them. Once done, the analytics tabs never touch the JSON blobs.
        const computedResult = await backfillComputedStats((current, total) => {
            updateStatus('loading', 'Preparing Analytics', `${formatInt(current)}/${formatInt(total)} matches...`);
            updateProgress(current, total);
        });
        hideProgress();

        // Reload match history (skip rank fetch — already done above)
        await window.loadMatchHistory(true);

        const advancedMsg = advancedResult.total  > 0 ? `, ${formatInt(advancedResult.updated)} stats computed`   : '';
        const computedMsg = computedResult.total  > 0 ? `, ${formatInt(computedResult.done)} matches indexed`     : '';
        const timelineMsg = backfillResult.total   > 0 ? `, ${formatInt(backfillResult.updated)} timelines added`  : '';
        if (auto) {
            // Quieter wording — this one ran on its own, off the back of a
            // game the user just played.
            updateStatus('success', 'Game Logged',
                result.newMatches > 0
                    ? `${formatInt(result.newMatches)} new match added to your history`
                    : 'No new match found yet — it may still be publishing');
        } else if (gaps) {
            updateStatus('success', 'Gaps Filled', result.missing > 0
                ? `${result.missing} missing games found, ${formatInt(result.newMatches)} added${timelineMsg}${advancedMsg}${computedMsg}`
                : `Nothing missing: all ${result.listed} games since the season started are stored`);
        } else {
            updateStatus('success', 'Sync Complete', `${formatInt(result.newMatches)} new matches added${timelineMsg}${advancedMsg}${computedMsg}`);
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

        // Let the caller see whether anything actually landed, so the
        // post-game watcher knows whether to try again.
        return { newMatches: result.newMatches || 0 };

    } catch (err) {
        console.error('Sync error:', err.message);
        hideProgress();

        // 401/403 = bad or expired key, 404 = unknown Riot ID, 429 = rate limited
        let errorMessage = friendlyRiotError(err);

        // syncMatches stops at the first game it couldn't fetch (oldest
        // first), so the games before it are stored and the next sync
        // carries on from there. Show what did land.
        if (err.savedBeforeStop > 0) {
            errorMessage += ` (${err.savedBeforeStop} new games were saved; ${options.fillGaps ? 'run Fill gaps' : 'sync'} again for the rest)`;
            try { await window.loadMatchHistory(true); } catch (e) { console.warn('Reload after partial sync failed:', e.message); }
        }

        updateStatus('error', 'Sync Failed', errorMessage);
        // Riot still said "too many" after the limiter's retries: wait as told
        const wait = rateLimitWaitSeconds(err);
        if (wait && !auto) startSyncCooldown(wait);
        return { newMatches: 0, error: errorMessage };
    } finally {
        window.isSyncing = false;
        if (!syncCooldownInterval) setButtonLoading(false);
    }
};

module.exports = { setButtonLoading, updateProgress, hideProgress };
