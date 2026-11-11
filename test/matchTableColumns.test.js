/**
 * Match History table: no Result column (a win or loss is the row's colour);
 * the MVP/SVP tag sits next to the champion instead.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { makeMatch, SRC } = require('./helpers');

global.window = global.window || {};
const { renderMatchTable } = require(path.join(SRC, 'components', 'tableRenderer.js'));

const table = (ms) => renderMatchTable(ms, ms, 'https://ddragon', { 420: 'Ranked Solo' }, () => '', () => '', null, null);

test('no Result column, and the row still says win or loss through its class', () => {
    const html = table([makeMatch({ win: 1 }), makeMatch({ win: 0 })]);
    assert.ok(!/>Result</.test(html), 'no Result header');
    assert.ok(!/Victory|Defeat/.test(html), 'no Victory/Defeat badge');
    assert.match(html, /<tr class="win"/);
    assert.match(html, /<tr class="loss"/);
    // header and row cells still line up
    const headers = (html.match(/<th[ >]/g) || []).length;
    const cells = (html.split('<tbody>')[1].split('</tr>')[0].match(/<td[ >]/g) || []).length;
    assert.equal(cells, headers);
});

test('MVP/SVP tag sits in the champion cell', () => {
    const html = table([makeMatch({ championName: 'Ahri', impactTag: 'MVP', impactRank: 1 })]);
    assert.match(html, /table-champion-name">Ahri<\/span><span class="impact-tag impact-tag--mvp"/);
});

test('no Level or Duration column', () => {
    const html = table([makeMatch({ champLevel: 17, gameDuration: 1834 })]);
    assert.ok(!/<th[^>]*>Level</.test(html), 'no Level header');
    assert.ok(!/<th[^>]*>Duration</.test(html), 'no Duration header');
    assert.ok(!/<td class="center">31m<\/td>/.test(html), 'no duration cell');
    const headers = (html.match(/<th[ >]/g) || []).length;
    const cells = (html.split('<tbody>')[1].split('</tr>')[0].match(/<td[ >]/g) || []).length;
    assert.equal(cells, headers);
});
