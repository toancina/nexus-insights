const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// #63: every z-index comes from the layer scale in polish.css. A raw number is
// how the Settings dialog ended up drawn under page content.
const STYLES = path.join(__dirname, '..', 'src', 'styles');
const files = fs.readdirSync(STYLES).filter(f => f.endsWith('.css'));
const read = f => fs.readFileSync(path.join(STYLES, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('every z-index uses the layer scale (#63)', () => {
    const bad = [];
    for (const f of files) {
        read(f).split('\n').forEach((line, i) => {
            const m = line.match(/z-index\s*:\s*([^;]+);/);
            if (m && !/^(calc\()?var\(--z-[a-z]+\)/.test(m[1].trim())) bad.push(`${f}:${i + 1}  ${line.trim()}`);
        });
    }
    assert.deepEqual(bad, [], 'raw z-index values:\n' + bad.join('\n'));
});

test('every layer used is defined, and the scale keeps its order', () => {
    const polish = read('polish.css');
    const defined = Object.fromEntries([...polish.matchAll(/--(z-[a-z]+)\s*:\s*(-?\d+)\s*;/g)].map(m => [m[1], Number(m[2])]));
    for (const f of files) {
        for (const m of read(f).matchAll(/var\(--(z-[a-z]+)\)/g)) {
            assert.ok(m[1] in defined, `${f} uses --${m[1]}, which isn't in the scale`);
        }
    }
    const order = ['z-below', 'z-local', 'z-sticky', 'z-topbar', 'z-nav', 'z-popover', 'z-modal', 'z-toast', 'z-tooltip', 'z-confetti', 'z-titlebar'];
    for (let i = 1; i < order.length; i++) {
        assert.ok(defined[order[i]] > defined[order[i - 1]], `--${order[i]} must be above --${order[i - 1]}`);
    }
});

test('the Settings dialog sits at page level, not inside a page', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const modal = html.indexOf('id="setupModal"');
    const lastPageEnd = html.lastIndexOf('id="chat-tab"');
    assert.ok(modal > lastPageEnd, 'setupModal comes after the last page');
    // The page shell must not be its own layer (#63, #87): the dialog is
    // drawn above whatever page is open
    for (const f of files) {
        assert.ok(!/\.page(-tab)?\s*\{[^}]*z-index/.test(read(f)), `${f}: .page / .page-tab have no z-index`);
    }
});
