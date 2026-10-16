/**
 * riotErrors.js — what to tell the user when a Riot API call fails. Pure.
 *
 * Shared by sync and the Live page (#59), so an expired key reads the same
 * everywhere.
 */

/** 401 (malformed/unknown key) or 403 (expired key). */
function isKeyError(err) {
    const status = err && err.response && err.response.status;
    return status === 401 || status === 403;
}

function friendlyRiotError(err) {
    // Riot answers 401 for a malformed/unknown key (e.g. pasted with a stray
    // space) and 403 for an expired one. Development keys expire every 24
    // hours, so this is the error a new user hits most — say what to do, not
    // just what went wrong.
    if (isKeyError(err)) {
        return 'Riot API key invalid or expired. Development keys last 24 hours: ' +
               'get a new one at developer.riotgames.com and paste it in Settings (⚙).';
    }
    const status = err && err.response && err.response.status;
    if (status === 404) return 'Player not found. Check your Riot ID';
    if (status === 429) return 'Rate limited. Please wait a moment';
    return (err && err.message) || String(err);
}

module.exports = { friendlyRiotError, isKeyError };
