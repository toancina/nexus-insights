// ============================================================
// IMPORTS — services (browser context, Node via nodeIntegration)
// ============================================================
const { ipcRenderer } = window.require('electron');
const { getPuuidByRiotId, PLATFORM_ROUTING } = window.require('./services/riotApi');
const { getLiveGame, testConnection } = window.require('./services/liveClient');
const {
    getMatches, getStats, getMatchById, getLeagueData,
    saveLpSnapshot,
    loadRawJson, clearJsonCache, backfillComputedStats,
    recordLpReading, attachLpReadingsToMatches, getLpDeltasByMatch
} = window.require('./services/matchService');
const {
    renderMatchTable, renderMatchRows, getRankedStats
} = window.require('./components/tableRenderer');
const { loadGameData, getDDragonBase } = window.require('./services/dataDragon');
const { loadConfig, saveConfig, isConfigValid, userDataPath } = window.require('./services/config');

// ============================================================
// IMPORTS — UI component modules (self-register window.* as side-effects)
// ============================================================
window.require('./components/analyticsEngine');
window.require('./components/statHistory');   // registers toggleStatHistory, syncStatHistory, isStatChartable
window.require('./components/matchModal');    // registers toggleRowExpand (expanded 10-player rows)
window.require('./components/syncPanel');     // registers handleSync
window.require('./components/calendarPanel'); // registers initCalendar, renderLpCharts, calculateTimeInsights, toggleCalPicker
window.require('./components/lpCheckpoints');  // the Checkpoints popover on the LP cards
window.require('./components/filtersPanel'); // registers applyFilters, toggleAllFilters, clearGameModeFilters
window.require('./components/coachingPanel'); // registers renderCoachingPanel
window.require('./components/windowControls'); // registers initWindowControls
window.require('./components/updateButton');   // registers initUpdateButton (titlebar ⟳)
window.require('./components/skinsPanel');     // registers applySavedSkin, openSkinsPanel
window.require('./components/chatPanel');      // registers openChatPanel (Ollama chat page)
window.require('./components/laneGapChart');  // registers renderLaneGapChart (Lane Phase chart, #12)
window.require('./components/roleBreakdown');  // registers renderRoleBreakdown (Roles table on Overview)
window.require('./components/deathMapPanel');  // registers renderDeathMap (map under Death Review)
window.require('./components/championsPanel'); // registers openChampionsPanel (Champions page)
window.require('./components/teammatesPanel'); // registers openTeammatesPanel (Teammates page)
window.require('./components/periodFilter');   // registers updatePeriodDropdown, applyPeriodFilter, renderPatchWinRates

// Destructure named exports needed inside renderer.js itself
const {
    renderRunes, renderSummonerSpells, formatDamage, getChampionIcon
} = window.require('./components/matchCard');
const { initTooltips }              = window.require('./components/tooltipSystem');
const {
    activeQueueFilters, initializeFilters, updateChampionDropdown, updateRoleDropdown
} = window.require('./components/filtersPanel');

// ============================================================
// SHARED GLOBAL STATE  (window.* so component files can read/write them)
// ============================================================
window.matchesData         = [];

/**
 * Remakes (games abandoned in the first few minutes because someone didn't
 * connect) are real rows worth seeing in match history, but they are noise in
 * every average: 0/0/0 KDA, no CS, no damage, and Riot still marks one side as
 * the winner. They are excluded from all statistics.
 *
 * Uses the stored flag (Riot's own gameEndedInEarlySurrender) and falls back to
 * duration for rows that predate the column.
 */
window.REMAKE_MAX_SECONDS = 300;
window.isRemake = function (m) {
    if (m.isRemake !== null && m.isRemake !== undefined) return m.isRemake === 1;
    return (m.gameDuration || 0) < window.REMAKE_MAX_SECONDS;
};
window.excludeRemakes = (list) => (list || []).filter(m => !window.isRemake(m));
window.DDRAGON_BASE        = getDDragonBase();   // fallback until loadGameData() picks the current version
window.QUEUE_NAMES         = {
    420: 'Ranked Solo',  440: 'Ranked Flex',
    710: 'Ranked Premade',
    400: 'Normal Draft', 430: 'Normal Blind',
    480: 'Swiftplay',   490: 'Quickplay',
    700: 'Clash'
};
window.selectedDates       = new Set(); // reserved for future calendar day-selection feature
window.displayedMatchCount = 50;
window.activeAnalyticsTab  = 'Overview';
window.currentFilteredMatches = [];
window.currentPreviousMatches = [];

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(title, message, duration = 3000) {
    const toast        = document.getElementById('toastNotification');
    const toastTitle   = document.getElementById('toastTitle');
    const toastMessage = document.getElementById('toastMessage');
    toastTitle.textContent   = title;
    toastMessage.textContent = message || '';
    toast.classList.add('show');
    setTimeout(hideToast, duration);
}

function hideToast() {
    document.getElementById('toastNotification').classList.remove('show');
}

// Expose so syncPanel.js (and any future module) can call it
window.showToast = showToast;

// ============================================================
// SETUP / CONFIG MODAL
// ============================================================

function showSetupModal(isFirstTime = true) {
    const modal    = document.getElementById('setupModal');
    const title    = modal.querySelector('.setup-title');
    const subtitle = modal.querySelector('.setup-subtitle');
    const saveBtn  = document.getElementById('setupSaveBtn');

    if (isFirstTime) {
        title.textContent    = 'Welcome to Nexus Insights';
        subtitle.textContent = 'Enter your details to get started';
        saveBtn.textContent  = 'Save & Start';
    } else {
        title.textContent    = 'Settings';
        subtitle.textContent = 'Update your configuration';
        saveBtn.textContent  = 'Save Changes';
    }

    const config = loadConfig();
    document.getElementById('setupApiKey').value   = config.apiKey   || '';
    document.getElementById('setupGameName').value = config.gameName || '';
    document.getElementById('setupTagLine').value  = config.tagLine  || '';
    document.getElementById('setupPlatform').value = config.platform || 'euw1';
    syncRegionToPlatform();
    // Both default on for a config saved before these settings existed
    document.getElementById('setupAutoLogGames').checked = config.autoLogGames !== false;
    document.getElementById('setupCloseToTray').checked  = config.closeToTray  !== false;
    document.getElementById('setupStartOnLogin').checked = config.startOnLogin !== false;
    // main.js can register a login item on Windows and macOS, not on Linux
    document.getElementById('setupStartOnLoginRow').style.display = process.platform === 'linux' ? 'none' : '';
    document.getElementById('setupStartOnLoginTitle').textContent =
        process.platform === 'darwin' ? 'Open at login' : 'Start with Windows';
    document.getElementById('setupError').style.display = 'none';

    const dataDirEl = document.getElementById('dataDirPath');
    if (dataDirEl) {
        dataDirEl.textContent = userDataPath;
        dataDirEl.title       = userDataPath;
    }

    modal.classList.add('visible');
}

function hideSetupModal() {
    document.getElementById('setupModal').classList.remove('visible');
}

function openSettings() {
    showSetupModal(false);
}

window.hideSetupModal = hideSetupModal;

/** Settings → "Fill gaps" (#18): runs like a sync, with its progress on Analytics. */
window.fillGapsFromSettings = function () {
    hideSetupModal();
    window.switchTopTab('analytics');
    window.handleSync({ fillGaps: true });
};
window.openSettings   = openSettings;

/**
 * Region is not a free choice: Riot routes each server (platform) to a fixed
 * regional cluster. The Region box just displays that, derived from the Server
 * box, so the two can never disagree.
 */
function syncRegionToPlatform() {
    const platform = document.getElementById('setupPlatform').value;
    const regionEl = document.getElementById('setupRegion');
    regionEl.value = PLATFORM_ROUTING[platform] || 'europe';
}
window.syncRegionToPlatform = syncRegionToPlatform;

/**
 * The database and config.json live in the OS's per-user app-data directory,
 * not next to the source — that's where Windows expects them, and keeping a
 * live SQLite file out of a cloud-synced folder avoids sync corruption.
 * This just makes the location easy to find.
 */
/**
 * Settings → Export matches to CSV (#15): the matches the current period,
 * game-mode, champion, role and calendar filters show, remakes included,
 * scalar columns only.
 */
window.exportMatchesCsv = async function () {
    const rows = window.exportableMatches || window.matchesData || [];
    if (rows.length === 0) { showToast('Nothing to export', 'No matches match the current filters'); return; }
    try {
        const { matchesToCsv } = window.require('./services/csvExport');
        const d = new Date();
        const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const result = await ipcRenderer.invoke('csv:save', {
            defaultName: `nexus-matches-${stamp}.csv`,
            content: matchesToCsv(rows),
        });
        if (result.saved) showToast('Exported', `${rows.length} matches saved to ${result.filePath}`);
    } catch (err) {
        console.warn('CSV export failed:', err);
        showToast('Error', 'Could not export the matches');
    }
};

window.openDataFolder = function () {
    try {
        window.require('electron').shell.openPath(userDataPath);
    } catch (err) {
        console.warn('Could not open data folder:', err);
        showToast('Error', 'Could not open the data folder');
    }
};

window.saveSetup = function () {
    const apiKey   = document.getElementById('setupApiKey').value.trim();
    const gameName = document.getElementById('setupGameName').value.trim();
    const tagLine  = document.getElementById('setupTagLine').value.trim();
    const platform = document.getElementById('setupPlatform').value;
    // Derived, never chosen — see syncRegionToPlatform()
    const region   = PLATFORM_ROUTING[platform] || 'europe';
    const errorEl  = document.getElementById('setupError');

    const closeToTray  = document.getElementById('setupCloseToTray').checked;
    const startOnLogin = document.getElementById('setupStartOnLogin').checked;
    const autoLogGames = document.getElementById('setupAutoLogGames').checked;

    if (!apiKey) {
        errorEl.textContent  = 'API Key is required. Get one from developer.riotgames.com';
        errorEl.style.display = 'block';
        return;
    }
    if (!gameName || !tagLine) {
        errorEl.textContent  = 'Summoner Name and Tag are required';
        errorEl.style.display = 'block';
        return;
    }

    // Merge, don't replace: config.json also holds the skin, custom background
    // and coaching state, which this dialog doesn't show. Replacing the whole
    // object used to silently wipe them on every Settings save.
    if (saveConfig({ ...loadConfig(), apiKey, gameName, tagLine, region, platform, closeToTray, startOnLogin, autoLogGames })) {
        // The login-item registration lives in the OS, so only the main
        // process can apply it — tell it the new values took effect.
        try {
            ipcRenderer.send('settings:background', { closeToTray, startOnLogin });
        } catch (e) { console.warn('Could not update background settings:', e.message); }

        // Pick up an autoLogGames change without needing a restart
        if (typeof window.restartLpWatcher === 'function') window.restartLpWatcher();

        hideSetupModal();
        document.getElementById('gameName').value = gameName;
        document.getElementById('tagLine').value  = tagLine;
        window.loadMatchHistory();
    } else {
        errorEl.textContent  = 'Failed to save configuration. Please try again.';
        errorEl.style.display = 'block';
    }
};

function checkConfigOnStartup() {
    const config = loadConfig();
    if (isConfigValid(config)) {
        document.getElementById('gameName').value = config.gameName;
        document.getElementById('tagLine').value  = config.tagLine;
        return true;
    }
    showSetupModal(true);
    return false;
}

// ============================================================
// RANKED STATS DISPLAY (fallback from DB stats if API fails)
// ============================================================
function displayRankedStats(allMatches) {
    // Remakes count as neither a win nor a loss
    const rankedStats = getRankedStats(window.excludeRemakes(allMatches));
    const soloStats   = rankedStats.solo;
    const flexStats   = rankedStats.flex;

    if (soloStats.totalMatches > 0) {
        document.getElementById('soloWins').textContent    = soloStats.wins;
        document.getElementById('soloLosses').textContent  = soloStats.losses;
        document.getElementById('soloWinRate').textContent = soloStats.winRate + '%';
    }
    if (flexStats.totalMatches > 0) {
        document.getElementById('flexWins').textContent    = flexStats.wins;
        document.getElementById('flexLosses').textContent  = flexStats.losses;
        document.getElementById('flexWinRate').textContent = flexStats.winRate + '%';
    }
}

// ============================================================
// RANK DATA — fetch from Riot API and update rank cards
// ============================================================
// PUUID never changes for a given Riot ID, so resolving it once saves the
// watcher an API call on every poll.
let cachedPuuid = null;
let cachedPuuidFor = '';

async function resolvePuuid(name, tag) {
    const key = `${name}#${tag}`.toLowerCase();
    if (cachedPuuid && cachedPuuidFor === key) return cachedPuuid;
    cachedPuuid    = await getPuuidByRiotId(name, tag);
    cachedPuuidFor = key;
    return cachedPuuid;
}

window.fetchAndDisplayRankData = async function () {
    try {
        const config = loadConfig();
        const name   = document.getElementById('gameName').value.trim() || config.gameName;
        const tag    = document.getElementById('tagLine').value.trim()  || config.tagLine;
        if (!name || !tag) return;

        const puuid      = await resolvePuuid(name, tag);
        const leagueData = await getLeagueData(puuid);

        if (leagueData.solo) {
            const solo   = leagueData.solo;
            const soloWr = Math.round((solo.wins / (solo.wins + solo.losses)) * 100);
            document.getElementById('soloRankText').textContent = `${solo.tier} ${solo.rank} (${solo.leaguePoints} LP)`;
            document.getElementById('soloWins').textContent     = solo.wins;
            document.getElementById('soloLosses').textContent   = solo.losses;
            document.getElementById('soloWinRate').textContent  = soloWr + '%';
            document.getElementById('soloRankIcon').src         = `assets/ranks/emblem-${solo.tier.toLowerCase()}.png`;
            document.getElementById('rankedSoloCard').classList.remove('no-data');
            saveLpSnapshot('solo', solo.tier, solo.rank, solo.leaguePoints).catch(e => console.warn('LP save failed:', e));
        } else {
            document.getElementById('rankedSoloCard').classList.add('no-data');
        }

        if (leagueData.flex) {
            const flex   = leagueData.flex;
            const flexWr = Math.round((flex.wins / (flex.wins + flex.losses)) * 100);
            document.getElementById('flexRankText').textContent = `${flex.tier} ${flex.rank} (${flex.leaguePoints} LP)`;
            document.getElementById('flexWins').textContent     = flex.wins;
            document.getElementById('flexLosses').textContent   = flex.losses;
            document.getElementById('flexWinRate').textContent  = flexWr + '%';
            document.getElementById('flexRankIcon').src         = `assets/ranks/emblem-${flex.tier.toLowerCase()}.png`;
            document.getElementById('rankedFlexCard').classList.remove('no-data');
            saveLpSnapshot('flex', flex.tier, flex.rank, flex.leaguePoints).catch(e => console.warn('LP save failed:', e));
        } else {
            document.getElementById('rankedFlexCard').classList.add('no-data');
        }

        // Refresh LP charts after persisting new data
        if (typeof window.renderLpCharts === 'function') window.renderLpCharts();
    } catch (err) {
        console.error('Failed to fetch rank data:', err.message);
    }
};


// ============================================================
// LP WATCHER — background polling for per-match LP
// ============================================================
/**
 * Riot only ever reports your *current* LP — never a history, never a
 * per-game figure. So the only way to know what a single game was worth is to
 * read LP shortly before it and shortly after it.
 *
 * The League client's Live Client Data API (127.0.0.1:2999) tells us exactly
 * when a game starts and ends, so the app reacts to the real event instead of
 * polling Riot on a timer and hoping the interval happens to line up. That
 * local check is free — no API key, no rate limit — so it can run every few
 * seconds. Riot's API is only touched at the moments that matter:
 *
 *   game starts  -> take a "before" LP reading
 *   game ends    -> wait for Riot to publish the match, then sync it, take an
 *                   "after" reading, and attribute the difference to it
 *
 * A slow safety-net poll covers games the watcher wasn't around for (app
 * opened mid-session, games played on another PC).
 */
const LIVE_POLL_MS       = 10 * 1000;       // local call, costs nothing
const LP_FALLBACK_MS     = 15 * 60 * 1000;  // safety net for missed games
const POST_GAME_DELAY_MS = 45 * 1000;       // let Riot publish the match first

let liveWatchTimer  = null;
let lpFallbackTimer = null;
let livePollBusy    = false;
let wasInGame       = false;
let pendingEndTimer = null;

/**
 * Read LP for both queues and persist anything that moved.
 * Returns true when at least one queue changed.
 */
async function captureLpReadings({ quiet = false } = {}) {
    const config = loadConfig();
    const name = (document.getElementById('gameName').value.trim() || config.gameName || '').trim();
    const tag  = (document.getElementById('tagLine').value.trim()  || config.tagLine  || '').trim();
    if (!name || !tag) return false;

    const puuid      = await resolvePuuid(name, tag);
    const leagueData = await getLeagueData(puuid);

    let moved = false;
    for (const [queue, entry] of [['solo', leagueData.solo], ['flex', leagueData.flex]]) {
        if (!entry) continue;
        const res = await recordLpReading(queue, entry.tier, entry.rank, entry.leaguePoints,
                                          { wins: entry.wins, losses: entry.losses });
        if (!res.changed) continue;
        moved = true;
        if (!quiet) {
            const sign = res.delta > 0 ? '+' : '';
            showToast(
                queue === 'solo' ? 'Solo/Duo LP' : 'Flex LP',
                `${sign}${res.delta} LP — now ${entry.tier} ${entry.rank} ${entry.leaguePoints} LP`,
                4000
            );
        }
    }

    if (moved) {
        await attachLpReadingsToMatches().catch(e => console.warn('LP attribution failed:', e.message));
        if (typeof window.invalidateLpCache === 'function') window.invalidateLpCache();
        if (typeof window.renderLpCharts === 'function') window.renderLpCharts();
    }
    return moved;
}

// Exposed so syncPanel.js can trigger a fresh LP read on every sync — manual
// clicks included, not just the post-game watcher — without a circular
// require between the two files.
window.captureLpReadings = captureLpReadings;

/**
 * A game just ended — pull it in and work out what it cost or earned.
 *
 * Riot publishes a match to Match-V5 some time after the client leaves it, and
 * how long is not guaranteed: usually under a minute, occasionally several.
 * A single attempt would silently give up whenever the match was slow, leaving
 * the game missing until the next manual sync — so this retries on a widening
 * schedule and stops as soon as the match lands.
 */
const POST_GAME_RETRY_MS = [45, 45, 60, 120, 180].map(s => s * 1000);

async function handleGameEnded() {
    if (window.isSyncing) return;

    const wait = ms => new Promise(r => { pendingEndTimer = setTimeout(r, ms); });

    try {
        showToast('Game Over', 'Fetching the result…', 3000);

        for (let attempt = 0; attempt < POST_GAME_RETRY_MS.length; attempt++) {
            await wait(POST_GAME_RETRY_MS[attempt]);
            pendingEndTimer = null;

            // A new game starting means the last one is stale news — the next
            // game-end will pick it up along with everything else.
            if (wasInGame) return;

            let found = 0;
            if (typeof window.handleSync === 'function') {
                const res = await window.handleSync({ auto: true });
                found = (res && res.newMatches) || 0;
            }

            await captureLpReadings();

            if (found > 0) {
                await window.fetchAndDisplayRankData();
                return;
            }
            console.log(`Match not published yet (attempt ${attempt + 1}/${POST_GAME_RETRY_MS.length})`);
        }

        // ~7.5 minutes and still nothing. Rare, but say so rather than leave
        // the user assuming it was logged.
        showToast('Still Waiting', 'Riot hasn\'t published that match yet — press Sync in a few minutes', 6000);
    } catch (err) {
        console.warn('Post-game update failed:', err.message);
    } finally {
        pendingEndTimer = null;
    }
}

async function pollLiveClient() {
    if (livePollBusy) return;
    livePollBusy = true;
    try {
        const { inGame } = await getLiveGame();

        if (inGame && !wasInGame) {
            wasInGame = true;
            console.log('Live client: game started');
            // "Before" reading, so the next one has something to measure from.
            captureLpReadings({ quiet: true }).catch(e => console.warn('Pre-game LP read failed:', e.message));
            showToast('Game Detected', 'Nexus Insights will log this game when it ends', 3500);
        } else if (!inGame && wasInGame) {
            wasInGame = false;
            console.log('Live client: game ended');
            handleGameEnded();
        }
    } catch (err) {
        console.warn('Live client poll failed:', err.message);
    } finally {
        livePollBusy = false;
    }
}

/** Safety net: catch LP movement the live watcher never saw. */
async function pollLpFallback() {
    if (window.isSyncing || wasInGame) return;
    try {
        await captureLpReadings();
    } catch (err) {
        console.warn('LP fallback poll failed:', err.message);
    }
}

window.startLpWatcher = function () {
    const { autoLogGames } = loadConfig();

    if (autoLogGames !== false && !liveWatchTimer) {
        liveWatchTimer = setInterval(pollLiveClient, LIVE_POLL_MS);
        console.log(`Live game watcher started (every ${LIVE_POLL_MS / 1000}s, local)`);
    }
    if (!lpFallbackTimer) {
        lpFallbackTimer = setInterval(pollLpFallback, LP_FALLBACK_MS);
        console.log(`LP fallback poll started (every ${LP_FALLBACK_MS / 60000} min)`);
    }
};

window.stopLpWatcher = function () {
    if (liveWatchTimer)  { clearInterval(liveWatchTimer);  liveWatchTimer  = null; }
    if (lpFallbackTimer) { clearInterval(lpFallbackTimer); lpFallbackTimer = null; }
    if (pendingEndTimer) { clearTimeout(pendingEndTimer);  pendingEndTimer = null; }
};

/** Re-read the autoLogGames setting after the user saves Settings. */
window.restartLpWatcher = function () {
    window.stopLpWatcher();
    window.startLpWatcher();
};

/**
 * Diagnostics for the auto-logging chain, callable from devtools (F12):
 *
 *   testLiveClient()   — can the app see a running game?
 *   lpWatcherStatus()  — are the timers actually running?
 *   forceGameEnd()     — run the post-game sequence now, without playing a game
 */
window.testLiveClient = async function () {
    const res = await testConnection();
    console.log(res.message);
    showToast(res.reachable ? 'Live Client Connected' : 'Live Client Not Reachable', res.message, 7000);
    return res;
};

window.lpWatcherStatus = function () {
    const status = {
        autoLogGames:      loadConfig().autoLogGames !== false,
        liveWatcherActive: liveWatchTimer !== null,
        fallbackActive:    lpFallbackTimer !== null,
        currentlyInGame:   wasInGame,
        syncInProgress:    !!window.isSyncing,
        pollSeconds:       LIVE_POLL_MS / 1000,
    };
    console.table(status);
    return status;
};

window.forceGameEnd = function () {
    console.log('Forcing the post-game sequence…');
    wasInGame = false;
    return handleGameEnded();
};

// ============================================================
// MAIN FILTER COORDINATOR — renderFilteredMatches
// ============================================================
// Signature of the last set of filter inputs we rendered derived views for.
// Pagination doesn't change it, so growing the page no longer re-runs the
// analytics engine, the calendar and the time-insight pass.
let lastFilterSignature = null;

/**
 * @param {object}  [opts]
 * @param {boolean} [opts.listOnly] - only touch the match list (pagination)
 * @param {boolean} [opts.append]   - append the new page instead of rebuilding
 */
window.renderFilteredMatches = async function (opts = {}) {
    const { listOnly = false, append = false } = opts;
    const matchList   = document.getElementById('matchList');
    const matchesData = window.matchesData || [];

    if (!matchesData || matchesData.length === 0) return;

    // Collect all queue IDs explicitly defined in filter checkboxes
    const allDefinedQueues = new Set();
    document.querySelectorAll('.queue-filter').forEach(cb => {
        cb.dataset.queue.split(',').map(q => parseInt(q)).forEach(q => allDefinedQueues.add(q));
    });

    // When "Other" (Special Modes) is checked, also include unknown queue IDs
    const otherCheckbox  = document.querySelector('.queue-filter[data-queue*="1020"]');
    const includeUnknown = otherCheckbox && otherCheckbox.checked;

    // Period filter (#6: last patches / one patch / time window) comes first,
    // so everything below, including the champion list, follows it
    if (typeof window.updatePeriodDropdown === 'function') window.updatePeriodDropdown(matchesData);
    const periodSelect  = document.getElementById('periodFilter');
    const periodMatches = typeof window.applyPeriodFilter === 'function' ? window.applyPeriodFilter(matchesData) : matchesData;

    const queueFiltered = periodMatches.filter(match =>
        activeQueueFilters.has(match.queueId) ||
        (includeUnknown && !allDefinedQueues.has(match.queueId))
    );

    const selectedChamp = document.getElementById('champFilter').value;
    const champMatches  = (selectedChamp && selectedChamp !== '__none__')
        ? queueFiltered.filter(match => match.championName === selectedChamp)
        : queueFiltered;

    // Role filter (#10) narrows everything below, like the champion filter.
    // The Roles table on Overview gets the list from before it, so it can
    // still compare every role.
    const roleSelect      = document.getElementById('roleFilter');
    const selectedRole    = roleSelect ? roleSelect.value : '';
    const filteredMatches = selectedRole
        ? champMatches.filter(match => (match.teamPosition || '') === selectedRole)
        : champMatches;
    window.analyticsRoleFilter = selectedRole || null;
    window.rolePoolMatches     = champMatches;

    // Calendar date filter (selectedDates is populated by future calendar-selection feature)
    const selectedDates      = window.selectedDates;
    const calFilteredMatches = selectedDates.size > 0
        ? filteredMatches.filter(m => {
            const d       = new Date(m.gameCreation);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            return selectedDates.has(dateStr);
          })
        : filteredMatches;

    // What Settings → Export matches to CSV saves (#15)
    window.exportableMatches = calFilteredMatches;

    // Compute previous period for trend comparison (calendar date ranges only)
    let previousMatches = [];
    if (selectedDates.size > 0) {
        const dates    = Array.from(selectedDates).map(d => new Date(d));
        const minDate  = new Date(Math.min(...dates));
        const maxDate  = new Date(Math.max(...dates));
        const rangeMs  = maxDate.getTime() - minDate.getTime() + (24 * 60 * 60 * 1000);
        const prevMaxDate = new Date(minDate.getTime() - 1);
        const prevMinDate = new Date(prevMaxDate.getTime() - rangeMs + 1);
        previousMatches = matchesData
            .filter(m => { const d = new Date(m.gameCreation); return d >= prevMinDate && d <= prevMaxDate; })
            .filter(match =>
                (activeQueueFilters.has(match.queueId) || (includeUnknown && !allDefinedQueues.has(match.queueId))) &&
                (!selectedChamp || selectedChamp === '__none__' || match.championName === selectedChamp) &&
                (!selectedRole || (match.teamPosition || '') === selectedRole)
            );
    }

    // Everything below the match list only depends on the FILTER inputs, not on
    // how many rows are currently paged in. Skip it when nothing filter-shaped
    // changed — this is what makes "Load 20 more" cheap.
    const signature = JSON.stringify({
        queues: [...activeQueueFilters].sort(),
        includeUnknown,
        champ: selectedChamp,
        role: selectedRole,
        dates: [...selectedDates].sort(),
        size: matchesData.length,
        period: periodSelect ? periodSelect.value : '',
    });
    const filtersChanged = signature !== lastFilterSignature;

    if (!listOnly && filtersChanged) {
        lastFilterSignature = signature;

        updateChampionDropdown(queueFiltered);
        updateRoleDropdown(champMatches);

        // Statistics run on real games only — remakes would drag every average
        // toward zero and count as wins/losses they never were.
        const statsMatches = window.excludeRemakes(filteredMatches);
        const remakeCount  = filteredMatches.length - statsMatches.length;

        // Analytics always uses queue+champion filter — calendar selection is display-only
        window.renderAnalyticsTab(statsMatches, []);

        // The Champions page follows the game-mode filter but lists every
        // champion, so it gets the list before the champion filter.
        window.championPoolMatches = window.excludeRemakes(queueFiltered);
        const champTab = document.getElementById('champions-tab');
        if (champTab && champTab.style.display !== 'none' && typeof window.openChampionsPanel === 'function') {
            window.openChampionsPanel();
        }
        // The Teammates page counts the same games (#11)
        const mateTab = document.getElementById('teammates-tab');
        if (mateTab && mateTab.style.display !== 'none' && typeof window.openTeammatesPanel === 'function') {
            window.openTeammatesPanel();
        }

        // Keep Time Analytics (calendar, time-of-day, best day, stamina, streaks) in sync
        window._calendarFilteredMatches = statsMatches;
        if (typeof window.renderCalendarMonthView === 'function') window.renderCalendarMonthView(statsMatches);
        if (typeof window.calculateTimeInsights   === 'function') window.calculateTimeInsights(statsMatches);

        // Mirror the count onto the Match History nav button, so the filter's
        // effect is visible from the Analytics page where the filter lives.
        const navCount = document.getElementById('navHistoryCount');
        if (navCount) navCount.textContent = filteredMatches.length;

        const badge = document.getElementById('matchCountBadge');
        badge.textContent = `${filteredMatches.length} ${filteredMatches.length === 1 ? 'match' : 'matches'}`
            + (remakeCount > 0 ? ` · ${remakeCount} remake${remakeCount === 1 ? '' : 's'} excluded from stats` : '');
        badge.title = remakeCount > 0
            ? 'Remakes are shown in the list below but left out of every statistic'
            : '';
    }

    const displayedMatchCount = window.displayedMatchCount;
    const pagedMatches = filteredMatches.slice(0, displayedMatchCount);
    const remaining    = filteredMatches.length - pagedMatches.length;

    // Only the rows we are about to draw need their rawJson (summoner spells)
    const tbody     = matchList.querySelector('.match-table tbody');
    const canAppend = append && tbody && tbody.children.length > 0 && tbody.children.length < pagedMatches.length;
    const newRows   = canAppend ? pagedMatches.slice(tbody.children.length) : pagedMatches;

    try {
        await loadRawJson(newRows.map(m => m.matchId));
    } catch (e) {
        console.warn('Could not preload match JSON for visible page:', e);
    }

    const rowArgs = [
        matchesData,
        window.DDRAGON_BASE,
        window.QUEUE_NAMES,
        getChampionIcon,
        formatDamage,
        renderRunes,
        renderSummonerSpells,
    ];

    if (canAppend) {
        // Growing the page — append only the new rows instead of rebuilding
        // (and destroying) every row already on screen.
        tbody.insertAdjacentHTML('beforeend', renderMatchRows(newRows, ...rowArgs));
    } else {
        matchList.innerHTML = renderMatchTable(pagedMatches, ...rowArgs);
    }

    const loadMoreBar  = document.getElementById('loadMoreBar');
    const loadMoreInfo = document.getElementById('loadMoreInfo');
    if (loadMoreBar) {
        if (remaining > 0) {
            loadMoreBar.style.display = 'flex';
            if (loadMoreInfo) loadMoreInfo.textContent = `Showing ${pagedMatches.length} of ${filteredMatches.length} matches`;
        } else {
            loadMoreBar.style.display = 'none';
        }
    }
};

// ============================================================
// LOAD MATCH HISTORY  (called on startup and after sync)
// ============================================================
window.loadMatchHistory = async function (skipRankFetch = false) {
    try {
        // Rows may have been rewritten by a sync/backfill — drop stale blobs
        // and force the next render to recompute every derived view.
        clearJsonCache();
        lastFilterSignature = null;

        const [matches, stats, lpDeltas] = await Promise.all([
            getMatches(),
            getStats(),
            // Per-match LP for the table's LP column. Empty for every game
            // played before the watcher existed — that history isn't
            // recoverable from Riot, so those rows show a dash.
            getLpDeltasByMatch().catch(e => {
                console.warn('LP deltas unavailable:', e.message);
                return {};
            })
        ]);

        window.matchesData = matches;
        window.lpDeltas    = lpDeltas;

        // LP for every ranked game, estimated where there's no reading (#5).
        // Before the first render, so the LP column has it from the start.
        if (typeof window.refreshLpEstimates === 'function') {
            await window.refreshLpEstimates().catch(e => console.warn('LP estimates unavailable:', e.message));
        }

        if (activeQueueFilters.size === 0) initializeFilters();

        const config = loadConfig();
        if (!document.getElementById('gameName').value && config.gameName) {
            document.getElementById('gameName').value = config.gameName;
            document.getElementById('tagLine').value  = config.tagLine;
        }

        if (!skipRankFetch) await window.fetchAndDisplayRankData();

        if (matches.length > 0) {
            document.getElementById('unifiedStatsSection').style.display = 'block';
            document.getElementById('matchHistory').style.display        = 'block';
            const filterSection = document.getElementById('filterSection');
            if (filterSection) filterSection.style.display = 'flex';
            if (typeof window.initCalendar === 'function') window.initCalendar();
            await window.renderFilteredMatches();
            showToast('Welcome Back', `${stats.totalMatches} matches loaded`);
        } else {
            showToast('Welcome', `Ready to sync matches for ${config.gameName || 'your account'}`);
        }
    } catch (err) {
        console.error('Failed to load matches:', err);
        showToast('Error', 'Failed to load match history: ' + err.message);
    }
};

// ============================================================
// ANALYTICS TAB RENDERER
// ============================================================
window.renderAnalyticsTab = async function (matches, previousMatches) {
    if (matches) {
        window.currentFilteredMatches = matches;
        window.currentPreviousMatches = previousMatches || [];
    } else {
        matches         = window.currentFilteredMatches || [];
        previousMatches = window.currentPreviousMatches || [];
    }

    const container = document.getElementById('analyticsCardsContainer');
    if (!container) return;

    const tabName = window.activeAnalyticsTab;

    // Pull in rawJson/timelineJson only if this tab actually needs them.
    // Done BEFORE any DOM mutation so the grid never flashes empty.
    if (typeof window.prefetchTabJson === 'function') {
        try {
            await window.prefetchTabJson(tabName, matches, previousMatches);
        } catch (e) {
            console.warn('Match JSON prefetch failed; stats may be partial:', e);
        }
        // A newer render started while we awaited — let that one win
        if (window.currentFilteredMatches !== matches || window.activeAnalyticsTab !== tabName) return;
    }

    const soloCard            = document.getElementById('rankedSoloCard');
    const flexCard            = document.getElementById('rankedFlexCard');
    const persistentContainer = document.getElementById('persistentRankCards');

    container.innerHTML = '';

    if (tabName === 'Overview') {
        if (soloCard) { soloCard.style.display = 'flex'; container.appendChild(soloCard); }
        if (flexCard) { flexCard.style.display = 'flex'; container.appendChild(flexCard); }
    } else {
        if (soloCard && persistentContainer) persistentContainer.appendChild(soloCard);
        if (flexCard && persistentContainer) persistentContainer.appendChild(flexCard);
    }

    // One role picked → cards are ranked on that role's thresholds (#10)
    const cards = window.computeTabStats(tabName, matches, previousMatches, { role: window.analyticsRoleFilter || null });

    cards.forEach(card => {
        const div     = document.createElement('div');
        div.className = 'unified-stat-card';
        const isRanked = card.benchmarkable && card.color && card.benchmarkRank !== 'unrated';

        if (isRanked) {
            // Rank colour lives in the top line, value and badge only — tinted
            // backgrounds on every card made the row read as a rainbow.
            div.style.borderTop  = `3px solid ${card.color}`;
        } else if (card.benchmarkable) {
            div.style.borderTop = '3px solid rgba(255,255,255,0.12)';
        } else {
            div.style.borderTop = '3px solid rgba(255,255,255,0.06)';
        }

        const valueColor = isRanked ? ` style="color:${card.color}"` : '';
        const badgeLabel = card.benchmarkRank
            ? card.benchmarkRank.charAt(0).toUpperCase() + card.benchmarkRank.slice(1)
            : '';

        let html = `
            <div class="std-stat-header">
                <div class="std-stat-label" title="${card.label}">${card.label}</div>
            </div>
            <div class="std-stat-value"${valueColor}>${card.displayValue}</div>`;

        if (card.benchmarkable && card.benchmarkRank) {
            const badgeBg = isRanked ? card.color : 'rgba(255,255,255,0.08)';
            html += `<div class="std-stat-badge" style="background:${badgeBg}">${badgeLabel}</div>`;
        }

        if (card.trend !== null) {
            let trendClass = 'std-trend-neutral', arrow = '−';
            if (card.isImproving === true)       { trendClass = 'std-trend-positive'; arrow = '▲'; }
            else if (card.isImproving === false)  { trendClass = 'std-trend-negative'; arrow = '▼'; }
            html += `
                <div class="std-stat-footer">
                    <span class="std-trend-val ${trendClass}"><span class="trend-arrow">${arrow}</span>${card.trend}</span>
                    <span class="std-trend-label">${card.trendLabel}</span>
                </div>`;
        }

        // Cards with a meaningful month-by-month trend get a green dot and open
        // the history chart (components/statHistory.js) when clicked.
        const chartable = typeof window.isStatChartable === 'function' && window.isStatChartable(card);
        if (chartable) {
            html += `<span class="stat-history-dot" aria-hidden="true"></span>`;
            div.classList.add('stat-card--clickable');
            div.dataset.statId = card.id;
            div.dataset.label  = card.label;
            div.tabIndex = 0;
            div.setAttribute('role', 'button');
            div.setAttribute('aria-expanded', 'false');
            div.setAttribute('aria-controls', 'statHistoryPanel');
            div.title = `${card.label} — click to see the last 12 months`;
            const open = () => window.toggleStatHistory(tabName, card.id, card.label);
            div.addEventListener('click', open);
            div.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
            });
        }

        div.innerHTML = html;
        container.appendChild(div);
    });

    balanceStatsGrid(container);

    // Roles table under the Overview cards: every role, before the role filter
    if (typeof window.renderRoleBreakdown === 'function') {
        window.renderRoleBreakdown(
            tabName === 'Overview' ? window.excludeRemakes(window.rolePoolMatches || matches) : null,
            window.analyticsRoleFilter);
    }

    // Where you die, under the Death Review cards (#8): the same games as the cards
    if (typeof window.renderDeathMap === 'function') {
        window.renderDeathMap(tabName === 'Death Review' ? matches : null);
    }

    // Gold/XP gap per minute under the Lane Phase cards (#12)
    if (typeof window.renderLaneGapChart === 'function') {
        window.renderLaneGapChart(tabName === 'Lane Phase' ? matches : null);
    }

    // Keep an open history chart in step: recompute it for new filters, or
    // close it when the sub-tab changed and its card is no longer on screen.
    if (typeof window.syncStatHistory === 'function') window.syncStatHistory(tabName, matches);
};

// ============================================================
// STATS GRID BALANCING
// ============================================================
/**
 * Pick a column count that spreads the stat cards evenly across rows, so a
 * wrapped row never leaves a big blank gap. A ranked card counts as 2 units
 * (it spans 2 columns). Preference order: the largest column count that fits
 * the container at >=130px per card AND divides the units with no remainder;
 * failing that, the count leaving the fewest empty cells.
 */
function balanceStatsGrid(container) {
    // Every card (including the two rank cards) is one column wide. At most
    // 8 per row: 10 Overview cards split 5+5 instead of one cramped row.
    const MIN_CARD_W = 130, GAP = 12, MAX_COLS = 8;

    const units = Array.from(container.children)
        .filter(el => el.style.display !== 'none').length;
    if (units === 0) return;

    const width   = container.clientWidth;
    const maxCols = Math.min(units, MAX_COLS, Math.max(1, Math.floor((width + GAP) / (MIN_CARD_W + GAP))));

    // Search from maxCols down to half of it: this allows dropping to a
    // perfectly-even column count (e.g. 6 when 11 fit but there are 12 units)
    // without ever letting cards grow past ~2x their minimum width.
    let best = maxCols, bestEmpty = Infinity;
    const minCols = Math.max(1, Math.ceil(maxCols / 2));
    for (let cols = maxCols; cols >= minCols; cols--) {
        const empty = (cols - (units % cols)) % cols;
        if (empty === 0) { best = cols; break; } // largest even split wins
        if (empty < bestEmpty) { bestEmpty = empty; best = cols; }
    }

    container.style.gridTemplateColumns = `repeat(${best}, 1fr)`;
}

// Re-balance when the window (and therefore the container) changes size
new ResizeObserver(() => {
    const container = document.getElementById('analyticsCardsContainer');
    if (container && container.children.length) balanceStatsGrid(container);
}).observe(document.getElementById('analyticsCardsContainer'));

// ============================================================
// PAGINATION
// ============================================================
window.loadMoreMatches = function () {
    window.displayedMatchCount += 50;
    // listOnly: the filter set is unchanged, so analytics/calendar/insights
    // don't need recomputing. append: keep the rows already rendered.
    window.renderFilteredMatches({ listOnly: true, append: true });
};

window.loadAllMatches = function () {
    window.displayedMatchCount = Infinity;
    window.renderFilteredMatches({ listOnly: true, append: true });
};

// ============================================================
// TOP-LEVEL TAB NAVIGATION (Analytics / Coaching)
// ============================================================
let coachingPanelLoaded = false;

/**
 * Top-level pages. Match History is its own page now — the filters that shape
 * it stay on the Analytics page, since they drive every statistic there too.
 */
const TOP_TABS = {
    analytics: { panel: 'analytics-tab', nav: 'navAnalytics' },
    history:   { panel: 'history-tab',   nav: 'navHistory'   },
    champions: { panel: 'champions-tab', nav: 'navChampions' },
    teammates: { panel: 'teammates-tab', nav: 'navTeammates' },
    coaching:  { panel: 'coaching-tab',  nav: 'navCoaching'  },
    chat:      { panel: 'chat-tab',      nav: 'navChat'      },
    skins:     { panel: 'skins-tab',     nav: 'navSkins'     },
};

window.switchTopTab = function (tab) {
    if (!TOP_TABS[tab]) tab = 'analytics';

    for (const [name, ids] of Object.entries(TOP_TABS)) {
        const panel = document.getElementById(ids.panel);
        const nav   = document.getElementById(ids.nav);
        const on    = name === tab;
        if (panel) panel.style.display = on ? 'block' : 'none';
        if (nav)   nav.classList.toggle('active', on);
    }

    // Picking a section is the end of the interaction — get the drawer out
    // of the way so the page it just revealed is actually visible.
    window.closeNavDrawer();

    // Re-render on every open: it is cheap (~50 ms) and picks up games
    // synced since the last visit.
    if (tab === 'coaching') {
        coachingPanelLoaded = true;
        if (typeof window.renderCoachingPanel === 'function') {
            window.renderCoachingPanel();
        }
    }

    if (tab === 'skins' && typeof window.openSkinsPanel === 'function') {
        window.openSkinsPanel();
    }

    if (tab === 'chat' && typeof window.openChatPanel === 'function') {
        window.openChatPanel();
    }

    if (tab === 'champions' && typeof window.openChampionsPanel === 'function') {
        window.openChampionsPanel();
    }

    if (tab === 'teammates' && typeof window.openTeammatesPanel === 'function') {
        window.openTeammatesPanel();
    }
};


/* ============================================================
   LEFT NAV RAIL
   Permanent button strip down the left edge (replaced the
   slide-out drawer, 2026-10). The old drawer functions stay as
   no-ops so existing callers like switchTopTab keep working.
   ============================================================ */
window.isNavDrawerOpen = function () { return false; };
window.openNavDrawer   = function () {};
window.closeNavDrawer  = function () {};
window.toggleNavDrawer = function () {};


document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    hideSetupModal();
});

// Enter starts a sync — but only from the summoner name/tag fields, so typing
// in the settings modal or filters can't fire an accidental sync.
for (const id of ['gameName', 'tagLine']) {
    const input = document.getElementById(id);
    if (input) input.addEventListener('keydown', e => {
        if (e.key === 'Enter') window.handleSync();
    });
}

// ============================================================
// ANALYTICS TAB CLICK LISTENERS
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.analytical-tab').forEach(btn => {
        btn.addEventListener('click', e => {
            document.querySelectorAll('.analytical-tab').forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            e.target.classList.add('active');
            e.target.setAttribute('aria-selected', 'true');
            window.activeAnalyticsTab = e.target.dataset.tab;
            window.renderAnalyticsTab();
        });
    });
});

// ============================================================
// STARTUP
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    // Skin (colours + background) — see components/skins.js. The default
    // skin keeps the old behaviour: a random region background.
    if (typeof window.applySavedSkin === 'function') window.applySavedSkin();

    if (typeof window.initWindowControls === 'function') window.initWindowControls();
    if (typeof window.initUpdateButton === 'function') window.initUpdateButton();

    const configValid = checkConfigOnStartup();

    try {
        await loadGameData();
        window.DDRAGON_BASE = getDDragonBase();
    } catch (err) {
        console.warn('Failed to load game data, tooltips will not work:', err);
    }

    initTooltips();

    if (configValid) await window.loadMatchHistory();

    // One-time indexing of matches synced before the precomputed analytics
    // columns existed. Runs in the background so it never blocks the UI, and
    // is a no-op on every launch after the first.
    if (configValid) backfillAnalyticsInBackground();

    // Watch LP while the app is open. This is what makes per-match LP possible
    // at all — Riot exposes no history, so the readings have to be collected
    // as they happen.
    if (configValid) window.startLpWatcher();
});

async function backfillAnalyticsInBackground() {
    try {
        // Rows indexed before these columns existed (#2, #4, #6, #12, #15)
        const pending = (window.matchesData || []).filter(
            m => m.statsComputedAt == null || m.impactRank == null || m.laneOpponent == null ||
                 m.patch == null ||       // #6
                 m.turretDamage == null ||  // #15
                 m.laneGaps == null ||      // #12
                 m.itemPurchases == null || m.deathPositions == null   // #7, #8
        );
        if (pending.length === 0) return;

        console.log(`Indexing ${pending.length} matches for analytics...`);
        const result = await backfillComputedStats();
        if (result.done > 0) {
            // Pick up the newly written columns
            await window.loadMatchHistory(true);
            showToast('Analytics Ready', `${result.done} matches indexed — tabs will load faster now`);
        }
    } catch (err) {
        // Purely an optimisation; the tabs still work by parsing the blobs
        console.warn('Analytics indexing failed (falling back to on-demand parsing):', err);
    }
}
