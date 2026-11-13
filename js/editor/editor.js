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
 * Enregistrement et concurrence (audit 13/11, B1 / I5) : toutes les requêtes
 * de l'éditeur passent par UNE file (une à la fois) et par EditorAutosave
 * (jamais de faux « Opgeslagen », nouveaux essais, brouillon local, session
 * expirée sans redirection). Le boek a une version : le PATCH du nom/des
 * textes l'envoie (409 BOOK_CONFLICT si le boek a changé ailleurs) ; chaque
 * réponse de mutation dit sur quelle version elle s'est appliquée — si ce
 * n'est pas celle que l'éditeur connaît, quelqu'un d'autre a modifié le boek
 * et la vue est rechargée. Un conflit sur un champ que l'utilisateur est en
 * train de modifier affiche un bandeau [Herladen] ; sa saisie est mise de
 * côté et peut être réappliquée.
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
    const statusEl = document.getElementById('save-status');
    const bannerEl = document.getElementById('editor-banner');

    // Version du boek connue de l'éditeur et dernières valeurs du nom et des
    // textes confirmées par le serveur (base des champs modifiés).
    let knownVersion = null;
    let serverDoc = { name: '', texts: {} };
    let stash = null; // saisie mise de côté après un conflit : [[champ, {value, base}]]
    let stashReason = 'conflict'; // 'conflict' | 'draft' (brouillon d'une visite précédente)
    let linkedName = ''; // dernier nom non vide (title-follow.js)
    let bannerKey = null; // contenu affiché du bandeau (showBanner)

    const AS = EditorAutosave;
    // window.fetch relu à chaque appel : la démo statique le remplace.
    const api = AS.createApi({ fetchImpl: (input, init) => window.fetch(input, init) });
    const queue = AS.createQueue();
    // Brouillons propres à l'UTILISATEUR connecté (revue 1.1.0) : celui d'un
    // autre compte sur le même poste n'est jamais relu ; effacés à la
    // déconnexion (common.js clearEditorStorage). Clé connue après /api/me.
    let userId = null;
    const userKey = (kind) => () => (userId ? `tapigro-editor-${kind}-${userId}-${bookId}` : null);
    const draftStore = AS.createDraftStore(userKey('draft'));
    const stashStore = AS.createDraftStore(userKey('stash'));
    const saver = AS.createSaver({
      send: sendDoc,
      onSaved: (result) => {
        if (reconcile(result.book).changed) renderSpreads();
      },
      onConflict: handleDocConflict,
      resync: () => resync(),
      onChange: (info) => renderUi(info),
      draft: draftStore,
    });

    // Session expirée pendant un appel App.api (panneau produits, chargement…) :
    // si une saisie n'est pas enregistrée, PAS de redirection brutale vers
    // /login — l'autosave le signale (« Sessie verlopen », reconnexion dans un
    // nouvel onglet, « Opnieuw proberen ») et la saisie reste à l'écran.
    // Sinon (rien en mémoire ni mis de côté) : /login?next=<cet éditeur>, et
    // common.js efface les brouillons de l'éditeur (poste partagé).
    App.onSessionExpired((err) => {
      if (!saver.hasUnsaved() && !stash) return false;
      saver.structureFailed(err);
      return true;
    });

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

    let errorTimer = null;
    function showError(err) {
      if (err && err.handled) return; // session expirée : le bandeau de l'autosave le dit
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => {
        errorEl.hidden = true;
      }, 6000);
    }

    // ---- nom et textes : champs, version, conflits ----------------------------------
    // Champs suivis par l'autosave : 'name' et 'text:<slot>'. Valeur d'un
    // slot non enregistré : null (le layout affiche alors son texte par défaut).

    const TEXT = 'text:';
    const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

    function fieldValue(doc, field) {
      if (field === 'name') return doc.name;
      const slot = field.slice(TEXT.length);
      return hasOwn(doc.texts, slot) ? doc.texts[slot] : null;
    }

    function setField(doc, field, value) {
      if (field === 'name') doc.name = value;
      else if (value === null) delete doc.texts[field.slice(TEXT.length)];
      else doc.texts[field.slice(TEXT.length)] = value;
    }

    function sameTexts(a, b) {
      const ka = Object.keys(a);
      return ka.length === Object.keys(b).length && ka.every((k) => hasOwn(b, k) && a[k] === b[k]);
    }

    // Slots de texte du layout (un brouillon ne réapplique que ceux-là).
    function layoutSlots() {
      const slots = new Set();
      for (const page of Object.values(layout.fixedPages || {})) {
        for (const el of page.elements || []) if (el.type === 'textSlot') slots.add(el.slot);
      }
      return slots;
    }

    function knownField(field) {
      return field === 'name' || (typeof field === 'string' && field.startsWith(TEXT) && layoutSlots().has(field.slice(TEXT.length)));
    }

    // L'utilisateur a modifié un champ : à enregistrer (base = valeur serveur).
    function markField(field, value) {
      saver.set(field, value, fieldValue(serverDoc, field));
    }

    // Avance la version connue DANS la tâche de la file, avant que la tâche
    // suivante (un PATCH du nom en attente derrière un dépôt…) ne lise
    // knownVersion — sinon elle partirait avec l'ancienne version : 409 à
    // soi-même (revue 1.1.0). Seulement si la requête s'est appliquée sur la
    // version connue : sinon quelqu'un d'autre a modifié le boek, la
    // resynchronisation s'en charge et une requête déjà en file part avec
    // l'ancienne version (409 traité, jamais d'écrasement).
    function advanceVersion(res) {
      if (!res || typeof res.baseVersion !== 'number' || res.baseVersion !== knownVersion) return;
      const v = res.book && typeof res.book.version === 'number' ? res.book.version : res.version;
      if (typeof v === 'number') knownVersion = v;
    }

    // PATCH partiel : seulement les champs modifiés, avec la version connue
    // (lue au moment de l'envoi, dans la file).
    function sendDoc(fields) {
      return queue.run(async () => {
        const body = { version: knownVersion };
        for (const [field, value] of Object.entries(fields)) {
          if (field === 'name') body.name = value;
          else (body.texts || (body.texts = {}))[field.slice(TEXT.length)] = value;
        }
        const res = await api.call(`/api/books/${bookId}`, { method: 'PATCH', body });
        advanceVersion(res);
        return res;
      });
    }

    // Recale l'éditeur sur un état complet du serveur (GET, réponse d'un
    // PATCH, 409) SANS perdre la saisie en attente : vue = serveur + champs
    // en attente. → {conflicts: champs modifiés ici ET ailleurs, changed: la
    // vue a changé (re-rendu nécessaire)}.
    function reconcile(srv) {
      knownVersion = srv.version;
      serverDoc = { name: srv.name, texts: { ...srv.texts } };
      const conflicts = [];
      for (const [field, c] of saver.entries()) {
        const sv = fieldValue(serverDoc, field);
        if (sv === c.value) saver.discard(field); // déjà enregistré (même valeur)
        else if (sv !== c.base) conflicts.push(field); // modifié ailleurs aussi
      }
      const view = { name: srv.name, texts: { ...srv.texts } };
      for (const [field, c] of saver.entries()) setField(view, field, c.value);
      let changed = false;
      if (!sameTexts(view.texts, book.texts)) {
        book.texts = view.texts; // nouvel objet : pages fixes re-rendues
        changed = true;
      }
      if (!saver.has('name') && srv.name !== book.name.trim()) {
        book.name = srv.name;
        nameEl.value = srv.name;
        linkedName = srv.name;
      }
      if (srv.fixedPages !== book.fixedPages) {
        book.fixedPages = srv.fixedPages;
        fixedToggle.checked = Boolean(srv.fixedPages);
        changed = true;
      }
      if (Array.isArray(srv.pages) && JSON.stringify(srv.pages) !== JSON.stringify(book.pages)) {
        book.pages = srv.pages;
        changed = true;
      }
      return { conflicts, changed };
    }

    // Recharge l'état du serveur (dans la file). Un conflit sur un champ en
    // cours de saisie met l'autosave en pause (bandeau).
    async function resync() {
      const srv = await queue.run(() => api.call(`/api/books/${bookId}`));
      const { conflicts, changed } = reconcile(srv);
      if (changed) renderSpreads();
      if (conflicts.length) saver.markConflict();
      return { conflicts, changed };
    }

    // 409 sur le PATCH du nom / des textes. Si les champs envoyés n'ont pas
    // été touchés ailleurs (autre champ, ou structure), on se recale et on
    // renvoie sans rien demander ; sinon : bandeau, saisie gardée.
    function handleDocConflict(err) {
      if (!err.book) {
        resync()
          .then(({ conflicts }) => {
            if (!conflicts.length) saver.resume();
          })
          .catch(() => {}); // boek supprimé… : le bandeau reste
        return;
      }
      const { conflicts, changed } = reconcile(err.book);
      if (changed) renderSpreads();
      if (!conflicts.length) {
        announce(App.t('editor.changedElsewhere'));
        saver.resume();
      }
    }

    // Mutation de structure : dans la file, comptée par l'indicateur. La
    // réponse fait avancer la version connue ; si elle s'est appliquée sur
    // une autre version que celle de l'éditeur, quelqu'un a modifié le boek
    // entre-temps → la vue est rechargée.
    async function mutate(path, options) {
      let foreign = false;
      const res = await saver.track(
        queue.run(async () => {
          const r = await api.call(path, options);
          foreign = Boolean(r && typeof r.baseVersion === 'number' && r.baseVersion !== knownVersion);
          advanceVersion(r); // avant la tâche suivante de la file
          return r;
        })
      );
      if (res && res.book && typeof res.book.version === 'number') {
        // Réponse = boek complet (PATCH) : la vue s'y recale directement.
        const { conflicts } = reconcile(res.book);
        if (conflicts.length) saver.markConflict();
        return res;
      }
      if (foreign) {
        // Version connue NON avancée : la resynchronisation la recale.
        // Après la mise à jour locale faite par l'appelant (le GET passe
        // après, dans la file).
        Promise.resolve()
          .then(() => resync())
          .then(({ changed }) => {
            if (changed) announce(App.t('editor.changedElsewhere'));
          })
          .catch((e) => saver.structureFailed(e));
      }
      return res;
    }

    // Échec d'une mutation de structure : on le dit, puis on recharge l'état
    // du serveur (la vue ne doit jamais montrer un état qui n'existe pas).
    // Si même le rechargement échoue (réseau, session), l'alerte reste et le
    // rechargement est réessayé automatiquement.
    async function structureFailed(err) {
      const kind = AS.classifyError(err);
      const message =
        kind === 'offline' ? App.t('editor.offline') : kind === 'session' ? App.t('editor.sessionExpired') : err.message;
      showError(new Error(App.t('editor.structureFailed', { message })));
      try {
        if (kind === 'conflict' && err.book) {
          const { conflicts } = reconcile(err.book);
          if (conflicts.length) saver.markConflict();
        } else {
          await resync();
        }
        saver.structureOk();
        announce(App.t('editor.resynced'));
      } catch (e) {
        saver.structureFailed(e);
      }
      renderSpreads();
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
        // Le dépôt est enregistré ; si le rechargement échoue, l'indicateur
        // le signale et le rechargement est réessayé.
        try {
          await resync();
        } catch (err) {
          saver.structureFailed(err);
        }
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
          await mutate(`/api/books/${bookId}/items`, {
            method: 'POST',
            body: { pageId, productId, beforeItemId },
          })
        );
      } catch (err) {
        await structureFailed(err);
      }
      renderSpreads();
      await ensureTrailingSpread();
      return item;
    }

    async function apiMove({ itemId, pageId, beforeItemId }) {
      try {
        await applyPlaced(
          await mutate(`/api/books/${bookId}/items/${itemId}`, {
            method: 'PATCH',
            body: { pageId, beforeItemId },
          })
        );
      } catch (err) {
        await structureFailed(err);
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
        await mutate(`/api/books/${bookId}/items/${itemId}`, { method: 'DELETE' });
        removeItemFromState(itemId);
      } catch (err) {
        // Déjà retiré ailleurs (404), réseau… : la vue est rechargée.
        await structureFailed(err);
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
      await resync();
      renderSpreads();
    }

    async function apiAddBlankPage(afterPageNo) {
      try {
        await mutate(`/api/books/${bookId}/pages`, {
          method: 'POST',
          body: { afterPageNo, kind: 'blank' },
        });
        await refetchBook();
        await ensureTrailingSpread();
      } catch (err) {
        await structureFailed(err);
      }
    }

    async function apiDeletePage(pageId) {
      try {
        // L'API refuse (409) une page non vide : l'erreur est affichée telle quelle.
        await mutate(`/api/books/${bookId}/pages/${pageId}`, { method: 'DELETE' });
        await refetchBook();
        await ensureTrailingSpread();
      } catch (err) {
        await structureFailed(err);
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
          const { page } = await mutate(`/api/books/${bookId}/pages`, { method: 'POST', body: {} });
          book.pages.push(page);
          added = true;
        } catch (err) {
          // Page ajoutée d'office : pas de message « wijziging niet
          // opgeslagen », mais l'indicateur le signale si le serveur est
          // injoignable (et la resynchro est réessayée).
          // Boek au plafond de pages (400 QUOTA) : pas de double page vide
          // de plus, sans message — le plafond est dit quand on ajoute
          // vraiment quelque chose.
          // (La page n'a pas été ajoutée : la vue reste juste, rien à
          // resynchroniser — structureSettled() termine l'échec suivi par track.)
          const kind = AS.classifyError(err);
          if (err.code !== 'QUOTA' && (kind === 'offline' || kind === 'session' || kind === 'retry')) {
            saver.structureFailed(err);
          } else {
            saver.structureSettled();
            if (err.code !== 'QUOTA') showError(err);
          }
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
            markField(TEXT + slotEl.dataset.slot, text);
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
          // Réponse = boek complet : mutate() y recale la vue (version, textes).
          await mutate(`/api/books/${bookId}`, { method: 'PATCH', body: { fixedPages: wanted } });
          renderSpreads();
          App.flash(
            'ok',
            App.t(wanted ? 'editor.fixedAdded' : 'editor.fixedRemoved')
          );
        } catch (err) {
          fixedToggle.checked = Boolean(book.fixedPages);
          await structureFailed(err);
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
      userId = me && me.user ? me.user.id : null;
      // Anciennes clés sans utilisateur (≤ 1.1.0) : on ne sait pas à qui
      // elles sont → jamais réappliquées, supprimées.
      AS.createDraftStore(`tapigro-editor-draft-${bookId}`).clear();
      AS.createDraftStore(`tapigro-editor-stash-${bookId}`).clear();
      knownVersion = book.version;
      serverDoc = { name: book.name, texts: { ...book.texts } };
      readOnly = !me || me.user.role === 'viewer';
      layout = layoutsRes.layouts.find((l) => l.id === book.layoutId);
      if (!layout) throw new Error(App.t('editor.unknownLayout', { id: book.layoutId }));

      nameEl.value = book.name;
      if (readOnly) {
        nameEl.disabled = true;
        saveBtn.hidden = true;
        rootEl.classList.add('read-only');
      } else {
        // Dernier nom NON VIDE : référence de la règle « le titre suit le nom »
        // (un champ effacé puis retapé ne casse pas le lien, title-follow.js).
        linkedName = book.name.trim();
        nameEl.addEventListener('input', () => {
          // Le titre de couverture suit le nom tant qu'il lui est identique
          // (jamais personnalisé) — même règle que le serveur (docs/API.md).
          // (jamais avec un nom vide, comparaison trimmée : title-follow.js).
          const followed = EditorTitleFollow.followTitle(linkedName, nameEl.value, book.texts.cover_title);
          if (followed !== null) {
            book.texts.cover_title = followed;
            const slotEl = spreadsEl.querySelector('.lr-slot[data-slot="cover_title"]');
            if (slotEl) slotEl.textContent = followed;
            markField(`${TEXT}cover_title`, followed);
          }
          if (nameEl.value.trim() !== '') linkedName = nameEl.value.trim();
          book.name = nameEl.value;
          // Un nom vide (champ en cours de saisie) n'est jamais envoyé : le
          // serveur garde l'ancien nom.
          if (nameEl.value.trim() !== '') markField('name', nameEl.value.trim());
          else saver.discard('name');
        });
        initFixedPagesSetting();
        // « Opslaan » : envoi immédiat (ou nouvel essai après un échec).
        saveBtn.addEventListener('click', () => saver.retryNow());
        restoreDraft();
        initLeaveGuards();
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

    // ---- indicateur, bandeau, brouillon -------------------------------------------------

    // Bandeau d'alerte (sous la barre d'outils, en surimpression : la vue ne
    // bouge pas). Reconstruit seulement quand son contenu change.
    function showBanner(kind, text, actions) {
      const key = `${kind}|${text}|${actions.map((a) => a.label).join('|')}`;
      if (key === bannerKey) return;
      bannerKey = key;
      bannerEl.className = `editor-banner is-${kind}`;
      const p = document.createElement('p');
      p.className = 'editor-banner-text';
      p.textContent = text;
      const row = document.createElement('div');
      row.className = 'editor-banner-actions';
      for (const a of actions) {
        let el;
        if (a.href) {
          // Nouvel onglet : l'éditeur (et la saisie) reste ouvert ici.
          el = document.createElement('a');
          el.href = a.href;
          el.target = '_blank';
          el.rel = 'noopener';
          el.className = 'btn sec petit';
        } else {
          el = document.createElement('button');
          el.type = 'button';
          el.className = a.primary ? 'btn petit' : 'btn sec petit';
          el.addEventListener('click', a.onClick);
        }
        el.textContent = a.label;
        el.dataset.action = a.id;
        row.appendChild(el);
      }
      bannerEl.replaceChildren(p, row);
      bannerEl.hidden = false;
    }

    function hideBanner() {
      if (bannerKey === null) return;
      bannerKey = null;
      bannerEl.hidden = true;
      bannerEl.replaceChildren();
    }

    // Indicateur + bandeau, d'après l'état de l'autosave (jamais
    // « Opgeslagen » tant que quelque chose n'est pas confirmé).
    function renderUi(info = saver.info()) {
      AS.renderStatus(statusEl, info);
      if (!bannerEl) return;
      const retry = { id: 'retry', label: App.t('editor.retry'), primary: true, onClick: () => saver.retryNow() };
      if (info.state === 'conflict') {
        showBanner('conflict', `${App.t('editor.conflict')} ${App.t('editor.conflictKeep')}`, [
          { id: 'reload', label: App.t('editor.reload'), primary: true, onClick: reloadKeepingInput },
        ]);
      } else if (stash) {
        const prefix = stashReason === 'draft' ? `${App.t('editor.draftConflict')} ` : '';
        showBanner('stash', `${prefix}${App.t('editor.stashed')}`, [
          { id: 'reapply', label: App.t('editor.reapply'), primary: true, onClick: reapplyStash },
          { id: 'discard', label: App.t('editor.discard'), onClick: discardStash },
        ]);
      } else if (info.state === 'session') {
        const stopped = info.gaveUp ? ` ${App.t('editor.autoRetryStopped')}` : '';
        showBanner('error', `${App.t('editor.sessionExpired')} ${App.t('editor.sessionKeep')}${stopped}`, [
          { id: 'login', label: App.t('editor.loginAgain'), href: App.url('/login') },
          retry,
        ]);
      } else if (info.state === 'offline' || info.state === 'retry' || info.state === 'rejected') {
        let reason = App.t('editor.offline');
        if (info.state === 'rejected') reason = App.t('editor.saveRejected', { message: info.error ? info.error.message : '' });
        else if (info.state === 'retry' && info.error) reason = info.error.message;
        let more = '';
        if (info.autoRetry) more = ` ${App.t('editor.autoRetry')}`;
        else if (info.gaveUp) more = ` ${App.t('editor.autoRetryStopped')}`; // bouton seulement (10 min)
        showBanner('error', `${reason}${more}`, [retry]);
      } else {
        hideBanner();
      }
    }

    function setStash(entries, reason) {
      stash = entries && entries.length ? entries : null;
      stashReason = reason || 'conflict';
      if (stash) stashStore.save(stash);
      else stashStore.clear();
      renderUi();
    }

    // [Herladen] : la saisie en attente est mise de côté (et gardée dans le
    // navigateur), l'éditeur affiche la dernière version du serveur ; le
    // bandeau propose ensuite de réappliquer cette saisie.
    async function reloadKeepingInput() {
      const kept = saver.entries();
      saver.discardAll();
      setStash(kept, 'conflict');
      try {
        await resync();
      } catch (err) {
        saver.structureFailed(err);
      }
      fixedCache = new Map();
      renderSpreads();
    }

    // Applique une valeur à la vue (nom, texte de page fixe) et la marque à
    // enregistrer (base = valeur actuelle du serveur).
    function applyLocal(field, value) {
      if (field === 'name') {
        book.name = value;
        nameEl.value = value;
        if (value.trim()) linkedName = value.trim();
      } else {
        book.texts = { ...book.texts }; // nouvel objet : page fixe re-rendue
        setField(book, field, value);
      }
      markField(field, value);
    }

    function reapplyStash() {
      const kept = stash || [];
      setStash(null);
      for (const [field, c] of kept) {
        if (!knownField(field) || !c || fieldValue(serverDoc, field) === c.value) continue;
        applyLocal(field, c.value);
      }
      renderSpreads();
      saver.flush();
    }

    function discardStash() {
      setStash(null);
    }

    // Brouillon d'une visite précédente (onglet fermé, session expirée…) :
    // réappliqué d'office si le serveur n'a pas changé ces champs depuis ;
    // sinon mis de côté, avec le bandeau « Opnieuw toepassen / Weggooien ».
    function restoreDraft() {
      const valid = (e) => Array.isArray(e) && e[1] && typeof e[1] === 'object' && knownField(e[0]);
      const draft = (draftStore.load() || []).filter(valid);
      const keptBefore = (stashStore.load() || []).filter(valid);
      draftStore.clear();
      let restored = 0;
      const conflicting = [];
      for (const [field, c] of draft) {
        const sv = fieldValue(serverDoc, field);
        if (sv === c.value) continue;
        if (sv === c.base) {
          applyLocal(field, c.value);
          restored += 1;
        } else {
          conflicting.push([field, c]);
        }
      }
      const stashed = [...keptBefore, ...conflicting];
      if (stashed.length) setStash(stashed, 'draft');
      if (restored) App.flash('info', App.t('editor.draftRestored'));
      renderUi();
    }

    // Avertissement avant de quitter la page tant que quelque chose n'est pas
    // enregistré ; nouvel essai dès le retour du réseau ; envoi immédiat quand
    // l'onglet passe en arrière-plan.
    function initLeaveGuards() {
      window.addEventListener('beforeunload', (e) => {
        if (!saver.hasUnsaved()) return;
        e.preventDefault();
        e.returnValue = '';
      });
      window.addEventListener('online', () => saver.retryNow());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saver.flush();
      });
    }

    init().catch(showError);
  });
})();
