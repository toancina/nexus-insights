const { getMatchIds, getMatchData, getMatchTimeline } = require('./riotApi');
const { db } = require('./database');

// Rate limit delay (ms) - Riot API allows 20 req/s, but we'll be conservative
const REQUEST_DELAY_MS = 150; // ~6-7 requests per second to stay safe

// January 1, 2026 at 00:00 AM UTC (start of the year - catch all matches)
// Epoch timestamp in seconds
const RANKED_SEASON_START = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Promisify database methods
function dbGet(sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbRun(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Load all matches from database, newest first
async function getMatches(limit = null) {
    const sql = `SELECT matchId, queueId, gameCreation, gameDuration, championName, champLevel,
                win, kills, deaths, assists, goldEarned, totalMinionsKilled,
                totalDamageDealtToChampions, visionScore,
                doubleKills, tripleKills, quadraKills, pentaKills,
                turretKills, inhibitorKills, dragonKills, baronKills, objectivesStolen,
                wardsPlaced, wardsKilled, detectorWardsPlaced,
                teamPosition, lane,
                item0, item1, item2, item3, item4, item5, item6,
                teamDragons, enemyDragons, teamBarons, enemyBarons,
                teamRiftHeralds, enemyRiftHeralds, teamTowers, enemyTowers,
                teamInhibitors, enemyInhibitors, teamId, teamKills,
                primaryRune, secondaryRuneStyle, rawJson, timelineJson,
                csDiff15, goldDiff15, xpDiff15, firstBlood, dmgGoldRatio, isolatedDeaths, objectiveRate
         FROM matches
         ORDER BY gameCreation DESC${limit ? ' LIMIT ?' : ''}`;

    const matches = await dbAll(sql, limit ? [limit] : []);
    return matches;
}

// Get full match details by ID (including rawJson for team composition)
async function getMatchById(matchId) {
    const match = await dbGet(
        `SELECT * FROM matches WHERE matchId = ?`,
        [matchId]
    );
    return match;
}

// Get summary stats
async function getStats() {
    const stats = await dbGet(
        `SELECT
            COUNT(*) as totalMatches,
            SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) as wins,
            AVG(kills) as avgKills,
            AVG(deaths) as avgDeaths,
            AVG(assists) as avgAssists,
            AVG(totalDamageDealtToChampions) as avgDamage,
            AVG(visionScore) as avgVision,
            AVG(totalMinionsKilled) as avgCs,
            SUM(pentaKills) as totalPentas,
            SUM(quadraKills) as totalQuadras,
            SUM(dragonKills) as totalDragons,
            SUM(baronKills) as totalBarons,
            SUM(turretKills) as totalTurrets,
            AVG(wardsPlaced) as avgWardsPlaced
         FROM matches`
    );
    return stats;
}

async function syncMatches(puuid, onProgress) {
    console.log('Fetching match IDs for PUUID:', puuid);

    // Get the most recent and oldest match timestamps from database
    const latestMatch = await dbGet("SELECT MAX(gameCreation) as latestTime FROM matches");
    const oldestMatch = await dbGet("SELECT MIN(gameCreation) as oldestTime FROM matches");

    let allMatchIds = [];

    if (latestMatch && latestMatch.latestTime) {
        // FORWARD SYNC: fetch matches AFTER the most recent one
        const forwardStartTime = Math.floor(latestMatch.latestTime / 1000) + 1;
        console.log(`Forward sync: fetching matches after ${new Date(latestMatch.latestTime).toISOString()}`);
        const forwardMatches = await getMatchIds(puuid, forwardStartTime);
        console.log(`Found ${forwardMatches.length} new matches (forward)`);
        allMatchIds.push(...forwardMatches);

        // BACKWARD SYNC: fetch matches BEFORE the oldest one (but after season start)
        if (oldestMatch && oldestMatch.oldestTime) {
            const oldestTimeSeconds = Math.floor(oldestMatch.oldestTime / 1000);

            // Only do backward sync if there's a gap between season start and oldest match
            if (oldestTimeSeconds > RANKED_SEASON_START + 86400) { // More than 1 day gap
                console.log(`Backward sync: fetching matches between season start and ${new Date(oldestMatch.oldestTime).toISOString()}`);

                // Fetch matches from season start, then filter out ones we already have
                const backwardMatches = await getMatchIds(puuid, RANKED_SEASON_START);

                // Filter to only include matches before our oldest (to avoid duplicates)
                const existingIds = new Set((await dbAll("SELECT matchId FROM matches")).map(m => m.matchId));
                const missingMatches = backwardMatches.filter(id => !existingIds.has(id));

                console.log(`Found ${missingMatches.length} missing older matches (backward)`);
                allMatchIds.push(...missingMatches);
            }
        }
    } else {
        // First sync: fetch all matches since season start
        console.log('First sync: fetching ALL matches since Jan 1, 2026...');
        allMatchIds = await getMatchIds(puuid, RANKED_SEASON_START);
    }

    // Fetch special queues that require explicit queue parameter (Riot API doesn't return them by default)
    const SPECIAL_QUEUES = [2400, 1700, 1710];
    const specialMatchIds = [];

    // Always fetch from RANKED_SEASON_START for special queues to catch any missed matches,
    // since backward sync (without queue filter) cannot find these queue types
    for (const queueId of SPECIAL_QUEUES) {
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`Fetching special queue ${queueId} matches (attempt ${attempt + 1})...`);
                const specialMatches = await getMatchIds(puuid, RANKED_SEASON_START, queueId);
                console.log(`Found ${specialMatches.length} matches for queue ${queueId}`);
                specialMatchIds.push(...specialMatches);
                await sleep(150);
                break; // Success, stop retrying
            } catch (err) {
                console.warn(`Attempt ${attempt + 1} failed for queue ${queueId}: ${err.message}`);
                if (attempt < MAX_RETRIES) {
                    // Wait longer before retrying (exponential backoff)
                    await sleep(1000 * (attempt + 1));
                } else {
                    console.error(`All retries failed for special queue ${queueId}. These matches may be missing.`);
                    if (onProgress) onProgress(0, 0, 'warn', `Failed to fetch queue ${queueId} matches - will retry next sync`);
                }
            }
        }
    }

    // Prepend special queue matches so they are processed FIRST (before rate limiting can drop them)
    allMatchIds.unshift(...specialMatchIds);

    // Deduplicate match IDs
    const matchIds = [...new Set(allMatchIds)];
    console.log(`Total unique matches to process: ${matchIds.length}`);

    // If no new matches, return early
    if (matchIds.length === 0) {
        console.log('No new matches to sync');
        if (onProgress) onProgress(0, 0, 'complete');
        return { newMatches: 0, skipped: 0, total: 0 };
    }

    let newMatches = 0;
    let skipped = 0;
    let processed = 0;
    const newMatchIds = [];
    const total = matchIds.length;
    const BATCH_SIZE = 2; // Process 2 matches concurrently to stay under rate limits

    // Report initial progress
    if (onProgress) onProgress(0, total);

    // Process in batches for much faster performance
    for (let i = 0; i < matchIds.length; i += BATCH_SIZE) {
        const batch = matchIds.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
            batch.map(async (id) => {
                try {
                    // Check if we already have it (shouldn't happen with incremental sync, but safety check)
                    const row = await dbGet("SELECT matchId, gameDuration, totalMinionsKilled, teamDragons, teamBarons, teamRiftHeralds, primaryRune, teamKills, timelineJson FROM matches WHERE matchId = ?", [id]);

                    // If match doesn't exist OR is missing critical data, fetch/update it
                    const needsFetch = !row || row.gameDuration === null || row.totalMinionsKilled === null || row.teamDragons === null || row.teamBarons === null || row.teamRiftHeralds === null || row.primaryRune === null || row.teamKills === null || row.timelineJson === null;

                    if (needsFetch) {
                        if (!row) {
                            console.log(`Fetching new match: ${id}`);
                        } else {
                            console.log(`Updating incomplete match: ${id}`);
                        }

                        const data = await getMatchData(id);
                        // Fetch timeline data for badge evaluation
                        let timelineData = null;
                        try {
                            await sleep(REQUEST_DELAY_MS); // Respect rate limits between calls
                            timelineData = await getMatchTimeline(id);
                        } catch (tlErr) {
                            console.warn(`Could not fetch timeline for ${id}: ${tlErr.message}`);
                        }
                        const info = data.info;

                        // Find yourself in the participants list
                        const me = info.participants.find(p => p.puuid === puuid);

                        if (me) {
                            // Extract team objectives
                            const myTeam = info.teams.find(t => t.teamId === me.teamId);
                            const enemyTeam = info.teams.find(t => t.teamId !== me.teamId);

                            // Calculate team kills if not directly available (though usually in objectives, we can also sum participants)
                            // But usually we can just count kills from all participants in that team
                            const teamKills = info.participants
                                .filter(p => p.teamId === me.teamId)
                                .reduce((sum, p) => sum + p.kills, 0);

                            const myObjectives = myTeam?.objectives || {};
                            const enemyObjectives = enemyTeam?.objectives || {};

                            const teamDragons = myObjectives.dragon?.kills || 0;
                            const enemyDragons = enemyObjectives.dragon?.kills || 0;
                            const teamBarons = myObjectives.baron?.kills || 0;
                            const enemyBarons = enemyObjectives.baron?.kills || 0;
                            const teamRiftHeralds = myObjectives.riftHerald?.kills || 0;
                            const enemyRiftHeralds = enemyObjectives.riftHerald?.kills || 0;
                            const teamTowers = myObjectives.tower?.kills || 0;
                            const enemyTowers = enemyObjectives.tower?.kills || 0;
                            const teamInhibitors = myObjectives.inhibitor?.kills || 0;
                            const enemyInhibitors = enemyObjectives.inhibitor?.kills || 0;

                            // Extract rune data
                            const primaryRune = me.perks?.styles?.[0]?.selections?.[0]?.perk || null;
                            const secondaryRuneStyle = me.perks?.styles?.[1]?.style || null;

                            // Compute advanced stats
                            const advStats = computeAdvancedStatsForMatch(data, timelineData, me.championName, me.teamId);

                            if (!row) {
                                // Insert new match
                                await dbRun(
                                    `INSERT INTO matches (
                                        matchId, queueId, gameCreation, gameDuration, championName, champLevel,
                                        win, kills, deaths, assists, goldEarned, totalMinionsKilled,
                                        totalDamageDealtToChampions, visionScore,
                                        doubleKills, tripleKills, quadraKills, pentaKills,
                                        turretKills, inhibitorKills, dragonKills, baronKills, objectivesStolen,
                                        wardsPlaced, wardsKilled, detectorWardsPlaced,
                                        teamPosition, lane,
                                        item0, item1, item2, item3, item4, item5, item6,
                                        teamDragons, enemyDragons, teamBarons, enemyBarons,
                                        teamRiftHeralds, enemyRiftHeralds, teamTowers, enemyTowers,
                                        teamInhibitors, enemyInhibitors, teamId, teamKills,
                                        primaryRune, secondaryRuneStyle,
                                        rawJson, timelineJson,
                                        csDiff15, goldDiff15, xpDiff15, firstBlood, dmgGoldRatio, isolatedDeaths, objectiveRate
                                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                    [
                                        id, info.queueId, info.gameCreation, info.gameDuration, me.championName, me.champLevel,
                                        me.win ? 1 : 0, me.kills, me.deaths, me.assists, me.goldEarned, (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0),
                                        me.totalDamageDealtToChampions, me.visionScore,
                                        me.doubleKills, me.tripleKills, me.quadraKills, me.pentaKills,
                                        me.turretKills, me.inhibitorKills, me.dragonKills, me.baronKills, me.objectivesStolen,
                                        me.wardsPlaced, me.wardsKilled, me.detectorWardsPlaced,
                                        me.teamPosition, me.lane,
                                        me.item0, me.item1, me.item2, me.item3, me.item4, me.item5, me.item6,
                                        teamDragons, enemyDragons, teamBarons, enemyBarons,
                                        teamRiftHeralds, enemyRiftHeralds, teamTowers, enemyTowers,
                                        teamInhibitors, enemyInhibitors, me.teamId, teamKills,
                                        primaryRune, secondaryRuneStyle,
                                        JSON.stringify(data), timelineData ? JSON.stringify(timelineData) : null,
                                        advStats.csDiff15, advStats.goldDiff15, advStats.xpDiff15, advStats.firstBlood, advStats.dmgGoldRatio, advStats.isolatedDeaths, advStats.objectiveRate
                                    ]
                                );
                                newMatches++;
                                newMatchIds.push(id);
                                console.log(`Saved match ${id}: ${me.championName} (${me.teamPosition || me.lane}) - ${me.kills}/${me.deaths}/${me.assists}`);
                            } else {
                                // Update existing match with complete data
                                await dbRun(
                                    `UPDATE matches SET
                                        gameDuration = ?, champLevel = ?, totalMinionsKilled = ?,
                                        totalDamageDealtToChampions = ?, visionScore = ?,
                                        doubleKills = ?, tripleKills = ?, quadraKills = ?, pentaKills = ?,
                                        turretKills = ?, inhibitorKills = ?, dragonKills = ?, baronKills = ?, objectivesStolen = ?,
                                        wardsPlaced = ?, wardsKilled = ?, detectorWardsPlaced = ?,
                                        teamPosition = ?, lane = ?,
                                        item0 = ?, item1 = ?, item2 = ?, item3 = ?, item4 = ?, item5 = ?, item6 = ?,
                                        teamDragons = ?, enemyDragons = ?, teamBarons = ?, enemyBarons = ?,
                                        teamRiftHeralds = ?, enemyRiftHeralds = ?, teamTowers = ?, enemyTowers = ?,
                                        teamInhibitors = ?, enemyInhibitors = ?, teamId = ?, teamKills = ?,
                                        primaryRune = ?, secondaryRuneStyle = ?, rawJson = ?,
                                        timelineJson = ?,
                                        csDiff15 = ?, goldDiff15 = ?, xpDiff15 = ?, firstBlood = ?, dmgGoldRatio = ?, isolatedDeaths = ?, objectiveRate = ?
                                    WHERE matchId = ?`,
                                    [
                                        info.gameDuration, me.champLevel, (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0),
                                        me.totalDamageDealtToChampions, me.visionScore,
                                        me.doubleKills, me.tripleKills, me.quadraKills, me.pentaKills,
                                        me.turretKills, me.inhibitorKills, me.dragonKills, me.baronKills, me.objectivesStolen,
                                        me.wardsPlaced, me.wardsKilled, me.detectorWardsPlaced,
                                        me.teamPosition, me.lane,
                                        me.item0, me.item1, me.item2, me.item3, me.item4, me.item5, me.item6,
                                        teamDragons, enemyDragons, teamBarons, enemyBarons,
                                        teamRiftHeralds, enemyRiftHeralds, teamTowers, enemyTowers,
                                        teamInhibitors, enemyInhibitors, me.teamId, teamKills,
                                        primaryRune, secondaryRuneStyle, JSON.stringify(data),
                                        timelineData ? JSON.stringify(timelineData) : null,
                                        advStats.csDiff15, advStats.goldDiff15, advStats.xpDiff15, advStats.firstBlood, advStats.dmgGoldRatio, advStats.isolatedDeaths, advStats.objectiveRate,
                                        id
                                    ]
                                );
                                console.log(`Updated match ${id} with complete data (including gameDuration)`);
                            }
                            return { type: row ? 'updated' : 'new', id };
                        }
                    } else {
                        console.log(`Match ${id} already exists with complete data. Skipping.`);
                        skipped++;
                        return { type: 'skipped', id };
                    }
                } catch (error) {
                    console.error(`Error processing match ${id}:`, error.message);
                    return { type: 'error', id, error };
                }
            })
        );

        // Update progress after batch completes
        processed += batch.length;
        if (onProgress) onProgress(processed, total);

        // Small delay between batches to avoid hitting rate limits
        // BATCH_SIZE requests with minimal gap between batches keeps us under 20 req/s
        if (i + BATCH_SIZE < matchIds.length) {
            await sleep(100);
        }
    }

    console.log(`Sync complete: ${newMatches} new, ${skipped} skipped`);
    return { newMatches, skipped, total: matchIds.length, newMatchIds };
}

// Compute advanced stats given the participant index and parsed data
function computeAdvancedStatsForMatch(matchData, timelineData, myChampionName, myTeamId) {
    const result = {
        csDiff15: null,
        goldDiff15: null,
        xpDiff15: null,
        firstBlood: 0,
        dmgGoldRatio: null,
        isolatedDeaths: null,
        objectiveRate: null
    };

    try {
        const info = typeof matchData === 'string' ? JSON.parse(matchData) : matchData;
        const participants = info.info ? info.info.participants : info.participants;
        if (!participants) return result;

        // Find "me"
        const me = participants.find(p => p.championName === myChampionName && p.teamId === myTeamId);
        if (!me) return result;

        const myPId = me.participantId || (participants.indexOf(me) + 1);

        // === First Blood ===
        result.firstBlood = (me.firstBloodKill || me.firstBloodAssist) ? 1 : 0;

        // === Dmg/Gold Ratio ===
        if (me.goldEarned > 0) {
            result.dmgGoldRatio = parseFloat(((me.totalDamageDealtToChampions || 0) / me.goldEarned).toFixed(3));
        }

        // Parse timeline if available
        const timeline = timelineData
            ? (typeof timelineData === 'string' ? JSON.parse(timelineData) : timelineData)
            : null;

        if (!timeline || !timeline.info || !timeline.info.frames) return result;

        const frames = timeline.info.frames;

        // === CSD@15, GD@15, XPD@15 ===
        // Frame index 15 = 15 minutes (each frame is 1 minute)
        const frame15 = frames[15] || frames[frames.length - 1];
        if (frame15 && frame15.participantFrames) {
            const myFrame = frame15.participantFrames[myPId];
            if (myFrame) {
                // Find lane opponent: same position on enemy team
                const myPosition = me.teamPosition || me.lane || '';
                const opponent = participants.find(p =>
                    p.teamId !== me.teamId &&
                    ((p.teamPosition || p.lane || '') === myPosition) &&
                    myPosition !== ''
                );

                if (opponent) {
                    const oppPId = opponent.participantId || (participants.indexOf(opponent) + 1);
                    const oppFrame = frame15.participantFrames[oppPId];
                    if (oppFrame) {
                        const myCs = (myFrame.minionsKilled || 0) + (myFrame.jungleMinionsKilled || 0);
                        const oppCs = (oppFrame.minionsKilled || 0) + (oppFrame.jungleMinionsKilled || 0);
                        result.csDiff15 = myCs - oppCs;
                        result.goldDiff15 = (myFrame.totalGold || 0) - (oppFrame.totalGold || 0);
                        result.xpDiff15 = (myFrame.xp || 0) - (oppFrame.xp || 0);
                    }
                }
            }
        }

        // === Isolated Deaths ===
        // Deaths where no teammate is within 1500 units and no objective taken within 15s
        let isolatedCount = 0;
        const allEvents = frames.flatMap(f => f.events || []);
        const killEvents = allEvents.filter(e => e.type === 'CHAMPION_KILL');
        const objectiveEvents = allEvents.filter(e =>
            e.type === 'ELITE_MONSTER_KILL' || e.type === 'BUILDING_KILL'
        );

        const myDeaths = killEvents.filter(e => e.victimId === myPId);
        const myTeamPIds = participants
            .filter(p => p.teamId === me.teamId && (p.participantId || participants.indexOf(p) + 1) !== myPId)
            .map(p => p.participantId || (participants.indexOf(p) + 1));

        for (const death of myDeaths) {
            const deathPos = death.position;
            if (!deathPos) { isolatedCount++; continue; }

            // Find nearest frame to death timestamp
            const frameIdx = Math.min(Math.floor(death.timestamp / 60000), frames.length - 1);
            const nearFrame = frames[frameIdx];
            if (!nearFrame || !nearFrame.participantFrames) { isolatedCount++; continue; }

            // Check if any teammate is within 1500 units
            let hasNearbyTeammate = false;
            for (const tmPId of myTeamPIds) {
                const tmFrame = nearFrame.participantFrames[tmPId];
                if (tmFrame && tmFrame.position) {
                    const dx = deathPos.x - tmFrame.position.x;
                    const dy = deathPos.y - tmFrame.position.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist <= 1500) {
                        hasNearbyTeammate = true;
                        break;
                    }
                }
            }

            // Check if an objective was taken within 15 seconds of the death
            let objectiveNearby = false;
            for (const obj of objectiveEvents) {
                if (Math.abs(obj.timestamp - death.timestamp) <= 15000) {
                    objectiveNearby = true;
                    break;
                }
            }

            if (!hasNearbyTeammate && !objectiveNearby) {
                isolatedCount++;
            }
        }
        result.isolatedDeaths = isolatedCount;

        // === Objective Rate ===
        // % of objectives (drakes, barons, grubs) your team secured while you were alive
        const teamObjEvents = allEvents.filter(e =>
            e.type === 'ELITE_MONSTER_KILL' &&
            myTeamPIds.concat([myPId]).includes(e.killerId)
        );

        if (teamObjEvents.length > 0) {
            // Check if player was alive at each objective kill
            const myDeathTimestamps = myDeaths.map(d => d.timestamp);
            // Build alive periods: start=0, die, respawn (~20-50s based on level, use next frame alive)
            let aliveCount = 0;
            for (const obj of teamObjEvents) {
                // Simple check: was the player's most recent death before this event,
                // and enough time has passed to respawn?
                const recentDeath = myDeathTimestamps.filter(t => t < obj.timestamp).pop();
                if (!recentDeath) {
                    // Never died before this objective
                    aliveCount++;
                } else {
                    // Check if respawned: at least 15-60s based on game time
                    // Use frame data to check if player has moved since death
                    const frameIdx = Math.min(Math.floor(obj.timestamp / 60000), frames.length - 1);
                    const frame = frames[frameIdx];
                    if (frame && frame.participantFrames && frame.participantFrames[myPId]) {
                        const pos = frame.participantFrames[myPId].position;
                        // If player position is not in fountain (roughly), they're alive
                        if (pos) {
                            const inFountain = (me.teamId === 100)
                                ? (pos.x < 1500 && pos.y < 1500)
                                : (pos.x > 13500 && pos.y > 13500);
                            // If death was very recent (within 30s) and in fountain, probably dead
                            if (obj.timestamp - recentDeath < 30000 && inFountain) {
                                continue; // was dead
                            }
                            aliveCount++;
                        }
                    }
                }
            }
            result.objectiveRate = parseFloat(((aliveCount / teamObjEvents.length) * 100).toFixed(1));
        }

    } catch (e) {
        console.warn('Error computing advanced stats:', e.message);
    }

    return result;
}

// Get league/rank data for a PUUID (using new PUUID-based endpoint)
async function getLeagueData(puuid) {
    try {
        console.log('Getting league data for PUUID:', puuid);
        const leagueData = await require('./riotApi').getLeagueByPuuid(puuid);
        return leagueData;
    } catch (error) {
        console.error('Error fetching league data:', error);
        return { solo: null, flex: null };
    }
}

// Backfill timeline data for existing matches that don't have it
async function backfillTimelines(onProgress) {
    const rows = await dbAll("SELECT matchId FROM matches WHERE timelineJson IS NULL ORDER BY gameCreation DESC");
    if (rows.length === 0) {
        console.log('All matches already have timeline data.');
        return { updated: 0, failed: 0, total: 0 };
    }

    console.log(`Backfilling timeline data for ${rows.length} matches...`);
    let updated = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i++) {
        const matchId = rows[i].matchId;
        try {
            const timelineData = await getMatchTimeline(matchId);
            await dbRun("UPDATE matches SET timelineJson = ? WHERE matchId = ?", [JSON.stringify(timelineData), matchId]);
            updated++;
            console.log(`[${i + 1}/${rows.length}] Timeline saved for ${matchId}`);
        } catch (err) {
            failed++;
            console.warn(`[${i + 1}/${rows.length}] Failed timeline for ${matchId}: ${err.message}`);
        }

        if (onProgress) onProgress(i + 1, rows.length);

        // Respect rate limits - single request at a time with delay
        if (i < rows.length - 1) {
            await sleep(REQUEST_DELAY_MS);
        }
    }

    console.log(`Backfill complete: ${updated} updated, ${failed} failed out of ${rows.length}`);
    return { updated, failed, total: rows.length };
}

// Backfill advanced stats for existing matches that have rawJson but no advanced stats
async function backfillAdvancedStats(onProgress) {
    const rows = await dbAll(
        "SELECT matchId, rawJson, timelineJson, championName, teamId FROM matches WHERE rawJson IS NOT NULL AND csDiff15 IS NULL ORDER BY gameCreation DESC"
    );
    if (rows.length === 0) {
        console.log('All matches already have advanced stats.');
        return { updated: 0, total: 0 };
    }

    console.log(`Computing advanced stats for ${rows.length} matches...`);
    let updated = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
            const stats = computeAdvancedStatsForMatch(row.rawJson, row.timelineJson, row.championName, row.teamId);
            await dbRun(
                `UPDATE matches SET csDiff15 = ?, goldDiff15 = ?, xpDiff15 = ?, firstBlood = ?, dmgGoldRatio = ?, isolatedDeaths = ?, objectiveRate = ? WHERE matchId = ?`,
                [stats.csDiff15, stats.goldDiff15, stats.xpDiff15, stats.firstBlood, stats.dmgGoldRatio, stats.isolatedDeaths, stats.objectiveRate, row.matchId]
            );
            updated++;
        } catch (err) {
            console.warn(`Failed advanced stats for ${row.matchId}: ${err.message}`);
        }

        if (onProgress) onProgress(i + 1, rows.length);
    }

    console.log(`Advanced stats backfill complete: ${updated}/${rows.length}`);
    return { updated, total: rows.length };
}

// === Player Rank Caching ===
const RANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function getPlayerRank(puuid, maxAgeMs = RANK_CACHE_TTL_MS) {
    // Check cache first
    const cached = await dbGet(
        "SELECT * FROM player_ranks WHERE puuid = ? AND fetchedAt > ?",
        [puuid, Date.now() - maxAgeMs]
    );
    if (cached) return cached;

    // Fetch from API
    try {
        const leagueData = await require('./riotApi').getLeagueByPuuid(puuid);
        const now = Date.now();

        const row = {
            puuid,
            soloTier: leagueData.solo?.tier || null,
            soloRank: leagueData.solo?.rank || null,
            soloLP: leagueData.solo?.leaguePoints ?? null,
            flexTier: leagueData.flex?.tier || null,
            flexRank: leagueData.flex?.rank || null,
            flexLP: leagueData.flex?.leaguePoints ?? null,
            fetchedAt: now
        };

        await dbRun(
            `INSERT INTO player_ranks (puuid, soloTier, soloRank, soloLP, flexTier, flexRank, flexLP, fetchedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(puuid) DO UPDATE SET
                soloTier=excluded.soloTier, soloRank=excluded.soloRank, soloLP=excluded.soloLP,
                flexTier=excluded.flexTier, flexRank=excluded.flexRank, flexLP=excluded.flexLP,
                fetchedAt=excluded.fetchedAt`,
            [row.puuid, row.soloTier, row.soloRank, row.soloLP, row.flexTier, row.flexRank, row.flexLP, row.fetchedAt]
        );

        return row;
    } catch (error) {
        console.warn(`Failed to fetch rank for ${puuid}: ${error.message}`);
        // Return stale cache if available
        const stale = await dbGet("SELECT * FROM player_ranks WHERE puuid = ?", [puuid]);
        return stale || null;
    }
}

// Get cached rank data for all participants in a match (no API calls)
async function getMatchParticipantRanks(matchId) {
    const match = await dbGet("SELECT rawJson FROM matches WHERE matchId = ?", [matchId]);
    if (!match || !match.rawJson) return {};

    const data = JSON.parse(match.rawJson);
    const participants = data.info.participants;
    const rankMap = {};

    for (const p of participants) {
        if (p.puuid) {
            const rank = await dbGet("SELECT * FROM player_ranks WHERE puuid = ?", [p.puuid]);
            rankMap[p.puuid] = rank || null;
        }
    }

    return rankMap;
}

// Fetch ranks for participants of newly synced matches only
async function fetchRanksForNewMatches(matchIds, onProgress) {
    if (!matchIds || matchIds.length === 0) return { fetched: 0, failed: 0, total: 0 };

    // Collect unique PUUIDs from the new matches
    const allPuuids = new Set();
    for (const matchId of matchIds) {
        const match = await dbGet("SELECT rawJson FROM matches WHERE matchId = ?", [matchId]);
        if (match && match.rawJson) {
            try {
                const data = JSON.parse(match.rawJson);
                for (const p of data.info.participants) {
                    if (p.puuid && p.puuid.length >= 40) allPuuids.add(p.puuid);
                }
            } catch (e) { /* skip malformed */ }
        }
    }

    // Filter out those already cached within TTL
    const puuidsToFetch = [];
    const cutoff = Date.now() - RANK_CACHE_TTL_MS;
    for (const puuid of allPuuids) {
        const cached = await dbGet(
            "SELECT fetchedAt FROM player_ranks WHERE puuid = ? AND fetchedAt > ?",
            [puuid, cutoff]
        );
        if (!cached) puuidsToFetch.push(puuid);
    }

    if (puuidsToFetch.length === 0) {
        console.log('All player ranks for new matches are already cached.');
        return { fetched: 0, failed: 0, total: 0 };
    }

    console.log(`Fetching ranks for ${puuidsToFetch.length} players from ${matchIds.length} new matches...`);
    let fetched = 0;
    let failed = 0;

    for (let i = 0; i < puuidsToFetch.length; i++) {
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                await getPlayerRank(puuidsToFetch[i], 0);
                fetched++;
                break;
            } catch (err) {
                if (attempt < MAX_RETRIES) {
                    await sleep(1000 * (attempt + 1));
                } else {
                    failed++;
                    console.warn(`Failed rank for player ${i + 1}/${puuidsToFetch.length}: ${err.message}`);
                }
            }
        }

        if (onProgress) onProgress(i + 1, puuidsToFetch.length);

        if (i < puuidsToFetch.length - 1) {
            await sleep(REQUEST_DELAY_MS);
        }
    }

    console.log(`Rank fetch complete: ${fetched} fetched, ${failed} failed`);
    return { fetched, failed, total: puuidsToFetch.length };
}

module.exports = { syncMatches, getMatches, getStats, getMatchById, getLeagueData, backfillTimelines, backfillAdvancedStats, getMatchParticipantRanks, fetchRanksForNewMatches };
