/**
 * liveClient.js — the League client's own Live Client Data API.
 *
 * While a game is running, the League client serves data on
 * https://127.0.0.1:2999. This is NOT the Riot web API:
 *
 *   - it runs on this machine, so there is no API key and no rate limit
 *   - it only answers while a game is actually in progress
 *   - it is unaffected by the Spectator-V5 deactivation, which concerns
 *     remotely observing *other* players
 *
 * That makes it the right way to know when a game starts and ends. Without it
 * the app can only guess — poll Riot on a timer and hope the interval lines up
 * with reality. With it, the app reacts to the actual event.
 *
 * WHY NOT AXIOS
 * -------------
 * The client presents a self-signed certificate, so the request has to opt out
 * of certificate verification. axios cannot do that here: it selects its
 * adapter by sniffing the environment, and this module is loaded in Electron's
 * renderer, where XMLHttpRequest exists. axios therefore picks the XHR adapter
 * and silently ignores `httpsAgent` — Chromium rejects the self-signed cert and
 * every call looks like "not in a game". Node's https module has no such
 * ambiguity, so it is used directly.
 *
 * Disabling verification is safe *specifically* because the destination is the
 * loopback address: nothing off this machine can answer it, and the client
 * rejects requests originating from any other IP regardless.
 */

const https = require('https');

const HOST = '127.0.0.1';
const PORT = 2999;

// A live-client call either answers immediately or the game isn't running.
// A short timeout keeps a stalled client from holding up the poll loop.
const TIMEOUT_MS = 2000;

/**
 * GET a Live Client Data endpoint. Resolves to parsed JSON, or null for any
 * failure — "not in a game" is the normal state and surfaces as ECONNREFUSED,
 * a 404, or a timeout depending on how far along the client is.
 */
function liveGet(pathname) {
    return new Promise(resolve => {
        const req = https.request(
            {
                host: HOST,
                port: PORT,
                path: pathname,
                method: 'GET',
                rejectUnauthorized: false, // self-signed, loopback only
                timeout: TIMEOUT_MS,
            },
            res => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume(); // drain, otherwise the socket leaks
                    return resolve(null);
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch { resolve(null); }
                });
            }
        );

        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.end();
    });
}

/**
 * Is a game in progress on this machine right now?
 * Resolves to { inGame, gameTime, gameMode, mapName }. Never rejects.
 */
async function getLiveGame() {
    const data = await liveGet('/liveclientdata/gamestats');
    if (!data) return { inGame: false, gameTime: 0, gameMode: null, mapName: null };

    return {
        inGame:   true,
        gameTime: typeof data.gameTime === 'number' ? data.gameTime : 0,
        gameMode: data.gameMode || null,
        mapName:  data.mapName  || null,
    };
}

/**
 * Every player in the running game (Live page, #59): the raw
 * /liveclientdata/playerlist array (Riot ID, champion, team, position,
 * spells, keystone), or null when no game is running.
 */
async function getPlayerList() {
    const list = await liveGet('/liveclientdata/playerlist');
    return Array.isArray(list) && list.length ? list : null;
}

/** Your Riot ID in the running game ("name#tag"), or null. */
async function getActivePlayerName() {
    const name = await liveGet('/liveclientdata/activeplayername');
    return typeof name === 'string' && name ? name : null;
}

/**
 * Diagnostic helper — call `window.testLiveClient()` from devtools while a game
 * is running to see whether the app can reach the client at all.
 */
async function testConnection() {
    const stats = await liveGet('/liveclientdata/gamestats');
    if (stats) {
        return {
            reachable: true,
            message: `Connected. Game mode ${stats.gameMode}, clock ${Math.round(stats.gameTime)}s.`,
            stats,
        };
    }
    return {
        reachable: false,
        message: `Nothing answered on https://${HOST}:${PORT}. Normal if no game is running — ` +
                 `if a game IS running, the client isn't serving the Live Client Data API.`,
    };
}

module.exports = { getLiveGame, getPlayerList, getActivePlayerName, testConnection };
