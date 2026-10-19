/**
 * matchModal.js — Inline expanded table rows (10-player breakdown + badges).
 *
 * The old full-screen match detail modal was removed 2026-07: it became
 * unreachable once match history moved to a table whose rows expand inline.
 * Reads window.matchesData, window.DDRAGON_BASE at call-time.
 */

const { getMatchById }   = require('../services/matchService');
const { itemImg } = require('./itemIcon');
const { evaluateBadges } = require('./badgeEvaluator');
const { escapeHtml, formatInt }     = require('./dom');
const { computeTeamImpact, IMPACT_AREAS } = require('../services/teamImpact');
const { renderMatchTimeline } = require('./matchTimelineChart');
const { renderGameReport } = require('./gameReportPanel');
const { purchasesFromTimeline, lastBoughtAt } = require('../services/itemBuild');
const { formatClock, teamSeries } = require('../services/matchTimeline');
const { lastPurchaseWpa, asStored } = require('../services/itemWpa');
const {
    RUNE_ICONS,
    getChampionIcon,
    formatDamage,
    getSummonerSpellImageName
} = require('./matchCard');

// Badge evaluation cache — avoids re-evaluating on repeated expands
const badgeCache = new Map();

// ---------------------------------------------------------------------------
// EXPANDED ROW HELPERS
// ---------------------------------------------------------------------------

function formatDiff(val) {
    if (val === null || val === undefined) return '-';
    return formatInt(parseInt(val), { signed: true });
}

function getDiffColor(val) {
    if (val === null || val === undefined) return '#8a8a9a';
    return val > 0 ? '#22c55e' : val < 0 ? '#ef4444' : '#8a8a9a';
}

/** "#2 SVP" cell; the per-area breakdown is in the hover title. */
function renderImpactCell(impact) {
    if (!impact) return '<td class="team-cell-center">-</td>';
    const breakdown = IMPACT_AREAS
        .filter(([key]) => impact.shares[key] !== null)
        .map(([key, label]) => `${label}: ${impact.shares[key]}% of team`);
    const title = [`Impact ${impact.score} (average share of team)`, ...breakdown].join('\n');
    const tag = impact.tag
        ? `<span class="impact-tag impact-tag--${impact.tag.toLowerCase()}">${impact.tag}</span>`
        : '';
    return `<td class="team-cell-center impact-cell" title="${escapeHtml(title)}">#${impact.rank}${tag}</td>`;
}

function renderPlayerRow(player, gameDuration, patch) {
    // No deaths counts as one, like the Analytics cards: 0/0/1 is 1.00, not "Perfect"
    const kdaNum = (player.kills + player.assists) / Math.max(1, player.deaths);
    const kda    = kdaNum.toFixed(2);
    const champIcon = getChampionIcon(player.championName);
    const csPerMin  = gameDuration > 0 ? (player.cs / (gameDuration / 60)).toFixed(1) : '0.0';
    const DDRAGON   = window.DDRAGON_BASE;

    // "Bought at" in the item tooltip (#7)
    const at = id => (player.boughtAt && player.boughtAt.has(id) ? ` data-bought="${formatClock(player.boughtAt.get(id))}"` : '')
        + (player.wpaAt && player.wpaAt.has(id) ? ` data-wpa="${player.wpaAt.get(id).from},${player.wpaAt.get(id).to}"` : '');   // #89
    const itemsTop    = player.items.slice(0, 3).map(id =>
        id && id > 0 ? itemImg(id, { patch, extra: `class="team-item-sm"${at(id)}` }) : `<div class="team-item-empty-sm"></div>`
    ).join('');
    const itemsBottom = player.items.slice(3, 7).map(id =>
        id && id > 0 ? itemImg(id, { patch, extra: `class="team-item-sm"${at(id)}` }) : `<div class="team-item-empty-sm"></div>`
    ).join('');

    const primaryPath   = RUNE_ICONS[player.primaryRune]        || null;
    const secondaryPath = RUNE_ICONS[player.secondaryRuneStyle] || null;
    const runesHTML = `
        <div class="team-runes-sm">
            ${primaryPath   ? `<img src="https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${primaryPath}"   class="team-rune-sm" data-rune-id="${player.primaryRune}" alt="Primary">` : '<div class="team-rune-empty-sm"></div>'}
            ${secondaryPath ? `<img src="https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${secondaryPath}" class="team-rune-sm team-rune-secondary-sm" data-rune-id="${player.secondaryRuneStyle}" alt="Secondary">` : '<div class="team-rune-empty-sm"></div>'}
        </div>`;

    const spell1Img = player.summoner1Id ? getSummonerSpellImageName(player.summoner1Id) : null;
    const spell2Img = player.summoner2Id ? getSummonerSpellImageName(player.summoner2Id) : null;
    const spellsHTML = `
        <div class="team-spells-sm">
            ${spell1Img ? `<img src="${DDRAGON}/img/spell/${spell1Img}" class="team-spell-sm" data-spell-id="${player.summoner1Id}" alt="Spell 1">` : '<div class="team-spell-empty-sm"></div>'}
            ${spell2Img ? `<img src="${DDRAGON}/img/spell/${spell2Img}" class="team-spell-sm" data-spell-id="${player.summoner2Id}" alt="Spell 2">` : '<div class="team-spell-empty-sm"></div>'}
        </div>`;

    return `
        <tr class="${player.isCurrentPlayer ? 'current-player-row' : ''}" data-pid="${player.participantId}">
            <td class="team-player-cell">
                <img src="${champIcon}" class="team-champion-icon-sm" alt="${escapeHtml(player.championName)}">
                <span class="team-player-name-sm">${escapeHtml(player.summonerName)}</span>
            </td>
            ${renderImpactCell(player.impact)}
            <td class="team-items-cell-sm">
                <div class="items-row-sm">${itemsTop}</div>
                <div class="items-row-sm">${itemsBottom}</div>
            </td>
            <td class="team-cell-center">${runesHTML}</td>
            <td class="team-cell-center">${spellsHTML}</td>
            <td class="team-cell-center">${player.kills}</td>
            <td class="team-cell-center">${player.deaths}</td>
            <td class="team-cell-center">${player.assists}</td>
            <td class="team-cell-center" style="color:${kdaNum >= 3 ? '#22c55e' : kdaNum >= 2 ? '#fbbf24' : '#ef4444'};font-weight:600">${kda}</td>
            <td class="team-cell-center">${player.cs}</td>
            <td class="team-cell-center">${csPerMin}</td>
            <td class="team-cell-center">${player.level}</td>
            <td class="team-cell-center">${formatDamage(player.damage)}</td>
            <td class="team-cell-center" style="color:${getDiffColor(player.goldDiff15)}">${formatDiff(player.goldDiff15)}</td>
            <td class="team-cell-center" style="color:${getDiffColor(player.xpDiff15)}">${formatDiff(player.xpDiff15)}</td>
            <td class="team-cell-center">${player.dmgGoldRatio}</td>
            <td class="team-cell-center">${player.totalPings}</td>
            <td class="team-cell-center">${player.controlWardsBought}</td>
            <td class="team-cell-center">${formatDamage(player.towerDamage)}</td>
        </tr>`;
}

function buildTeamData(match) {
    const teamData = { team100: [], team200: [] };
    if (!match.rawJson) return teamData;

    let timelineFrames = null;
    try {
        const matchData    = typeof match.rawJson === 'string' ? JSON.parse(match.rawJson) : match.rawJson;
        const participants = matchData.info?.participants || [];

        let timeline = null;
        if (match.timelineJson) {
            timeline        = typeof match.timelineJson === 'string' ? JSON.parse(match.timelineJson) : match.timelineJson;
            timelineFrames  = timeline?.info?.frames || null;
        }

        const impact = computeTeamImpact(participants);

        // Each team's win chance, for the WPA line in item tooltips (#89)
        const seriesOf = timeline
            ? { 100: teamSeries(matchData, timeline, 100), 200: teamSeries(matchData, timeline, 200) }
            : null;

        // Build position map for lane-opponent lookups
        const positionMap = {};
        participants.forEach((p, idx) => {
            const pos = p.teamPosition || p.lane || '';
            positionMap[`${p.teamId}-${pos}`] = { participantId: p.participantId || (idx + 1), ...p };
        });

        // Rounded like the stored columns, so it matches the match row's tooltip
        const wpaFor = (purchases, teamId) => {
            const s = asStored(purchases, seriesOf[teamId] || [], matchData.info?.gameDuration);
            return lastPurchaseWpa(s.purchases, s.points);
        };

        participants.forEach((p, idx) => {
            const participantId = p.participantId || (idx + 1);
            const position      = p.teamPosition || p.lane || '';
            let gd15 = null, xpd15 = null;

            if (timelineFrames && position) {
                const frame15  = timelineFrames[15] || timelineFrames[timelineFrames.length - 1];
                const oppTeam  = p.teamId === 100 ? 200 : 100;
                const opponent = positionMap[`${oppTeam}-${position}`];
                if (frame15?.participantFrames && opponent) {
                    const myFrame  = frame15.participantFrames[participantId];
                    const oppFrame = frame15.participantFrames[opponent.participantId];
                    if (myFrame && oppFrame) {
                        gd15  = (myFrame.totalGold || 0) - (oppFrame.totalGold || 0);
                        xpd15 = (myFrame.xp        || 0) - (oppFrame.xp        || 0);
                    }
                }
            }

            const totalPings =
                (p.allInPings||0) + (p.assistMePings||0) + (p.basicPings||0) +
                (p.commandPings||0) + (p.dangerPings||0) + (p.enemyMissingPings||0) +
                (p.enemyVisionPings||0) + (p.getBackPings||0) + (p.holdPings||0) +
                (p.needVisionPings||0) + (p.onMyWayPings||0) + (p.pushPings||0) +
                (p.visionClearedPings||0);

            // Purchases once per player: "Bought at" and the WPA line (#7, #89)
            const purchases = timeline ? purchasesFromTimeline(timeline, participantId) : null;

            const dmgGoldRatio = p.goldEarned > 0
                ? (p.totalDamageDealtToChampions / p.goldEarned).toFixed(2)
                : '0.00';

            const playerData = {
                participantId,
                championName: p.championName,
                summonerName: p.riotIdGameName || p.summonerName || 'Unknown',
                kills: p.kills, deaths: p.deaths, assists: p.assists,
                cs:    (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
                level: p.champLevel,
                items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
                primaryRune:        p.perks?.styles?.[0]?.selections?.[0]?.perk || null,
                secondaryRuneStyle: p.perks?.styles?.[1]?.style || null,
                summoner1Id: p.summoner1Id, summoner2Id: p.summoner2Id,
                damage:            p.totalDamageDealtToChampions || 0,
                goldDiff15: gd15,  xpDiff15: xpd15, dmgGoldRatio,
                totalPings,        controlWardsBought: p.visionWardsBoughtInGame || 0,
                towerDamage:       p.damageDealtToTurrets || 0,
                isCurrentPlayer:   p.championName === match.championName && p.teamId === match.teamId,
                impact:            impact.get(participantId) || null,
                boughtAt:          purchases ? lastBoughtAt(purchases) : null,
                wpaAt:             purchases ? wpaFor(purchases, p.teamId) : null
            };

            if (p.teamId === 100) teamData.team100.push(playerData);
            else                  teamData.team200.push(playerData);
        });
    } catch (e) {
        console.error('Error parsing match data for expanded row:', e);
    }

    return teamData;
}

function createExpandedRow(match, index, badges = []) {
    const teamData       = buildTeamData(match);
    const playerOnTeam100 = teamData.team100.some(p => p.isCurrentPlayer);
    const yourTeam        = playerOnTeam100 ? teamData.team100 : teamData.team200;
    const enemyTeam       = playerOnTeam100 ? teamData.team200 : teamData.team100;

    const badgesHTML = badges.length > 0 ? `
        <div class="badges-section-top">
            <div class="badges-header">Badges Earned <span class="badges-count">${badges.length}</span></div>
            <div class="badges-grid">
                ${badges.map(b => {
                    const desc = b.description.replace(/"/g, '&apos;');
                    return `<div class="badge-pill" data-badge-tooltip="${desc}"><span class="badge-name">${b.name}</span></div>`;
                }).join('')}
            </div>
        </div>` : '';

    const tableHeader = `
        <thead><tr>
            <th>Player</th>
            <th class="tooltip-header" data-column-tooltip="Rank of all 10 players by average share of their own team's kills + assists, damage, gold, vision, objective and structure damage, healing and damage taken. MVP = best on the winning team, SVP = best on the losing team. Hover a value for the breakdown.">Impact</th>
            <th>Items</th><th>Runes</th><th>SP</th>
            <th>K</th><th>D</th><th>A</th><th>KDA</th><th>CS</th><th>CS/M</th><th>LVL</th><th>DMG</th>
            <th class="tooltip-header" data-column-tooltip="Gold difference vs lane opponent at 15 minutes">GD@15</th>
            <th class="tooltip-header" data-column-tooltip="XP difference vs lane opponent at 15 minutes">XPD@15</th>
            <th class="tooltip-header" data-column-tooltip="Damage dealt per gold earned - measures gold efficiency">DMG/Gold</th>
            <th>Pings</th>
            <th class="tooltip-header" data-column-tooltip="Control wards bought">CWB</th>
            <th class="tooltip-header" data-column-tooltip="Total tower damage">TTD</th>
        </tr></thead>`;

    const yourWin  = !!match.win;
    const enemyWin = !match.win;

    return `
        <tr class="expanded-row" data-match-index="${index}">
            <td colspan="100%">
                <div class="expanded-content-vertical">
                    ${badgesHTML}
                    <div class="match-timeline"></div>
                    <div class="game-report"></div>
                    <div class="teams-vertical">
                        <div class="team-section-full ${yourWin ? 'team-win' : 'team-loss'}">
                            <div class="team-header">${yourWin ? 'Victory' : 'Defeat'} - Your Team</div>
                            <div class="team-table-wrapper">
                                <table class="team-table-expanded">
                                    ${tableHeader}
                                    <tbody>${yourTeam.map(p => renderPlayerRow(p, match.gameDuration, match.patch)).join('')}</tbody>
                                </table>
                            </div>
                        </div>
                        <div class="team-section-full ${enemyWin ? 'team-win' : 'team-loss'}">
                            <div class="team-header">${enemyWin ? 'Victory' : 'Defeat'} - Enemy Team</div>
                            <div class="team-table-wrapper">
                                <table class="team-table-expanded">
                                    ${tableHeader}
                                    <tbody>${enemyTeam.map(p => renderPlayerRow(p, match.gameDuration, match.patch)).join('')}</tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </td>
        </tr>`;
}

// ---------------------------------------------------------------------------
// ROW EXPAND / COLLAPSE
// ---------------------------------------------------------------------------

window.toggleRowExpand = async function (index) {
    const matchesData = window.matchesData || [];
    const match       = matchesData[index];
    if (!match) return;

    const clickedRow = document.querySelector(`tr[data-match-index="${index}"]`);
    if (!clickedRow) return;

    const nextRow           = clickedRow.nextElementSibling;
    const isCurrentlyExpanded = nextRow && nextRow.classList.contains('expanded-row') && nextRow.dataset.matchIndex == index;

    // Collapse all
    document.querySelectorAll('.expanded-row').forEach(row => row.remove());
    if (isCurrentlyExpanded) return; // toggle off

    // window.matchesData rows no longer carry rawJson/timelineJson, so the
    // expanded 10-player table needs the full row pulled from the DB.
    let fullMatch = null;
    try {
        fullMatch = await getMatchById(match.matchId);
    } catch (err) {
        console.warn('Could not load full match for expanded row:', err);
    }

    // Fetch badges (cached after first evaluation)
    let badges = [];
    if (badgeCache.has(match.matchId)) {
        badges = badgeCache.get(match.matchId);
    } else if (fullMatch) {
        try {
            badges = evaluateBadges(fullMatch);
            badgeCache.set(match.matchId, badges);
        } catch (err) {
            console.warn('Badge evaluation failed:', err);
        }
    }

    clickedRow.insertAdjacentHTML('afterend', createExpandedRow(fullMatch || match, index, badges));

    // Game report (#9): this game against your season / patch / week, and blunders
    const reportHost = clickedRow.nextElementSibling && clickedRow.nextElementSibling.querySelector('.game-report');
    if (reportHost && fullMatch) {
        try {
            renderGameReport(reportHost, match, fullMatch);
        } catch (err) {
            console.warn('Game report failed:', err);
            reportHost.remove();
        }
    }

    // Timeline chart (#3) needs the canvas in the DOM before it can draw
    const host = clickedRow.nextElementSibling && clickedRow.nextElementSibling.querySelector('.match-timeline');
    if (host) {
        try {
            renderMatchTimeline(host, fullMatch);
        } catch (err) {
            console.warn('Match timeline failed:', err);
            host.remove();
        }
    }
};

module.exports = {};
