// Import functions from other modules (loaded via Electron's nodeIntegration)
const { getPuuidByRiotId } = window.require('./services/riotApi');
const { syncMatches, getMatches, getStats, getMatchById, backfillTimelines, backfillAdvancedStats, getMatchParticipantRanks, fetchRanksForNewMatches } = window.require('./services/matchService');
const { renderMatchTable, calculateStats, getRankedStats, getRankColor, getRankFromKDA, getRankFromKP, getRankFromCSM, getRankFromCS, getRankFromDamage, getRankFromWinRate, getInsightColor, getInsightCsDiff15, getInsightGoldDiff15, getInsightXpDiff15, getInsightFirstBlood, getInsightDmgGold, getInsightIsolatedDeaths, getInsightObjectiveRate } = window.require('./components/tableRenderer');
const { loadGameData, getItemData, getRuneData, getSummonerSpellData, getDDragonBase } = window.require('./services/dataDragon');
const { evaluateBadges } = window.require('./components/badgeEvaluator');
const { loadConfig, saveConfig, isConfigValid } = window.require('./services/config');

// Data Dragon CDN base URL - resolved after loadGameData fetches the latest version
let DDRAGON_BASE = 'https://ddragon.leagueoflegends.com/cdn/25.S1.1';

// Store matches for modal access
let matchesData = [];

// Queue ID to game mode mapping
const QUEUE_NAMES = {
    // Summoner's Rift
    420: 'Ranked Solo',
    440: 'Ranked Flex',
    400: 'Normal Draft',
    430: 'Normal Blind',
    480: 'Swiftplay',
    490: 'Quickplay',
    700: 'Clash',
    // ARAM
    450: 'ARAM',
    720: 'ARAM (Clash)',
    2400: 'ARAM Mayhem',
    // Arena & URF
    1700: 'Arena',
    1710: 'Arena',
    900: 'URF',
    1010: 'URF',
    1900: 'URF',
    // Co-op vs AI
    830: 'Co-op vs AI',
    840: 'Co-op vs AI',
    850: 'Co-op vs AI',
    870: 'Co-op vs AI',
    880: 'Co-op vs AI',
    890: 'Co-op vs AI',
    // Other / Rotating
    1020: 'One for All',
    1300: 'Nexus Blitz',
    1400: 'Ultimate Spellbook',
    1810: 'Swarm',
    1820: 'Swarm',
    1830: 'Swarm',
    1840: 'Swarm',
    2300: 'Brawl',
    0: 'Custom'
};

// ===== Setup Modal Functions =====

// Show setup modal
function showSetupModal(isFirstTime = true) {
    const modal = document.getElementById('setupModal');
    const title = modal.querySelector('.setup-title');
    const subtitle = modal.querySelector('.setup-subtitle');
    const saveBtn = document.getElementById('setupSaveBtn');

    if (isFirstTime) {
        title.textContent = 'Welcome to Nexus Insights';
        subtitle.textContent = 'Enter your details to get started';
        saveBtn.textContent = 'Save & Start';
    } else {
        title.textContent = 'Settings';
        subtitle.textContent = 'Update your configuration';
        saveBtn.textContent = 'Save Changes';
    }

    // Load existing config into form
    const config = loadConfig();
    document.getElementById('setupApiKey').value = config.apiKey || '';
    document.getElementById('setupGameName').value = config.gameName || '';
    document.getElementById('setupTagLine').value = config.tagLine || '';
    document.getElementById('setupRegion').value = config.region || 'europe';
    document.getElementById('setupPlatform').value = config.platform || 'euw1';

    // Clear any previous error
    document.getElementById('setupError').style.display = 'none';

    modal.classList.add('visible');
}

// Hide setup modal
function hideSetupModal() {
    document.getElementById('setupModal').classList.remove('visible');
}
window.hideSetupModal = hideSetupModal;

// Open settings (alias for showing setup modal in edit mode)
function openSettings() {
    showSetupModal(false);
}
window.openSettings = openSettings;

// Save setup configuration
function saveSetup() {
    const apiKey = document.getElementById('setupApiKey').value.trim();
    const gameName = document.getElementById('setupGameName').value.trim();
    const tagLine = document.getElementById('setupTagLine').value.trim();
    const region = document.getElementById('setupRegion').value;
    const platform = document.getElementById('setupPlatform').value;

    // Validate required fields
    const errorEl = document.getElementById('setupError');
    if (!apiKey) {
        errorEl.textContent = 'API Key is required. Get one from developer.riotgames.com';
        errorEl.style.display = 'block';
        return;
    }
    if (!gameName || !tagLine) {
        errorEl.textContent = 'Summoner Name and Tag are required';
        errorEl.style.display = 'block';
        return;
    }

    // Save config
    const config = {
        apiKey,
        gameName,
        tagLine,
        region,
        platform
    };

    if (saveConfig(config)) {
        hideSetupModal();

        // Update main form inputs
        document.getElementById('gameName').value = gameName;
        document.getElementById('tagLine').value = tagLine;

        // Reload match history with new user
        loadMatchHistory();
    } else {
        errorEl.textContent = 'Failed to save configuration. Please try again.';
        errorEl.style.display = 'block';
    }
}

// Check config on startup and show setup if needed
function checkConfigOnStartup() {
    const config = loadConfig();

    if (isConfigValid(config)) {
        // Config is valid - populate inputs and continue
        document.getElementById('gameName').value = config.gameName;
        document.getElementById('tagLine').value = config.tagLine;
        return true;
    } else {
        // Config is invalid/missing - show setup modal
        showSetupModal(true);
        return false;
    }
}

// Format relative time
function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    const intervals = [
        { label: 'd', seconds: 86400 },
        { label: 'h', seconds: 3600 },
        { label: 'm', seconds: 60 }
    ];
    for (const interval of intervals) {
        const count = Math.floor(seconds / interval.seconds);
        if (count >= 1) return `${count}${interval.label} ago`;
    }
    return 'Just now';
}

// Format game duration
function formatDuration(seconds) {
    if (!seconds) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Format damage number (e.g., 15400 -> 15.4k)
function formatDamage(dmg) {
    if (!dmg) return '0';
    if (dmg >= 1000) return (dmg / 1000).toFixed(1) + 'k';
    return dmg.toString();
}

// Build multi-kill badges HTML with tooltips
function getMultiKillBadges(match) {
    const badges = [];
    if (match.pentaKills > 0) {
        badges.push(`<span class="multi-kill-badge penta" data-tooltip="Penta Kill - 5 kills in quick succession (${match.pentaKills}x)">PENTA</span>`);
    }
    if (match.quadraKills > 0) {
        badges.push(`<span class="multi-kill-badge quadra" data-tooltip="Quadra Kill - 4 kills in quick succession (${match.quadraKills}x)">QUADRA</span>`);
    }
    if (match.tripleKills > 0) {
        badges.push(`<span class="multi-kill-badge triple" data-tooltip="Triple Kill - 3 kills in quick succession (${match.tripleKills}x)">TRIPLE</span>`);
    }
    if (match.doubleKills > 0) {
        badges.push(`<span class="multi-kill-badge double" data-tooltip="Double Kill - 2 kills in quick succession (${match.doubleKills}x)">DOUBLE</span>`);
    }
    return badges.join('');
}

// Get position display name
function getPositionName(pos) {
    const positions = {
        'TOP': 'TOP',
        'JUNGLE': 'JG',
        'MIDDLE': 'MID',
        'BOTTOM': 'ADC',
        'UTILITY': 'SUP'
    };
    return positions[pos] || pos || '';
}

// Build items HTML with Data Dragon icons
function renderItems(match) {
    const items = [match.item0, match.item1, match.item2, match.item3, match.item4, match.item5, match.item6];
    return items.map(itemId => {
        if (itemId && itemId > 0) {
            return `<div class="item-slot has-item"><img src="${DDRAGON_BASE}/img/item/${itemId}.png" alt="Item" data-item-id="${itemId}" onerror="this.style.display='none'"></div>`;
        }
        return `<div class="item-slot"></div>`;
    }).join('');
}

// Rune ID to icon path mapping
const RUNE_ICONS = {
    // Precision Keystones
    8005: 'Precision/PressTheAttack/PressTheAttack.png',
    8008: 'Precision/LethalTempo/LethalTempoTemp.png',
    8021: 'Precision/FleetFootwork/FleetFootwork.png',
    8010: 'Precision/Conqueror/Conqueror.png',
    // Domination Keystones
    8112: 'Domination/Electrocute/Electrocute.png',
    8124: 'Domination/Predator/Predator.png',
    8128: 'Domination/DarkHarvest/DarkHarvest.png',
    9923: 'Domination/HailOfBlades/HailOfBlades.png',
    // Sorcery Keystones
    8214: 'Sorcery/SummonAery/SummonAery.png',
    8229: 'Sorcery/ArcaneComet/ArcaneComet.png',
    8230: 'Sorcery/PhaseRush/PhaseRush.png',
    // Resolve Keystones
    8437: 'Resolve/GraspOfTheUndying/GraspOfTheUndying.png',
    8439: 'Resolve/VeteranAftershock/VeteranAftershock.png',
    8465: 'Resolve/Guardian/Guardian.png',
    // Inspiration Keystones
    8351: 'Inspiration/GlacialAugment/GlacialAugment.png',
    8360: 'Inspiration/UnsealedSpellbook/UnsealedSpellbook.png',
    8369: 'Inspiration/FirstStrike/FirstStrike.png',
    // Rune Tree Icons (for secondary)
    8000: '7201_Precision.png',      // Precision
    8100: '7200_Domination.png',     // Domination
    8200: '7202_Sorcery.png',        // Sorcery
    8300: '7203_Whimsy.png',         // Inspiration
    8400: '7204_Resolve.png'         // Resolve
};

// Build runes HTML with Data Dragon icons
function renderRunes(match) {
    if (!match.primaryRune && !match.secondaryRuneStyle) {
        return `<div class="rune-display"><div class="rune-empty"></div><div class="rune-empty"></div></div>`;
    }

    const primaryPath = RUNE_ICONS[match.primaryRune] || null;
    const secondaryPath = RUNE_ICONS[match.secondaryRuneStyle] || null;

    const primaryHTML = primaryPath
        ? `<img src="https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${primaryPath}" alt="Primary Rune" class="rune-icon" data-rune-id="${match.primaryRune}">`
        : '<div class="rune-empty"></div>';

    const secondaryHTML = secondaryPath
        ? `<img src="https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${secondaryPath}" alt=" Secondary Rune" class="rune-icon secondary" data-rune-id="${match.secondaryRuneStyle}">`
        : '<div class="rune-empty"></div>';

    return `<div class="rune-display">${primaryHTML}${secondaryHTML}</div>`;
}

// Build summoner spells HTML with Data Dragon icons
function renderSummonerSpells(match) {
    // Get summoner spell IDs from rawJson
    let spell1Id = null;
    let spell2Id = null;

    if (match.rawJson) {
        try {
            const matchData = typeof match.rawJson === 'string' ? JSON.parse(match.rawJson) : match.rawJson;
            const participants = matchData.info?.participants || [];
            // Find the current player
            const me = participants.find(p => p.championName === match.championName);
            if (me) {
                spell1Id = me.summoner1Id;
                spell2Id = me.summoner2Id;
            }
        } catch (e) {
            console.warn('Error parsing match data for summoner spells:', e);
        }
    }

    if (!spell1Id && !spell2Id) {
        return `<div class="spell-display"><div class="spell-empty"></div><div class="spell-empty"></div></div>`;
    }

    const spell1HTML = spell1Id
        ? `<img src="${DDRAGON_BASE}/img/spell/${getSummonerSpellImageName(spell1Id)}" alt="Spell 1" class="spell-icon" data-spell-id="${spell1Id}">`
        : '<div class="spell-empty"></div>';

    const spell2HTML = spell2Id
        ? `<img src="${DDRAGON_BASE}/img/spell/${getSummonerSpellImageName(spell2Id)}" alt="Spell 2" class="spell-icon" data-spell-id="${spell2Id}">`
        : '<div class="spell-empty"></div>';

    return `<div class="spell-display">${spell1HTML}${spell2HTML}</div>`;
}

// Get summoner spell image name from ID
function getSummonerSpellImageName(spellId) {
    const spellData = getSummonerSpellData(spellId);
    if (spellData && spellData.image) {
        return spellData.image.full;
    }
    // Fallback to common spell names
    const spellMap = {
        1: 'SummonerBoost.png',      // Cleanse
        3: 'SummonerExhaust.png',    // Exhaust
        4: 'SummonerFlash.png',      // Flash
        6: 'SummonerHaste.png',      // Ghost
        7: 'SummonerHeal.png',       // Heal
        11: 'SummonerSmite.png',     // Smite
        12: 'SummonerTeleport.png',  // Teleport
        13: 'SummonerMana.png',      // Clarity
        14: 'SummonerDot.png',       // Ignite
        21: 'SummonerBarrier.png',   // Barrier
        32: 'SummonerSnowball.png'   // Mark (ARAM)
    };
    return spellMap[spellId] || 'SummonerFlash.png';
}

// Build objective badges HTML with tooltips (similar to multi-kill badges)
function getObjectiveBadges(match) {
    const badges = [];
    if (match.dragonKills > 0) {
        badges.push(`<span class="objective-badge dragon" data-tooltip="Dragons slain by you (${match.dragonKills}x)">DRAGON</span>`);
    }
    if (match.baronKills > 0) {
        badges.push(`<span class="objective-badge baron" data-tooltip="Baron Nashors slain by you (${match.baronKills}x)">BARON</span>`);
    }
    if (match.turretKills > 0) {
        badges.push(`<span class="objective-badge tower" data-tooltip="Turrets destroyed by you (${match.turretKills}x)">TOWER</span>`);
    }
    if (match.inhibitorKills > 0) {
        badges.push(`<span class="objective-badge inhibitor" data-tooltip="Inhibitors destroyed by you (${match.inhibitorKills}x)">INHIB</span>`);
    }
    return badges.join('');
}

// Champion icon URL cache for performance
const championIconCache = new Map();

// Get champion icon URL from Data Dragon
function getChampionIcon(championName) {
    if (!championName) return '';

    // Check cache first
    if (championIconCache.has(championName)) {
        return championIconCache.get(championName);
    }

    // Handle special champion name cases (FiddleSticks -> Fiddlesticks, etc.)
    let normalized = championName;
    // Some champions have different asset names
    const specialNames = {
        'FiddleSticks': 'Fiddlesticks',
        'Wukong': 'MonkeyKing'
    };
    if (specialNames[championName]) {
        normalized = specialNames[championName];
    }

    const url = `${DDRAGON_BASE}/img/champion/${normalized}.png`;

    // Cache for future use
    championIconCache.set(championName, url);

    return url;
}

// Render a single match card
function renderMatchCard(match, index) {
    const isWin = match.win === 1;
    const kda = match.deaths === 0 ? 'Perfect' : ((match.kills + match.assists) / match.deaths).toFixed(1);
    const queueName = QUEUE_NAMES[match.queueId] || 'Game';
    const multiKills = getMultiKillBadges(match);
    const objectiveBadges = getObjectiveBadges(match);
    const position = match.teamPosition || match.lane;
    const positionBadge = position ? `<span class="position-badge ${position}">${getPositionName(position)}</span>` : '';
    const champIcon = getChampionIcon(match.championName);

    return `
                <div class="match-card ${isWin ? 'win' : 'loss'}" onclick="openMatchModal(${index})">
                    <div class="match-champion">
                        ${champIcon ? `<img src="${champIcon}" alt="${match.championName}" onerror="this.parentElement.textContent='${match.championName ? match.championName.charAt(0) : '?'}'">` : (match.championName ? match.championName.charAt(0) : '?')}
                    </div>
                    <div class="match-info">
                        <div class="match-primary">
                            <span class="match-champion-name">${match.championName || 'Unknown'}</span>
                            ${positionBadge}
                            <span class="match-result ${isWin ? 'win' : 'loss'}">${isWin ? 'Victory' : 'Defeat'}</span>
                        </div>
                        <div class="match-secondary">${queueName} · ${formatDuration(match.gameDuration)} · Lvl ${match.champLevel || '?'}</div>
                        <div class="multi-kills">${multiKills}${objectiveBadges}</div>
                        <div class="match-items">${renderItems(match)}</div>
                    </div>
                    <div class="match-stats">
                        <div class="match-kda">
                            <div class="kda-value">${match.kills}/${match.deaths}/${match.assists}</div>
                            <div class="kda-label">${kda} KDA</div>
                        </div>
                        <div class="match-stat-item">
                            <div class="stat-item-value">${match.totalMinionsKilled || 0}</div>
                            <div class="stat-item-label">CS</div>
                        </div>
                        <div class="match-stat-item">
                            <div class="stat-item-value">${formatDamage(match.totalDamageDealtToChampions)}</div>
                            <div class="stat-item-label">DMG</div>
                        </div>
                        <div class="match-stat-item">
                            <div class="stat-item-value">${match.wardsPlaced || 0}</div>
                            <div class="stat-item-label">Wards</div>
                        </div>
                        <div class="match-time">
                            <div class="time-value">${match.gameCreation ? timeAgo(match.gameCreation) : ''}</div>
                        </div>
                    </div>
                </div>
            `;
}

// ============ FILTER LOGIC ============

// Filter state
let activeQueueFilters = new Set();

// Initialize filters - called on first load
function initializeFilters() {
    // Start with all filters active
    const checkboxes = document.querySelectorAll('.queue-filter');
    checkboxes.forEach(checkbox => {
        const queues = checkbox.dataset.queue.split(',').map(q => parseInt(q));
        queues.forEach(q => activeQueueFilters.add(q));
    });
}

// Toggle all filters
window.toggleAllFilters = function () {
    const allCheckbox = document.getElementById('filter-all');
    const queueCheckboxes = document.querySelectorAll('.queue-filter');

    queueCheckboxes.forEach(checkbox => {
        checkbox.checked = allCheckbox.checked;
    });

    applyFilters();
}

// Clear all game mode filters
window.clearGameModeFilters = function () {
    const allCheckbox = document.getElementById('filter-all');
    const queueCheckboxes = document.querySelectorAll('.queue-filter');

    allCheckbox.checked = false;
    queueCheckboxes.forEach(checkbox => {
        checkbox.checked = false;
    });

    applyFilters();
}

// Apply filters to match list
window.applyFilters = function () {
    const allCheckbox = document.getElementById('filter-all');
    const queueCheckboxes = document.querySelectorAll('.queue-filter');

    // Rebuild active queue set
    activeQueueFilters.clear();
    let allChecked = true;

    queueCheckboxes.forEach(checkbox => {
        if (checkbox.checked) {
            const queues = checkbox.dataset.queue.split(',').map(q => parseInt(q));
            queues.forEach(q => activeQueueFilters.add(q));
        } else {
            allChecked = false;
        }
    });

    // Update "All" checkbox state
    allCheckbox.checked = allChecked;

    // Re-render matches with filter
    renderFilteredMatches();
}

// Render filtered matches
function renderFilteredMatches() {
    const matchList = document.getElementById('matchList');

    if (!matchesData || matchesData.length === 0) {
        return;
    }

    // Collect all queue IDs explicitly defined in filter checkboxes
    const allDefinedQueues = new Set();
    document.querySelectorAll('.queue-filter').forEach(cb => {
        cb.dataset.queue.split(',').map(q => parseInt(q)).forEach(q => allDefinedQueues.add(q));
    });

    // Check if "Other" checkbox is checked (includes unknown/future modes)
    const otherCheckbox = document.querySelector('.queue-filter[data-queue*="1020"]');
    const includeUnknown = otherCheckbox && otherCheckbox.checked;

    // Filter matches by active queues; include unknown queue IDs when Special Modes is on
    const queueFiltered = matchesData.filter(match =>
        activeQueueFilters.has(match.queueId) ||
        (includeUnknown && !allDefinedQueues.has(match.queueId))
    );

    // Update champion dropdown based on queue-filtered matches
    updateChampionDropdown(queueFiltered);

    // Apply champion filter
    const selectedChamp = document.getElementById('champFilter').value;
    // __none__ or empty string means no champion filter (show all)
    const filteredMatches = (selectedChamp && selectedChamp !== '__none__')
        ? queueFiltered.filter(match => match.championName === selectedChamp)
        : queueFiltered;

    // Calculate stats from filtered matches
    const stats = calculateStats(filteredMatches);

    // Update stats display
    document.getElementById('matchCount').textContent = stats.totalMatches;

    function setStatColor(el, color) {
        el.style.background = 'none';
        el.style.webkitTextFillColor = color;
        el.style.color = color;
    }

    function setStatRank(id, rank, color) {
        const el = document.getElementById(id);
        el.textContent = rank;
        el.style.color = color;
    }

    function setCardHoverGlow(valueEl, color) {
        const card = valueEl.closest('.unified-stat-card');
        if (!card) return;
        card.dataset.hoverColor = color;
        if (!card.dataset.hoverBound) {
            card.dataset.hoverBound = '1';
            card.addEventListener('mouseenter', () => {
                const c = card.dataset.hoverColor;
                card.style.background = hexToRgba(c, 0.1);
                card.style.borderColor = hexToRgba(c, 0.25);
            });
            card.addEventListener('mouseleave', () => {
                card.style.background = '';
                card.style.borderColor = '';
            });
        }
    }

    function hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    const wrRank = getRankFromWinRate(stats.winRate);
    const wrColor = getRankColor(wrRank);
    const winRateEl = document.getElementById('winRate');
    winRateEl.textContent = stats.winRate + '%';
    setStatColor(winRateEl, wrColor);
    setStatRank('winRateRank', wrRank, wrColor);
    setCardHoverGlow(winRateEl, wrColor);

    const kdaRank = getRankFromKDA(parseFloat(stats.avgKda));
    const kdaColor = getRankColor(kdaRank);
    const avgKdaEl = document.getElementById('avgKda');
    avgKdaEl.textContent = stats.avgKda;
    setStatColor(avgKdaEl, kdaColor);
    setStatRank('avgKdaRank', kdaRank, kdaColor);
    setCardHoverGlow(avgKdaEl, kdaColor);

    const kpRank = getRankFromKP(stats.avgKp);
    const kpColor = getRankColor(kpRank);
    const avgKpEl = document.getElementById('avgKp');
    avgKpEl.textContent = stats.avgKp + '%';
    setStatColor(avgKpEl, kpColor);
    setStatRank('avgKpRank', kpRank, kpColor);
    setCardHoverGlow(avgKpEl, kpColor);

    const csmRank = getRankFromCSM(parseFloat(stats.avgCsm));
    const csmColor = getRankColor(csmRank);
    const avgCsmEl = document.getElementById('avgCsm');
    avgCsmEl.textContent = stats.avgCsm;
    setStatColor(avgCsmEl, csmColor);
    setStatRank('avgCsmRank', csmRank, csmColor);
    setCardHoverGlow(avgCsmEl, csmColor);

    const csRank = getRankFromCS(stats.avgCs);
    const csColor = getRankColor(csRank);
    const avgCsEl = document.getElementById('avgCs');
    avgCsEl.textContent = stats.avgCs;
    setStatColor(avgCsEl, csColor);
    setStatRank('avgCsRank', csRank, csColor);
    setCardHoverGlow(avgCsEl, csColor);

    const dmgRank = getRankFromDamage(stats.avgDmg, stats.avgDuration);
    const dmgColor = getRankColor(dmgRank);
    const avgDmgEl = document.getElementById('avgDmg');
    avgDmgEl.textContent = formatDamage(stats.avgDmg);
    setStatColor(avgDmgEl, dmgColor);
    setStatRank('avgDmgRank', dmgRank, dmgColor);
    setCardHoverGlow(avgDmgEl, dmgColor);

    // Advanced stats (no rank coloring for now)
    function formatDiff(val) {
        if (val === null || val === undefined) return '--';
        const num = parseFloat(val);
        return num > 0 ? '+' + val : val.toString();
    }

    document.getElementById('avgCsDiff15').textContent = formatDiff(stats.avgCsDiff15);
    document.getElementById('avgGoldDiff15').textContent = formatDiff(stats.avgGoldDiff15);
    document.getElementById('avgXpDiff15').textContent = formatDiff(stats.avgXpDiff15);
    document.getElementById('firstBloodRate').textContent = stats.firstBloodRate !== null ? stats.firstBloodRate + '%' : '--';
    document.getElementById('avgDmgGoldRatio').textContent = stats.avgDmgGoldRatio !== null ? stats.avgDmgGoldRatio : '--';
    document.getElementById('avgIsolatedDeaths').textContent = stats.avgIsolatedDeaths !== null ? stats.avgIsolatedDeaths : '--';
    document.getElementById('avgObjectiveRate').textContent = stats.avgObjectiveRate !== null ? stats.avgObjectiveRate + '%' : '--';

    // Color diff stats green/red based on positive/negative
    ['avgCsDiff15', 'avgGoldDiff15', 'avgXpDiff15'].forEach(id => {
        const el = document.getElementById(id);
        const rawVal = id === 'avgCsDiff15' ? stats.avgCsDiff15 : id === 'avgGoldDiff15' ? stats.avgGoldDiff15 : stats.avgXpDiff15;
        if (rawVal !== null && rawVal !== undefined) {
            const num = parseFloat(rawVal);
            const color = num > 0 ? '#22c55e' : num < 0 ? '#ef4444' : '#a0a0b0';
            setStatColor(el, color);
        }
    });

    // Insight labels for advanced stats
    function setInsightLabel(id, insight) {
        const el = document.getElementById(id);
        if (!el) return;
        const label = insight.tier.charAt(0).toUpperCase() + insight.tier.slice(1);
        el.textContent = label;
        el.style.color = getInsightColor(insight.tier);
    }

    const insightMap = [
        { id: 'avgCsDiff15Insight', labelId: 'avgCsDiff15Label', val: stats.avgCsDiff15, fn: getInsightCsDiff15 },
        { id: 'avgGoldDiff15Insight', labelId: 'avgGoldDiff15Label', val: stats.avgGoldDiff15, fn: getInsightGoldDiff15 },
        { id: 'avgXpDiff15Insight', labelId: 'avgXpDiff15Label', val: stats.avgXpDiff15, fn: getInsightXpDiff15 },
        { id: 'firstBloodRateInsight', labelId: 'firstBloodRateLabel', val: stats.firstBloodRate, fn: getInsightFirstBlood },
        { id: 'avgDmgGoldRatioInsight', labelId: 'avgDmgGoldRatioLabel', val: stats.avgDmgGoldRatio, fn: getInsightDmgGold },
        { id: 'avgIsolatedDeathsInsight', labelId: 'avgIsolatedDeathsLabel', val: stats.avgIsolatedDeaths, fn: getInsightIsolatedDeaths },
        { id: 'avgObjectiveRateInsight', labelId: 'avgObjectiveRateLabel', val: stats.avgObjectiveRate, fn: getInsightObjectiveRate }
    ];

    insightMap.forEach(({ id, labelId, val, fn }) => {
        const insightEl = document.getElementById(id);
        const labelEl = document.getElementById(labelId);
        if (val !== null && val !== undefined) {
            const insight = fn(val);
            setInsightLabel(id, insight);
            if (labelEl) {
                labelEl.dataset.insightTooltip = insight.tooltip;
            }
            const insightColor = getInsightColor(insight.tier);
            if (insightEl) setCardHoverGlow(insightEl, insightColor);
        } else {
            if (insightEl) insightEl.textContent = '';
            if (labelEl) delete labelEl.dataset.insightTooltip;
        }
    });

    // Calculate and display trend indicators
    updateTrendIndicators(filteredMatches, stats);

    // Update match count badge
    document.getElementById('matchCountBadge').textContent = `${filteredMatches.length} ${filteredMatches.length === 1 ? 'match' : 'matches'}`;

    // Render table with filtered matches
    matchList.innerHTML = renderMatchTable(
        filteredMatches,
        matchesData,
        DDRAGON_BASE,
        QUEUE_NAMES,
        getChampionIcon,
        timeAgo,
        formatDamage,
        renderRunes,
        renderSummonerSpells
    );
}

// Calculate trend indicators comparing recent form (last 10) vs historical baseline (all)
// Execution order: 1. Build last10 → 2. Compute R (weighted) → 3. Compute B → 4. Compute trend → 5. Apply inversion → 6. Apply threshold → Assign arrow
function updateTrendIndicators(filteredMatches, baselineStats) {
    const NOISE_THRESHOLD_PCT = 0.03; // 3% threshold for normalized percent-change stats
    const NOISE_THRESHOLD_PP = 2;     // 2pp threshold for percentage-point stats (values are 0-100)

    const trendIds = [
        'avgCsDiff15Trend', 'avgGoldDiff15Trend', 'avgXpDiff15Trend',
        'firstBloodRateTrend', 'avgDmgGoldRatioTrend', 'avgIsolatedDeathsTrend',
        'avgObjectiveRateTrend'
    ];

    // Need at least 11 matches for meaningful comparison (10 recent + some baseline)
    if (filteredMatches.length < 11) {
        trendIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });
        return;
    }

    // Get last 10 matches (recent form) - matches are newest first, reverse for weighting (oldest=index 0)
    const recentMatches = filteredMatches.slice(0, 10).reverse();

    // Weighted average helper: weight = index + 1 (oldest=1, newest=n)
    // R = SUM(v[i] * (i+1)) / SUM(weights)
    function weightedAvg(values) {
        if (values.length === 0) return null;
        let weightedSum = 0;
        let totalWeight = 0;
        values.forEach((v, i) => {
            const weight = i + 1;
            weightedSum += v * weight;
            totalWeight += weight;
        });
        return weightedSum / totalWeight;
    }

    // Extract raw values from recent matches for each stat
    function getRecentValues(matches, field, isBoolField = false) {
        const values = [];
        matches.forEach(m => {
            const val = m[field];
            if (val !== null && val !== undefined) {
                values.push(isBoolField ? val : parseFloat(val));
            }
        });
        return values;
    }

    // Trend config:
    // calcType: 'normalizedPct' = (R-B)/abs(B), 'delta' = R-B (for percentage stats)
    // isInverted: true for Isolated Deaths (lower is better)
    // field: raw match data field, isBoolField: true for firstBlood (0/1)
    const trendConfig = [
        { field: 'csDiff15', baselineKey: 'avgCsDiff15', trendId: 'avgCsDiff15Trend', calcType: 'normalizedPct', isInverted: false },
        { field: 'goldDiff15', baselineKey: 'avgGoldDiff15', trendId: 'avgGoldDiff15Trend', calcType: 'normalizedPct', isInverted: false },
        { field: 'xpDiff15', baselineKey: 'avgXpDiff15', trendId: 'avgXpDiff15Trend', calcType: 'normalizedPct', isInverted: false },
        { field: 'firstBlood', baselineKey: 'firstBloodRate', trendId: 'firstBloodRateTrend', calcType: 'delta', isInverted: false, isBoolField: true },
        { field: 'dmgGoldRatio', baselineKey: 'avgDmgGoldRatio', trendId: 'avgDmgGoldRatioTrend', calcType: 'normalizedPct', isInverted: false },
        { field: 'isolatedDeaths', baselineKey: 'avgIsolatedDeaths', trendId: 'avgIsolatedDeathsTrend', calcType: 'normalizedPct', isInverted: true },
        { field: 'objectiveRate', baselineKey: 'avgObjectiveRate', trendId: 'avgObjectiveRateTrend', calcType: 'delta', isInverted: false }
    ];

    trendConfig.forEach(({ field, baselineKey, trendId, calcType, isInverted, isBoolField }) => {
        const el = document.getElementById(trendId);
        if (!el) return;

        const baselineVal = baselineStats[baselineKey];

        // If baseline is null/undefined, clear the indicator
        if (baselineVal === null || baselineVal === undefined) {
            el.innerHTML = '';
            el.className = 'stat-trend-indicator';
            return;
        }

        // STEP 1: Build last10 values (ordered oldest -> newest for weighting)
        const recentValues = getRecentValues(recentMatches, field, isBoolField);

        if (recentValues.length === 0) {
            el.innerHTML = '';
            el.className = 'stat-trend-indicator';
            return;
        }

        // STEP 2: Compute R (weighted recent average)
        let R;
        if (isBoolField) {
            // For firstBlood: compute weighted rate as percentage (0-100)
            // Weight each match's contribution (1 or 0) then convert to percentage
            R = weightedAvg(recentValues) * 100;
        } else if (calcType === 'delta') {
            // For objectiveRate: values are already percentages, use weighted avg
            R = weightedAvg(recentValues);
        } else {
            // For numeric stats: use weighted avg
            R = weightedAvg(recentValues);
        }

        // STEP 3: Get B (baseline average from all matches)
        const B = parseFloat(baselineVal);

        // STEP 4: Compute trend
        let trend;
        let displayText;
        const threshold = calcType === 'delta' ? NOISE_THRESHOLD_PP : NOISE_THRESHOLD_PCT;

        if (calcType === 'delta') {
            // For percentage-based stats (First Blood %, Objective %): use delta in percentage points
            trend = R - B;
            // Display as percentage points
            displayText = trend === 0 ? '0pp' : (trend > 0 ? `+${trend.toFixed(0)}pp` : `${trend.toFixed(0)}pp`);
        } else {
            // For normalized percent change stats: (R - B) / abs(B)
            // Handle zero baseline
            if (B === 0) {
                if (R === 0) {
                    trend = 0;
                } else {
                    trend = R > 0 ? 1 : -1;
                }
            } else {
                trend = (R - B) / Math.abs(B);
            }
            // Display as percentage
            displayText = trend === 0 ? '0%' : (trend > 0 ? `+${(trend * 100).toFixed(0)}%` : `${(trend * 100).toFixed(0)}%`);
        }

        // STEP 5: Apply inversion (Isolated Deaths only)
        if (isInverted) {
            trend = trend * -1;
        }

        // STEP 6: Apply threshold and assign arrow
        let state;
        let arrow;

        // For delta stats, compare trend directly to pp threshold; for pct stats, compare to decimal threshold
        const absThreshold = calcType === 'delta' ? threshold : threshold;

        if (Math.abs(trend) < absThreshold) {
            // No meaningful change
            state = 'neutral';
            arrow = '→';
            displayText = calcType === 'delta' ? '0pp' : '0%';
        } else if (trend > 0) {
            // Improvement (player trending better)
            state = 'improvement';
            arrow = '↑';
        } else {
            // Decline (player trending worse)
            state = 'decline';
            arrow = '↓';
        }

        el.className = `stat-trend-indicator ${state}`;
        el.innerHTML = `
            <span class="trend-arrow">${arrow}</span>
            <span class="trend-percent">${displayText}</span>
        `;
    });
}

function updateChampionDropdown(matches) {
    const select = document.getElementById('champFilter');
    const currentValue = select.value;

    // Get unique champion names from queue-filtered matches, sorted alphabetically
    const champions = [...new Set(matches.map(m => m.championName).filter(Boolean))].sort();

    // Rebuild options with All and None at the top
    select.innerHTML = '';

    // Add All option (shows all champions - no filter)
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All Champions';
    select.appendChild(allOpt);

    // Add None option (clears filter explicitly)
    const noneOpt = document.createElement('option');
    noneOpt.value = '__none__';
    noneOpt.textContent = 'None (Clear Filter)';
    select.appendChild(noneOpt);

    // Add separator-like option
    const sepOpt = document.createElement('option');
    sepOpt.disabled = true;
    sepOpt.textContent = '──────────';
    select.appendChild(sepOpt);

    // Add all champions
    champions.forEach(champ => {
        const count = matches.filter(m => m.championName === champ).length;
        const opt = document.createElement('option');
        opt.value = champ;
        opt.textContent = `${champ} (${count})`;
        if (champ === currentValue) opt.selected = true;
        select.appendChild(opt);
    });

    // If previous selection no longer exists in filtered set, reset
    if (currentValue && currentValue !== '__none__' && !champions.includes(currentValue)) {
        select.value = '';
    }
}

// Display ranked stats function
function displayRankedStats(allMatches) {
    const rankedStats = getRankedStats(allMatches);
    const soloStats = rankedStats.solo;
    const flexStats = rankedStats.flex;

    // Update Solo/Duo stats from stored match data (fallback if API fails)
    if (soloStats.totalMatches > 0) {
        document.getElementById('soloWins').textContent = soloStats.wins;
        document.getElementById('soloLosses').textContent = soloStats.losses;
        document.getElementById('soloWinRate').textContent = soloStats.winRate + '%';
    }

    if (flexStats.totalMatches > 0) {
        document.getElementById('flexWins').textContent = flexStats.wins;
        document.getElementById('flexLosses').textContent = flexStats.losses;
        document.getElementById('flexWinRate').textContent = flexStats.winRate + '%';
    }
}

// Fetch and display rank data from Riot API
async function fetchAndDisplayRankData() {
    try {
        console.log('=== Starting fetchAndDisplayRankData ===');
        const { getLeagueData } = window.require('./services/matchService');
        const config = loadConfig();
        const name = document.getElementById('gameName').value.trim() || config.gameName;
        const tag = document.getElementById('tagLine').value.trim() || config.tagLine;

        if (!name || !tag) {
            console.log('No summoner name/tag configured, skipping rank fetch');
            return;
        }

        console.log(`Looking up PUUID for ${name}#${tag}...`);
        const puuid = await getPuuidByRiotId(name, tag);
        console.log('PUUID found:', puuid);

        console.log('Fetching league data...');
        const leagueData = await getLeagueData(puuid);
        console.log('League data received:', leagueData);

        // Update Solo/Duo rank display
        if (leagueData.solo) {
            const solo = leagueData.solo;
            console.log('Updating Solo rank UI with:', solo);
            document.getElementById('soloRankText').textContent = `${solo.tier} ${solo.rank} (${solo.leaguePoints} LP)`;
            document.getElementById('soloWins').textContent = solo.wins;
            document.getElementById('soloLosses').textContent = solo.losses;
            const soloWinRate = Math.round((solo.wins / (solo.wins + solo.losses)) * 100);
            document.getElementById('soloWinRate').textContent = soloWinRate + '%';
            document.getElementById('soloRankIcon').src = `assets/ranks/emblem-${solo.tier.toLowerCase()}.png`;
            document.getElementById('rankedSoloCard').classList.remove('no-data');
            console.log('Solo rank UI updated successfully');
        } else {
            console.log('No Solo/Duo rank data - player is unranked in Solo/Duo');
            document.getElementById('rankedSoloCard').classList.add('no-data');
        }

        // Update Flex rank display
        if (leagueData.flex) {
            const flex = leagueData.flex;
            console.log('Updating Flex rank UI with:', flex);
            document.getElementById('flexRankText').textContent = `${flex.tier} ${flex.rank} (${flex.leaguePoints} LP)`;
            document.getElementById('flexWins').textContent = flex.wins;
            document.getElementById('flexLosses').textContent = flex.losses;
            const flexWinRate = Math.round((flex.wins / (flex.wins + flex.losses)) * 100);
            document.getElementById('flexWinRate').textContent = flexWinRate + '%';
            document.getElementById('flexRankIcon').src = `assets/ranks/emblem-${flex.tier.toLowerCase()}.png`;
            document.getElementById('rankedFlexCard').classList.remove('no-data');
            console.log('Flex rank UI updated successfully');
        } else {
            console.log('No Flex rank data - player is unranked in Flex');
            document.getElementById('rankedFlexCard').classList.add('no-data');
        }

        console.log('=== fetchAndDisplayRankData completed successfully ===');
    } catch (err) {
        console.error('=== ERROR in fetchAndDisplayRankData ===');
        console.error('Error message:', err.message);
        console.error('Error stack:', err.stack);
        if (err.response) {
            console.error('API Response status:', err.response.status);
            console.error('API Response data:', err.response.data);
        }
    }
}

// Load and display matches from database
async function loadMatchHistory(skipRankFetch = false) {
    console.log('!!! loadMatchHistory called !!!');
    try {
        const matches = await getMatches(); // Get all matches instead of limiting to 50
        const stats = await getStats();

        // Store for modal access and filtering
        matchesData = matches;

        // Initialize filters if not done yet
        if (activeQueueFilters.size === 0) {
            initializeFilters();
        }

        // Pre-fill inputs from config if empty
        const config = loadConfig();
        if (!document.getElementById('gameName').value && config.gameName) {
            document.getElementById('gameName').value = config.gameName;
            document.getElementById('tagLine').value = config.tagLine;
        }

        // Fetch rank data immediately and wait for it (skip if already fetched during sync)
        if (!skipRankFetch) {
            await fetchAndDisplayRankData();
        }

        if (matches.length > 0) {
            // Show unified stats section
            document.getElementById('unifiedStatsSection').style.display = 'block';
            document.getElementById('matchCount').textContent = stats.totalMatches;

            const winRate = stats.totalMatches > 0 ? Math.round((stats.wins / stats.totalMatches) * 100) : 0;
            document.getElementById('winRate').textContent = winRate + '%';

            const avgKda = stats.avgDeaths > 0
                ? ((stats.avgKills + stats.avgAssists) / stats.avgDeaths).toFixed(2)
                : (stats.avgKills + stats.avgAssists).toFixed(2);
            document.getElementById('avgKda').textContent = avgKda;

            // Rank data is fetched from API via fetchAndDisplayRankData() above
            // No need to display database-calculated ranked stats here

            // Show match history
            document.getElementById('matchHistory').style.display = 'block';

            // Render with filters
            renderFilteredMatches();

            showToast('Welcome Back', `${stats.totalMatches} matches loaded`);
        } else {
            const userName = config.gameName || 'your account';
            showToast('Welcome', `Ready to sync matches for ${userName}`);
        }
    } catch (err) {
        console.error('Failed to load matches:', err);
        showToast('Error', 'Failed to load match history: ' + err.message);
    }
}

// Toast notification functions
function showToast(title, message, duration = 3000) {
    const toast = document.getElementById('toastNotification');
    const toastTitle = document.getElementById('toastTitle');
    const toastMessage = document.getElementById('toastMessage');

    toastTitle.textContent = title;
    toastMessage.textContent = message || '';

    toast.classList.add('show');

    // Auto-hide after duration
    setTimeout(() => {
        hideToast();
    }, duration);
}

function hideToast() {
    const toast = document.getElementById('toastNotification');
    toast.classList.remove('show');
}

// ===== TOOLTIP FUNCTIONALITY =====
const tooltip = () => document.getElementById('gameTooltip');

function initTooltips() {
    console.log('Initializing tooltips...');

    // Use event delegation on document
    document.addEventListener('mouseover', handleTooltipShow);
    document.addEventListener('mouseout', handleTooltipHide);
    document.addEventListener('mousemove', handleTooltipMove);
}

function handleTooltipShow(e) {
    // Check if hovering over item
    if (e.target.dataset && e.target.dataset.itemId) {
        const itemId = e.target.dataset.itemId;
        showItemTooltip(itemId);
        return;
    }

    // Check if hovering over rune
    if (e.target.dataset && e.target.dataset.runeId) {
        const runeId = parseInt(e.target.dataset.runeId);
        showRuneTooltip(runeId);
        return;
    }

    // Check if hovering over summoner spell
    if (e.target.dataset && e.target.dataset.spellId) {
        const spellId = parseInt(e.target.dataset.spellId);
        showSummonerSpellTooltip(spellId);
        return;
    }

    // Check if hovering over badge (or child of badge)
    const badgeEl = e.target.closest('.badge-pill');
    if (badgeEl && badgeEl.dataset.badgeTooltip) {
        showBadgeTooltip(badgeEl);
        return;
    }

    // Check if hovering over insight stat label
    if (e.target.dataset && e.target.dataset.insightTooltip) {
        showInsightTooltip(e.target);
        return;
    }

    // Check if hovering over column header tooltip
    if (e.target.dataset && e.target.dataset.columnTooltip) {
        showColumnTooltip(e.target);
        return;
    }
}

function handleTooltipHide(e) {
    // Only hide if we're NOT moving to another tooltip element
    const related = e.relatedTarget;
    if (!related || (!related.dataset?.itemId && !related.dataset?.runeId && !related.dataset?.spellId && !related.closest?.('.badge-pill') && !related.dataset?.insightTooltip && !related.dataset?.columnTooltip)) {
        hideTooltip();
    }
}

function handleTooltipMove(e) {
    const tooltipEl = tooltip();
    if (tooltipEl.style.display === 'block') {
        positionTooltip(e.clientX, e.clientY);
    }
}

function showItemTooltip(itemId) {
    const itemData = getItemData(itemId);
    if (!itemData) {
        console.warn('No item data found for ID:', itemId);
        return;
    }

    const tooltipEl = tooltip();
    const titleEl = tooltipEl.querySelector('.tooltip-title');
    const descEl = tooltipEl.querySelector('.tooltip-description');

    // Format gold cost
    const totalCost = itemData.gold?.total || 0;
    const baseCost = itemData.gold?.base || 0;
    const costText = baseCost > 0 ? `<span class="item-cost">Cost: <span class="gold-value">${totalCost}</span> (<span class="gold-value">${baseCost}</span>)</span>` : `<span class="item-cost">Cost: <span class="gold-value">${totalCost}</span></span>`;

    // Get description and parse it properly
    let description = itemData.description || '';

    // Strip Riot wrapper tags
    description = description.replace(/<\/?mainText>/gi, '');

    // Handle stats section
    description = description.replace(/<stats>/gi, '<div class="item-stats">');
    description = description.replace(/<\/stats>/gi, '</div>');

    // Handle passive/active labels
    description = description.replace(/<passive>/gi, '<span class="item-passive-label">');
    description = description.replace(/<\/passive>/gi, '</span>');
    description = description.replace(/<active>/gi, '<span class="item-active-label">');
    description = description.replace(/<\/active>/gi, '</span>');

    // Handle other known Riot tags
    description = description.replace(/<attention>/gi, '<span class="item-attention">');
    description = description.replace(/<\/attention>/gi, '</span>');
    description = description.replace(/<unique>/gi, '<span class="item-unique">');
    description = description.replace(/<\/unique>/gi, '</span>');
    description = description.replace(/<rarityMythic>/gi, '<span class="item-mythic">');
    description = description.replace(/<\/rarityMythic>/gi, '</span>');
    description = description.replace(/<rarityLegendary>/gi, '<span class="item-legendary">');
    description = description.replace(/<\/rarityLegendary>/gi, '</span>');

    // Strip any remaining unknown Riot custom tags (non-standard HTML)
    description = description.replace(/<\/?[a-zA-Z]+[A-Z][a-zA-Z]*>/g, '');

    // Remove <br> adjacent to block elements (div open/close, passive/active labels)
    description = description.replace(/<\/div>\s*(<br\s*\/?>[\s]*)+ /gi, '</div>');
    description = description.replace(/(<br\s*\/?>[\s]*)+\s*<div/gi, '<div');
    description = description.replace(/(<br\s*\/?>[\s]*)+\s*<span class="item-(passive|active)-label">/gi, '<span class="item-$2-label">');

    // Normalize line breaks: collapse 2+ consecutive <br> into a single one
    description = description.replace(/(<br\s*\/?>[\s]*){2,}/gi, '<br>');

    // Remove leading/trailing <br>
    description = description.replace(/^(\s*<br\s*\/?>)+/gi, '');
    description = description.replace(/(<br\s*\/?>)+\s*$/gi, '');

    titleEl.innerHTML = `${itemData.name || 'Unknown Item'}<br>${costText}`;
    descEl.innerHTML = description;

    tooltipEl.style.display = 'block';
}

function showRuneTooltip(runeId) {
    const runeData = getRuneData(runeId);
    if (!runeData) {
        console.warn('No rune data found for ID:', runeId);
        return;
    }

    const tooltipEl = tooltip();
    const titleEl = tooltipEl.querySelector('.tooltip-title');
    const descEl = tooltipEl.querySelector('.tooltip-description');

    titleEl.textContent = runeData.name || 'Unknown Rune';
    descEl.textContent = runeData.shortDesc || runeData.description || 'No description available';

    tooltipEl.style.display = 'block';
}

function showBadgeTooltip(badgeEl) {
    const description = badgeEl.dataset.badgeTooltip || '';

    const tooltipEl = tooltip();
    const titleEl = tooltipEl.querySelector('.tooltip-title');
    const descEl = tooltipEl.querySelector('.tooltip-description');

    const nameEl = badgeEl.querySelector('.badge-name');
    titleEl.textContent = nameEl ? nameEl.textContent : '';
    descEl.textContent = description;

    tooltipEl.style.display = 'block';
}

function showInsightTooltip(labelEl) {
    const description = labelEl.dataset.insightTooltip || '';
    if (!description) return;

    const tooltipEl = tooltip();
    const titleEl = tooltipEl.querySelector('.tooltip-title');
    const descEl = tooltipEl.querySelector('.tooltip-description');

    titleEl.textContent = labelEl.textContent;
    descEl.textContent = description;

    tooltipEl.style.display = 'block';
}

function showSummonerSpellTooltip(spellId) {
    const spellData = getSummonerSpellData(spellId);
    if (!spellData) {
        console.warn('No summoner spell data found for ID:', spellId);
        return;
    }

    const tooltipEl = tooltip();
    const titleEl = tooltipEl.querySelector('.tooltip-title');
    const descEl = tooltipEl.querySelector('.tooltip-description');

    titleEl.textContent = spellData.name || 'Unknown Spell';
    descEl.textContent = spellData.description || 'No description available';

    tooltipEl.style.display = 'block';
}

function showColumnTooltip(el) {
    const description = el.dataset.columnTooltip || '';
    if (!description) return;

    const tooltipEl = tooltip();
    const titleEl = tooltipEl.querySelector('.tooltip-title');
    const descEl = tooltipEl.querySelector('.tooltip-description');

    titleEl.textContent = el.textContent;
    descEl.textContent = description;

    tooltipEl.style.display = 'block';
}

function hideTooltip() {
    tooltip().style.display = 'none';
}

function positionTooltip(x, y) {
    const tooltipEl = tooltip();
    const offset = 15;
    const tooltipWidth = tooltipEl.offsetWidth;
    const tooltipHeight = tooltipEl.offsetHeight;

    // Position to the right and below cursor by default
    let left = x + offset;
    let top = y + offset;

    // Flip to left if would go off screen
    if (left + tooltipWidth > window.innerWidth) {
        left = x - tooltipWidth - offset;
    }

    // Flip to above if would go off screen
    if (top + tooltipHeight > window.innerHeight) {
        top = y - tooltipHeight - offset;
    }

    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = top + 'px';
}

// ===== EXPANDABLE ROW FUNCTIONALITY =====
const badgeCache = new Map();

async function toggleRowExpand(index) {
    const match = matchesData[index];
    if (!match) return;

    // Find the clicked row
    const clickedRow = document.querySelector(`tr[data-match-index="${index}"]`);
    if (!clickedRow) return;

    // Check if there's already an expanded row after this row
    const nextRow = clickedRow.nextElementSibling;
    const isCurrentlyExpanded = nextRow && nextRow.classList.contains('expanded-row') && nextRow.dataset.matchIndex == index;

    // Remove any existing expanded rows
    document.querySelectorAll('.expanded-row').forEach(row => row.remove());

    // If clicking the same row that was expanded, just collapse it (already removed above)
    if (isCurrentlyExpanded) {
        return;
    }

    // Evaluate badges (fetch full match data including timeline if needed)
    let badges = [];
    if (badgeCache.has(match.matchId)) {
        badges = badgeCache.get(match.matchId);
    } else {
        try {
            const fullMatch = await getMatchById(match.matchId);
            if (fullMatch) {
                badges = evaluateBadges(fullMatch);
                badgeCache.set(match.matchId, badges);
            }
        } catch (err) {
            console.warn('Badge evaluation failed:', err);
        }
    }

    // Create and insert new expanded row
    const expandedRow = createExpandedRow(match, index, badges);
    clickedRow.insertAdjacentHTML('afterend', expandedRow);
}

function createExpandedRow(match, index, badges = []) {
    // Parse rawJson and timelineJson to get all participants with full data
    let teamData = { team100: [], team200: [] };
    let timelineFrames = null;

    if (match.rawJson) {
        try {
            const matchData = typeof match.rawJson === 'string' ? JSON.parse(match.rawJson) : match.rawJson;
            const participants = matchData.info?.participants || [];

            // Parse timeline for GD@15/XPD@15
            if (match.timelineJson) {
                const timeline = typeof match.timelineJson === 'string' ? JSON.parse(match.timelineJson) : match.timelineJson;
                timelineFrames = timeline?.info?.frames || null;
            }

            // Build position map for lane opponent matching
            const positionMap = {};
            participants.forEach((p, idx) => {
                const pos = p.teamPosition || p.lane || '';
                const key = `${p.teamId}-${pos}`;
                positionMap[key] = { participantId: p.participantId || (idx + 1), ...p };
            });

            participants.forEach((p, idx) => {
                const participantId = p.participantId || (idx + 1);
                const position = p.teamPosition || p.lane || '';

                // Calculate GD@15 and XPD@15 vs lane opponent
                let gd15 = null;
                let xpd15 = null;

                if (timelineFrames && position) {
                    const frame15 = timelineFrames[15] || timelineFrames[timelineFrames.length - 1];
                    if (frame15 && frame15.participantFrames) {
                        const myFrame = frame15.participantFrames[participantId];
                        // Find opponent with same position on enemy team
                        const enemyTeamId = p.teamId === 100 ? 200 : 100;
                        const oppKey = `${enemyTeamId}-${position}`;
                        const opponent = positionMap[oppKey];

                        if (myFrame && opponent) {
                            const oppFrame = frame15.participantFrames[opponent.participantId];
                            if (oppFrame) {
                                gd15 = (myFrame.totalGold || 0) - (oppFrame.totalGold || 0);
                                xpd15 = (myFrame.xp || 0) - (oppFrame.xp || 0);
                            }
                        }
                    }
                }

                // Calculate total pings
                const totalPings = (p.allInPings || 0) + (p.assistMePings || 0) + (p.basicPings || 0) +
                    (p.commandPings || 0) + (p.dangerPings || 0) + (p.enemyMissingPings || 0) +
                    (p.enemyVisionPings || 0) + (p.getBackPings || 0) + (p.holdPings || 0) +
                    (p.needVisionPings || 0) + (p.onMyWayPings || 0) + (p.pushPings || 0) +
                    (p.visionClearedPings || 0);

                // Calculate DMG/Gold ratio
                const dmgGoldRatio = p.goldEarned > 0 ? (p.totalDamageDealtToChampions / p.goldEarned).toFixed(2) : '0.00';

                const playerData = {
                    championName: p.championName,
                    summonerName: p.riotIdGameName || p.summonerName || 'Unknown',
                    kills: p.kills,
                    deaths: p.deaths,
                    assists: p.assists,
                    cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
                    level: p.champLevel,
                    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
                    primaryRune: p.perks?.styles?.[0]?.selections?.[0]?.perk || null,
                    secondaryRuneStyle: p.perks?.styles?.[1]?.style || null,
                    summoner1Id: p.summoner1Id,
                    summoner2Id: p.summoner2Id,
                    damage: p.totalDamageDealtToChampions || 0,
                    goldDiff15: gd15,
                    xpDiff15: xpd15,
                    dmgGoldRatio: dmgGoldRatio,
                    totalPings: totalPings,
                    controlWardsBought: p.visionWardsBoughtInGame || 0,
                    towerDamage: p.damageDealtToTurrets || 0,
                    isCurrentPlayer: p.championName === match.championName && p.teamId === match.teamId
                };

                if (p.teamId === 100) {
                    teamData.team100.push(playerData);
                } else {
                    teamData.team200.push(playerData);
                }
            });
        } catch (e) {
            console.error('Error parsing match data:', e);
        }
    }

    // Helper to format diff values with color
    function formatDiff(val) {
        if (val === null || val === undefined) return '-';
        const num = parseInt(val);
        const formatted = num > 0 ? '+' + num : num.toString();
        return formatted;
    }

    function getDiffColor(val) {
        if (val === null || val === undefined) return '#8a8a9a';
        return val > 0 ? '#22c55e' : val < 0 ? '#ef4444' : '#8a8a9a';
    }

    // Helper to render player row with all new columns
    function renderPlayerRow(player, gameDuration) {
        const kda = player.deaths === 0 ? 'Perfect' : ((player.kills + player.assists) / player.deaths).toFixed(2);
        const kdaNum = player.deaths === 0 ? 99 : ((player.kills + player.assists) / player.deaths);
        const champIcon = getChampionIcon(player.championName);

        // Calculate CS/min
        const csPerMin = gameDuration > 0 ? (player.cs / (gameDuration / 60)).toFixed(1) : '0.0';

        // Split items into 2 rows (3+4)
        const itemsTop = player.items.slice(0, 3).map(itemId => {
            if (itemId && itemId > 0) {
                return `<img src="${DDRAGON_BASE}/img/item/${itemId}.png" class="team-item-sm" data-item-id="${itemId}" alt="Item">`;
            }
            return `<div class="team-item-empty-sm"></div>`;
        }).join('');

        const itemsBottom = player.items.slice(3, 7).map(itemId => {
            if (itemId && itemId > 0) {
                return `<img src="${DDRAGON_BASE}/img/item/${itemId}.png" class="team-item-sm" data-item-id="${itemId}" alt="Item">`;
            }
            return `<div class="team-item-empty-sm"></div>`;
        }).join('');

        // Runes
        const primaryRunePath = RUNE_ICONS[player.primaryRune] || null;
        const secondaryRunePath = RUNE_ICONS[player.secondaryRuneStyle] || null;

        const runesHTML = `
            <div class="team-runes-sm">
                ${primaryRunePath ? `<img src="https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${primaryRunePath}" class="team-rune-sm" data-rune-id="${player.primaryRune}" alt="Primary">` : '<div class="team-rune-empty-sm"></div>'}
                ${secondaryRunePath ? `<img src="https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${secondaryRunePath}" class="team-rune-sm team-rune-secondary-sm" data-rune-id="${player.secondaryRuneStyle}" alt="Secondary">` : '<div class="team-rune-empty-sm"></div>'}
            </div>
        `;

        // Summoner Spells
        const spell1Img = player.summoner1Id ? getSummonerSpellImageName(player.summoner1Id) : null;
        const spell2Img = player.summoner2Id ? getSummonerSpellImageName(player.summoner2Id) : null;

        const spellsHTML = `
            <div class="team-spells-sm">
                ${spell1Img ? `<img src="${DDRAGON_BASE}/img/spell/${spell1Img}" class="team-spell-sm" data-spell-id="${player.summoner1Id}" alt="Spell 1">` : '<div class="team-spell-empty-sm"></div>'}
                ${spell2Img ? `<img src="${DDRAGON_BASE}/img/spell/${spell2Img}" class="team-spell-sm" data-spell-id="${player.summoner2Id}" alt="Spell 2">` : '<div class="team-spell-empty-sm"></div>'}
            </div>
        `;

        return `
            <tr class="${player.isCurrentPlayer ? 'current-player-row' : ''}">
                <td class="team-player-cell">
                    <img src="${champIcon}" class="team-champion-icon-sm" alt="${player.championName}">
                    <span class="team-player-name-sm">${player.summonerName}</span>
                </td>
                <td class="team-items-cell-sm">
                    <div class="items-row-sm">${itemsTop}</div>
                    <div class="items-row-sm">${itemsBottom}</div>
                </td>
                <td class="team-cell-center">${runesHTML}</td>
                <td class="team-cell-center">${spellsHTML}</td>
                <td class="team-cell-center">${player.kills}</td>
                <td class="team-cell-center">${player.deaths}</td>
                <td class="team-cell-center">${player.assists}</td>
                <td class="team-cell-center" style="color: ${kdaNum >= 3 ? '#22c55e' : kdaNum >= 2 ? '#fbbf24' : '#ef4444'}; font-weight: 600;">${kda}</td>
                <td class="team-cell-center">${player.cs}</td>
                <td class="team-cell-center">${csPerMin}</td>
                <td class="team-cell-center">${player.level}</td>
                <td class="team-cell-center">${formatDamage(player.damage)}</td>
                <td class="team-cell-center" style="color: ${getDiffColor(player.goldDiff15)}">${formatDiff(player.goldDiff15)}</td>
                <td class="team-cell-center" style="color: ${getDiffColor(player.xpDiff15)}">${formatDiff(player.xpDiff15)}</td>
                <td class="team-cell-center">${player.dmgGoldRatio}</td>
                <td class="team-cell-center">${player.totalPings}</td>
                <td class="team-cell-center">${player.controlWardsBought}</td>
                <td class="team-cell-center">${formatDamage(player.towerDamage)}</td>
            </tr>
        `;
    }

    // Determine which team the player is on
    const playerOnTeam100 = teamData.team100.some(p => p.isCurrentPlayer);

    // Your team first, enemy team second (vertical layout)
    const yourTeam = playerOnTeam100 ? teamData.team100 : teamData.team200;
    const enemyTeam = playerOnTeam100 ? teamData.team200 : teamData.team100;
    const yourTeamWon = match.win;
    const enemyTeamWon = !match.win;

    // Build badges HTML (now at top)
    const badgesHTML = badges.length > 0 ? `
        <div class="badges-section-top">
            <div class="badges-header">Badges Earned <span class="badges-count">${badges.length}</span></div>
            <div class="badges-grid">
                ${badges.map(b => {
                    const desc = b.description.replace(/"/g, '&apos;');
                    return `<div class="badge-pill" data-badge-tooltip="${desc}">
                        <span class="badge-name">${b.name}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>` : '';

    // Table header with tooltips for new columns
    const tableHeader = `
        <thead>
            <tr>
                <th>Player</th>
                <th>Items</th>
                <th>Runes</th>
                <th>SP</th>
                <th>K</th>
                <th>D</th>
                <th>A</th>
                <th>KDA</th>
                <th>CS</th>
                <th>CS/M</th>
                <th>LVL</th>
                <th>DMG</th>
                <th class="tooltip-header" data-column-tooltip="Gold difference vs lane opponent at 15 minutes">GD@15</th>
                <th class="tooltip-header" data-column-tooltip="XP difference vs lane opponent at 15 minutes">XPD@15</th>
                <th class="tooltip-header" data-column-tooltip="Damage dealt per gold earned - measures gold efficiency">DMG/Gold</th>
                <th>Pings</th>
                <th class="tooltip-header" data-column-tooltip="Control wards bought">CWB</th>
                <th class="tooltip-header" data-column-tooltip="Total tower damage">TTD</th>
            </tr>
        </thead>
    `;

    return `
        <tr class="expanded-row" data-match-index="${index}">
            <td colspan="100%">
                <div class="expanded-content-vertical">
                    ${badgesHTML}
                    <div class="teams-vertical">
                        <div class="team-section-full ${yourTeamWon ? 'team-win' : 'team-loss'}">
                            <div class="team-header">${yourTeamWon ? 'Victory' : 'Defeat'} - Your Team</div>
                            <div class="team-table-wrapper">
                                <table class="team-table-expanded">
                                    ${tableHeader}
                                    <tbody>
                                        ${yourTeam.map(p => renderPlayerRow(p, match.gameDuration)).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <div class="team-section-full ${enemyTeamWon ? 'team-win' : 'team-loss'}">
                            <div class="team-header">${enemyTeamWon ? 'Victory' : 'Defeat'} - Enemy Team</div>
                            <div class="team-table-wrapper">
                                <table class="team-table-expanded">
                                    ${tableHeader}
                                    <tbody>
                                        ${enemyTeam.map(p => renderPlayerRow(p, match.gameDuration)).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </td>
        </tr>
    `;
}

function updateStatus(type, title, message) {
    // Forward to toast system
    showToast(title, message, type === 'error' ? 5000 : 3000);
}

let syncCooldownInterval = null;
let syncCooldownEnd = 0;
const SYNC_COOLDOWN_SECONDS = 120; // 2 minutes matching Riot rate limit window

function setButtonLoading(loading) {
    const btn = document.getElementById('syncBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnIcon = btn.querySelector('.btn-icon');

    btn.disabled = loading;

    if (loading) {
        btnIcon.innerHTML = '<div class="spinner"></div>';
        btnText.textContent = 'Syncing...';
    } else {
        btnIcon.innerHTML = '&#8635;';
        btnText.textContent = 'Sync Matches';
    }
}

function startSyncCooldown() {
    const btn = document.getElementById('syncBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnIcon = btn.querySelector('.btn-icon');

    syncCooldownEnd = Date.now() + SYNC_COOLDOWN_SECONDS * 1000;
    btn.disabled = true;
    btnIcon.innerHTML = '&#9202;'; // timer icon

    function updateCooldown() {
        const remaining = Math.max(0, Math.ceil((syncCooldownEnd - Date.now()) / 1000));
        if (remaining <= 0) {
            clearInterval(syncCooldownInterval);
            syncCooldownInterval = null;
            btn.disabled = false;
            btnIcon.innerHTML = '&#8635;';
            btnText.textContent = 'Sync Matches';
            return;
        }
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        btnText.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    updateCooldown();
    syncCooldownInterval = setInterval(updateCooldown, 1000);
}

function updateProgress(current, total) {
    const container = document.getElementById('progressContainer');
    const fill = document.getElementById('progressFill');
    const count = document.getElementById('progressCount');

    container.classList.add('visible');
    const percentage = total > 0 ? (current / total) * 100 : 0;
    fill.style.width = percentage + '%';
    count.textContent = `${current} / ${total}`;
}

function hideProgress() {
    const container = document.getElementById('progressContainer');
    const fill = document.getElementById('progressFill');
    container.classList.remove('visible');
    fill.style.width = '0%';
}

window.handleSync = async function () {
    const name = document.getElementById('gameName').value.trim();
    const tag = document.getElementById('tagLine').value.trim();

    console.log('=== handleSync DEBUG ===');
    console.log('Raw name from input:', JSON.stringify(name));
    console.log('Raw tag from input:', JSON.stringify(tag));
    console.log('Name length:', name.length, 'Tag length:', tag.length);

    // Check config
    const config = loadConfig();
    console.log('Config loaded:', JSON.stringify(config, null, 2));
    console.log('Config API key present:', config.apiKey ? 'YES (length: ' + config.apiKey.length + ')' : 'NO');

    if (!name || !tag) {
        updateStatus('error', 'Missing Information', 'Please enter both your game name and tag');
        return;
    }

    // Don't allow sync during cooldown
    if (syncCooldownInterval) {
        updateStatus('error', 'Cooldown Active', 'Please wait for the cooldown to finish');
        return;
    }

    setButtonLoading(true);

    try {
        updateStatus('loading', 'Finding Account', `Looking up ${name}#${tag}...`);
        const puuid = await getPuuidByRiotId(name, tag);

        // Fetch rank data FIRST before heavy API usage to avoid rate limit issues
        await fetchAndDisplayRankData();

        updateStatus('loading', 'Syncing Matches', 'Fetching your recent match history...');
        const result = await syncMatches(puuid, (current, total) => {
            updateProgress(current, total);
        });

        hideProgress();

        // Backfill timeline data for any matches missing it
        const backfillResult = await backfillTimelines((current, total) => {
            updateStatus('loading', 'Fetching Timelines', `${current}/${total} match timelines...`);
            updateProgress(current, total);
        });
        hideProgress();

        // Backfill advanced stats for matches that have timeline data but no computed stats
        const advancedResult = await backfillAdvancedStats((current, total) => {
            updateStatus('loading', 'Computing Advanced Stats', `${current}/${total} matches...`);
            updateProgress(current, total);
        });
        hideProgress();

        // Fetch player ranks for newly synced matches only
        let rankMsg = '';
        if (result.newMatchIds && result.newMatchIds.length > 0) {
            const rankResult = await fetchRanksForNewMatches(result.newMatchIds, (current, total) => {
                updateStatus('loading', 'Fetching Player Ranks', `${current}/${total} players...`);
                updateProgress(current, total);
            });
            hideProgress();
            rankMsg = rankResult.total > 0 ? `, ${rankResult.fetched} player ranks fetched` : '';
        }

        // Reload match history to show new matches (skip rank fetch - already done above)
        await loadMatchHistory(true);

        // Show sync complete message
        const advancedMsg = advancedResult.total > 0 ? `, ${advancedResult.updated} stats computed` : '';
        const timelineMsg = backfillResult.total > 0 ? `, ${backfillResult.updated} timelines added` : '';
        updateStatus('success', 'Sync Complete', `${result.newMatches} new matches added${timelineMsg}${advancedMsg}${rankMsg}`);

        // Start cooldown timer
        startSyncCooldown();

    } catch (err) {
        console.error(err);
        hideProgress();

        let errorMessage = err.message;
        if (err.response?.status === 403) {
            errorMessage = 'Invalid or expired API key';
        } else if (err.response?.status === 404) {
            errorMessage = 'Player not found. Check your Riot ID';
        } else if (err.response?.status === 429) {
            errorMessage = 'Rate limited. Please wait a moment';
        }

        updateStatus('error', 'Sync Failed', errorMessage);
    } finally {
        // Only reset button if cooldown hasn't taken over
        if (!syncCooldownInterval) {
            setButtonLoading(false);
        }
    }
}

// Modal functions for match details
async function openMatchModal(index) {
    const match = matchesData[index];
    if (!match) return;

    const modal = document.getElementById('matchModal');
    const modalHeader = document.getElementById('modalHeader');
    const modalBody = document.getElementById('modalBody');

    // Fetch full match data including rawJson
    const fullMatch = await getMatchById(match.matchId);
    if (!fullMatch || !fullMatch.rawJson) {
        console.error('Could not load full match data');
        return;
    }

    const matchData = JSON.parse(fullMatch.rawJson);
    const info = matchData.info;

    const isWin = match.win === 1;
    const queueName = QUEUE_NAMES[match.queueId] || 'Game';
    const champIcon = getChampionIcon(match.championName);
    const kda = match.deaths === 0 ? 'Perfect' : ((match.kills + match.assists) / match.deaths).toFixed(2);

    // Build modal header
    modalHeader.innerHTML = `
                <div class="modal-champion-icon">
                    ${champIcon ? `<img src="${champIcon}" alt="${match.championName}">` : ''}
                </div>
                <div class="modal-title-group">
                    <div class="modal-champion-name">${match.championName || 'Unknown'}</div>
                    <div class="modal-match-info">${queueName} · ${formatDuration(match.gameDuration)} · ${timeAgo(match.gameCreation)}</div>
                </div>
                <div class="modal-result-badge ${isWin ? 'win' : 'loss'}">
                    ${isWin ? 'Victory' : 'Defeat'}
                </div>
            `;

    // Separate teams
    const myTeam = info.participants.filter(p => p.teamId === match.teamId);
    const enemyTeam = info.participants.filter(p => p.teamId !== match.teamId);

    // Fetch cached rank data for all participants
    const participantRanks = await getMatchParticipantRanks(match.matchId);

    // Render team composition
    function renderTeam(team, isMyTeam, rankMap) {
        const teamWin = team[0].win;
        const MASTER_PLUS = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];
        return team.map(player => {
            const isMe = player.puuid === info.participants.find(p => p.championName === match.championName && p.teamId === match.teamId)?.puuid;
            const role = player.teamPosition || player.lane || '?';
            const playerChampIcon = getChampionIcon(player.championName);

            // Build rank badge (first column)
            const playerRank = rankMap[player.puuid];
            const soloTier = playerRank?.soloTier || null;
            const soloDiv = playerRank?.soloRank || '';
            const rankTooltip = soloTier
                ? (MASTER_PLUS.includes(soloTier) ? soloTier.charAt(0) + soloTier.slice(1).toLowerCase() : soloTier.charAt(0) + soloTier.slice(1).toLowerCase() + ' ' + soloDiv)
                : 'Unranked';
            const rankBadgeHtml = soloTier
                ? `<div class="team-player-rank" title="${rankTooltip}">
                       <img src="assets/ranks/emblem-${soloTier.toLowerCase()}.png" alt="${rankTooltip}" class="rank-emblem-mini">
                   </div>`
                : `<div class="team-player-rank unranked" title="Unranked">
                       <span class="rank-unranked-dash">-</span>
                   </div>`;

            // Build item slots for this player
            const items = [player.item0, player.item1, player.item2, player.item3, player.item4, player.item5, player.item6];
            const playerItems = items.map(itemId => {
                if (itemId && itemId > 0) {
                    return `<div class="item-slot-small has-item"><img src="${DDRAGON_BASE}/img/item/${itemId}.png" alt="Item" onerror="this.style.display='none'"></div>`;
                }
                return `<div class="item-slot-small"></div>`;
            }).join('');

            return `
                        <div class="team-player ${isMe ? 'me' : ''}">
                            ${rankBadgeHtml}
                            <div class="team-player-champ">
                                ${playerChampIcon ? `<img src="${playerChampIcon}" alt="${player.championName}">` : ''}
                            </div>
                            <div class="team-player-info">
                                <div class="team-player-name">${player.riotIdGameName || player.summonerName || 'Unknown'}</div>
                                <div class="team-player-role">${getPositionName(role)}</div>
                                <div class="team-player-items">${playerItems}</div>
                            </div>
                            <div class="team-player-stats">
                                <span class="team-player-kda">${player.kills}/${player.deaths}/${player.assists}</span>
                            </div>
                        </div>
                    `;
        }).join('');
    }

    // Build modal body with teams and objectives
    modalBody.innerHTML = `
                <div class="modal-section">
                    <div class="modal-section-title">Team Objectives</div>
                    
                    <div class="objectives-comparison">
                        <div class="obj-team-score ${match.teamDragons > match.enemyDragons ? 'win' : (match.teamDragons < match.enemyDragons ? 'loss' : '')}">${match.teamDragons || 0}</div>
                        <div class="obj-label"><span class="obj-icon-large">🐉</span><br>Dragons</div>
                        <div class="obj-team-score ${match.enemyDragons > match.teamDragons ? 'win' : (match.enemyDragons < match.teamDragons ? 'loss' : '')}">${match.enemyDragons || 0}</div>
                    </div>

                    <div class="objectives-comparison">
                        <div class="obj-team-score ${match.teamBarons > match.enemyBarons ? 'win' : (match.teamBarons < match.enemyBarons ? 'loss' : '')}">${match.teamBarons || 0}</div>
                        <div class="obj-label"><span class="obj-icon-large">👾</span><br>Barons</div>
                        <div class="obj-team-score ${match.enemyBarons > match.teamBarons ? 'win' : (match.enemyBarons < match.teamBarons ? 'loss' : '')}">${match.enemyBarons || 0}</div>
                    </div>

                    <div class="objectives-comparison">
                        <div class="obj-team-score ${match.teamRiftHeralds > match.enemyRiftHeralds ? 'win' : (match.teamRiftHeralds < match.enemyRiftHeralds ? 'loss' : '')}">${match.teamRiftHeralds || 0}</div>
                        <div class="obj-label"><span class="obj-icon-large">⚔️</span><br>Rift Heralds</div>
                        <div class="obj-team-score ${match.enemyRiftHeralds > match.teamRiftHeralds ? 'win' : (match.enemyRiftHeralds < match.teamRiftHeralds ? 'loss' : '')}">${match.enemyRiftHeralds || 0}</div>
                    </div>

                    <div class="objectives-comparison">
                        <div class="obj-team-score ${match.teamTowers > match.enemyTowers ? 'win' : (match.teamTowers < match.enemyTowers ? 'loss' : '')}">${match.teamTowers || 0}</div>
                        <div class="obj-label"><span class="obj-icon-large">🏰</span><br>Towers</div>
                        <div class="obj-team-score ${match.enemyTowers > match.teamTowers ? 'win' : (match.enemyTowers < match.teamTowers ? 'loss' : '')}">${match.enemyTowers || 0}</div>
                    </div>

                    <div class="objectives-comparison">
                        <div class="obj-team-score ${match.teamInhibitors > match.enemyInhibitors ? 'win' : (match.teamInhibitors < match.enemyInhibitors ? 'loss' : '')}">${match.teamInhibitors || 0}</div>
                        <div class="obj-label"><span class="obj-icon-large">💥</span><br>Inhibitors</div>
                        <div class="obj-team-score ${match.enemyInhibitors > match.teamInhibitors ? 'win' : (match.enemyInhibitors < match.teamInhibitors ? 'loss' : '')}">${match.enemyInhibitors || 0}</div>
                    </div>
                </div>

                <div class="modal-section">
                    <div class="modal-section-title">Teams</div>
                    <div class="teams-container">
                        <div class="team-column ${myTeam[0].win ? 'victory' : 'defeat'}">
                            <div class="team-header">
                                <div class="team-title">${myTeam[0].win ? 'Victory' : 'Defeat'} - Your Team</div>
                            </div>
                            ${renderTeam(myTeam, true, participantRanks)}
                        </div>
                        <div class="team-column ${enemyTeam[0].win ? 'victory' : 'defeat'}">
                            <div class="team-header">
                                <div class="team-title">${enemyTeam[0].win ? 'Victory' : 'Defeat'} - Enemy Team</div>
                            </div>
                            ${renderTeam(enemyTeam, false, participantRanks)}
                        </div>
                    </div>
                </div>

                <div class="modal-section">
                    <div class="modal-section-title">Your Performance</div>
                    <div class="modal-stats-grid">
                        <div class="modal-stat-card">
                            <div class="modal-stat-value highlight">${match.kills}/${match.deaths}/${match.assists}</div>
                            <div class="modal-stat-label">K / D / A</div>
                        </div>
                        <div class="modal-stat-card">
                            <div class="modal-stat-value highlight">${kda}</div>
                            <div class="modal-stat-label">KDA Ratio</div>
                        </div>
                        <div class="modal-stat-card">
                            <div class="modal-stat-value">${formatDamage(match.totalDamageDealtToChampions)}</div>
                            <div class="modal-stat-label">Damage</div>
                        </div>
                        <div class="modal-stat-card">
                            <div class="modal-stat-value">${match.champLevel || 0}</div>
                            <div class="modal-stat-label">Level</div>
                        </div>
                        <div class="modal-stat-card">
                            <div class="modal-stat-value">${match.totalMinionsKilled || 0}</div>
                            <div class="modal-stat-label">CS</div>
                        </div>
                        <div class="modal-stat-card">
                            <div class="modal-stat-value">${((match.totalMinionsKilled || 0) / (match.gameDuration / 60)).toFixed(1)}</div>
                            <div class="modal-stat-label">CS/Min</div>
                        </div>
                        <div class="modal-stat-card">
                            <div class="modal-stat-value">${(match.goldEarned / 1000).toFixed(1)}k</div>
                            <div class="modal-stat-label">Gold</div>
                        </div>
                        <div class="modal-stat-card">
                            <div class="modal-stat-value">${match.visionScore || 0}</div>
                            <div class="modal-stat-label">Vision</div>
                        </div>
                    </div>
                </div>

                ${match.pentaKills || match.quadraKills || match.tripleKills || match.doubleKills ? `
                <div class="modal-section">
                    <div class="modal-section-title">Multi-Kills</div>
                    <div class="modal-badges">
                        ${match.pentaKills > 0 ? `<div class="modal-badge penta">🔥 ${match.pentaKills} Penta Kill${match.pentaKills > 1 ? 's' : ''}</div>` : ''}
                        ${match.quadraKills > 0 ? `<div class="modal-badge quadra">⚡ ${match.quadraKills} Quadra Kill${match.quadraKills > 1 ? 's' : ''}</div>` : ''}
                        ${match.tripleKills > 0 ? `<div class="modal-badge triple">💫 ${match.tripleKills} Triple Kill${match.tripleKills > 1 ? 's' : ''}</div>` : ''}
                        ${match.doubleKills > 0 ? `<div class="modal-badge double">⭐ ${match.doubleKills} Double Kill${match.doubleKills > 1 ? 's' : ''}</div>` : ''}
                    </div>
                </div>
                ` : ''}

                <div class="modal-section">
                    <div class="modal-section-title">Final Build</div>
                    <div class="modal-items-grid">
                        ${renderModalItems(match)}
                    </div>
                </div>
            `;

    // Show modal
    modal.classList.add('visible');
}

function closeModal() {
    const modal = document.getElementById('matchModal');
    modal.classList.remove('visible');
}

function closeModalOnBackdrop(event) {
    if (event.target.id === 'matchModal') {
        closeModal();
    }
}

// Render items for modal (larger size)
function renderModalItems(match) {
    const items = [match.item0, match.item1, match.item2, match.item3, match.item4, match.item5, match.item6];
    return items.map(itemId => {
        if (itemId && itemId > 0) {
            return `<div class="modal-item"><img src="${DDRAGON_BASE}/img/item/${itemId}.png" alt="Item" onerror="this.parentElement.style.display='none'"></div>`;
        }
        return '';
    }).join('');
}

// Close modal with Escape key
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        closeModal();
    }
});

// Allow Enter key to trigger sync
document.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        handleSync();
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    // Randomly pick a background image
    const backgrounds = [
        'bandle city.png', 'bilgewater.png', 'demacia.png', 'freljord.png',
        'ionia.png', 'ixtal.png', 'league of legends5.png', 'noxus.png',
        'piltover.png', 'shadow isles.png', 'shurima.png', 'targon.png',
        'the void.png', 'zaun.png'
    ];
    const randomBg = backgrounds[Math.floor(Math.random() * backgrounds.length)];
    const bgPath = `./assets/backgrounds/${randomBg}`;
    document.body.style.backgroundImage = `linear-gradient(rgba(15, 15, 18, 0.85), rgba(15, 15, 18, 0.85)), url('${bgPath}')`;
    document.body.style.backgroundRepeat = 'no-repeat';
    document.body.style.backgroundPosition = 'center center';
    document.body.style.backgroundAttachment = 'fixed';
    document.body.style.backgroundSize = 'cover';

    // Check config on startup - show setup modal if needed
    const configValid = checkConfigOnStartup();

    // Load Data Dragon assets (auto-fetches latest version)
    try {
        console.log('Loading game data...');
        await loadGameData();
        DDRAGON_BASE = getDDragonBase();
        console.log('Game data loaded successfully');
    } catch (err) {
        console.warn('Failed to load game data, tooltips will not work:', err);
    }

    // Initialize tooltips
    initTooltips();

    // Only load match history if config is valid
    if (configValid) {
        await loadMatchHistory();
    }
});
