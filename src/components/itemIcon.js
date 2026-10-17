/**
 * itemIcon.js — item icon <img> markup shared by the match table, the
 * expanded match row and the Champions page (#67).
 *
 * Icons come from the Data Dragon version of the game's own patch, so items
 * removed since then still show. If an icon fails anyway it is retried from
 * the current version, then replaced by a "removed item" placeholder: the
 * same in every view, never a broken image.
 */

const { getDDragonBase, getVersions } = require('../services/dataDragon');
const { ddragonVersionForPatch } = require('../services/patches');

const CDN = 'https://ddragon.leagueoflegends.com/cdn';

/** URL of an item icon, for the game's patch when known. */
function itemIconUrl(id, patch) {
    const version = ddragonVersionForPatch(patch, getVersions());
    const base = version ? `${CDN}/${version}` : getDDragonBase();
    return `${base}/img/item/${Number(id)}.png`;
}

/** onerror: current version once, then the placeholder. */
function itemIconFallback(img) {
    const current = `${getDDragonBase()}/img/item/${img.dataset.itemId}.png`;
    if (!img.dataset.retried && img.src !== current) {
        img.dataset.retried = '1';
        img.src = current;
        return;
    }
    img.onerror = null;
    img.removeAttribute('src');
    img.classList.add('item-missing');
    img.title = `Removed item (id ${img.dataset.itemId})`;
}
window.itemIconFallback = itemIconFallback;

/**
 * <img> for an item. `extra` is trusted attribute text built by the caller
 * (class, data-bought, …).
 */
function itemImg(id, { patch = null, extra = '' } = {}) {
    const n = Number(id);
    return `<img src="${itemIconUrl(n, patch)}" data-item-id="${n}" alt="Item" ${extra} onerror="itemIconFallback(this)">`;
}

module.exports = { itemIconUrl, itemImg, itemIconFallback };
