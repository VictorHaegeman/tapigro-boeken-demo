/* dragdrop.js — câblage SortableJS de l'éditeur (tâche C).
 *
 * Trois sources/cibles :
 *  - le panneau produits (source, clone : un même produit est déposable N fois) ;
 *  - chaque page de contenu (groupe partagé 'book' : réordonnancement intra-
 *    et inter-pages, insertion ENTRE deux items, l'ordre DOM fait foi) ;
 *  - les pages fixes n'ont pas de Sortable : aucun drop possible.
 *
 * Page pleine → put refusé (refus visuel, classe .drop-refused) ; le serveur
 * renvoie de toute façon 409 PAGE_FULL.
 *
 * Emplacements libres : chaque grille de page contient, APRÈS ses cellules,
 * des cases vides en pointillés (.lr-empty, écran uniquement — elles
 * n'existent pas dans le PDF). Lâcher un produit sur une case vide l'ajoute à
 * la suite des items (ordre de lecture compact, jamais de trou) : pendant le
 * drag, l'élément se place sur la PREMIÈRE case libre, qui est ainsi la case
 * cible surlignée. Les cases vides ne sont jamais des items : ni comptées
 * dans la capacité, ni dans les index envoyés à l'API.
 *
 * Module UMD : les fonctions pures (computeBeforeId, applyInsert, applyMove)
 * sont testables en Node sans DOM (tests/c/frontend.test.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditorDragDrop = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- logique pure -------------------------------------------------------------

  // Ordre final des ids d'une page (l'élément déposé/déplacé est à `index`,
  // ids[index] == null pour un élément tout juste déposé qui n'a pas encore
  // d'id serveur) → beforeItemId attendu par l'API : l'item qui SUIT, ou null
  // (fin de page).
  function computeBeforeId(finalIds, index) {
    return index + 1 < finalIds.length ? finalIds[index + 1] : null;
  }

  // Modèle de référence pour les tests : applique une insertion à une liste
  // d'ids comme le ferait le serveur (insère newId avant beforeId, ou en fin).
  function applyInsert(ids, newId, beforeId) {
    const out = ids.slice();
    const idx = beforeId === null ? out.length : out.indexOf(beforeId);
    if (idx === -1) throw new Error(`applyInsert: beforeId ${beforeId} introuvable`);
    out.splice(idx, 0, newId);
    return out;
  }

  // Verdict d'un drop au RELÂCHEMENT. SortableJS peut laisser le clone dans
  // une grille simplement TRAVERSÉE quand la grille visée refuse (page
  // pleine) : on n'accepte le drop que si le pointeur est réellement
  // au-dessus de la grille qui a adopté l'élément, et qu'elle a de la place.
  //  → 'ok' | 'outside' (relâché hors de la grille adoptante) | 'full'.
  function dropVerdict({ x, y, rect, cellCount, capacity }) {
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return 'outside';
    if (cellCount >= capacity) return 'full';
    return 'ok';
  }

  // Idem pour un déplacement : retire itemId de fromIds, l'insère dans toIds
  // avant beforeId (fromIds et toIds peuvent être la même liste : intra-page).
  function applyMove(fromIds, toIds, itemId, beforeId) {
    const from = fromIds.filter((id) => id !== itemId);
    const to = (fromIds === toIds ? from : toIds.filter((id) => id !== itemId)).slice();
    const idx = beforeId === null ? to.length : to.indexOf(beforeId);
    if (idx === -1) throw new Error(`applyMove: beforeId ${beforeId} introuvable`);
    to.splice(idx, 0, itemId);
    return fromIds === toIds ? { from: to, to } : { from, to };
  }

  // Nombre de cases vides à montrer dans une page : la capacité moins les
  // emplacements occupés (items + élément en cours de dépôt), jamais négatif.
  function emptySlotCount(capacity, used) {
    return Math.max(0, capacity - used);
  }

  // ---- câblage navigateur --------------------------------------------------------

  const GROUP = 'book';
  const ITEM_SELECTOR = '.lr-cell, .prod-entry'; // un item, ou un produit en cours de dépôt
  const EMPTY_CLASS = 'lr-empty';

  // Les ITEMS d'une grille, dans l'ordre du DOM (les cases vides n'en sont pas).
  function itemNodes(gridEl) {
    return Array.from(gridEl.children).filter((c) => c.matches(ITEM_SELECTOR));
  }

  function cellIds(gridEl) {
    return itemNodes(gridEl).map((c) => (c.dataset.itemId ? Number(c.dataset.itemId) : null));
  }

  function cellCount(gridEl, except) {
    return Array.from(gridEl.children).filter((c) => c !== except && c.classList.contains('lr-cell'))
      .length;
  }

  // ---- cases vides ---------------------------------------------------------------

  // Ajoute à une grille ses cases vides (une par emplacement du layout : on en
  // masque ensuite ce qu'il faut — une page peut PERDRE un item pendant un
  // drag vers une autre page et doit alors en montrer une de plus).
  function fillEmptySlots(gridEl, capacity) {
    gridEl.dataset.capacity = String(capacity);
    // Invite de la première case libre, dans la langue de l'interface.
    const hint = typeof self !== 'undefined' && self.App ? self.App.t('editor.dropHere') : '';
    for (let i = 0; i < capacity; i++) {
      const slot = document.createElement('div');
      slot.className = EMPTY_CLASS;
      slot.dataset.hint = hint;
      slot.setAttribute('aria-hidden', 'true');
      gridEl.appendChild(slot);
    }
    syncEmptySlots(gridEl);
  }

  // Remet une grille d'aplomb : cases vides TOUJOURS après les items (et après
  // l'élément en cours de dépôt), items + cases visibles = capacité, la
  // première case libre marquée (.is-first : elle porte l'invite).
  function syncEmptySlots(gridEl) {
    const capacity = Number(gridEl.dataset.capacity);
    if (!capacity) return;
    const children = Array.from(gridEl.children);
    const slots = children.filter((c) => c.classList.contains(EMPTY_CLASS));
    if (slots.length === 0) return;
    const used = children.length - slots.length;
    const tail = children.slice(used);
    if (tail.some((c, i) => c !== slots[i])) {
      for (const slot of slots) gridEl.appendChild(slot);
    }
    const free = emptySlotCount(capacity, used);
    slots.forEach((slot, i) => {
      slot.classList.toggle('is-hidden', i >= free);
      slot.classList.toggle('is-first', i === 0 && free > 0);
    });
  }

  function syncAllEmptySlots() {
    document.querySelectorAll('.lr-grid[data-capacity]').forEach(syncEmptySlots);
  }

  // onMove commun (panneau ET grilles : SortableJS l'appelle sur la liste
  // d'ORIGINE). Survol d'une case vide = « à la suite des items » :
  //  - l'élément est déjà dans cette grille → on le place nous-mêmes sur la
  //    première case libre et on annule le déplacement de SortableJS (sinon
  //    il oscillerait autour de la case survolée) ;
  //  - il arrive d'ailleurs → SortableJS l'insère (son état interne suit),
  //    puis la resynchronisation le ramène devant les cases vides.
  function handleMove(evt) {
    requestAnimationFrame(syncAllEmptySlots); // avant le prochain affichage
    const related = evt.related;
    if (!related || !related.classList.contains(EMPTY_CLASS)) return undefined;
    if (evt.dragged.parentNode !== evt.to) return undefined;
    const firstSlot = Array.from(evt.to.children).find((c) => c.classList.contains(EMPTY_CLASS));
    if (firstSlot && evt.dragged.nextElementSibling !== firstSlot) {
      evt.to.insertBefore(evt.dragged, firstSlot);
    }
    return false;
  }

  function handleEnd() {
    clearRefusals();
    syncAllEmptySlots();
  }

  // Rend le panneau produits draggable (clone, jamais de retrait de la liste).
  function initProductPanel(listEl) {
    return new Sortable(listEl, {
      group: { name: GROUP, pull: 'clone', put: false },
      sort: false,
      draggable: '.prod-entry',
      forceFallback: true, // fiable avec les pages mises à l'échelle (transform: scale)
      fallbackOnBody: true,
      onMove: handleMove,
      onEnd: handleEnd,
    });
  }

  // Coordonnées du pointeur au relâchement (souris ou tactile).
  function pointerOf(evt) {
    const e = evt.originalEvent || {};
    const t = (e.changedTouches && e.changedTouches[0]) || e;
    return { x: t.clientX, y: t.clientY };
  }

  // Applique dropVerdict à un événement onAdd de SortableJS.
  function verdictFor(evt, capacity) {
    const { x, y } = pointerOf(evt);
    if (typeof x !== 'number' || Number.isNaN(x)) return 'ok'; // pas de pointeur : le serveur tranchera
    // Seuls les items comptent (ni l'élément déposé, ni les cases vides).
    return dropVerdict({
      x,
      y,
      rect: evt.to.getBoundingClientRect(),
      cellCount: cellCount(evt.to, evt.item),
      capacity,
    });
  }

  // Rend une grille de page de contenu triable.
  // handlers = {capacity(), onInsert({pageId, productId, beforeItemId, el}),
  //             onMove({itemId, pageId, beforeItemId}),
  //             onRefused('outside'|'full') — drop annulé au relâchement}
  function initPageGrid(gridEl, pageId, handlers) {
    return new Sortable(gridEl, {
      group: {
        name: GROUP,
        pull: true,
        // Page pleine → drop refusé visuellement (et 409 côté serveur).
        put: (to, from, dragEl) => {
          if (dragEl.classList.contains('lr-cell') && from.el === to.el) return true;
          const full = cellCount(to.el) >= handlers.capacity();
          to.el.closest('.lr-page').classList.toggle('drop-refused', full);
          return !full;
        },
      },
      animation: 120,
      // Les cases vides sont des CIBLES de dépôt (SortableJS ne réagit qu'au
      // survol d'éléments « draggable ») mais ne se déplacent pas (filter).
      draggable: `${ITEM_SELECTOR}, .${EMPTY_CLASS}`,
      filter: `.${EMPTY_CLASS}`,
      forceFallback: true,
      fallbackOnBody: true,
      onMove: handleMove,
      onEnd: handleEnd,
      onAdd(evt) {
        // Un groupe voisin traversé ne doit jamais adopter le drop : on
        // vérifie la grille sous le pointeur ET sa capacité au relâchement.
        const verdict = verdictFor(evt, handlers.capacity());
        if (verdict !== 'ok') {
          evt.item.remove(); // clone retiré ; un vrai item sera re-rendu depuis l'état
          if (handlers.onRefused) handlers.onRefused(verdict);
          return;
        }
        syncEmptySlots(evt.to);
        // Rang parmi les ITEMS de la page (evt.newIndex compterait les cases vides).
        const index = itemNodes(evt.to).indexOf(evt.item);
        if (evt.item.classList.contains('prod-entry')) {
          // Dépôt depuis le panneau produits → création d'item.
          const productId = Number(evt.item.dataset.productId);
          const ids = cellIds(evt.to);
          ids[index] = null; // le clone n'a pas d'id d'item
          handlers.onInsert({
            pageId,
            productId,
            beforeItemId: computeBeforeId(ids, index),
            el: evt.item,
          });
        } else {
          // Arrivée depuis une autre page → déplacement inter-pages.
          const itemId = Number(evt.item.dataset.itemId);
          handlers.onMove({
            itemId,
            pageId,
            beforeItemId: computeBeforeId(cellIds(evt.to), index),
          });
        }
      },
      onUpdate(evt) {
        // Réordonnancement intra-page (rang parmi les items, cases vides exclues).
        const itemId = Number(evt.item.dataset.itemId);
        handlers.onMove({
          itemId,
          pageId,
          beforeItemId: computeBeforeId(cellIds(evt.to), itemNodes(evt.to).indexOf(evt.item)),
        });
      },
    });
  }

  function clearRefusals() {
    document.querySelectorAll('.lr-page.drop-refused').forEach((el) => {
      el.classList.remove('drop-refused');
    });
  }

  return {
    computeBeforeId,
    applyInsert,
    applyMove,
    dropVerdict,
    emptySlotCount,
    fillEmptySlots,
    syncEmptySlots,
    initProductPanel,
    initPageGrid,
    clearRefusals,
    GROUP,
  };
});
