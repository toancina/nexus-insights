const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, escapeAttr, formatInt } = require('../src/components/dom');

test('escapes the characters that break out of markup', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
    assert.equal(escapeHtml("it's"), 'it&#39;s');
});

test('neutralises an injected image handler in a summoner name', () => {
    const name = '"><img src=x onerror=alert(1)>';
    const out  = escapeHtml(name);
    assert.ok(!out.includes('<img'), 'tag must not survive');
    assert.ok(!out.includes('">'),   'attribute break-out must not survive');
});

test('leaves ordinary names untouched', () => {
    for (const name of ['Faker', 'Toan', 'Hide on bush', 'Ünicode Nöme', '홍길동']) {
        assert.equal(escapeHtml(name), name);
    }
});

test('handles null and undefined without throwing', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
});

test('escapeAttr strips dangerous URL schemes', () => {
    assert.equal(escapeAttr('javascript:alert(1)'), '');
    assert.equal(escapeAttr('  JavaScript:alert(1)'), '');
    assert.equal(escapeAttr('data:text/html,<h1>x'), '');
    assert.ok(escapeAttr('https://ddragon.leagueoflegends.com/x.png').startsWith('https://'));
});

test('formatInt adds thousands separators and rounds', () => {
    assert.equal(formatInt(1234), '1,234');
    assert.equal(formatInt(1234567.6), '1,234,568');
    assert.equal(formatInt(999), '999');
    assert.equal(formatInt(-2500), '-2,500');
    assert.equal(formatInt(1500, { signed: true }), '+1,500');
    assert.equal(formatInt(0, { signed: true }), '0');
    assert.equal(formatInt(null), '');
    assert.equal(formatInt('-'), '-');
});
