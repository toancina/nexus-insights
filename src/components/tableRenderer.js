// Table rendering module for match display

// Get position icon URL from Community Dragon
function getPositionIcon(teamPosition) {
    if (!teamPosition) return null;

    // Map teamPosition values to icon names
    const positionMap = {
        'TOP': 'top',
        'JUNGLE': 'jungle',
        'MIDDLE': 'middle',
        'MID': 'middle',
        'BOTTOM': 'bottom',
        'BOT': 'bottom',
        'UTILITY': 'utility',
        'SUPPORT': 'utility'
    };

    const iconName = positionMap[teamPosition.toUpperCase()];
    if (!iconName) return null;

    return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-champ-select/global/default/svg/position-${iconName}.svg`;
}

// Format champion name with spaces (e.g., LeeSin -> Lee Sin)
function formatChampionName(name) {
    if (!name) return 'Unknown';
    // Add space before capital letters (except the first one)
    return name.replace(/([A-Z])/g, ' $1').trim();
}

// Get rank color based on rank tier
function getRankColor(rank) {
    const rankColors = {
        'iron': '#6b7280',        // Grey
        'bronze': '#cd7f32',      // Bronze/Copper
        'silver': '#c0c0c0',      // Silver
        'gold': '#ffd700',        // Gold
        'platinum': '#4ecca3',    // Teal/Platinum
        'emerald': '#50c878',     // Emerald green
        'diamond': '#b9f2ff',     // Diamond blue
        'master': '#e78aff'       // Master+ purple
    };
    return rankColors[rank] || '#8a8a9a';
}

// Get rank from KDA value
function getRankFromKDA(kda) {
    if (kda >= 2.8) return 'master';
    if (kda >= 2.5) return 'diamond';
    if (kda >= 2.4) return 'emerald';
    if (kda >= 2.3) return 'platinum';
    if (kda >= 2.2) return 'gold';
    if (kda >= 2.1) return 'silver';
    if (kda >= 2.0) return 'bronze';
    return 'iron';
}

// Get rank from CS/M value
function getRankFromCSM(csm) {
    if (csm >= 8.5) return 'master';
    if (csm >= 7.8) return 'diamond';
    if (csm >= 7.3) return 'emerald';
    if (csm >= 6.8) return 'platinum';
    if (csm >= 6.1) return 'gold';
    if (csm >= 5.3) return 'silver';
    if (csm >= 4.5) return 'bronze';
    return 'iron';
}

// Get rank from Avg Total CS value
function getRankFromCS(cs) {
    if (cs >= 270) return 'master';
    if (cs >= 245) return 'diamond';
    if (cs >= 230) return 'emerald';
    if (cs >= 215) return 'platinum';
    if (cs >= 195) return 'gold';
    if (cs >= 170) return 'silver';
    if (cs >= 140) return 'bronze';
    return 'iron';
}

// Get rank from damage value (normalized to per-minute, then scaled to 30 min)
function getRankFromDamage(damage, gameDurationSeconds) {
    // Normalize damage to 30 minute game (1800 seconds)
    const normalizedDamage = gameDurationSeconds > 0
        ? (damage / gameDurationSeconds) * 1800
        : damage;

    if (normalizedDamage >= 28500) return 'master';   // 950/min
    if (normalizedDamage >= 25500) return 'diamond';   // 850/min
    if (normalizedDamage >= 23400) return 'emerald';   // 780/min
    if (normalizedDamage >= 21000) return 'platinum';  // 700/min
    if (normalizedDamage >= 18600) return 'gold';      // 620/min
    if (normalizedDamage >= 16500) return 'silver';    // 550/min
    if (normalizedDamage >= 13500) return 'bronze';    // 450/min
    return 'iron';
}

// Get rank from Win Rate value
function getRankFromWinRate(wr) {
    if (wr >= 53) return 'master';
    if (wr >= 52) return 'diamond';
    if (wr >= 51) return 'emerald';
    if (wr >= 50) return 'platinum';
    if (wr >= 49) return 'gold';
    if (wr >= 48) return 'silver';
    if (wr >= 47) return 'bronze';
    return 'iron';
}

// Get rank from KP% value
function getRankFromKP(kp) {
    if (kp >= 58) return 'master';
    if (kp >= 54) return 'diamond';
    if (kp >= 52) return 'emerald';
    if (kp >= 50) return 'platinum';
    if (kp >= 48) return 'gold';
    if (kp >= 45) return 'silver';
    if (kp >= 40) return 'bronze';
    return 'iron';
}

// Render table row for a match
function renderMatchRow(match, index, DDRAGON_BASE, QUEUE_NAMES, getChampionIcon, timeAgo, formatDamage, renderRunes, renderSummonerSpells) {
    const isWin = match.win === 1;
    const kda = match.deaths === 0 ? 'Perfect' : ((match.kills + match.assists) / match.deaths).toFixed(2);
    const kdaNum = match.deaths === 0 ? 99 : ((match.kills + match.assists) / match.deaths);

    // Calculate KP%
    const totalTeamKills = match.teamKills || 0;
    const kpNum = totalTeamKills > 0 ? Math.round(((match.kills + match.assists) / totalTeamKills) * 100) : 0;
    const kpDisplay = totalTeamKills > 0 ? `${kpNum}%` : 'N/A';

    const queueName = QUEUE_NAMES[match.queueId] || 'Game';
    const champIcon = getChampionIcon(match.championName);
    const csPerMin = match.gameDuration > 0 ? ((match.totalMinionsKilled || 0) / (match.gameDuration / 60)).toFixed(1) : '0.0';
    const csPerMinNum = parseFloat(csPerMin);
    const durationMins = match.gameDuration > 0 ? Math.round(match.gameDuration / 60) : '?';

    // Get rank-based colors for KDA, CS/M, Damage, and KP
    const kdaRank = getRankFromKDA(kdaNum);
    const kdaColor = getRankColor(kdaRank);
    const csmRank = getRankFromCSM(csPerMinNum);
    const csmColor = getRankColor(csmRank);
    const damageRank = getRankFromDamage(match.totalDamageDealtToChampions || 0, match.gameDuration);
    const damageColor = getRankColor(damageRank);
    const kpRank = getRankFromKP(kpNum);
    const kpColor = totalTeamKills > 0 ? getRankColor(kpRank) : '#8a8a9a';

    // Build items HTML for table display in 2 rows (smaller icons)
    const items = [match.item0, match.item1, match.item2, match.item3, match.item4, match.item5, match.item6];
    const itemsRow1 = items.slice(0, 4).map(itemId => {
        if (itemId && itemId > 0) {
            return `<div class="table-item-slot has-item"><img src="${DDRAGON_BASE}/img/item/${itemId}.png" alt="Item" data-item-id="${itemId}" onerror="this.style.display='none'"></div>`;
        }
        return `<div class="table-item-slot"></div>`;
    }).join('');

    const itemsRow2 = items.slice(4, 7).map(itemId => {
        if (itemId && itemId > 0) {
            return `<div class="table-item-slot has-item"><img src="${DDRAGON_BASE}/img/item/${itemId}.png" alt="Item" data-item-id="${itemId}" onerror="this.style.display='none'"></div>`;
        }
        return `<div class="table-item-slot"></div>`;
    }).join('');

    return `
        <tr class="${isWin ? 'win' : 'loss'}" data-match-index="${index}" onclick="toggleRowExpand(${index})" style="cursor: pointer;">
            <td class="table-game-mode">${queueName}</td>
            <td>
                <div class="table-champion-cell">
                    <div class="table-champion-icon">
                        ${champIcon ? `<img src="${champIcon}" alt="${match.championName}" onerror="this.style.display='none'">` : ''}
                    </div>
                    <span class="table-champion-name">${formatChampionName(match.championName)}</span>
                </div>
            </td>
            <td class="center">
                <div class="table-items-container">
                    <div class="table-items-row">${itemsRow1}</div>
                    <div class="table-items-row">${itemsRow2}</div>
                </div>
            </td>
            <td class="center">
                <div class="table-runes-container">
                    ${renderRunes ? renderRunes(match) : ''}
                </div>
            </td>
            <td class="center">
                <div class="table-spells-container">
                    ${renderSummonerSpells ? renderSummonerSpells(match) : ''}
                </div>
            </td>
            <td class="center">
                ${match.teamPosition ? `<img src="${getPositionIcon(match.teamPosition)}" alt="${match.teamPosition}" class="position-icon" style="width: 28px; height: 28px; filter: brightness(0.8);" onerror="this.style.display='none'">` : '?'}
            </td>
            <td class="center">${match.champLevel || '?'}</td>
            <td class="center">${durationMins}m</td>
            <td class="center">
                <span class="table-outcome-badge ${isWin ? 'win' : 'loss'}">${isWin ? 'Victory' : 'Defeat'}</span>
            </td>
            <td class="center">${match.kills}</td>
            <td class="center">${match.deaths}</td>
            <td class="center">${match.assists}</td>
            <td class="center" style="color:${kdaColor}; font-weight: 700;">${kda}</td>
            <td class="center" style="color:${kpColor}; font-weight: 700;">${kpDisplay}</td>
            <td class="center" style="color:${csmColor}; font-weight: 700;">${match.totalMinionsKilled || 0}</td>
            <td class="center" style="color:${csmColor}; font-weight: 700;">${csPerMin}</td>
            <td class="center" style="color:${damageColor}; font-weight: 700;">${formatDamage(match.totalDamageDealtToChampions)}</td>
            <td class="center">${match.wardsPlaced || 0}</td>
            <td class="center" style="color:#f97316;">${match.teamDragons || 0}</td>
            <td class="center" style="color:#a855f7;">${match.teamBarons || 0}</td>
            <td class="center" style="color:#8b5cf6;">${match.teamRiftHeralds || 0}</td>
            <td class="center" style="color:#3b82f6;">${match.teamTowers || 0}</td>
        </tr>
    `;
}

// Render match table with header
function renderMatchTable(matches, matchesData, DDRAGON_BASE, QUEUE_NAMES, getChampionIcon, timeAgo, formatDamage, renderRunes, renderSummonerSpells) {
    if (matches.length === 0) {
        return `
            <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <div class="empty-state-text">No matches found for selected filters</div>
            </div>
        `;
    }

    const matchRows = matches.map((match) => {
        const originalIndex = matchesData.indexOf(match);
        return renderMatchRow(match, originalIndex, DDRAGON_BASE, QUEUE_NAMES, getChampionIcon, timeAgo, formatDamage, renderRunes, renderSummonerSpells);
    }).join('');

    return `
        <div class="match-table-container">
            <table class="match-table">
                <thead>
                    <tr>
                        <th>Mode</th>
                        <th>Champion</th>
                        <th class="center">Items</th>
                        <th class="center">Runes</th>
                        <th class="center">SP</th>
                        <th class="center">Position</th>
                        <th class="center">Level</th>
                        <th class="center">Duration</th>
                        <th class="center">Result</th>
                        <th class="center">K</th>
                        <th class="center">D</th>
                        <th class="center">A</th>
                        <th class="center">KDA</th>
                        <th class="center">KP%</th>
                        <th class="center">CS</th>
                        <th class="center">CS/M</th>
                        <th class="center">DMG</th>
                        <th class="center">Wards</th>
                        <th class="center">Dragons</th>
                        <th class="center">Barons</th>
                        <th class="center">Heralds</th>
                        <th class="center">Towers</th>
                    </tr>
                </thead>
                <tbody>
                    ${matchRows}
                </tbody>
            </table>
        </div>
    `;
}

// Calculate stats from filtered matches
function calculateStats(matches) {
    if (!matches || matches.length === 0) {
        return {
            totalMatches: 0,
            wins: 0,
            winRate: 0,
            avgKda: '0.00',
            avgKp: 0,
            avgCsm: '0.0',
            avgCs: 0,
            avgDmg: 0
        };
    }

    const totalMatches = matches.length;
    const wins = matches.filter(m => m.win === 1).length;
    const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;

    let totalKda = 0;
    let totalKp = 0;
    let kpCount = 0;
    let totalCsm = 0;
    let totalCs = 0;
    let totalDmg = 0;
    let totalDuration = 0;

    matches.forEach(match => {
        // KDA
        const kda = match.deaths === 0
            ? (match.kills + match.assists)
            : ((match.kills + match.assists) / match.deaths);
        totalKda += kda;

        // KP%
        const teamKills = match.teamKills || 0;
        if (teamKills > 0) {
            totalKp += ((match.kills + match.assists) / teamKills) * 100;
            kpCount++;
        }

        // CS/M
        const cs = match.totalMinionsKilled || 0;
        totalCs += cs;
        if (match.gameDuration > 0) {
            totalCsm += cs / (match.gameDuration / 60);
        }

        // DMG
        totalDmg += match.totalDamageDealtToChampions || 0;
        totalDuration += match.gameDuration || 0;
    });

    const avgKda = totalMatches > 0 ? (totalKda / totalMatches).toFixed(2) : '0.00';
    const avgKp = kpCount > 0 ? Math.round(totalKp / kpCount) : 0;
    const avgCsm = totalMatches > 0 ? (totalCsm / totalMatches).toFixed(1) : '0.0';
    const avgCs = totalMatches > 0 ? Math.round(totalCs / totalMatches) : 0;
    const avgDmg = totalMatches > 0 ? Math.round(totalDmg / totalMatches) : 0;
    const avgDuration = totalMatches > 0 ? Math.round(totalDuration / totalMatches) : 0;

    // Advanced stats
    const withCsDiff = matches.filter(m => m.csDiff15 !== null && m.csDiff15 !== undefined);
    const avgCsDiff15 = withCsDiff.length > 0 ? (withCsDiff.reduce((s, m) => s + m.csDiff15, 0) / withCsDiff.length).toFixed(1) : null;

    const withGoldDiff = matches.filter(m => m.goldDiff15 !== null && m.goldDiff15 !== undefined);
    const avgGoldDiff15 = withGoldDiff.length > 0 ? Math.round(withGoldDiff.reduce((s, m) => s + m.goldDiff15, 0) / withGoldDiff.length) : null;

    const withXpDiff = matches.filter(m => m.xpDiff15 !== null && m.xpDiff15 !== undefined);
    const avgXpDiff15 = withXpDiff.length > 0 ? Math.round(withXpDiff.reduce((s, m) => s + m.xpDiff15, 0) / withXpDiff.length) : null;

    const withFb = matches.filter(m => m.firstBlood !== null && m.firstBlood !== undefined);
    const firstBloodRate = withFb.length > 0 ? Math.round((withFb.filter(m => m.firstBlood === 1).length / withFb.length) * 100) : null;

    const withDmgGold = matches.filter(m => m.dmgGoldRatio !== null && m.dmgGoldRatio !== undefined);
    const avgDmgGoldRatio = withDmgGold.length > 0 ? (withDmgGold.reduce((s, m) => s + m.dmgGoldRatio, 0) / withDmgGold.length).toFixed(2) : null;

    const withIso = matches.filter(m => m.isolatedDeaths !== null && m.isolatedDeaths !== undefined);
    const avgIsolatedDeaths = withIso.length > 0 ? (withIso.reduce((s, m) => s + m.isolatedDeaths, 0) / withIso.length).toFixed(1) : null;

    const withObjRate = matches.filter(m => m.objectiveRate !== null && m.objectiveRate !== undefined);
    const avgObjectiveRate = withObjRate.length > 0 ? Math.round(withObjRate.reduce((s, m) => s + m.objectiveRate, 0) / withObjRate.length) : null;

    return {
        totalMatches,
        wins,
        winRate,
        avgKda,
        avgKp,
        avgCsm,
        avgCs,
        avgDmg,
        avgDuration,
        avgCsDiff15,
        avgGoldDiff15,
        avgXpDiff15,
        firstBloodRate,
        avgDmgGoldRatio,
        avgIsolatedDeaths,
        avgObjectiveRate
    };
}

// Calculate ranked stats for Solo/Duo (420) and Flex (440)
function getRankedStats(allMatches) {
    const soloMatches = allMatches.filter(m => m.queueId === 420);
    const flexMatches = allMatches.filter(m => m.queueId === 440);

    const soloStats = calculateStats(soloMatches);
    const flexStats = calculateStats(flexMatches);

    return {
        solo: {
            ...soloStats,
            losses: soloStats.totalMatches - soloStats.wins
        },
        flex: {
            ...flexStats,
            losses: flexStats.totalMatches - flexStats.wins
        }
    };
}

// === Insight tier system (3-tier: Developing / Competitive / Elite) ===

function getInsightColor(tier) {
    const colors = {
        'developing': '#6b7280',
        'competitive': '#22c55e',
        'elite': '#c084fc'
    };
    return colors[tier] || '#6b7280';
}

function getInsightCsDiff15(val) {
    const v = parseFloat(val);
    if (v >= 10) return { tier: 'elite', tooltip: 'Shows if you are winning the pure laning phase mechanics.' };
    if (v >= 3) return { tier: 'competitive', tooltip: 'Shows if you are winning the pure laning phase mechanics.' };
    return { tier: 'developing', tooltip: 'Shows if you are winning the pure laning phase mechanics.' };
}

function getInsightGoldDiff15(val) {
    const v = parseFloat(val);
    if (v >= 500) return { tier: 'elite', tooltip: 'Measures lane dominance, plates, and kill pressure combined.' };
    if (v >= 100) return { tier: 'competitive', tooltip: 'Measures lane dominance, plates, and kill pressure combined.' };
    return { tier: 'developing', tooltip: 'Measures lane dominance, plates, and kill pressure combined.' };
}

function getInsightXpDiff15(val) {
    const v = parseFloat(val);
    if (v >= 250) return { tier: 'elite', tooltip: 'Tracks recall efficiency. High XP leads mean you never miss waves.' };
    if (v >= 50) return { tier: 'competitive', tooltip: 'Tracks recall efficiency. High XP leads mean you never miss waves.' };
    return { tier: 'developing', tooltip: 'Tracks recall efficiency. High XP leads mean you never miss waves.' };
}

function getInsightFirstBlood(val) {
    const v = parseFloat(val);
    if (v >= 15) return { tier: 'elite', tooltip: 'Higher % means you are proactive and creating your own leads.' };
    if (v >= 10) return { tier: 'competitive', tooltip: 'Higher % means you are proactive and creating your own leads.' };
    return { tier: 'developing', tooltip: 'Higher % means you are proactive and creating your own leads.' };
}

function getInsightDmgGold(val) {
    const v = parseFloat(val);
    if (v >= 1.30) return { tier: 'elite', tooltip: 'Measures efficiency. Are you doing more with less?' };
    if (v >= 1.00) return { tier: 'competitive', tooltip: 'Measures efficiency. Are you doing more with less?' };
    return { tier: 'developing', tooltip: 'Measures efficiency. Are you doing more with less?' };
}

function getInsightIsolatedDeaths(val) {
    const v = parseFloat(val);
    // Inverted: lower is better
    if (v < 1) return { tier: 'elite', tooltip: 'The Throw Meter. Elite players rarely die without a trade.' };
    if (v < 3) return { tier: 'competitive', tooltip: 'The Throw Meter. Elite players rarely die without a trade.' };
    return { tier: 'developing', tooltip: 'The Throw Meter. Elite players rarely die without a trade.' };
}

function getInsightObjectiveRate(val) {
    const v = parseFloat(val);
    if (v >= 60) return { tier: 'elite', tooltip: 'Shows your macro impact and presence at Drakes/Barons.' };
    if (v >= 45) return { tier: 'competitive', tooltip: 'Shows your macro impact and presence at Drakes/Barons.' };
    return { tier: 'developing', tooltip: 'Shows your macro impact and presence at Drakes/Barons.' };
}

// Export functions for use in index.html
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        renderMatchTable,
        calculateStats,
        getRankedStats,
        getRankColor,
        getRankFromKDA,
        getRankFromKP,
        getRankFromCSM,
        getRankFromDamage,
        getRankFromWinRate,
        getRankFromCS,
        getInsightColor,
        getInsightCsDiff15,
        getInsightGoldDiff15,
        getInsightXpDiff15,
        getInsightFirstBlood,
        getInsightDmgGold,
        getInsightIsolatedDeaths,
        getInsightObjectiveRate
    };
}
