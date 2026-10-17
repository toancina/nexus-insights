/**
 * itemIcon.js — item icon <img> markup shared by the match table, the
 * expanded match row and the Champions page (#67).
 *
 * Items still in the game use the current version (one URL per item, so the
 * browser cache shares it across every game). Items that have been removed
 * since (not in today's item.json) come from the Data Dragon version of the
 * game's own patch, where they still exist. Per-patch URLs for every item
 * meant ~20× the downloads on "Load All". If an icon fails anyway it is
 * retried from the current version, then replaced by a "removed item"
 * placeholder: the same in every view, never a broken image.
 */

const { getDDragonBase, getVersions, getItemData, isGameDataLoaded } = require('../services/dataDragon');
const { ddragonVersionForPatch } = require('../services/patches');

const CDN = 'https://ddragon.leagueoflegends.com/cdn';

/** URL of an item icon: current version, or the game's patch for a removed item. */
function itemIconUrl(id, patch) {
    const removed = isGameDataLoaded() && !getItemData(Number(id));
    const version = removed ? ddragonVersionForPatch(patch, getVersions()) : null;
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
