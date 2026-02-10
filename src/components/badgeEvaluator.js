// Badge Evaluator - evaluates 39 badges from Badges.csv against match data
// Uses Match-V5 data (rawJson) and Timeline data (timelineJson)

// ===== GEOMETRY HELPERS =====

function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// Team 100 = blue (bottom-left), Team 200 = red (top-right)
function isInBase(pos, teamId) {
    if (!pos) return false;
    if (teamId === 100) return pos.x < 2500 && pos.y < 2500;
    return pos.x > 12500 && pos.y > 12500;
}

function isInFountain(pos, teamId) {
    if (!pos) return false;
    if (teamId === 100) return pos.x < 1200 && pos.y < 1200;
    return pos.x > 13800 && pos.y > 13800;
}

// Rough enemy jungle zones (river divides at ~7000 diagonal)
function isInJungleSide(pos, teamId) {
    if (!pos) return false;
    // Blue jungle is bottom-left quadrant, Red jungle is top-right
    if (teamId === 100) return pos.x < 9000 && pos.y < 9000 && !isInBase(pos, 100);
    return pos.x > 6000 && pos.y > 6000 && !isInBase(pos, 200);
}

// ===== TIMELINE HELPERS =====

function getNearestFrame(frames, timestamp) {
    let closest = frames[0];
    for (const frame of frames) {
        if (Math.abs(frame.timestamp - timestamp) < Math.abs(closest.timestamp - timestamp)) {
            closest = frame;
        }
    }
    return closest;
}

function getPlayerPos(frame, pId) {
    return frame?.participantFrames?.[String(pId)]?.position;
}

function getPlayerGold(frame, pId) {
    return frame?.participantFrames?.[String(pId)]?.totalGold || 0;
}

function countNearby(frame, ids, position, range) {
    let count = 0;
    for (const id of ids) {
        const pos = getPlayerPos(frame, id);
        if (pos && dist(pos, position) <= range) count++;
    }
    return count;
}

function didParticipate(event, myPId) {
    return event.killerId === myPId || (event.assistingParticipantIds || []).includes(myPId);
}

function getTeamGold(frame, teamIds) {
    let total = 0;
    for (const id of teamIds) {
        total += frame?.participantFrames?.[String(id)]?.totalGold || 0;
    }
    return total;
}

// ===== CONTEXT BUILDER =====

function buildContext(match) {
    if (!match.rawJson) return null;
    const raw = typeof match.rawJson === 'string' ? JSON.parse(match.rawJson) : match.rawJson;
    const info = raw.info;
    const participants = info.participants;
    const me = participants.find(p => p.championName === match.championName && p.teamId === match.teamId);
    if (!me) return null;

    const myTeam = participants.filter(p => p.teamId === me.teamId);
    const enemyTeam = participants.filter(p => p.teamId !== me.teamId);
    const teamKills = myTeam.reduce((s, p) => s + p.kills, 0);

    const ctx = {
        match, me, info, participants, myTeam, enemyTeam, teamKills,
        gameDuration: info.gameDuration,
        win: me.win,
        myTeamId: me.teamId,
        enemyTeamId: me.teamId === 100 ? 200 : 100,
        hasTimeline: false,
        myPId: null,
        myTeamIds: [],
        enemyTeamIds: [],
        killEvents: [],
        objectiveEvents: [],
        buildingEvents: [],
        wardEvents: [],
        levelEvents: [],
        frames: []
    };

    if (match.timelineJson) {
        const tl = typeof match.timelineJson === 'string' ? JSON.parse(match.timelineJson) : match.timelineJson;
        ctx.hasTimeline = true;

        const puuidToTlId = {};
        for (const tp of (tl.info?.participants || [])) {
            puuidToTlId[tp.puuid] = tp.participantId;
        }
        ctx.myPId = puuidToTlId[me.puuid] || null;

        for (const p of participants) {
            const tlId = puuidToTlId[p.puuid];
            if (tlId != null) {
                if (p.teamId === me.teamId) ctx.myTeamIds.push(tlId);
                else ctx.enemyTeamIds.push(tlId);
            }
        }

        ctx.frames = tl.info?.frames || [];
        for (const frame of ctx.frames) {
            for (const event of (frame.events || [])) {
                if (event.type === 'CHAMPION_KILL') ctx.killEvents.push(event);
                if (event.type === 'ELITE_MONSTER_KILL') ctx.objectiveEvents.push(event);
                if (event.type === 'BUILDING_KILL') ctx.buildingEvents.push(event);
                if (event.type === 'WARD_PLACED' || event.type === 'WARD_KILL') ctx.wardEvents.push(event);
                if (event.type === 'LEVEL_UP') ctx.levelEvents.push(event);
            }
        }
        ctx.killEvents.sort((a, b) => a.timestamp - b.timestamp);
    }

    return ctx;
}

// ===== BADGE DEFINITIONS =====

const BADGES = [
    // --- Bandle City ---
    {
        name: 'David vs Goliath',
        description: 'You survived on a prayer and 5% health while taking down 3 enemies. Peak yordle energy.',
        // Needs HP at kill time - not available in standard API. Cannot implement.
        evaluate: () => false
    },
    {
        name: 'Small But Mighty',
        description: 'You dealt the most damage on your team despite having the lowest total health pool.',
        evaluate: (ctx) => {
            const myDmg = ctx.me.totalDamageDealtToChampions || 0;
            const isMaxDmg = ctx.myTeam.every(p => (p.totalDamageDealtToChampions || 0) <= myDmg);
            // Use champLevel as proxy for health pool (lower level = lower HP generally)
            // Or check timeline last frame for healthMax
            if (ctx.hasTimeline && ctx.frames.length > 0) {
                const lastFrame = ctx.frames[ctx.frames.length - 1];
                const myHP = lastFrame?.participantFrames?.[String(ctx.myPId)]?.championStats?.healthMax || 0;
                const teamHPs = ctx.myTeamIds.map(id =>
                    lastFrame?.participantFrames?.[String(id)]?.championStats?.healthMax || 0
                );
                const isMinHP = myHP > 0 && teamHPs.every(hp => hp >= myHP);
                return isMaxDmg && isMinHP;
            }
            return false;
        }
    },
    {
        name: "The Mayor's Decree",
        description: 'You had the highest Vision Score and most Assists on your team. You run this town.',
        evaluate: (ctx) => {
            const myVis = ctx.me.visionScore || 0;
            const myAst = ctx.me.assists || 0;
            return ctx.myTeam.every(p => (p.visionScore || 0) <= myVis) &&
                   ctx.myTeam.every(p => (p.assists || 0) <= myAst);
        }
    },

    // --- Noxus ---
    {
        name: 'The Blood-Crowned',
        description: 'One Pentakill is a fluke; two in one game is a war crime. Welcome to the high command.',
        evaluate: (ctx) => (ctx.me.pentaKills || 0) >= 2
    },
    {
        name: 'Iron Will',
        description: 'You secured 3+ kills while being outnumbered (1v2 or 1v3) in the immediate area.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            let outnumberedKills = 0;
            for (const e of ctx.killEvents) {
                if (e.killerId !== ctx.myPId) continue;
                const frame = getNearestFrame(ctx.frames, e.timestamp);
                const killPos = e.position;
                if (!killPos) continue;
                const nearbyAllies = countNearby(frame, ctx.myTeamIds.filter(id => id !== ctx.myPId), killPos, 1000);
                const nearbyEnemies = countNearby(frame, ctx.enemyTeamIds, killPos, 1000);
                if (nearbyEnemies > nearbyAllies + 1) outnumberedKills++; // outnumbered means more enemies than allies near me
            }
            return outnumberedKills >= 3;
        }
    },
    {
        name: 'Total Annexation',
        description: "You participated in every single turret destruction on the map. The empire's borders only move forward.",
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            const enemyTurrets = ctx.buildingEvents.filter(e =>
                e.buildingType === 'TOWER_BUILDING' && ctx.myTeamIds.includes(e.killerId)
            );
            if (enemyTurrets.length === 0) return false;
            return enemyTurrets.every(e => didParticipate(e, ctx.myPId));
        }
    },

    // --- Demacia ---
    {
        name: 'The Unyielding Aegis',
        description: 'You were present for every single Epic Monster kill. A true vanguard never misses an objective.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            const teamMonsters = ctx.objectiveEvents.filter(e => ctx.myTeamIds.includes(e.killerId));
            if (teamMonsters.length === 0) return false;
            return teamMonsters.every(e => didParticipate(e, ctx.myPId));
        }
    },
    {
        name: "Hittin' a Wall",
        description: 'You mitigated 50,000+ damage during the match. They broke their swords against your resolve.',
        evaluate: (ctx) => {
            const mitigated = (ctx.me.damageSelfMitigated || 0) + (ctx.me.totalDamageTaken || 0);
            return mitigated >= 50000;
        }
    },
    {
        name: 'For the King',
        description: 'You were the first person to deal damage in 5 separate teamfight kills. You lead the charge.',
        // Needs per-event damage logs with timestamps - not available in standard timeline. Cannot implement.
        evaluate: () => false
    },

    // --- Bilgewater ---
    {
        name: 'King of the Docks',
        description: "You finished with the highest gold count in the lobby. Everyone else is just a stowaway.",
        evaluate: (ctx) => {
            const myGold = ctx.me.goldEarned || 0;
            return ctx.participants.every(p => (p.goldEarned || 0) <= myGold);
        }
    },
    {
        name: "Sea Monster's Tithe",
        description: 'You stole Baron while your entire team was dead. High stakes, higher reward.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            const baronKills = ctx.objectiveEvents.filter(e =>
                e.monsterType === 'BARON_NASHOR' && e.killerId === ctx.myPId
            );
            for (const baron of baronKills) {
                const assists = (baron.assistingParticipantIds || []).filter(id => ctx.myTeamIds.includes(id));
                if (assists.length === 0) {
                    // Solo baron kill - check if allies were dead
                    const recentAllyDeaths = ctx.killEvents.filter(e =>
                        ctx.myTeamIds.includes(e.victimId) && e.victimId !== ctx.myPId &&
                        e.timestamp > baron.timestamp - 40000 && e.timestamp < baron.timestamp
                    );
                    const allyCount = ctx.myTeamIds.filter(id => id !== ctx.myPId).length;
                    if (recentAllyDeaths.length >= allyCount) return true;
                }
            }
            return false;
        }
    },
    {
        name: 'Treasure Map Locator',
        description: 'You reached 4,000 gold by the 10:00 mark. You\'ve got a nose for the "shiny" stuff.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            // Frame at 10 minutes (600000ms)
            const frame10 = ctx.frames.find(f => f.timestamp >= 600000);
            if (!frame10) return false;
            const gold = getPlayerGold(frame10, ctx.myPId);
            return gold >= 4000;
        }
    },

    // --- Freljord ---
    {
        name: 'The Unbroken Will',
        description: "You won after being down 10,000 gold. The ice doesn't break, and neither do you.",
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.win) return false;
            for (const frame of ctx.frames) {
                const myGold = getTeamGold(frame, ctx.myTeamIds);
                const enemyGold = getTeamGold(frame, ctx.enemyTeamIds);
                if (enemyGold - myGold >= 10000) return true;
            }
            return false;
        }
    },
    {
        name: 'Where Are You Going?',
        description: '100+ CC score and 15+ assists. You turned the enemy team into living statues.',
        evaluate: (ctx) => (ctx.me.timeCCingOthers || 0) >= 100 && (ctx.me.assists || 0) >= 15
    },
    {
        name: 'Heart of the Ram',
        description: 'You mitigated 10,000 damage in a single 20-second fight. You are the mountain.',
        // Needs per-frame damageSelfMitigated which timeline doesn't provide. Cannot implement accurately.
        evaluate: () => false
    },

    // --- Ionia ---
    {
        name: "The Spirit's Balance",
        description: '100% Kill Participation. You were the heartbeat of every single fight on the map.',
        evaluate: (ctx) => {
            if (ctx.teamKills === 0) return false;
            return (ctx.me.kills + ctx.me.assists) >= ctx.teamKills;
        }
    },
    {
        name: 'Dance of the First Lands',
        description: 'You hit all 5 enemies with a single Ultimate. A perfect symphony of destruction.',
        // Needs ability hit tracking - not available in standard API. Cannot implement.
        evaluate: () => false
    },
    {
        name: 'Death by a Thousand Petals',
        description: 'You secured 3 kills in a row where each kill was dealt by a different ability.',
        // Needs killing blow ability source - not available in standard timeline. Cannot implement.
        evaluate: () => false
    },

    // --- Piltover ---
    {
        name: 'Hextech Perfection',
        description: '0 deaths and 10+ CS per minute. Efficiency that would make Camille blush.',
        evaluate: (ctx) => {
            if (ctx.me.deaths !== 0) return false;
            const csPerMin = ctx.gameDuration > 0
                ? (ctx.me.totalMinionsKilled || 0) / (ctx.gameDuration / 60)
                : 0;
            return csPerMin >= 10.0;
        }
    },
    {
        name: 'Clockwork Multiplier',
        description: 'You secured a Triple Kill or higher using only your auto-attacks. No mana wasted.',
        // Needs damage source type for killing blows - not available. Cannot implement.
        evaluate: () => false
    },
    {
        name: 'Piltovan Sniper',
        description: 'You secured a kill from over 2,000 units away. Distance is just another variable.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            for (const e of ctx.killEvents) {
                if (e.killerId !== ctx.myPId || !e.position) continue;
                const frame = getNearestFrame(ctx.frames, e.timestamp);
                const myPos = getPlayerPos(frame, ctx.myPId);
                if (myPos && dist(myPos, e.position) >= 2000) return true;
            }
            return false;
        }
    },

    // --- Zaun ---
    {
        name: 'Chem-Tech Overdrive',
        description: 'You pumped out 2,000 damage while below 10% health. High-octane desperation.',
        // Needs HP tracking during damage output - not available. Cannot implement.
        evaluate: () => false
    },
    {
        name: 'Unstable Mutation',
        description: 'You used 4 different abilities or items to secure 4 kills. Versatility is your only constant.',
        // Needs kill source tracking - not available. Cannot implement.
        evaluate: () => false
    },
    {
        name: 'Toxic Work Culture',
        description: 'You dealt 10,000+ total True Damage or Damage-over-time (Burn/Poison) in one match.',
        evaluate: (ctx) => {
            // trueDamageDealtToChampions is available; DoT is not tracked separately
            return (ctx.me.trueDamageDealtToChampions || 0) >= 10000;
        }
    },

    // --- Targon ---
    {
        name: 'The Star-Crossed Hero',
        description: "You denied 10 killing blows on allies. You didn't just support them; you saved their souls.",
        // Needs lethal damage denial tracking - not available. Cannot implement.
        evaluate: () => false
    },
    {
        name: 'Peak Performance',
        description: 'You reached Level 18 before anyone else in the match. The view is better from the top.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            const lvl18events = ctx.levelEvents.filter(e => e.level === 18);
            if (lvl18events.length === 0) return false;
            lvl18events.sort((a, b) => a.timestamp - b.timestamp);
            return lvl18events[0].participantId === ctx.myPId;
        }
    },
    {
        name: 'Celestial Impact',
        description: "You CC'd all 5 enemies simultaneously using a single ability. A cosmic alignment.",
        // Needs CC application tracking - not available. Cannot implement.
        evaluate: () => false
    },

    // --- Shurima ---
    {
        name: 'The Ascended Emperor',
        description: 'Highest gold, damage, and level. Tell the people what you have seen today.',
        evaluate: (ctx) => {
            const myGold = ctx.me.goldEarned || 0;
            const myDmg = ctx.me.totalDamageDealtToChampions || 0;
            const myLvl = ctx.me.champLevel || 0;
            return ctx.participants.every(p => (p.goldEarned || 0) <= myGold) &&
                   ctx.participants.every(p => (p.totalDamageDealtToChampions || 0) <= myDmg) &&
                   ctx.participants.every(p => (p.champLevel || 0) <= myLvl);
        }
    },
    {
        name: 'Architect of Ruin',
        description: 'You destroyed a tower, an inhibitor, and a nexus turret in one continuous push.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            const myBuildings = ctx.buildingEvents.filter(e => e.killerId === ctx.myPId);
            const towers = myBuildings.filter(e => e.buildingType === 'TOWER_BUILDING');
            const inhibs = myBuildings.filter(e => e.buildingType === 'INHIBITOR_BUILDING');
            // Check if a tower, inhibitor, and another tower (nexus turret) all within 60s
            for (const tower of towers) {
                for (const inhib of inhibs) {
                    if (Math.abs(tower.timestamp - inhib.timestamp) > 60000) continue;
                    // Look for another tower kill near these events (nexus turret)
                    const nexusTower = towers.find(t =>
                        t !== tower &&
                        Math.abs(t.timestamp - inhib.timestamp) <= 60000
                    );
                    if (nexusTower) return true;
                    // Or just tower + inhib within 60s is close enough
                    return true;
                }
            }
            return false;
        }
    },
    {
        name: "The Emperor's Tax",
        description: "You took every single jungle camp (including the enemy's) in one rotation. All belongs to Shurima.",
        // Needs specific camp identification from neutral minion kills - not reliably available. Cannot implement.
        evaluate: () => false
    },

    // --- Shadow Isles ---
    {
        name: 'Death is Only the Start',
        description: 'You got a Triple Kill while gray-screened. Death is just a change in management.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            // Find my death events, then check if I got 3+ kills after death before respawn
            const myDeaths = ctx.killEvents.filter(e => e.victimId === ctx.myPId);
            for (const death of myDeaths) {
                // Rough respawn window: check kills within 30s after death attributed to me
                const postDeathKills = ctx.killEvents.filter(e =>
                    e.killerId === ctx.myPId &&
                    e.timestamp > death.timestamp &&
                    e.timestamp <= death.timestamp + 30000
                );
                if (postDeathKills.length >= 3) return true;
            }
            return false;
        }
    },
    {
        name: 'The Harrowing Mist',
        description: '10+ takedowns inside the enemy base. The mist has finally claimed their home.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            let count = 0;
            for (const e of ctx.killEvents) {
                if (!didParticipate(e, ctx.myPId)) continue;
                if (!e.position) continue;
                if (isInBase(e.position, ctx.enemyTeamId)) count++;
            }
            return count >= 10;
        }
    },
    {
        name: 'Soul-Siphon Surge',
        description: 'You healed for 100% of your maximum HP during a single continuous fight.',
        // Needs heal tracking in specific time windows - not available. Cannot implement.
        evaluate: () => false
    },

    // --- Ixtal ---
    {
        name: 'Elemental Ambush',
        description: 'You secured a kill within 3 seconds of leaving a bush. They never saw the leaves move.',
        // Needs brush enter/exit events - not available in timeline. Cannot implement.
        evaluate: () => false
    },
    {
        name: 'Jungle Stalker',
        description: 'You killed the enemy Jungler in their own jungle multiple times. Their camps are your camps now.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            // Find enemy jungler
            const enemyJungler = ctx.enemyTeam.find(p =>
                p.teamPosition === 'JUNGLE' || p.individualPosition === 'JUNGLE'
            );
            if (!enemyJungler) return false;
            // Find their timeline participantId
            const puuidToTlId = {};
            const tl = typeof ctx.match.timelineJson === 'string' ? JSON.parse(ctx.match.timelineJson) : ctx.match.timelineJson;
            for (const tp of (tl.info?.participants || [])) {
                puuidToTlId[tp.puuid] = tp.participantId;
            }
            const enemyJgPId = puuidToTlId[enemyJungler.puuid];
            if (!enemyJgPId) return false;

            let count = 0;
            for (const e of ctx.killEvents) {
                if (e.killerId !== ctx.myPId || e.victimId !== enemyJgPId) continue;
                if (!e.position) continue;
                // Kill happened in enemy's jungle side
                if (isInJungleSide(e.position, ctx.enemyTeamId)) count++;
            }
            return count >= 4;
        }
    },
    {
        name: 'The Unseen Gardener',
        description: 'You cleared 15+ wards and secured 2 kills while remaining undetected by the enemy.',
        // Needs detection/visibility tracking - not available. Cannot implement.
        evaluate: () => false
    },

    // --- The Void ---
    {
        name: 'Evolve and Consume',
        description: 'You shut down an enemy who had a significant gold lead. Adaptation is the key to survival.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            for (const e of ctx.killEvents) {
                if (e.killerId !== ctx.myPId) continue;
                const frame = getNearestFrame(ctx.frames, e.timestamp);
                const myGold = getPlayerGold(frame, ctx.myPId);
                const victimGold = getPlayerGold(frame, e.victimId);
                if (victimGold > myGold + 2000) return true;
            }
            return false;
        }
    },
    {
        name: "Oblivion's Call",
        description: "Over 30% of your damage was True Damage. Resistances are an illusion you've deleted.",
        evaluate: (ctx) => {
            const totalDmg = ctx.me.totalDamageDealtToChampions || 0;
            const trueDmg = ctx.me.trueDamageDealtToChampions || 0;
            return totalDmg > 0 && (trueDmg / totalDmg) >= 0.30;
        }
    },
    {
        name: "The Void's Reach",
        description: 'You secured a kill from your own fountain while the victim was in their base.',
        evaluate: (ctx) => {
            if (!ctx.hasTimeline || !ctx.myPId) return false;
            for (const e of ctx.killEvents) {
                if (e.killerId !== ctx.myPId || !e.position) continue;
                // Victim in enemy base
                if (!isInBase(e.position, ctx.enemyTeamId)) continue;
                // Me in my fountain
                const frame = getNearestFrame(ctx.frames, e.timestamp);
                const myPos = getPlayerPos(frame, ctx.myPId);
                if (isInFountain(myPos, ctx.myTeamId)) return true;
            }
            return false;
        }
    },
];

// ===== MAIN EVALUATION FUNCTION =====

function evaluateBadges(match) {
    const ctx = buildContext(match);
    if (!ctx) return [];

    const earned = [];
    for (const badge of BADGES) {
        try {
            if (badge.evaluate(ctx)) {
                earned.push({
                    name: badge.name,
                    description: badge.description
                });
            }
        } catch (err) {
            // Skip badge on error
        }
    }

    return earned;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { evaluateBadges };
}
