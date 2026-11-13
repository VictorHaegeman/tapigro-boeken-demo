/* book-plan.js — règles PURES d'un boek, partagées par le serveur (bookService,
 * export PDF), le navigateur (éditeur, aperçu) et la démo statique. Une seule
 * écriture → l'aperçu, l'éditeur et le PDF ne peuvent pas diverger.
 *
 *  - printablePages / pageSequence : quelles pages sont imprimées et avec
 *    quel numéro (celui du PDF) ;
 *  - MAX_PRINTED_PAGES / printedPageCount / exceedsPageLimit : LE plafond de
 *    taille d'un boek, en pages imprimées (export PDF et service des boeken) ;
 *  - cascadeChain : où vont les articles quand on dépose dans une page pleine ;
 *  - planFill : remplissage automatique d'un boek ;
 *  - copyNameOf : nom d'une copie, borné.
 *
 * Module UMD : window.TapigroBookPlan dans le navigateur, require() en Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TapigroBookPlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIXED_KEYS = ['cover', 'page2', 'back'];

  // Plafond UNIQUE de la taille d'un boek, en PAGES IMPRIMÉES (pages fixes
  // comprises, double page vide de fin exclue : printedPageCount). L'export
  // PDF refuse au-delà (413 BOOK_TOO_LARGE) ; la création, la cascade et le
  // remplissage automatique doivent refuser AVANT d'atteindre ce chiffre.
  // 500 pages ≈ 4 900 produits en labels-10 ou ≈ 2 900 en stock-6. Mesuré
  // (3 000 produits, labels-10, 303 p.) : PDF de 51 Mo, ~2 s de rendu hors du
  // thread principal une fois les variantes d'impression des photos créées.
  const MAX_PRINTED_PAGES = 500;

  function hasItems(page) {
    if (typeof page.hasItems === 'boolean') return page.hasItems;
    return Array.isArray(page.items) ? page.items.length > 0 : Boolean(page.itemCount);
  }

  /**
   * Pages de contenu à imprimer. L'éditeur maintient toujours une double page
   * vide en fin de boek : la séquence FINALE de pages 'products' sans items
   * n'est pas imprimée. Les pages 'blank' (pages blanches voulues) et les pages
   * vides SUIVIES d'une page avec items restent rendues.
   * @param {Array<{kind: string, hasItems?: boolean, items?: Array}>} allPages ordre page_no
   * @returns la même liste, tronquée
   */
  function printablePages(allPages) {
    let lastKeep = -1;
    for (let i = 0; i < allPages.length; i++) {
      if (allPages[i].kind !== 'products' || hasItems(allPages[i])) lastKeep = i;
    }
    return allPages.slice(0, lastKeep + 1);
  }

  /**
   * Toutes les pages du boek dans l'ordre du PDF, avec leur numéro de page
   * dans le PDF (null = page non imprimée : double page vide de fin).
   *  → [{type: 'cover'|'page2'|'products'|'blank'|'back', page: objet de
   *      contenu ou null, number: n|null, printed: bool}]
   * Un boek sans aucune page imprimable et sans pages fixes donne UNE page
   * blanche (le PDF ne peut pas être vide) : type 'blank', page null.
   * @param {object} book {fixedPages: bool, pages: [...]}
   * @param {object} layout layout résolu ({fixedPages: {cover?, page2?, back?}})
   */
  function pageSequence(book, layout) {
    const fixed = book.fixedPages ? (layout && layout.fixedPages) || {} : {};
    const printed = new Set(printablePages(book.pages || []));
    const out = [];
    let n = 0;
    const push = (type, page, isPrinted) => {
      out.push({ type, page, printed: isPrinted, number: isPrinted ? ++n : null });
    };
    if (fixed.cover) push('cover', null, true);
    if (fixed.page2) push('page2', null, true);
    for (const page of book.pages || []) push(page.kind === 'blank' ? 'blank' : 'products', page, printed.has(page));
    if (fixed.back) push('back', null, true);
    if (n === 0) out.unshift({ type: 'blank', page: null, printed: true, number: ++n });
    return out;
  }

  /** Nombre de pages fixes imprimées (0 si le boek ne les utilise pas). */
  function fixedPageCount(useFixedPages, layout) {
    if (!useFixedPages) return 0;
    const fixed = (layout && layout.fixedPages) || {};
    return FIXED_KEYS.filter((k) => fixed[k]).length;
  }

  /** Nombre de pages du PDF (= numéro de la dernière page de pageSequence). */
  function printedPageCount(book, layout) {
    return pageSequence(book, layout).filter((e) => e.printed).length;
  }

  /**
   * Un boek de `contentPages` pages de contenu (TOUTES, vides de fin
   * comprises : majorant des pages imprimées) dépasse-t-il le plafond ?
   * Règle à appliquer AVANT d'écrire (création, ajout de page, cascade,
   * remplissage, activation des pages fixes) : tout boek accepté ici a un PDF
   * accepté par l'export.
   */
  function exceedsPageLimit(contentPages, useFixedPages, layout) {
    return contentPages + fixedPageCount(useFixedPages, layout) > MAX_PRINTED_PAGES;
  }

  /** Légende d'une page (éditeur, aperçu) : clé de traduction + paramètres,
   *  numérotée comme le PDF. entry : élément de pageSequence. */
  function captionOf(entry) {
    if (entry.type === 'cover') return { key: 'editor.cover', params: {} };
    if (entry.type === 'page2') return { key: 'editor.page2', params: {} };
    if (entry.type === 'back') return { key: 'editor.backCover', params: {} };
    if (!entry.printed) return { key: 'editor.notPrinted', params: {} };
    return { key: 'editor.pageN', params: { n: entry.number } };
  }

  /** Les pages imprimées regroupées en doubles pages comme un livre ouvert :
   *  la 1re page seule (à droite), puis 2-3, 4-5… ; la dernière seule si le
   *  total est pair. */
  function bookSpreads(printedEntries) {
    const spreads = [];
    if (printedEntries.length === 0) return spreads;
    spreads.push([printedEntries[0]]);
    for (let i = 1; i < printedEntries.length; i += 2) spreads.push(printedEntries.slice(i, i + 2));
    return spreads;
  }

  /**
   * Dépôt dans une page PLEINE : l'article déposé prend sa place et le dernier
   * article de la page glisse au début de la page de produits suivante, et
   * ainsi de suite jusqu'à une page qui a de la place. Les pages blanches
   * intercalaires sont sautées (ce ne sont pas des pages de produits) ; les
   * pages fixes ne font pas partie de `pages`, on ne peut donc jamais y
   * déborder.
   * @param {Array<{kind: string, itemIds: number[]}>} pages pages de contenu, ordre page_no
   * @param {number} capacity articles par page
   * @param {number} from index de la page pleine
   * @param {number|null} excludeItemId article en cours de déplacement (ne compte pas)
   * @returns {{chain: number[], needsNewPage: boolean}} chain = index des
   *   pages concernées (from d'abord) ; needsNewPage = il faut ajouter une page
   *   de produits en fin de boek (elle prolonge la chaîne).
   */
  function cascadeChain(pages, capacity, from, excludeItemId = null) {
    const count = (p) => p.itemIds.filter((id) => id !== excludeItemId).length;
    const chain = [from];
    if (count(pages[from]) < capacity) return { chain, needsNewPage: false };
    for (let i = from + 1; i < pages.length; i++) {
      if (pages[i].kind !== 'products') continue;
      chain.push(i);
      if (count(pages[i]) < capacity) return { chain, needsNewPage: false };
    }
    return { chain, needsNewPage: true };
  }

  // Comparaisons stables et identiques partout (serveur, navigateur, démo).
  function byCode(a, b) {
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  }
  function byName(a, b) {
    const r = String(a.name || '').localeCompare(String(b.name || ''), 'nl', {
      sensitivity: 'base',
      numeric: true,
    });
    return r || byCode(a, b);
  }

  /**
   * Remplissage automatique : produits → pages (listes d'ids).
   * @param {Array<{id, code, name, category}>} products produits à placer
   *   (déjà filtrés : actifs seulement)
   * @param {object} opts {capacity, sort: 'code'|'name', newPagePerCategory}
   *   newPagePerCategory : chaque catégorie commence sur une nouvelle page
   *   (comme le stock boek de référence) ; les catégories se suivent dans
   *   l'ordre de leur premier produit.
   * @returns {number[][]} une liste d'ids par page
   */
  function planFill(products, { capacity, sort = 'code', newPagePerCategory = false }) {
    const sorted = products.slice().sort(sort === 'name' ? byName : byCode);
    const sections = [];
    if (newPagePerCategory) {
      const byCat = new Map();
      for (const p of sorted) {
        const key = p.category || '';
        if (!byCat.has(key)) {
          byCat.set(key, []);
          sections.push(byCat.get(key));
        }
        byCat.get(key).push(p);
      }
    } else {
      sections.push(sorted);
    }
    const pages = [];
    for (const section of sections) {
      for (let i = 0; i < section.length; i += capacity) {
        pages.push(section.slice(i, i + capacity).map((p) => p.id));
      }
    }
    return pages;
  }

  const FILL_LIST_MAX = 200; // catégories / groupes cochés au plus
  const FILL_TEXT_MAX = 200;
  const TRI = ['1', '0', 'all'];

  /**
   * Options de remplissage automatique envoyées par le client → forme propre,
   * ou null si invalides (le serveur répond alors 400 VALIDATION).
   *  {categories?: string[], groups?: string[], q?: string, photo?, barcode?:
   *   '1'|'0'|'all', sort?: 'code'|'name', newPagePerCategory?: boolean}
   * Listes absentes = pas de filtre ; liste vide `[]` : voir fillHasEmptyList.
   */
  function normalizeFill(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const list = (v) => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.length > FILL_LIST_MAX) return null;
      if (!v.every((x) => typeof x === 'string' && x.length <= FILL_TEXT_MAX)) return null;
      return [...new Set(v)];
    };
    const categories = list(raw.categories);
    const groups = list(raw.groups);
    if (!categories || !groups) return null;
    const q = raw.q === undefined || raw.q === null ? '' : raw.q;
    if (typeof q !== 'string' || q.length > 100) return null;
    const photo = raw.photo === undefined ? 'all' : raw.photo;
    const barcode = raw.barcode === undefined ? 'all' : raw.barcode;
    if (!TRI.includes(photo) || !TRI.includes(barcode)) return null;
    const sort = raw.sort === undefined ? 'code' : raw.sort;
    if (sort !== 'code' && sort !== 'name') return null;
    const newPagePerCategory = raw.newPagePerCategory === undefined ? false : raw.newPagePerCategory;
    if (typeof newPagePerCategory !== 'boolean') return null;
    return { categories, groups, q: q.trim(), photo, barcode, sort, newPagePerCategory };
  }

  /** Liste de catégories ou de groupes envoyée VIDE (`[]`) : l'utilisateur a
   *  choisi « certaines catégories » sans en cocher aucune. Ce n'est pas « pas
   *  de filtre » (tout le catalogue) : le serveur refuse (FILL_EMPTY_SELECTION).
   *  Absent = pas de filtre. */
  function fillHasEmptyList(raw) {
    if (raw === null || typeof raw !== 'object') return false;
    return ['categories', 'groups'].some((k) => Array.isArray(raw[k]) && raw[k].length === 0);
  }

  /** Le produit entre-t-il dans le remplissage ? Les produits retirés du
   *  catalogue n'y entrent jamais. Même règle de recherche que la liste des
   *  produits (code ou nom contient le texte, sans tenir compte de la casse).
   *  product : {code, name, category, group, isActive, hasPhoto, hasBarcode} */
  function matchesFill(product, fill) {
    if (!product.isActive) return false;
    if (fill.categories.length && !fill.categories.includes(product.category)) return false;
    if (fill.groups.length && !fill.groups.includes(product.group)) return false;
    if (fill.q) {
      const needle = fill.q.toLowerCase();
      if (!String(product.code).toLowerCase().includes(needle) && !String(product.name).toLowerCase().includes(needle)) {
        return false;
      }
    }
    if (fill.photo !== 'all' && Boolean(product.hasPhoto) !== (fill.photo === '1')) return false;
    if (fill.barcode !== 'all' && Boolean(product.hasBarcode) !== (fill.barcode === '1')) return false;
    return true;
  }

  const NAME_MAX = 200; // longueur max d'un nom de boek (routes/books.js)

  /** Nom d'une copie (copyName(nom) → « nom (kopie) ») borné à NAME_MAX : on
   *  raccourcit le nom d'origine, jamais le suffixe. */
  function copyNameOf(name, copyName) {
    let base = String(name);
    let out = copyName(base);
    while (out.length > NAME_MAX && base.length > 1) {
      base = base.slice(0, Math.max(1, base.length - (out.length - NAME_MAX))).trimEnd() || base.slice(0, 1);
      out = copyName(base);
    }
    return out.slice(0, NAME_MAX);
  }

  return {
    FIXED_KEYS,
    NAME_MAX,
    MAX_PRINTED_PAGES,
    printablePages,
    pageSequence,
    fixedPageCount,
    printedPageCount,
    exceedsPageLimit,
    captionOf,
    bookSpreads,
    cascadeChain,
    planFill,
    normalizeFill,
    fillHasEmptyList,
    matchesFill,
    byCode,
    byName,
    copyNameOf,
  };
});
