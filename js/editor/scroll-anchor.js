/* scroll-anchor.js — garder « la même page à l'écran » quand la zone des
 * doubles pages est re-rendue (éditeur de boek, editor.js / renderSpreads).
 *
 * On ne restaure pas un scrollTop brut : des pages peuvent apparaître ou
 * disparaître AU-DESSUS de la vue (couverture retirée/remise, page blanche
 * insérée, page supprimée) et l'échelle peut changer (fenêtre ou panneau
 * redimensionné). On se repère donc sur une PAGE :
 *  - captureAnchor : la première page visible en haut de la vue (et les
 *    suivantes, en secours si elle disparaît), avec le décalage déjà défilé
 *    dans cette page — en px et en fraction de sa hauteur ;
 *  - resolveAnchor : le scrollTop qui remet cette même page au même endroit
 *    dans la nouvelle géométrie — au pixel près à échelle constante, à la
 *    même hauteur relative si l'échelle a changé.
 *
 * Fonctions pures (boîtes = [{key, top, height}] en px, dans le repère du
 * contenu défilant, dans l'ordre du document), testées en Node :
 * tests/c/frontend.test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditorScrollAnchor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_CANDIDATES = 8; // la page repère + quelques suivantes en secours

  // → {entries: [{key, offset, ratio}]} à partir de la première boîte dont le
  // bas dépasse scrollTop. offset = px défilés depuis le haut de la boîte
  // (négatif si la vue commence dans l'espace qui la précède). null si vide.
  function captureAnchor(scrollTop, boxes) {
    if (!boxes || boxes.length === 0) return null;
    let index = boxes.findIndex((b) => b.top + b.height > scrollTop);
    if (index === -1) index = boxes.length - 1; // défilé au-delà de la dernière
    const entries = boxes.slice(index, index + MAX_CANDIDATES).map((b) => ({
      key: b.key,
      offset: scrollTop - b.top,
      ratio: b.height > 0 ? (scrollTop - b.top) / b.height : 0,
    }));
    return { entries };
  }

  // → scrollTop qui remet la page repère au même endroit, ou null si aucune
  // des pages repères n'existe plus (l'appelant garde alors le scrollTop brut).
  // sameScale : hauteurs inchangées → décalage en px (exact) ; sinon fraction.
  function resolveAnchor(anchor, boxes, sameScale) {
    if (!anchor || !boxes) return null;
    for (const entry of anchor.entries) {
      const box = boxes.find((b) => b.key === entry.key);
      if (!box) continue;
      return Math.max(0, box.top + (sameScale ? entry.offset : entry.ratio * box.height));
    }
    return null;
  }

  return { captureAnchor, resolveAnchor };
});
