/* editor.js — orchestration de l'éditeur de boek (tâche C).
 *
 * État local = miroir du serveur : chaque mutation (drop, move, remove) est
 * un appel API granulaire immédiat ; à sa réussite l'état local est mis à
 * jour depuis la réponse et les pages re-rendues (F5 restitue donc toujours
 * l'état exact). Le re-rendu NE DOIT JAMAIS déplacer la vue : voir
 * renderSpreads (remplacement en une fois, cellules et pages fixes réutilisées,
 * position de défilement restaurée). Nom + textes des pages fixes passent par l'autosave débouncée
 * et le bouton Enregistrer (public/js/editor/autosave.js).
 *
 * Le boek est affiché en DOUBLE PAGE : couverture + page 2 (si le boek a ses
 * pages fixes — book.fixedPages, réglable dans la barre d'outils), puis les
 * pages de contenu par paires, puis le dos. Une double page vide est toujours
 * disponible en fin de boek (ensureTrailingSpread). Les pages fixes sont
 * VERROUILLÉES : aucun dépôt possible, seuls leurs textes (slots du layout)
 * sont éditables. Les légendes numérotent les pages comme le PDF
 * (book-plan.js pageSequence) ; la double page vide de fin est marquée « pas
 * imprimée ».
 *
 * Ajouter un produit : glisser-déposer (dragdrop.js) — y compris entre deux
 * articles d'une page pleine (cascade côté serveur) — ou bouton « + Toevoegen »
 * du panneau (au clavier aussi) qui place le produit après le dernier article
 * du boek. Retirer : bouton × de la cellule, avec « Ongedaan maken ».
 */
(function () {
  'use strict';

  const PX_PER_MM = 96 / 25.4;
  const NARROW = '(max-width: 760px)'; // gsm : une page par ligne, panneau en tiroir
  const HELP_KEY = 'tapigro-editor-help-closed';

  document.addEventListener('DOMContentLoaded', () => {
    const rootEl = document.getElementById('editor-root');
    if (!rootEl) return;
    const bookId = Number(rootEl.dataset.bookId);

    const spreadsEl = document.getElementById('spreads');
    const nameEl = document.getElementById('book-name');
    const saveBtn = document.getElementById('save-btn');
    const fixedToggle = document.getElementById('fixed-pages-toggle');
    const fixedToggleWrap = document.getElementById('fixed-pages-setting');
    const errorEl = document.getElementById('editor-error');
    const liveEl = document.getElementById('editor-live');
    const panelEl = document.getElementById('product-panel');
    const panelToggle = document.getElementById('panel-toggle');
    const saver = EditorAutosave.createSaver(document.getElementById('save-status'));

    let book = null;
    let layout = null;
    let readOnly = true;
    let sortables = [];
    // Nœuds DOM réutilisés d'un rendu à l'autre (renderSpreads) : une cellule
    // par item, une page fixe par clé — leurs images ne sont pas rechargées,
    // donc rien ne clignote quand une AUTRE partie du boek change.
    let cellCache = new Map(); // itemId → élément .lr-cell (décoré)
    let fixedCache = new Map(); // 'cover'|'page2'|'back' → {scale, texts, wrap}
    let lastScale = null;
    let sequence = new Map(); // pageId → élément de pageSequence (numéro du PDF)
    let pendingMarks = null; // {ids, className} : cellules à signaler au prochain rendu

    function showError(err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      setTimeout(() => {
        errorEl.hidden = true;
      }, 4000);
    }

    // ---- état ------------------------------------------------------------------

    function pageById(pageId) {
      return book.pages.find((p) => p.id === pageId);
    }

    function removeItemFromState(itemId) {
      for (const page of book.pages) {
        const idx = page.items.findIndex((it) => it.id === itemId);
        if (idx !== -1) return page.items.splice(idx, 1)[0];
      }
      return null;
    }

    // Insère/replace un item (réponse serveur {id, pageId, position, product})
    // dans la page cible, trié par position — l'état local reste = la BDD.
    function upsertItemInState(item) {
      removeItemFromState(item.id);
      const page = pageById(item.pageId);
      const entry = { id: item.id, position: item.position, product: item.product };
      const idx = page.items.findIndex((it) => it.position > item.position);
      page.items.splice(idx === -1 ? page.items.length : idx, 0, entry);
    }

    // ---- mutations granulaires ---------------------------------------------------

    // Annonce pour les lecteurs d'écran (zone aria-live invisible).
    function announce(text) {
      liveEl.textContent = '';
      requestAnimationFrame(() => {
        liveEl.textContent = text;
      });
    }

    // Signale brièvement des cellules (article déplacé par une cascade,
    // article ajouté) — au prochain rendu, puis la classe disparaît.
    function markCells(ids, className) {
      pendingMarks = { ids, className };
    }
    function applyMarks() {
      if (!pendingMarks) return;
      const { ids, className } = pendingMarks;
      pendingMarks = null;
      for (const id of ids) {
        const cell = cellCache.get(id);
        if (!cell) continue;
        cell.classList.add(className);
        setTimeout(() => cell.classList.remove(className), 2200);
      }
    }

    // Réponse {item, shifted} d'un dépôt / déplacement → état local. Une
    // cascade (page pleine) déplace d'autres articles et peut créer une page :
    // on recharge alors tout le boek.
    async function applyPlaced(res) {
      if (res.shifted && res.shifted.length) {
        book = await App.api(`/api/books/${bookId}`);
        markCells(res.shifted, 'is-shifted');
        announce(App.t('editor.shifted', { n: res.shifted.length }));
      } else {
        upsertItemInState(res.item);
      }
      return res.item;
    }

    async function apiInsert({ pageId, productId, beforeItemId }) {
      // Le clone du panneau reste dans la case (« en attente », editor.css)
      // jusqu'au re-rendu depuis la réponse : pas de case qui se vide puis se
      // remplit. En cas d'erreur le re-rendu le fait disparaître.
      let item = null;
      try {
        item = await applyPlaced(
          await saver.track(
            App.api(`/api/books/${bookId}/items`, {
              method: 'POST',
              body: { pageId, productId, beforeItemId },
            })
          )
        );
      } catch (err) {
        showError(err);
      }
      renderSpreads();
      await ensureTrailingSpread();
      return item;
    }

    async function apiMove({ itemId, pageId, beforeItemId }) {
      try {
        await applyPlaced(
          await saver.track(
            App.api(`/api/books/${bookId}/items/${itemId}`, {
              method: 'PATCH',
              body: { pageId, beforeItemId },
            })
          )
        );
      } catch (err) {
        showError(err);
      }
      renderSpreads();
      await ensureTrailingSpread();
    }

    // Retrait avec « Ongedaan maken » : le produit revient à sa place (avant
    // l'article qui le suivait, s'il est toujours sur la même page).
    async function apiRemove(itemId) {
      const page = book.pages.find((p) => p.items.some((it) => it.id === itemId));
      if (!page) return;
      const idx = page.items.findIndex((it) => it.id === itemId);
      const removed = page.items[idx];
      const nextId = page.items[idx + 1] ? page.items[idx + 1].id : null;
      try {
        await saver.track(App.api(`/api/books/${bookId}/items/${itemId}`, { method: 'DELETE' }));
        removeItemFromState(itemId);
      } catch (err) {
        showError(err);
        renderSpreads();
        return;
      }
      renderSpreads();
      const code = removed.product.code;
      App.flash('ok', App.t('editor.removed', { code }), {
        label: App.t('editor.undo'),
        onClick: async () => {
          const target = pageById(page.id);
          if (!target) return showError(new Error(App.t('apiErrors.pageNotFound')));
          const before = nextId !== null && target.items.some((it) => it.id === nextId) ? nextId : null;
          const item = await apiInsert({ pageId: page.id, productId: removed.product.id, beforeItemId: before });
          if (item) {
            markCells([item.id], 'is-new');
            renderSpreads();
            announce(App.t('editor.restored', { code }));
          }
        },
      });
    }

    // « + Toevoegen » : après le DERNIER article du boek (ordre de lecture) —
    // prévisible, comme un remplissage à la suite. Page pleine : le serveur
    // l'envoie au début de la page de produits suivante (créée au besoin).
    async function addToEnd(product) {
      const products = book.pages.filter((p) => p.kind === 'products');
      if (!products.length) return;
      const withItems = products.filter((p) => p.items.length);
      const target = withItems.length ? withItems[withItems.length - 1] : products[0];
      const item = await apiInsert({ pageId: target.id, productId: product.id, beforeItemId: null });
      if (!item) return;
      markCells([item.id], 'is-new');
      renderSpreads();
      const entry = sequence.get(item.pageId);
      announce(App.t('editor.added', { code: product.code, n: entry && entry.number ? entry.number : '?' }));
      const slot = spreadsEl.querySelector(`.page-slot[data-key="page:${item.pageId}"]`);
      if (slot) slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    // Recharge l'état complet depuis le serveur (opérations de pages : les
    // page_no des pages suivantes sont décalés côté serveur).
    async function refetchBook() {
      book = await App.api(`/api/books/${bookId}`);
      renderSpreads();
    }

    async function apiAddBlankPage(afterPageNo) {
      try {
        await saver.track(
          App.api(`/api/books/${bookId}/pages`, {
            method: 'POST',
            body: { afterPageNo, kind: 'blank' },
          })
        );
        await refetchBook();
        await ensureTrailingSpread();
      } catch (err) {
        showError(err);
      }
    }

    async function apiDeletePage(pageId) {
      try {
        // L'API refuse (409) une page non vide : l'erreur est affichée telle quelle.
        await saver.track(App.api(`/api/books/${bookId}/pages/${pageId}`, { method: 'DELETE' }));
        await refetchBook();
        await ensureTrailingSpread();
      } catch (err) {
        showError(err);
      }
    }

    // Une double page vide est toujours disponible en fin de boek : si la
    // dernière paire contient des items (ou si le compte est impair), on
    // ajoute des pages de contenu.
    async function ensureTrailingSpread() {
      if (readOnly) return;
      const endsWithEmptySpread = () => {
        const n = book.pages.length;
        if (n < 2 || n % 2 !== 0) return false;
        return book.pages
          .slice(-2)
          .every((p) => p.kind === 'products' && p.items.length === 0);
      };
      let guard = 0;
      let added = false;
      while (!endsWithEmptySpread() && guard < 4) {
        guard += 1;
        try {
          const { page } = await saver.track(
            App.api(`/api/books/${bookId}/pages`, { method: 'POST', body: {} })
          );
          book.pages.push(page);
          added = true;
        } catch (err) {
          showError(err);
          break;
        }
      }
      if (added) renderSpreads();
    }

    // ---- rendu -------------------------------------------------------------------

    function currentScale() {
      const pageW = layout.page.widthMm * PX_PER_MM;
      const avail = spreadsEl.clientWidth || 900;
      // Écran étroit : une page par ligne (editor.css), à pleine largeur.
      if (window.matchMedia(NARROW).matches) return Math.min(0.85, (avail - 24) / pageW);
      return Math.min(0.85, (avail - 64) / (2 * pageW));
    }

    function scaledBox(pageEl, scale) {
      const box = document.createElement('div');
      box.className = 'page-box';
      box.style.width = `${layout.page.widthMm * PX_PER_MM * scale}px`;
      box.style.height = `${layout.page.heightMm * PX_PER_MM * scale}px`;
      pageEl.style.transformOrigin = '0 0';
      pageEl.style.transform = `scale(${scale})`;
      box.appendChild(pageEl);
      return box;
    }

    // Légende sous la page + actions de page (page blanche intercalaire,
    // suppression d'une page vide) pour les pages de CONTENU des editors.
    function captionned(box, text, page) {
      const wrap = document.createElement('div');
      wrap.className = 'page-slot';
      wrap.appendChild(box);
      const cap = document.createElement('div');
      cap.className = 'page-caption';
      cap.textContent = text;
      wrap.appendChild(cap);
      if (page && !readOnly) {
        const actions = document.createElement('div');
        actions.className = 'page-actions';
        const blankBtn = document.createElement('button');
        blankBtn.type = 'button';
        blankBtn.className = 'btn sec petit';
        blankBtn.textContent = App.t('editor.addBlank');
        blankBtn.title = App.t('editor.addBlankTitle');
        blankBtn.addEventListener('click', () => apiAddBlankPage(page.pageNo));
        actions.appendChild(blankBtn);
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn sec petit';
        delBtn.textContent = App.t('editor.deletePage');
        // Une page qui porte des produits ne se supprime pas : bouton
        // désactivé, l'infobulle dit pourquoi (plutôt qu'une erreur après coup).
        const blocked = page.items.length > 0;
        delBtn.disabled = blocked;
        delBtn.title = App.t(blocked ? 'editor.deletePageBlocked' : 'editor.deletePageTitle');
        delBtn.addEventListener('click', () => apiDeletePage(page.id));
        actions.appendChild(delBtn);
        wrap.appendChild(actions);
      }
      return wrap;
    }

    // Page fixe (couverture / page 2 / dos) : verrouillée — aucun dépôt (ce
    // n'est pas une grille SortableJS), seuls les textes sont modifiables. La
    // légende et le cadenas le DISENT ; les zones de texte se révèlent au
    // survol (contour, curseur texte, infobulle) et un texte vide montre son
    // indication grisée (écran seulement, jamais dans le PDF).
    function buildFixedPage(key, caption, scale) {
      if (!book.fixedPages) return null; // choix du boek (réglage de la barre d'outils)
      // Même échelle et mêmes textes (même objet : la saisie écrit dans le DOM
      // ET dans book.texts) → on réutilise la page telle quelle.
      const cached = fixedCache.get(key);
      if (cached && cached.scale === scale && cached.texts === book.texts) return cached.wrap;
      const rendered = LayoutRender.renderFixedPage(layout, key, book.texts);
      if (!rendered) return null;
      rendered.page.classList.add('is-locked');
      if (!readOnly) {
        for (const slotEl of rendered.slotNodes) {
          slotEl.classList.add('editable');
          slotEl.contentEditable = 'true';
          slotEl.spellcheck = false;
          slotEl.title = App.t('editor.clickToEdit');
          slotEl.setAttribute('role', 'textbox');
          slotEl.setAttribute('aria-label', slotEl.dataset.placeholder || App.t('editor.pageText'));
          slotEl.addEventListener('input', () => {
            const text = slotEl.innerText.replace(/\n$/, '');
            // Un contenteditable « vidé » garde souvent un <br> : on le retire
            // pour que l'indication grisée (:empty) réapparaisse.
            if (text === '') slotEl.textContent = '';
            book.texts[slotEl.dataset.slot] = text;
            saver.scheduleDoc();
          });
        }
      }
      const wrap = captionned(scaledBox(rendered.page, scale), '');
      const cap = wrap.querySelector('.page-caption');
      cap.classList.add('is-fixed');
      const lock = document.createElement('span');
      lock.className = 'lock';
      lock.setAttribute('aria-hidden', 'true');
      lock.textContent = '🔒';
      const strong = document.createElement('strong');
      strong.textContent = caption;
      const hint = document.createElement('span');
      hint.textContent = App.t(readOnly ? 'editor.fixedHintReadOnly' : 'editor.fixedHint');
      cap.title = App.t('editor.fixedTitle');
      cap.append(lock, strong, hint);
      wrap.dataset.key = `fixed:${key}`; // repère de défilement (scroll-anchor.js)
      fixedCache.set(key, { scale, texts: book.texts, wrap });
      return wrap;
    }

    // Cellule d'un item : réutilisée si elle existe déjà (même nœud DOM, images
    // déjà chargées), sinon rendue et décorée (badge « retiré », bouton ×).
    function cellFor(item, nextCells) {
      let cell = cellCache.get(item.id);
      if (cell) {
        // Traces éventuelles d'un drag SortableJS interrompu par le re-rendu.
        cell.classList.remove('sortable-chosen', 'sortable-ghost', 'sortable-drag');
        cell.style.transform = '';
        cell.style.transition = '';
      } else {
        cell = LayoutRender.renderCell(layout, { id: item.id, product: item.product });
        // Produit désactivé (retiré du catalogue au dernier import) : badge
        // visible par TOUS les rôles — à voir avant d'imprimer. NB : le panneau
        // produits n'affiche jamais d'inactifs (/api/products filtre active=1).
        if (item.product.isActive === false) {
          const badge = document.createElement('div');
          badge.className = 'cell-inactive';
          badge.textContent = App.t('editor.retired');
          cell.appendChild(badge);
        }
        if (!readOnly) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'cell-remove';
          btn.title = App.t('editor.removeLabel', { code: item.product.code });
          btn.setAttribute('aria-label', App.t('editor.removeLabel', { code: item.product.code }));
          btn.textContent = '×';
          btn.addEventListener('click', () => apiRemove(item.id));
          cell.appendChild(btn);
        }
      }
      nextCells.set(item.id, cell);
      return cell;
    }

    function buildContentPage(page, caption, scale, nextCells) {
      // Page et grille vides du layout, puis les cellules (réutilisées).
      const { page: pageEl, grid } = LayoutRender.renderContentPage(layout, []);
      if (page.kind === 'blank') {
        pageEl.classList.add('lr-blank');
        const blank = captionned(scaledBox(pageEl, scale), App.t('editor.blankSuffix', { caption }), page);
        blank.dataset.key = `page:${page.id}`;
        return blank;
      }
      for (const item of page.items) grid.appendChild(cellFor(item, nextCells));
      if (!readOnly) {
        // Emplacements libres en pointillés : montrent où déposer (écran
        // seulement) et acceptent le dépôt « à la suite » (dragdrop.js).
        EditorDragDrop.fillEmptySlots(grid, LayoutRender.pageCapacity(layout));
        sortables.push(
          EditorDragDrop.initPageGrid(grid, page.id, {
            onInsert: apiInsert,
            onMove: apiMove,
            // Relâché hors de la grille adoptante : aucun POST, re-rendu.
            onRefused: () => {
              showError(new Error(App.t('editor.dropOutside')));
              renderSpreads();
            },
          })
        );
      }
      const wrap = captionned(scaledBox(pageEl, scale), caption, page);
      wrap.dataset.key = `page:${page.id}`; // repère de défilement (scroll-anchor.js)
      const entry = sequence.get(page.id);
      if (entry && !entry.printed) wrap.classList.add('is-unprinted');
      return wrap;
    }

    // Boîtes des pages (clé + position) dans le repère du contenu défilant (px).
    function pageBoxes() {
      const origin = spreadsEl.getBoundingClientRect().top - spreadsEl.scrollTop;
      return Array.from(spreadsEl.querySelectorAll('.page-slot')).map((el) => {
        const r = el.getBoundingClientRect();
        return { key: el.dataset.key, top: r.top - origin, height: r.height };
      });
    }

    // Re-rendu complet depuis l'état, SANS déplacer la vue :
    //  - tout est construit hors document puis posé en une seule opération
    //    (replaceChildren) : la zone n'est jamais vide, donc ni saut ni
    //    clignotement (vider la zone ramenait scrollTop à 0 — c'était la
    //    cause du « retour en haut » après chaque dépôt) ;
    //  - cellules et pages fixes inchangées = mêmes nœuds DOM (images gardées) ;
    //  - la vue est recalée sur la MÊME PAGE (scroll-anchor.js) : au pixel
    //    près à échelle constante — même si des pages apparaissent ou
    //    disparaissent au-dessus (couverture, page blanche) —, à la même
    //    hauteur relative si l'échelle a changé.
    function renderSpreads() {
      const scale = currentScale();
      const scrollTop = spreadsEl.scrollTop;
      const anchor = EditorScrollAnchor.captureAnchor(scrollTop, pageBoxes());
      const sameScale = lastScale === null || lastScale === scale;

      for (const s of sortables) s.destroy();
      sortables = [];
      // Numéros du PDF (book-plan.js) : mêmes légendes que l'aperçu.
      sequence = new Map();
      for (const entry of TapigroBookPlan.pageSequence(book, layout)) {
        if (entry.page) sequence.set(entry.page.id, entry);
      }
      const captionFor = (page) => {
        const c = TapigroBookPlan.captionOf(sequence.get(page.id));
        return App.t(c.key, c.params);
      };
      // Bouton × des cellules à taille d'écran constante (≥ 24 px) malgré
      // la mise à l'échelle des pages (editor.css --inv-scale).
      spreadsEl.style.setProperty('--inv-scale', String(1 / scale));
      EditorDragDrop.clearRefusals();
      const nextCells = new Map();
      if (!book.fixedPages) fixedCache = new Map();
      const spreads = [];

      // Double page fixe de tête (cover + page 2) selon le layout.
      const fixedHead = [];
      const cover = buildFixedPage('cover', App.t('editor.cover'), scale);
      if (cover) fixedHead.push(cover);
      const page2 = buildFixedPage('page2', App.t('editor.page2'), scale);
      if (page2) fixedHead.push(page2);
      if (fixedHead.length) spreads.push(fixedHead);

      // Pages de contenu par paires.
      let pair = [];
      book.pages.forEach((page) => {
        pair.push(buildContentPage(page, captionFor(page), scale, nextCells));
        if (pair.length === 2) {
          spreads.push(pair);
          pair = [];
        }
      });
      if (pair.length) spreads.push(pair);

      // Dos.
      const back = buildFixedPage('back', App.t('editor.backCover'), scale);
      if (back) spreads.push([back]);

      const fragment = document.createDocumentFragment();
      for (const pages of spreads) {
        const spreadEl = document.createElement('div');
        spreadEl.className = 'spread';
        for (const p of pages) spreadEl.appendChild(p);
        fragment.appendChild(spreadEl);
      }
      spreadsEl.replaceChildren(fragment);
      cellCache = nextCells; // les cellules des items disparus sont oubliées
      lastScale = scale;
      const restored = EditorScrollAnchor.resolveAnchor(anchor, pageBoxes(), sameScale);
      spreadsEl.scrollTop = restored === null ? scrollTop : restored;
      applyMarks();
      updateBadges();
    }

    // ---- panneau produits ----------------------------------------------------------

    const panel = {
      q: '',
      category: '',
      group: '',
      offset: 0,
      limit: 50,
      total: 0,
    };
    const listEl = document.getElementById('prod-list');
    const moreBtn = document.getElementById('prod-more');
    const countEl = document.getElementById('prod-count');

    function productEntry(p) {
      const el = document.createElement('div');
      el.className = 'prod-entry';
      el.dataset.productId = String(p.id);
      const img = document.createElement('img');
      img.className = 'prod-thumb';
      img.alt = '';
      img.loading = 'lazy';
      img.draggable = false;
      if (p.hasPhoto) {
        img.src = App.url(`/img/${encodeURIComponent(p.code)}/thumb`);
        img.addEventListener('error', () => img.classList.add('is-missing'));
      } else {
        img.classList.add('is-missing');
      }
      el.appendChild(img);
      const txt = document.createElement('div');
      txt.className = 'prod-txt';
      const code = document.createElement('div');
      code.className = 'prod-code';
      code.textContent = p.code;
      const name = document.createElement('div');
      name.className = 'prod-name';
      name.textContent = p.name;
      txt.appendChild(code);
      txt.appendChild(name);
      // Déjà placé : « ×N in dit boek » (mis à jour à chaque rendu, updateBadges).
      const badge = document.createElement('span');
      badge.className = 'prod-badge';
      badge.hidden = true;
      txt.appendChild(badge);
      el.appendChild(txt);
      if (!readOnly) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'prod-add btn sec petit';
        add.textContent = App.t('editor.add');
        add.title = App.t('editor.addTitle', { code: p.code });
        add.setAttribute('aria-label', App.t('editor.addTitle', { code: p.code }));
        add.addEventListener('click', () => addToEnd(p));
        el.appendChild(add);
      }
      return el;
    }

    // Combien de fois chaque produit du panneau est déjà dans le boek.
    function updateBadges() {
      const counts = new Map();
      for (const page of book.pages) {
        for (const it of page.items) counts.set(it.product.id, (counts.get(it.product.id) || 0) + 1);
      }
      listEl.querySelectorAll('.prod-entry').forEach((el) => {
        const n = counts.get(Number(el.dataset.productId)) || 0;
        const badge = el.querySelector('.prod-badge');
        if (!badge) return;
        badge.hidden = n === 0;
        badge.textContent = n ? App.t('editor.inBook', { n }) : '';
        badge.title = n ? App.t('editor.inBookTitle', { n }) : '';
      });
    }

    async function loadProducts(reset) {
      if (panel.loading) return;
      panel.loading = true;
      if (reset) {
        panel.offset = 0;
        listEl.textContent = '';
      }
      const params = new URLSearchParams({
        q: panel.q,
        category: panel.category,
        group: panel.group,
        limit: String(panel.limit),
        offset: String(panel.offset),
      });
      try {
        const { items, total } = await App.api(`/api/products?${params}`);
        panel.total = total;
        for (const p of items) listEl.appendChild(productEntry(p));
        panel.offset += items.length;
        updateBadges();
        countEl.textContent = App.t('editor.productCount', { shown: panel.offset, total });
        moreBtn.hidden = panel.offset >= total;
      } catch (err) {
        showError(err);
      } finally {
        panel.loading = false;
      }
    }

    function initPanel(meta) {
      const catSel = document.getElementById('prod-category');
      for (const c of meta.categories) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        catSel.appendChild(opt);
      }
      const grpSel = document.getElementById('prod-group');
      for (const g of meta.groups) {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g;
        grpSel.appendChild(opt);
      }
      let timer = null;
      document.getElementById('prod-search').addEventListener('input', (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          panel.q = e.target.value.trim();
          loadProducts(true);
        }, 300);
      });
      catSel.addEventListener('change', () => {
        panel.category = catSel.value;
        loadProducts(true);
      });
      grpSel.addEventListener('change', () => {
        panel.group = grpSel.value;
        loadProducts(true);
      });
      moreBtn.addEventListener('click', () => loadProducts(false));
      // Chargement automatique de la suite en fin de liste (catalogue ~1000).
      listEl.addEventListener('scroll', () => {
        if (moreBtn.hidden || panel.loading) return;
        if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 200) {
          loadProducts(false);
        }
      });
      if (!readOnly) EditorDragDrop.initProductPanel(listEl);
    }

    // ---- réglage du boek : pages fixes ------------------------------------------------

    // Ajouter / retirer la couverture, la page 2 et le dos après coup. Les
    // textes saisis restent enregistrés : ils reviennent si on les remet.
    function initFixedPagesSetting() {
      const available = Object.keys(layout.fixedPages || {}).length > 0;
      fixedToggleWrap.hidden = !available;
      fixedToggle.checked = Boolean(book.fixedPages);
      fixedToggle.addEventListener('change', async () => {
        const wanted = fixedToggle.checked;
        if (!wanted) {
          const ok = await App.confirm({
            titre: App.t('editor.removeFixedTitle'),
            texte: App.t('editor.removeFixedText'),
            oui: App.t('editor.removeFixedYes'),
          });
          if (!ok) {
            fixedToggle.checked = true;
            return;
          }
        }
        try {
          await saver.flush(); // les textes en attente partent AVANT la bascule
          const { book: updated } = await saver.track(
            App.api(`/api/books/${bookId}`, { method: 'PATCH', body: { fixedPages: wanted } })
          );
          book.fixedPages = updated.fixedPages;
          book.texts = updated.texts;
          renderSpreads();
          App.flash(
            'ok',
            App.t(wanted ? 'editor.fixedAdded' : 'editor.fixedRemoved')
          );
        } catch (err) {
          fixedToggle.checked = Boolean(book.fixedPages);
          showError(err);
        }
      });
    }

    // ---- initialisation --------------------------------------------------------------

    async function init() {
      const [me, layoutsRes, bookRes, meta] = await Promise.all([
        App.fetchMe(),
        App.api('/api/layouts'),
        App.api(`/api/books/${bookId}`),
        App.api('/api/products/meta'),
      ]);
      book = bookRes;
      readOnly = !me || me.user.role === 'viewer';
      layout = layoutsRes.layouts.find((l) => l.id === book.layoutId);
      if (!layout) throw new Error(App.t('editor.unknownLayout', { id: book.layoutId }));

      nameEl.value = book.name;
      if (readOnly) {
        nameEl.disabled = true;
        saveBtn.hidden = true;
        rootEl.classList.add('read-only');
      } else {
        saver.setDocSave(() =>
          App.api(`/api/books/${bookId}`, {
            method: 'PATCH',
            // Un nom vide (champ en cours de saisie) n'est jamais envoyé : le
            // serveur garde l'ancien nom, seuls les textes partent.
            body: { name: book.name.trim() || undefined, texts: book.texts },
          })
        );
        // Dernier nom NON VIDE : référence de la règle « le titre suit le nom »
        // (un champ effacé puis retapé ne casse pas le lien, title-follow.js).
        let linkedName = book.name.trim();
        nameEl.addEventListener('input', () => {
          // Le titre de couverture suit le nom tant qu'il lui est identique
          // (jamais personnalisé) — même règle que le serveur (docs/API.md).
          // (jamais avec un nom vide, comparaison trimmée : title-follow.js).
          const followed = EditorTitleFollow.followTitle(linkedName, nameEl.value, book.texts.cover_title);
          if (followed !== null) {
            book.texts.cover_title = followed;
            const slotEl = spreadsEl.querySelector('.lr-slot[data-slot="cover_title"]');
            if (slotEl) slotEl.textContent = followed;
          }
          if (nameEl.value.trim() !== '') linkedName = nameEl.value.trim();
          book.name = nameEl.value;
          saver.scheduleDoc();
        });
        initFixedPagesSetting();
        saveBtn.addEventListener('click', () => {
          saver.scheduleDoc();
          saver.flush().catch(showError);
        });
      }

      renderSpreads();
      await ensureTrailingSpread();
      initPanel(meta);
      initDrawer();
      await loadProducts(true);
      // Recalcul de l'échelle APRÈS le chargement initial des produits : le
      // panneau (ou une barre de défilement) a pu modifier la largeur utile.
      renderSpreads();
      if (!readOnly) initHelp();
      scrollToFirstProductPage();

      let resizeTimer = null;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(renderSpreads, 150);
      });
      // Toute variation de largeur du conteneur des pages (panneau, scrollbar,
      // fenêtre) recale l'échelle — garde anti-boucle sur la largeur.
      if (typeof ResizeObserver !== 'undefined') {
        let lastWidth = spreadsEl.clientWidth;
        const ro = new ResizeObserver(() => {
          if (spreadsEl.clientWidth !== lastWidth) {
            lastWidth = spreadsEl.clientWidth;
            renderSpreads();
          }
        });
        ro.observe(spreadsEl);
      }
    }

    // À l'ouverture, la vue se place sur la 1re page de produits (sinon un
    // nouveau boek ne montre que la couverture et la page 2 : les cases à
    // remplir sont hors de l'écran).
    function scrollToFirstProductPage() {
      const first = book.pages.find((p) => p.kind === 'products');
      const slot = first && spreadsEl.querySelector(`.page-slot[data-key="page:${first.id}"]`);
      if (!slot) return;
      const spread = slot.closest('.spread') || slot;
      const top = spread.getBoundingClientRect().top - spreadsEl.getBoundingClientRect().top + spreadsEl.scrollTop;
      spreadsEl.scrollTop = Math.max(0, top - 12);
    }

    // Petit bandeau d'aide, refermable ; on s'en souvient (navigateur).
    function initHelp() {
      const help = document.getElementById('editor-help');
      let closed = false;
      try {
        closed = localStorage.getItem(HELP_KEY) === '1';
      } catch {
        /* stockage indisponible : le bandeau s'affiche */
      }
      help.hidden = closed;
      document.getElementById('editor-help-close').addEventListener('click', () => {
        help.hidden = true;
        try {
          localStorage.setItem(HELP_KEY, '1');
        } catch {
          /* stockage indisponible : fermé pour cette page seulement */
        }
      });
    }

    // Écran étroit : le panneau produits est un tiroir (bouton « Producten »).
    function initDrawer() {
      const setOpen = (open) => {
        panelEl.classList.toggle('is-open', open);
        panelToggle.setAttribute('aria-expanded', String(open));
        if (open) document.getElementById('prod-search').focus({ preventScroll: true });
      };
      panelToggle.hidden = readOnly;
      panelToggle.addEventListener('click', () => setOpen(!panelEl.classList.contains('is-open')));
      document.getElementById('panel-close').addEventListener('click', () => {
        setOpen(false);
        panelToggle.focus();
      });
      panelEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panelEl.classList.contains('is-open')) {
          setOpen(false);
          panelToggle.focus();
        }
      });
    }

    init().catch(showError);
  });
})();
