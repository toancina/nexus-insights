/**
 * setupCheck.js — what the setup dialog says when the Riot check of its
 * details fails (#74). Pure; riotApi.verifyAccount makes the calls.
 */
const { isKeyError } = require('./riotErrors');

/**
 * `offline`: the check itself couldn't run (no connection, Riot down or
 * busy), so the details are saved unchecked rather than blocking a user who
 * is offline.
 */
function verifyProblem(err, { gameName, tagLine, serverName }) {
    const status = err && err.response && err.response.status;
    if (isKeyError(err)) {
        return { message: 'This API key is invalid or expired. Development keys last 24 hours: ' +
                          'get a new one at developer.riotgames.com.' };
    }
    if ((status === 404 || status === 400) && err.step === 'account') {
        return { message: `There is no Riot ID ${gameName}#${tagLine}. Check the name and the tag (the part after #).` };
    }
    if (status === 404 && err.step === 'summoner') {
        return { message: `${gameName}#${tagLine} has no League account on ${serverName}. Pick the server you play on.` };
    }
    return { offline: true, message: "Couldn't reach Riot to check these details, so they were saved unchecked." };
}

module.exports = { verifyProblem };
