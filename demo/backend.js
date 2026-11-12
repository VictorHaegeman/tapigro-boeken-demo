/* backend.js — l'API de Tapigro Boeken, simulée dans le navigateur (version
 * démo statique, GitHub Pages). Elle répond aux MÊMES routes, avec les mêmes
 * formes de réponse et les mêmes erreurs que le serveur Express :
 *   /api/me, /api/layouts, /api/products*, /api/books* (pages, items, textes,
 *   pages fixes), /api/imports — l'état vit dans localStorage.
 *
 * Fidélité au serveur : le code PUR du serveur est réutilisé tel quel (même
 * validateur `validate`, mêmes règles produit `productRules`, mêmes fonctions
 * de layouts) ; seule la logique qui, côté serveur, est écrite en SQL
 * (server/services/bookService.js, server/routes/products.js) est transcrite
 * ici sur un état en mémoire. tests/e/demo-backend.test.js rejoue les mêmes
 * scénarios sur le vrai bookService et sur ce module et compare les réponses.
 *
 * Module UMD : navigateur (window.TapigroDemoBackend, dépendances fournies
 * par demo/shared.js, généré au build) ou Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const i18n = require('../server/i18n');
    module.exports = factory({
      validate: require('../server/middleware/validate').validate,
      HttpError: require('../server/middleware/errors').HttpError,
      translateError: require('../server/middleware/errors').translateError,
      rules: require('../server/services/productRules'),
      layoutsLib: require('../server/services/layouts'),
      bookPlan: require('../public/js/book-plan'),
      translator: (lang) => i18n.translator(lang),
      hasKey: i18n.has,
    });
  } else {
    // Navigateur : dictionnaire de la page (GET /i18n/<langue>.js → i18n/<langue>.js).
    const s = root.TapigroShared;
    const I18N = root.TapigroI18n || { messages: {}, fallback: null };
    const core = s.i18n;
    const fallback = I18N.fallback || I18N.messages;
    root.TapigroDemoBackend = factory({
      validate: s.validate.validate,
      HttpError: s.errors.HttpError,
      translateError: s.errors.translateError,
      rules: s.productRules,
      layoutsLib: s.layouts,
      bookPlan: s.bookPlan,
      translator: () => core.createTranslator(I18N.messages, fallback),
      hasKey: (key) => core.lookup(fallback, key) !== undefined,
    });
  }
})(typeof self !== 'undefined' ? self : this, function (deps) {
  'use strict';
  const { validate, HttpError, translateError, rules, layoutsLib, bookPlan, translator, hasKey } = deps;

  const STATE_VERSION = 1;
  const STEP = 1024; // bookService.js : pas initial entre deux positions
  const TEXT_MAX = 4000;
  const MAX_PAGES_PER_BOOK = 500;
  const MAX_BOOKS = 200;
  const TITLE_SLOT = 'cover_title';
  const DEMO_USER = { id: 1, username: 'Demo', role: 'admin', lang: null };

  // Horodatage au format SQLite datetime('now') : 'YYYY-MM-DD HH:MM:SS' (UTC).
  function sqliteNow(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }

  const clone = (v) => JSON.parse(JSON.stringify(v));

  // ---- état ---------------------------------------------------------------------

  // catalog (data/catalog.js, généré au build depuis la vraie BDD) :
  // {products: [{id, code, name, category, group, unit, minimumStock, isActive,
  //   source, modifiedManuallyAt, createdAt, updatedAt, photoFile, barcodeFile}],
  //  layouts: [...], imports: [...]}
  function initialState(catalog) {
    return {
      version: STATE_VERSION,
      catalogId: catalog.id,
      products: clone(catalog.products),
      books: [],
      pages: [],
      items: [],
    };
  }

  /**
   * @param {object} opts
   * @param {object} opts.catalog données du build (data/catalog.js)
   * @param {{load(): object|null, save(state): void, clear(): void}} [opts.storage]
   * @param {() => Date} [opts.clock] horloge (tests)
   * @param {boolean} [opts.seed=true] boek d'exemple au premier chargement
   * @param {string} [opts.lang='nl'] langue des messages d'erreur (comme le serveur)
   * @param {(lang: string) => void} [opts.onLang] PATCH /api/me {lang} : la page
   *   mémorise le choix et s'affiche dans la nouvelle langue
   */
  function createBackend({ catalog, storage = null, clock = () => new Date(), seed = true, lang = 'nl', onLang = null }) {
    const t = translator(lang);
    const layouts = catalog.layouts;
    const layoutById = Object.fromEntries(layouts.map((l) => [l.id, l]));
    const now = () => sqliteNow(clock());

    let state = null; // chargé en fin de fonction (une fois tout défini)

    // Nouvel identifiant, comme SQLite (INTEGER PRIMARY KEY sans
    // AUTOINCREMENT) : le plus grand id présent + 1 — l'id d'une ligne
    // supprimée en dernier est donc réutilisé, exactement comme sur le serveur.
    const nextId = (rows) => rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;

    function persist() {
      if (storage) storage.save(state);
    }

    function reset() {
      state = initialState(catalog);
      if (seed) seedExampleBook();
      if (storage) storage.clear();
      persist();
    }

    // ---- produits (server/routes/products.js) -------------------------------------

    const productById = (id) => state.products.find((p) => p.id === id);

    function productShape(p) {
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        category: p.category,
        group: p.group,
        unit: p.unit,
        minimumStock: p.minimumStock,
        isActive: p.isActive,
        hasPhoto: Boolean(p.photoFile),
        hasBarcode: Boolean(p.barcodeFile),
      };
    }

    function productDetail(p) {
      return {
        ...productShape(p),
        source: p.source,
        modifiedManuallyAt: p.modifiedManuallyAt,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    }

    // ORDER BY product_code : collation BINARY = ordre des unités de code.
    const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
    // ORDER BY updated_at DESC, id DESC
    const byUpdatedDesc = (a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.id - a.id;

    function listProducts(q) {
      const { category, group, active, photo, barcode, sort, limit, offset } = q;
      const needle = q.q.toLowerCase(); // LIKE SQLite : insensible à la casse
      let rows = state.products.filter((p) => {
        if (needle && !p.code.toLowerCase().includes(needle) && !p.name.toLowerCase().includes(needle)) {
          return false;
        }
        if (category && p.category !== category) return false;
        if (group && p.group !== group) return false;
        if (active !== 'all' && p.isActive !== (active === '1')) return false;
        if (photo !== 'all' && Boolean(p.photoFile) !== (photo === '1')) return false;
        if (barcode !== 'all' && Boolean(p.barcodeFile) !== (barcode === '1')) return false;
        return true;
      });
      rows = rows.slice().sort(sort === 'updated' ? byUpdatedDesc : byCode);
      return {
        items: rows
          .slice(offset, offset + limit)
          .map((p) => ({ ...productShape(p), updatedAt: p.updatedAt })),
        total: rows.length,
      };
    }

    function productsMeta() {
      const distinct = (key) =>
        [...new Set(state.products.map((p) => p[key]).filter((v) => v !== ''))].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0
        );
      return { categories: distinct('category'), groups: distinct('group') };
    }

    function productStats() {
      const active = state.products.filter((p) => p.isActive);
      return {
        total: state.products.length,
        active: active.length,
        inactive: state.products.length - active.length,
        withoutPhoto: active.filter((p) => !p.photoFile).length,
        withoutBarcode: active.filter((p) => !p.barcodeFile).length,
        manual: state.products.filter((p) => p.source === 'manual').length,
      };
    }

    function getProduct(id) {
      const p = productById(id);
      if (!p) throw new HttpError(404, 'NOT_FOUND', 'Product not found', 'apiErrors.productNotFound');
      return p;
    }

    function createProduct(v) {
      if (rules.isReservedCode(v.code)) {
        throw new HttpError(400, 'VALIDATION', rules.RESERVED_CODE_MESSAGE, 'apiErrors.reservedCode');
      }
      const lower = v.code.toLowerCase(); // COLLATE NOCASE (ASCII)
      const exists = state.products.find((p) => p.code.toLowerCase() === lower);
      if (exists) {
        throw new HttpError(409, 'CODE_TAKEN', `Product code ${exists.code} already exists`, {
          key: 'apiErrors.codeTaken',
          params: { code: exists.code },
        });
      }
      const t = now();
      const p = {
        id: nextId(state.products),
        code: v.code,
        name: v.name,
        category: v.category,
        group: v.group,
        unit: v.unit,
        minimumStock: v.minimumStock ?? null,
        isActive: true,
        source: 'manual',
        modifiedManuallyAt: null,
        createdAt: t,
        updatedAt: t,
        photoFile: null,
        barcodeFile: null,
      };
      state.products.push(p);
      return p;
    }

    function patchProduct(id, valid, body) {
      const p = getProduct(id);
      const fields = { ...valid };
      if (body && body.minimumStock === null) fields.minimumStock = null;
      for (const key of ['category', 'group', 'unit']) {
        if (body && body[key] === '') fields[key] = '';
      }
      if (Object.keys(fields).length === 0) {
        throw new HttpError(400, 'VALIDATION', 'Nothing to update', 'apiErrors.nothingToUpdate');
      }
      let changed = false;
      for (const key of ['name', 'category', 'group', 'unit', 'minimumStock', 'isActive']) {
        if (!(key in fields) || fields[key] === p[key]) continue;
        p[key] = fields[key];
        changed = true;
      }
      if (changed) {
        const t = now();
        p.modifiedManuallyAt = t;
        p.updatedAt = t;
      }
      return { product: productDetail(p), changed };
    }

    function releaseProduct(id) {
      const p = getProduct(id);
      if (p.source !== 'import') {
        throw new HttpError(400, 'VALIDATION', 'Manual product: not managed by imports', 'apiErrors.releaseManual');
      }
      p.modifiedManuallyAt = null;
      p.updatedAt = now();
      return p;
    }

    // ---- boeken (server/services/bookService.js) ---------------------------------

    function getBookRow(id) {
      const b = state.books.find((x) => x.id === id);
      if (!b) throw new HttpError(404, 'NOT_FOUND', 'Book not found', 'apiErrors.bookNotFound');
      return b;
    }
    function layoutOf(b) {
      const layout = layoutById[b.layoutId];
      if (!layout) throw new HttpError(500, 'INTERNAL', `Unknown layout ${b.layoutId}`);
      return layout;
    }
    function getPageRow(bookId, pageId) {
      const p = state.pages.find((x) => x.id === pageId && x.bookId === bookId);
      if (!p) throw new HttpError(404, 'NOT_FOUND', 'Page not found', 'apiErrors.pageNotFound');
      return p;
    }
    function getItemRow(bookId, itemId) {
      const it = state.items.find((x) => x.id === itemId && x.bookId === bookId);
      if (!it) throw new HttpError(404, 'NOT_FOUND', 'Item not found', 'apiErrors.itemNotFound');
      return it;
    }
    const touchBook = (b) => {
      b.updatedAt = now();
    };
    const capacityOf = (layout) => layout.grid.columns * layout.grid.rows;
    const pageItems = (pageId) =>
      state.items.filter((it) => it.pageId === pageId).sort((a, b) => a.position - b.position);
    const bookPages = (bookId) =>
      state.pages.filter((p) => p.bookId === bookId).sort((a, b) => a.pageNo - b.pageNo);
    const hasFixed = (b) => b.hasFixedPages && layoutsLib.hasFixedPages(layoutById[b.layoutId] || {});

    function itemShape(it) {
      return {
        id: it.id,
        pageId: it.pageId,
        position: it.position,
        product: productShape(productById(it.productId)),
      };
    }

    function getBook(id) {
      const b = getBookRow(id);
      return {
        id: b.id,
        name: b.name,
        layoutId: b.layoutId,
        fixedPages: hasFixed(b),
        texts: clone(b.texts),
        pages: bookPages(id).map((p) => ({
          id: p.id,
          pageNo: p.pageNo,
          kind: p.kind,
          items: pageItems(p.id).map((it) => ({
            id: it.id,
            position: it.position,
            product: productShape(productById(it.productId)),
          })),
        })),
      };
    }

    function listBooks() {
      return state.books
        .slice()
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.id - a.id))
        .map((b) => ({
          id: b.id,
          name: b.name,
          layoutId: b.layoutId,
          fixedPages: hasFixed(b),
          updatedAt: b.updatedAt,
          // Nombre de pages du PDF (bookService.js listBooks).
          pageCount: bookPlan
            .pageSequence(
              { fixedPages: hasFixed(b), pages: bookPages(b.id).map((p) => ({ kind: p.kind, hasItems: pageItems(p.id).length > 0 })) },
              layoutById[b.layoutId] || {}
            )
            .filter((e) => e.printed).length,
          itemCount: state.items.filter((it) => it.bookId === b.id).length,
        }));
    }

    function checkBookQuota() {
      if (state.books.length >= MAX_BOOKS) {
        throw new HttpError(400, 'QUOTA', `Too many books (${MAX_BOOKS} max)`, {
          key: 'apiErrors.tooManyBooks',
          params: { n: MAX_BOOKS },
        });
      }
    }

    function insertPage(bookId, pageNo, kind = 'products') {
      const page = { id: nextId(state.pages), bookId, pageNo, kind };
      state.pages.push(page);
      return page;
    }

    function createBook(name, layoutId, { fixedPages = true, fill } = {}) {
      const layout = layoutById[layoutId];
      if (!layout) {
        throw new HttpError(
          400,
          'VALIDATION',
          `layoutId must be one of: ${Object.keys(layoutById).join(', ')}`,
          'apiErrors.unknownLayout'
        );
      }
      checkBookQuota();
      // Remplissage automatique : mêmes règles que bookService (book-plan.js).
      let plan = null;
      if (fill !== undefined && fill !== null) {
        if (bookPlan.fillHasEmptyList(fill)) {
          throw new HttpError(400, 'FILL_EMPTY_SELECTION', 'No category or group selected', 'apiErrors.FILL_EMPTY_SELECTION');
        }
        const options = bookPlan.normalizeFill(fill);
        if (!options) throw new HttpError(400, 'VALIDATION', 'fill is invalid', 'apiErrors.fillInvalid');
        const candidates = state.products
          .map(productShape)
          .filter((p) => bookPlan.matchesFill(p, options));
        plan = bookPlan.planFill(candidates, {
          capacity: capacityOf(layout),
          sort: options.sort,
          newPagePerCategory: options.newPagePerCategory,
        });
        if (plan.length === 0) {
          throw new HttpError(400, 'VALIDATION', 'No product matches the selection', 'apiErrors.fillEmpty');
        }
        if (plan.length > MAX_PAGES_PER_BOOK) {
          throw new HttpError(400, 'QUOTA', `Too many pages (${MAX_PAGES_PER_BOOK} max per book)`, {
            key: 'apiErrors.tooManyPages',
            params: { n: MAX_PAGES_PER_BOOK },
          });
        }
      }
      const withFixed = Boolean(fixedPages) && layoutsLib.hasFixedPages(layout);
      const texts = layoutsLib.layoutSlots(layout).has(TITLE_SLOT) ? { [TITLE_SLOT]: name } : {};
      const t = now();
      const b = {
        id: nextId(state.books),
        name,
        layoutId,
        texts,
        hasFixedPages: withFixed,
        createdAt: t,
        updatedAt: t,
      };
      state.books.push(b);
      if (plan) {
        plan.forEach((ids, i) => {
          const page = insertPage(b.id, i + 1);
          ids.forEach((productId, j) => {
            state.items.push({ id: nextId(state.items), bookId: b.id, pageId: page.id, productId, position: (j + 1) * STEP });
          });
        });
      } else {
        insertPage(b.id, 1);
        insertPage(b.id, 2);
      }
      return getBook(b.id);
    }

    // Transcription d'updateBook (bookService.js) : texts remplace, slots
    // validés ; fixedPages ne touche jamais aux textes ; le titre suit le nom
    // tant qu'il lui est identique et que le PATCH n'envoie pas de titre.
    function updateBook(id, { name, texts, fixedPages }) {
      const b = getBookRow(id);
      const layout = layoutOf(b);
      const slots = layoutsLib.layoutSlots(layout);
      let nextTexts = b.texts;
      let textsChanged = false;
      if (texts !== undefined) {
        if (texts === null || typeof texts !== 'object' || Array.isArray(texts)) {
          throw new HttpError(400, 'VALIDATION', 'texts must be an object');
        }
        for (const [slot, value] of Object.entries(texts)) {
          if (!slots.has(slot)) {
            throw new HttpError(400, 'VALIDATION', `Unknown text slot: ${slot}`, {
              key: 'apiErrors.unknownTextSlot',
              params: { slot },
            });
          }
          if (typeof value !== 'string' || value.length > TEXT_MAX) {
            throw new HttpError(400, 'VALIDATION', `texts.${slot} must be a string of at most ${TEXT_MAX} characters`, {
              key: 'apiErrors.textTooLong',
              params: { slot, max: TEXT_MAX },
            });
          }
        }
        nextTexts = { ...texts };
        textsChanged = true;
      }
      if (fixedPages !== undefined) {
        if (typeof fixedPages !== 'boolean') {
          throw new HttpError(400, 'VALIDATION', 'fixedPages must be a boolean');
        }
        if (fixedPages && !layoutsLib.hasFixedPages(layout)) {
          throw new HttpError(400, 'VALIDATION', 'Layout has no fixed pages', 'apiErrors.noFixedPages');
        }
        b.hasFixedPages = fixedPages;
      }
      if (name !== undefined) {
        const titleSent =
          texts !== undefined && Object.prototype.hasOwnProperty.call(texts, TITLE_SLOT);
        const stored = nextTexts[TITLE_SLOT];
        if (
          !titleSent &&
          name !== b.name &&
          typeof stored === 'string' &&
          b.name.trim() !== '' &&
          stored.trim() === b.name.trim()
        ) {
          nextTexts = { ...nextTexts, [TITLE_SLOT]: name };
          textsChanged = true;
        }
        b.name = name;
      }
      if (textsChanged) b.texts = nextTexts;
      touchBook(b);
      return getBook(id);
    }

    function duplicateBook(id) {
      const b = getBookRow(id);
      checkBookQuota();
      const stamp = now();
      const copy = {
        id: nextId(state.books),
        name: bookPlan.copyNameOf(b.name, (name) => t('books.copyName', { name })),
        layoutId: b.layoutId,
        texts: clone(b.texts),
        hasFixedPages: b.hasFixedPages,
        createdAt: stamp,
        updatedAt: stamp,
      };
      state.books.push(copy);
      for (const page of bookPages(id)) {
        const np = insertPage(copy.id, page.pageNo, page.kind);
        for (const it of pageItems(page.id)) {
          state.items.push({
            id: nextId(state.items),
            bookId: copy.id,
            pageId: np.id,
            productId: it.productId,
            position: it.position,
          });
        }
      }
      return getBook(copy.id);
    }

    function deleteBook(id) {
      getBookRow(id);
      state.books = state.books.filter((b) => b.id !== id);
      state.pages = state.pages.filter((p) => p.bookId !== id);
      state.items = state.items.filter((it) => it.bookId !== id);
    }

    function addPage(bookId, { afterPageNo, kind = 'products' } = {}) {
      const b = getBookRow(bookId);
      const pages = bookPages(bookId);
      if (pages.length >= MAX_PAGES_PER_BOOK) {
        throw new HttpError(400, 'QUOTA', `Too many pages (${MAX_PAGES_PER_BOOK} max per book)`, {
          key: 'apiErrors.tooManyPages',
          params: { n: MAX_PAGES_PER_BOOK },
        });
      }
      const maxNo = pages.reduce((m, p) => Math.max(m, p.pageNo), 0);
      const after = afterPageNo === undefined ? maxNo : Math.min(afterPageNo, maxNo);
      for (const p of pages) if (p.pageNo > after) p.pageNo += 1;
      const page = insertPage(bookId, after + 1, kind);
      // Page de produits vide en fin de boek : rien ne change à l'impression.
      if (kind !== 'products' || after < maxNo) touchBook(b);
      return { id: page.id, pageNo: page.pageNo, kind: page.kind, items: [] };
    }

    function deletePage(bookId, pageId) {
      const b = getBookRow(bookId);
      getPageRow(bookId, pageId);
      if (state.items.some((it) => it.pageId === pageId)) {
        throw new HttpError(409, 'PAGE_NOT_EMPTY', 'Page is not empty', 'apiErrors.PAGE_NOT_EMPTY');
      }
      state.pages = state.pages.filter((p) => p.id !== pageId);
      touchBook(b);
    }

    // Ordonnancement gap-based (ARCHITECTURE §3) : renumérotation (1024, 2048…)
    // quand le trou est épuisé, insertion au point médian.
    function renumberPage(pageId) {
      // Un article « garé » (position négative, moveItem) n'est pas renuméroté.
      pageItems(pageId).filter((it) => it.position > 0).forEach((it, i) => {
        it.position = (i + 1) * STEP;
      });
    }

    function positionFor(pageId, beforeItemId, excludeItemId = null) {
      const list = () => pageItems(pageId).filter((r) => r.id !== excludeItemId);
      let items = list();
      const bounds = () => {
        if (beforeItemId == null) {
          const last = items[items.length - 1];
          return { prev: last ? last.position : 0, next: null };
        }
        const idx = items.findIndex((r) => r.id === beforeItemId);
        if (idx === -1) {
          throw new HttpError(400, 'VALIDATION', 'beforeItemId is not an item of this page');
        }
        return { prev: idx > 0 ? items[idx - 1].position : 0, next: items[idx].position };
      };
      let { prev, next } = bounds();
      if (next === null) return prev + STEP;
      if (next - prev < 2) {
        renumberPage(pageId);
        items = list();
        ({ prev, next } = bounds());
      }
      return Math.floor((prev + next) / 2);
    }

    // Page pleine : glissement en cascade (transcription de bookService.js
    // makeRoom / placeFor, règle pure book-plan.js cascadeChain).
    function contentPages(bookId) {
      return bookPages(bookId).map((p) => ({ id: p.id, kind: p.kind, itemIds: pageItems(p.id).map((it) => it.id) }));
    }

    function appendProductsPage(bookId) {
      return addPage(bookId, {}).id;
    }

    function makeRoom(bookId, pages, from, capacity, excludeItemId) {
      const { chain, needsNewPage } = bookPlan.cascadeChain(pages, capacity, from, excludeItemId);
      if (needsNewPage) {
        pages.push({ id: appendProductsPage(bookId), kind: 'products', itemIds: [] });
        chain.push(pages.length - 1);
      }
      const shifted = [];
      const others = (p) => p.itemIds.filter((id) => id !== excludeItemId);
      for (let k = chain.length - 1; k >= 1; k--) {
        const src = pages[chain[k - 1]];
        const dst = pages[chain[k]];
        const moving = others(src).pop();
        const first = others(dst)[0];
        const position = positionFor(dst.id, first === undefined ? null : first, excludeItemId);
        const it = state.items.find((x) => x.id === moving);
        it.pageId = dst.id;
        it.position = position;
        src.itemIds = src.itemIds.filter((id) => id !== moving);
        dst.itemIds.unshift(moving);
        shifted.push(moving);
      }
      return shifted;
    }

    function placeFor(bookId, b, { pageId, beforeItemId, excludeItemId = null }) {
      const capacity = capacityOf(layoutOf(b));
      const pages = contentPages(bookId);
      const from = pages.findIndex((p) => p.id === pageId);
      const count = pages[from].itemIds.filter((id) => id !== excludeItemId).length;
      if (count < capacity) return { pageId, beforeItemId, shifted: [] };
      if (beforeItemId == null) {
        const { chain, needsNewPage } = bookPlan.cascadeChain(pages, capacity, from, excludeItemId);
        let next = chain[1];
        if (next === undefined && needsNewPage) {
          pages.push({ id: appendProductsPage(bookId), kind: 'products', itemIds: [] });
          next = pages.length - 1;
        }
        const shifted = makeRoom(bookId, pages, next, capacity, excludeItemId);
        const first = pages[next].itemIds.filter((id) => id !== excludeItemId)[0];
        return { pageId: pages[next].id, beforeItemId: first === undefined ? null : first, shifted };
      }
      if (!pages[from].itemIds.includes(beforeItemId)) {
        throw new HttpError(400, 'VALIDATION', 'beforeItemId is not an item of this page');
      }
      const shifted = makeRoom(bookId, pages, from, capacity, excludeItemId);
      const stays = pages[from].itemIds.includes(beforeItemId);
      return { pageId, beforeItemId: stays ? beforeItemId : null, shifted };
    }

    // Le serveur travaille en transaction : la démo copie l'état avant une
    // mutation à plusieurs étapes et le restaure en cas d'erreur.
    function atomically(fn) {
      const saved = clone(state);
      try {
        return fn();
      } catch (err) {
        state = saved;
        throw err;
      }
    }

    function insertItemPlaced(bookId, { pageId, productId, beforeItemId = null }) {
      return atomically(() => {
        const b = getBookRow(bookId);
        if (getPageRow(bookId, pageId).kind !== 'products') {
          throw new HttpError(409, 'PAGE_NOT_PRODUCTS', 'Not a products page', 'apiErrors.PAGE_NOT_PRODUCTS');
        }
        if (!productById(productId)) throw new HttpError(404, 'NOT_FOUND', 'Product not found', 'apiErrors.productNotFound');
        const place = placeFor(bookId, b, { pageId, beforeItemId });
        const position = positionFor(place.pageId, place.beforeItemId);
        const it = { id: nextId(state.items), bookId, pageId: place.pageId, productId, position };
        state.items.push(it);
        touchBook(b);
        return { item: itemShape(it), shifted: place.shifted };
      });
    }

    function moveItemPlaced(bookId, itemId, { pageId, beforeItemId = null }) {
      return atomically(() => {
        const b = getBookRow(bookId);
        getItemRow(bookId, itemId);
        if (getPageRow(bookId, pageId).kind !== 'products') {
          throw new HttpError(409, 'PAGE_NOT_PRODUCTS', 'Not a products page', 'apiErrors.PAGE_NOT_PRODUCTS');
        }
        if (beforeItemId === itemId) {
          throw new HttpError(400, 'VALIDATION', 'beforeItemId cannot be the moved item itself');
        }
        getItemRow(bookId, itemId).position = -itemId; // « garé » pendant la cascade
        const place = placeFor(bookId, b, { pageId, beforeItemId, excludeItemId: itemId });
        const position = positionFor(place.pageId, place.beforeItemId, itemId);
        const it = getItemRow(bookId, itemId);
        it.pageId = place.pageId;
        it.position = position;
        touchBook(b);
        return { item: itemShape(it), shifted: place.shifted };
      });
    }

    const insertItem = (bookId, body) => insertItemPlaced(bookId, body).item;
    const moveItem = (bookId, itemId, body) => moveItemPlaced(bookId, itemId, body).item;

    function deleteItem(bookId, itemId) {
      const b = getBookRow(bookId);
      getItemRow(bookId, itemId);
      state.items = state.items.filter((it) => it.id !== itemId);
      touchBook(b);
    }

    // Données du PDF (demo/pdf-page.js) : mêmes lignes que celles que lit
    // server/services/pdf/renderer.js dans SQLite.
    function pdfData(bookId) {
      const b = getBookRow(bookId);
      return {
        name: b.name,
        layoutId: b.layoutId,
        withFixedPages: b.hasFixedPages,
        texts: clone(b.texts),
        pages: bookPages(bookId).map((p) => {
          const items = pageItems(p.id).map((it) => {
            const prod = productById(it.productId);
            return {
              product_code: prod.code,
              name: prod.name,
              category: prod.category,
              product_group: prod.group,
              unit: prod.unit,
              minimum_stock: prod.minimumStock,
              photo_file: prod.photoFile,
              barcode_file: prod.barcodeFile,
            };
          });
          return { kind: p.kind, hasItems: items.length > 0, items };
        }),
      };
    }

    // Boek d'exemple : catalogue stock-6 avec couverture, 14 produits sur
    // 3 pages, puis la double page vide de fin que l'éditeur maintient.
    function seedExampleBook() {
      const layout = layoutById['stock-6'];
      if (!layout) return;
      const book = createBook('Stock boek Tapigro', 'stock-6');
      for (let i = 0; i < 4; i++) addPage(book.id, {});
      const pages = bookPages(book.id);
      const products = state.products.filter((p) => p.isActive).sort(byCode).slice(0, 14);
      products.forEach((p, i) => {
        insertItem(book.id, { pageId: pages[Math.floor(i / 6)].id, productId: p.id });
      });
    }

    // ---- routage ----------------------------------------------------------------------

    // validate() du serveur, appelé hors Express : → valeurs validées ou HttpError.
    function check(schema, data) {
      const req = { body: data && typeof data === 'object' ? data : {} };
      let error = null;
      validate(schema, 'body')(req, null, (err) => {
        error = err || null;
      });
      if (error) throw error;
      return req.valid;
    }

    function idOf(raw) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'NOT_FOUND', 'Not found');
      return n;
    }

    const PRODUCT_LIST_SCHEMA = {
      q: { type: 'string', maxLength: 100, default: '' },
      category: { type: 'string', maxLength: 200, default: '' },
      group: { type: 'string', maxLength: 200, default: '' },
      active: { type: 'string', enum: ['1', '0', 'all'], default: '1' },
      photo: { type: 'string', enum: ['1', '0', 'all'], default: 'all' },
      barcode: { type: 'string', enum: ['1', '0', 'all'], default: 'all' },
      sort: { type: 'string', enum: ['code', 'updated'], default: 'code' },
      limit: { type: 'integer', min: 1, max: 200, default: 50 },
      offset: { type: 'integer', min: 0, default: 0 },
    };
    const NO_CONTROL = rules.NO_CONTROL_RE;
    const PRODUCT_CREATE_SCHEMA = {
      code: { type: 'string', required: true, maxLength: 64, pattern: rules.CODE_RE },
      name: { type: 'string', required: true, minLength: 1, maxLength: 200, pattern: NO_CONTROL },
      category: { type: 'string', maxLength: 200, default: '', pattern: NO_CONTROL },
      group: { type: 'string', maxLength: 200, default: '', pattern: NO_CONTROL },
      unit: { type: 'string', maxLength: 50, default: '', pattern: NO_CONTROL },
      minimumStock: { type: 'number', min: 0, max: 1e9 },
    };
    const PRODUCT_PATCH_SCHEMA = {
      name: { type: 'string', minLength: 1, maxLength: 200, pattern: NO_CONTROL },
      category: { type: 'string', maxLength: 200, pattern: NO_CONTROL },
      group: { type: 'string', maxLength: 200, pattern: NO_CONTROL },
      unit: { type: 'string', maxLength: 50, pattern: NO_CONTROL },
      minimumStock: { type: 'number', min: 0, max: 1e9 },
      isActive: { type: 'boolean' },
    };

    // [méthode, motif, handler(match, body, query) → {status?, body}]
    const ROUTES = [
      ['GET', /^\/api\/me$/, () => ({
        body: { user: { ...DEMO_USER, username: t('demo.userName'), lang }, csrfToken: 'demo' },
      })],
      ['PATCH', /^\/api\/me$/, (m, b) => {
        const next = b ? b.lang : undefined;
        if (next !== 'nl' && next !== 'fr') {
          throw new HttpError(400, 'VALIDATION', 'lang must be one of: nl, fr', {
            key: 'validation.enum',
            params: { field: 'lang', values: 'nl, fr' },
          });
        }
        if (onLang) onLang(next);
        return { body: { user: { ...DEMO_USER, username: t('demo.userName'), lang: next }, csrfToken: 'demo' } };
      }],
      ['POST', /^\/api\/logout$/, () => ({ body: { ok: true } })],
      ['GET', /^\/api\/layouts$/, () => ({ body: { layouts: clone(layouts) } })],

      ['GET', /^\/api\/products$/, (m, b, q) => ({ body: listProducts(check(PRODUCT_LIST_SCHEMA, q)) })],
      ['GET', /^\/api\/products\/meta$/, () => ({ body: productsMeta() })],
      ['GET', /^\/api\/products\/stats$/, () => ({ body: productStats() })],
      ['GET', /^\/api\/products\/([^/]+)$/, (m) => ({ body: { product: productDetail(getProduct(idOf(m[1]))) } })],
      ['POST', /^\/api\/products$/, (m, b) => {
        const p = createProduct(check(PRODUCT_CREATE_SCHEMA, b));
        return { status: 201, body: { product: productDetail(p) } };
      }],
      ['PATCH', /^\/api\/products\/([^/]+)$/, (m, b) => {
        const id = idOf(m[1]);
        getProduct(id); // 404 avant la validation, comme la route
        return { body: patchProduct(id, check(PRODUCT_PATCH_SCHEMA, b), b) };
      }],
      ['POST', /^\/api\/products\/([^/]+)\/release$/, (m) => ({
        body: { product: productDetail(releaseProduct(idOf(m[1]))) },
      })],
      ['POST', /^\/api\/products\/([^/]+)\/(photo|barcode)$/, (m) => {
        getProduct(idOf(m[1]));
        throw new HttpError(400, 'VALIDATION', 'Images are not available in the demo', 'apiErrors.demoImages');
      }],

      ['GET', /^\/api\/books$/, () => ({ body: { items: listBooks() } })],
      ['POST', /^\/api\/books$/, (m, b) => {
        const v = check(
          {
            name: { type: 'string', required: true, minLength: 1, maxLength: 200 },
            layoutId: { type: 'string', required: true, maxLength: 64 },
            fixedPages: { type: 'boolean', default: true },
          },
          b
        );
        const fill = b && typeof b === 'object' ? b.fill : undefined;
        return { status: 201, body: { book: createBook(v.name, v.layoutId, { fixedPages: v.fixedPages, fill }) } };
      }],
      ['GET', /^\/api\/books\/([^/]+)$/, (m) => ({ body: getBook(idOf(m[1])) })],
      ['GET', /^\/api\/books\/([^/]+)\/pdf-data$/, (m) => ({ body: pdfData(idOf(m[1])) })],
      ['PATCH', /^\/api\/books\/([^/]+)$/, (m, b) => {
        const id = idOf(m[1]);
        const v = check(
          { name: { type: 'string', minLength: 1, maxLength: 200 }, fixedPages: { type: 'boolean' } },
          b
        );
        const texts = b && typeof b === 'object' ? b.texts : undefined;
        return { body: { book: updateBook(id, { name: v.name, texts, fixedPages: v.fixedPages }) } };
      }],
      ['POST', /^\/api\/books\/([^/]+)\/duplicate$/, (m) => ({
        status: 201,
        body: { book: duplicateBook(idOf(m[1])) },
      })],
      ['DELETE', /^\/api\/books\/([^/]+)$/, (m) => {
        deleteBook(idOf(m[1]));
        return { body: { ok: true } };
      }],
      ['POST', /^\/api\/books\/([^/]+)\/pages$/, (m, b) => {
        const id = idOf(m[1]);
        const v = check(
          {
            afterPageNo: { type: 'integer', min: 0, max: 100000 },
            kind: { type: 'string', enum: ['products', 'blank'], default: 'products' },
          },
          b
        );
        return { status: 201, body: { page: addPage(id, v) } };
      }],
      ['DELETE', /^\/api\/books\/([^/]+)\/pages\/([^/]+)$/, (m) => {
        deletePage(idOf(m[1]), idOf(m[2]));
        return { body: { ok: true } };
      }],
      ['POST', /^\/api\/books\/([^/]+)\/items$/, (m, b) => {
        const id = idOf(m[1]);
        const v = check(
          {
            pageId: { type: 'integer', required: true, min: 1 },
            productId: { type: 'integer', required: true, min: 1 },
            beforeItemId: { type: 'integer', min: 1 },
          },
          b
        );
        return { status: 201, body: insertItemPlaced(id, v) };
      }],
      ['PATCH', /^\/api\/books\/([^/]+)\/items\/([^/]+)$/, (m, b) => {
        const id = idOf(m[1]);
        const itemId = idOf(m[2]);
        const v = check(
          {
            pageId: { type: 'integer', required: true, min: 1 },
            beforeItemId: { type: 'integer', min: 1 },
          },
          b
        );
        return { body: moveItemPlaced(id, itemId, v) };
      }],
      ['DELETE', /^\/api\/books\/([^/]+)\/items\/([^/]+)$/, (m) => {
        deleteItem(idOf(m[1]), idOf(m[2]));
        return { body: { ok: true } };
      }],

      ['GET', /^\/api\/imports$/, (m, b, q) => {
        const v = check(
          {
            limit: { type: 'integer', min: 1, max: 200, default: 20 },
            offset: { type: 'integer', min: 0, default: 0 },
          },
          q
        );
        const all = catalog.imports || [];
        return { body: { items: clone(all.slice(v.offset, v.offset + v.limit)), total: all.length } };
      }],
    ];

    /**
     * Traite une requête API. → {status, body} (jamais d'exception : les
     * erreurs sortent au format du serveur {error: {code, message}}).
     */
    function handle(method, url, body) {
      const [pathname, search = ''] = String(url).split('?');
      const query = Object.fromEntries(new URLSearchParams(search));
      const verb = String(method || 'GET').toUpperCase();
      try {
        for (const [m, re, fn] of ROUTES) {
          if (m !== verb) continue;
          const match = re.exec(pathname);
          if (!match) continue;
          const res = fn(match, body === undefined ? {} : body, query);
          if (verb !== 'GET') persist();
          return { status: res.status || 200, body: res.body };
        }
        throw new HttpError(404, 'NOT_FOUND', 'Not found');
      } catch (err) {
        if (verb !== 'GET') {
          // Une mutation refusée ne laisse aucune trace : on recharge l'état
          // enregistré (équivalent du ROLLBACK des transactions du serveur).
          const saved = storage ? storage.load() : null;
          if (saved && saved.version === STATE_VERSION) state = saved;
        }
        const status = Number.isInteger(err.status) ? err.status : 500;
        const code = err.code || 'INTERNAL';
        // Message traduit exactement comme le fait errorHandler sur le serveur.
        const message = translateError(err, code, t, hasKey) || err.message;
        return { status, body: { error: { code, message } } };
      }
    }

    // ---- chargement ------------------------------------------------------------------
    // État enregistré s'il correspond à CE catalogue (un nouveau build de la
    // démo repart de zéro), sinon état neuf + boek d'exemple.
    const stored = storage ? storage.load() : null;
    if (stored && stored.version === STATE_VERSION && stored.catalogId === catalog.id) {
      state = stored;
    } else {
      state = initialState(catalog);
      if (seed) seedExampleBook();
      persist();
    }

    return {
      handle,
      reset,
      getState: () => state,
      // exposés pour les tests de parité (tests/e)
      createBook,
      updateBook,
      getBook,
      addPage,
      deletePage,
      insertItem,
      insertItemPlaced,
      moveItem,
      moveItemPlaced,
      deleteItem,
      duplicateBook,
      listBooks,
      pdfData,
    };
  }

  // ---- stockage navigateur -------------------------------------------------------------

  // localStorage si disponible (navigation privée, stockage bloqué, quota :
  // chaque accès est protégé), sinon état en mémoire pour la session.
  function browserStorage(key) {
    let memory = null;
    return {
      load() {
        try {
          const raw = window.localStorage.getItem(key);
          if (raw) return JSON.parse(raw);
        } catch {
          /* stockage indisponible ou illisible */
        }
        return memory ? JSON.parse(memory) : null;
      },
      save(state) {
        memory = JSON.stringify(state);
        try {
          window.localStorage.setItem(key, memory);
        } catch {
          /* quota ou stockage bloqué : la session continue en mémoire */
        }
      },
      clear() {
        memory = null;
        try {
          window.localStorage.removeItem(key);
        } catch {
          /* idem */
        }
      },
    };
  }

  return { createBackend, browserStorage, sqliteNow, DEMO_USER };
});
