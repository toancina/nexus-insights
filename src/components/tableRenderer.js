// Table rendering module for match display

// Get position icon URL from Community Dragon
const { escapeHtml } = require('./dom');
const { itemImg } = require('./itemIcon');
const { decodePurchases, lastBoughtAt } = require('../services/itemBuild');
const { formatClock } = require('../services/matchTimeline');

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

// Get rank color based on rank tier — shared palette, same hex as the
// analytics cards and LP charts.
const { tierColor } = require('./rankTiers');
function getRankColor(rank) {
    return rank ? tierColor(rank) : '#8a8a9a';
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
function renderMatchRow(match, index, DDRAGON_BASE, QUEUE_NAMES, getChampionIcon, formatDamage, renderRunes, renderSummonerSpells) {
    const isWin = match.win === 1;
    // No deaths counts as one, like the Analytics cards: 0/0/1 is 1.00, not "Perfect"
    const kdaNum = (match.kills + match.assists) / Math.max(1, match.deaths);
    const kda = kdaNum.toFixed(2);

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
    // "Bought at" in the item tooltip, from the stored purchases (#7)
    const bought = lastBoughtAt(decodePurchases(match.itemPurchases));
    const itemSlot = itemId => {
        if (itemId && itemId > 0) {
            const at = bought.has(itemId) ? ` data-bought="${formatClock(bought.get(itemId))}"` : '';
            return `<div class="table-item-slot has-item">${itemImg(itemId, { patch: match.patch, extra: at })}</div>`;
        }
        return `<div class="table-item-slot"></div>`;
    };
    const itemsRow1 = items.slice(0, 4).map(itemSlot).join('');
    const itemsRow2 = items.slice(4, 7).map(itemSlot).join('');

    // Remakes stay visible in the list but are excluded from every statistic,
    // so they're labelled to explain why the counts don't add up.
    const isRemake = typeof window !== 'undefined' && typeof window.isRemake === 'function'
        ? window.isRemake(match)
        : (match.gameDuration || 0) < 300;

    return `
        <tr class="${isWin ? 'win' : 'loss'}${isRemake ? ' remake' : ''}" data-match-index="${index}" onclick="toggleRowExpand(${index})" style="cursor: pointer;">
            <td class="table-game-mode">${queueName}${isRemake ? '<span class="remake-tag" title="Remake — excluded from all statistics">REMAKE</span>' : ''}</td>
            <td>
                <div class="table-champion-cell">
                    <div class="table-champion-icon">
                        ${champIcon ? `<img src="${champIcon}" alt="${escapeHtml(match.championName)}" onerror="this.style.display='none'">` : ''}
                    </div>
                    <span class="table-champion-name">${formatChampionName(match.championName)}</span>${renderImpactTag(match)}
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
            <td class="center">${renderLpDelta(match.matchId)}</td>
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

/**
 * MVP / SVP next to the champion: you were the highest-impact player on your
 * team (services/teamImpact.js). Stored per match, so no rawJson is needed.
 */
function renderImpactTag(match) {
    if (match.impactTag !== 'MVP' && match.impactTag !== 'SVP') return '';
    const side = match.impactTag === 'MVP' ? 'winning' : 'losing';
    const title = `Best player on the ${side} team by impact (#${match.impactRank} of 10)`;
    return `<span class="impact-tag impact-tag--${match.impactTag.toLowerCase()}" title="${title}">${match.impactTag}</span>`;
}

/**
 * LP gained or lost on a match, when known.
 *
 * Populated on `window.lpDeltas` by the renderer from `getLpDeltasByMatch()`.
 * Only games played while the LP watcher was running can have a value — Riot
 * publishes no LP history, so anything older is genuinely unknowable and
 * renders as a dash rather than a guess.
 */
function renderLpDelta(matchId) {
    const delta = window.lpDeltas ? window.lpDeltas[matchId] : undefined;
    if (delta === undefined || delta === null) {
        // No reading for this game: show the estimate (#5), marked with ~
        const est = window.lpEstimates && window.lpEstimates.byMatch ? window.lpEstimates.byMatch[matchId] : null;
        if (est && est.estimated) {
            const s = est.delta > 0 ? '+' : '';
            return `<span class="lp-delta lp-delta--estimated" title="Estimate: no LP reading for this game. Based on your usual LP per win/loss, fitted between known readings and checkpoints.">~${s}${est.delta}</span>`;
        }
        return '<span class="lp-delta lp-delta--unknown" title="LP tracking only covers games played with Nexus Insights (and the League client) open — Riot doesn\'t expose LP history, so older games can\'t be backfilled.">—</span>';
    }
    const cls  = delta > 0 ? 'lp-delta--gain' : (delta < 0 ? 'lp-delta--loss' : 'lp-delta--flat');
    const sign = delta > 0 ? '+' : '';
    return `<span class="lp-delta ${cls}">${sign}${delta}</span>`;
}

/**
 * Map matchId -> index in the full dataset.
 *
 * Row markup embeds the index into window.matchesData so click handlers can
 * find the match again. This used to be `matchesData.indexOf(match)` per row,
 * which is a linear scan inside a map — O(n²) over the history. The map is
 * cached and only rebuilt when the dataset identity changes.
 */
let _indexMapSource = null;
let _indexMap       = null;

function getIndexMap(matchesData) {
    if (_indexMapSource !== matchesData) {
        _indexMap = new Map();
        matchesData.forEach((m, i) => _indexMap.set(m.matchId, i));
        _indexMapSource = matchesData;
    }
    return _indexMap;
}

/** Just the <tr> rows — used both for a full render and for appending a page. */
function renderMatchRows(matches, matchesData, DDRAGON_BASE, QUEUE_NAMES, getChampionIcon, formatDamage, renderRunes, renderSummonerSpells) {
    const indexMap = getIndexMap(matchesData);
    return matches.map((match) => {
        const originalIndex = indexMap.has(match.matchId) ? indexMap.get(match.matchId) : -1;
        return renderMatchRow(match, originalIndex, DDRAGON_BASE, QUEUE_NAMES, getChampionIcon, formatDamage, renderRunes, renderSummonerSpells);
    }).join('');
}

// Render match table with header
function renderMatchTable(matches, matchesData, DDRAGON_BASE, QUEUE_NAMES, getChampionIcon, formatDamage, renderRunes, renderSummonerSpells) {
    if (matches.length === 0) {
        return `
            <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <div class="empty-state-text">No matches found for selected filters</div>
            </div>
        `;
    }

    const matchRows = renderMatchRows(matches, matchesData, DDRAGON_BASE, QUEUE_NAMES, getChampionIcon, formatDamage, renderRunes, renderSummonerSpells);

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
                        <th class="center" title="LP gained or lost on this game. Only populated for games played with the app open — see the column for why.">LP</th>
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

// Win/loss summary for a set of matches (consumed by getRankedStats).
function calculateStats(matches) {
    const totalMatches = matches ? matches.length : 0;
    const wins = totalMatches ? matches.filter(m => m.win === 1).length : 0;
    const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;
    return { totalMatches, wins, winRate };
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

module.exports = {
    renderMatchRows,
    renderMatchTable,
    calculateStats,
    getRankedStats,
    getRankColor,
    getRankFromKDA,
    getRankFromKP,
    getRankFromCSM,
    getRankFromDamage
};
