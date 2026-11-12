/* demo/shared.js — GÉNÉRÉ par scripts/build-demo.js, ne pas modifier.
 * Code du serveur réutilisé tel quel dans la démo statique :
 * server/middleware/errors.js, server/middleware/validate.js, server/services/productRules.js, server/services/layouts.js, shared/i18n/i18n.js, public/js/book-plan.js, server/services/pdf/document.js, server/services/pdf/fonts.js. */
(function (global) {
  'use strict';
  function norm(p) {
    return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  }
  // Système de fichiers virtuel : les fichiers sont préchargés (fetch) par la
  // page qui en a besoin (demo/pdf-page.js).
  const files = new Map();
  const vfs = {
    files,
    existsSync: (p) => files.has(norm(p)),
    readFileSync: (p) => {
      const data = files.get(norm(p));
      if (data === undefined) throw new Error('ENOENT: ' + p);
      return data;
    },
  };
  const pathShim = {
    sep: '/',
    join: (...parts) => norm(parts.filter((x) => x !== '' && x != null).join('/')),
    basename: (p) => String(p).split('/').pop(),
    dirname: (p) => String(p).split('/').slice(0, -1).join('/') || '.',
  };
  const builtins = { 'node:fs': vfs, fs: vfs, 'node:path': pathShim, path: pathShim };
  const defs = {
"server/middleware/errors.js": function (module, exports, require) {
'use strict';
// Gestion d'erreur unifiée : toute erreur sort en JSON {error: {code, message}}.
// En production les erreurs 5xx ne divulguent ni message interne ni stack.

// `message` : texte technique (anglais, journaux et tests) ; `i18n` : clé de
// traduction (« apiErrors.pageFull ») ou {key, params} — le message renvoyé à
// l'utilisateur est traduit dans SA langue par errorHandler. Sans clé, le
// message générique du code (apiErrors.<CODE>) est utilisé.
class HttpError extends Error {
  constructor(status, code, message, i18n) {
    super(message);
    this.status = status;
    this.code = code;
    if (i18n) this.i18n = typeof i18n === 'string' ? { key: i18n } : i18n;
  }
}

// Message d'erreur dans la langue de la requête.
function translateError(err, code, t, has) {
  if (err.i18n && err.i18n.key) return t(err.i18n.key, err.i18n.params);
  if (has(`apiErrors.${code}`)) return t(`apiErrors.${code}`);
  return null;
}

function notFound(req, res, next) {
  next(new HttpError(404, 'NOT_FOUND', 'Not found'));
}

// Une erreur sur une page HTML (hors /api/* et /img/*) ouverte dans un
// navigateur (Accept privilégiant text/html) rend une page d'erreur sobre
// dans le shell layout.ejs ; les routes API gardent le JSON inchangé.
function prefersHtmlPage(req) {
  if (req.path.startsWith('/api/') || req.path.startsWith('/img/')) return false;
  // Sans en-tête Accept (ou */*), 'json' gagne : seuls les navigateurs
  // (text/html prioritaire) reçoivent la page HTML.
  return req.accepts(['json', 'html']) === 'html';
}

// i18n : server/i18n.js (injecté par app.js — ce module reste sans dépendance,
// il est aussi utilisé tel quel par la démo statique).
function errorHandler(config, i18n) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = Number.isInteger(err.status) ? err.status : 500;
    const code = typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) ? err.code : 'INTERNAL';
    let message = err.message || 'Error';
    if (status >= 500) {
      console.error(err);
      if (config.env === 'production') message = 'Internal server error';
    }
    // Traduction (langue de la requête ; avant le middleware de langue, celle
    // du .env). En développement, une 5xx garde son détail technique.
    const t = req.t || (i18n ? i18n.translator(config.lang) : (k) => k);
    if (i18n && !(status >= 500 && config.env !== 'production')) {
      message = translateError(err, code, t, i18n.has) || message;
    }
    if (res.headersSent) return;
    const sendJson = () => res.status(status).json({ error: { code, message } });
    if (prefersHtmlPage(req)) {
      // render() avec callback : si la vue échoue, on retombe sur le JSON.
      return res.status(status).render(
        'layout',
        { title: t('error.titleOther', { status }), page: 'error', status, code, message },
        (renderErr, html) => {
          if (renderErr) {
            console.error(renderErr);
            return sendJson();
          }
          res.type('html').send(html);
        }
      );
    }
    sendJson();
  };
}

module.exports = { HttpError, notFound, errorHandler, translateError };

},
"server/middleware/validate.js": function (module, exports, require) {
'use strict';
// Validation par petits schémas maison (ARCHITECTURE §8).
// Usage : router.post('/api/x', validate({ name: { type: 'string', required: true, maxLength: 100 } }), handler)
// Les champs validés (et EUX SEULS — les clés inconnues sont ignorées) sont
// posés sur req.valid. `source` peut être 'body' (défaut) ou 'query'.
//
// Règles supportées par champ :
//   type: 'string' | 'integer' | 'number' | 'boolean'
//   required, default, enum: [..]
//   string : minLength, maxLength (défaut 500), pattern (RegExp), trim (défaut true)
//   integer/number : min, max
const { HttpError } = require('./errors');

// Erreur de validation : message technique (anglais) + clé traduite pour
// l'utilisateur (validation.<règle>, paramètres {field, min, max, values}).
function fail(message, rule, params) {
  return new HttpError(400, 'VALIDATION', message, rule ? { key: `validation.${rule}`, params } : undefined);
}

function coerce(key, value, rule) {
  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string') throw fail(`${key} must be a string`, 'string', { field: key });
      if (rule.trim !== false) value = value.trim();
      const maxLength = rule.maxLength ?? 500;
      if (value.length > maxLength) {
        throw fail(`${key} must be at most ${maxLength} characters`, 'maxLength', { field: key, max: maxLength });
      }
      if (rule.minLength && value.length < rule.minLength) {
        throw fail(`${key} must be at least ${rule.minLength} characters`, 'minLength', { field: key, min: rule.minLength });
      }
      if (rule.pattern && !rule.pattern.test(value)) throw fail(`${key} has an invalid format`, 'format', { field: key });
      return value;
    }
    case 'integer':
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value));
      if (!Number.isFinite(n)) throw fail(`${key} must be a number`, 'number', { field: key });
      if (rule.type === 'integer' && !Number.isInteger(n)) throw fail(`${key} must be an integer`, 'integer', { field: key });
      if (rule.min !== undefined && n < rule.min) throw fail(`${key} must be >= ${rule.min}`, 'min', { field: key, min: rule.min });
      if (rule.max !== undefined && n > rule.max) throw fail(`${key} must be <= ${rule.max}`, 'max', { field: key, max: rule.max });
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1' || value === 1) return true;
      if (value === 'false' || value === '0' || value === 0) return false;
      throw fail(`${key} must be a boolean`, 'boolean', { field: key });
    }
    default:
      throw new Error(`validate: unknown type for ${key}`);
  }
}

function validate(schema, source = 'body') {
  return (req, res, next) => {
    try {
      const data = req[source] && typeof req[source] === 'object' ? req[source] : {};
      const out = {};
      for (const [key, rule] of Object.entries(schema)) {
        const raw = data[key];
        if (raw === undefined || raw === null || raw === '') {
          if (rule.required) throw fail(`${key} is required`, 'required', { field: key });
          if ('default' in rule) out[key] = rule.default;
          continue;
        }
        const value = coerce(key, raw, rule);
        if (rule.enum && !rule.enum.includes(value)) {
          throw fail(`${key} must be one of: ${rule.enum.join(', ')}`, 'enum', {
            field: key,
            values: rule.enum.join(', '),
          });
        }
        out[key] = value;
      }
      req.valid = out;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { validate };

},
"server/services/productRules.js": function (module, exports, require) {
'use strict';
// Règles PARTAGÉES sur les données produit (API manuelle ET imports) — un seul
// endroit pour qu'aucun chemin d'écriture n'ait sa propre variante.
//
// 1. Codes réservés : le code produit sert de nom de fichier image
//    (`<CODE>.png` = photo, `<CODE>-BAR.png` = code-barres, cf. imageStore).
//    Un produit dont le code FINIT par `-bar` (casse indifférente) écrirait sa
//    photo dans le fichier code-barres du produit voisin (`X-BAR` ↔ `X`) :
//    ces codes sont refusés partout (création manuelle et import Excel).
// 2. Textes : aucun caractère de contrôle [\x00-\x1f] (ni DEL) dans les champs
//    libres — rejetés par l'API, nettoyés à l'import.

// Alphabet strict du code (ARCHITECTURE §8, même règle que l'import d'images).
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const RESERVED_SUFFIX_RE = /-bar$/i;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const CONTROL_CHARS_GLOBAL_RE = /[\x00-\x1f\x7f]+/g;
// Pour validate({ pattern }) : chaîne sans caractère de contrôle.
const NO_CONTROL_RE = /^[^\x00-\x1f\x7f]*$/;

const RESERVED_CODE_MESSAGE =
  'Un code produit ne peut pas finir par « -BAR » : ce suffixe est réservé aux fichiers de code-barres';

// true si le code entrerait en collision avec un fichier code-barres.
function isReservedCode(code) {
  return RESERVED_SUFFIX_RE.test(String(code ?? ''));
}

function hasControlChars(value) {
  return CONTROL_CHARS_RE.test(String(value ?? ''));
}

// Nettoyage à l'import : chaque suite de caractères de contrôle (retour à la
// ligne dans une cellule Excel, tabulation…) devient une espace.
function cleanText(value) {
  return String(value ?? '').replace(CONTROL_CHARS_GLOBAL_RE, ' ').trim();
}

module.exports = {
  CODE_RE,
  NO_CONTROL_RE,
  RESERVED_CODE_MESSAGE,
  isReservedCode,
  hasControlChars,
  cleanText,
};

},
"server/services/layouts.js": function (module, exports, require) {
'use strict';
// Chargement des layouts (shared/layouts/*.json) — LE point d'entrée unique,
// utilisé par l'API (/api/layouts → aperçu HTML), le service des boeken et le
// rendu PDF : tous voient exactement le même objet, donc le même rendu.
//
// Pages fixes PARTAGÉES (shared/layout-schema.md §fixedPages) : un layout peut
// écrire `"fixedPages": "standard"` au lieu de recopier les définitions ; la
// référence est RÉSOLUE ici en `{cover, page2, back}` depuis
// shared/fixed-pages/<nom>.json. Les consommateurs ne voient jamais la forme
// référence. Une définition en ligne (objet) reste acceptée.
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FIXED_KEYS = ['cover', 'page2', 'back'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// `fixedPages` d'un layout → objet {cover?, page2?, back?} (jamais une chaîne).
function resolveFixedPages(rootDir, layout) {
  const ref = layout.fixedPages;
  if (ref === undefined || ref === null) return {};
  if (typeof ref !== 'string') return ref; // définition en ligne
  if (!ID_RE.test(ref)) {
    throw new Error(`layout ${layout.id}: fixedPages "${ref}" n'est pas un nom valide`);
  }
  const file = path.join(rootDir, 'shared', 'fixed-pages', `${ref}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`layout ${layout.id}: pages fixes "${ref}" introuvables (${file})`);
  }
  const set = readJson(file);
  // Les éléments sont positionnés en mm sur la page entière : le jeu partagé
  // n'est valable que pour le format de page pour lequel il a été dessiné.
  if (
    set.page &&
    (set.page.widthMm !== layout.page.widthMm || set.page.heightMm !== layout.page.heightMm)
  ) {
    throw new Error(
      `layout ${layout.id}: les pages fixes "${ref}" sont dessinées pour ${set.page.widthMm}×${set.page.heightMm} mm`
    );
  }
  const out = {};
  for (const key of FIXED_KEYS) {
    if (set.pages && set.pages[key]) out[key] = set.pages[key];
  }
  return out;
}

function resolveLayout(rootDir, layout) {
  return { ...layout, fixedPages: resolveFixedPages(rootDir, layout) };
}

/** Tous les layouts, triés par nom de fichier, pages fixes résolues. */
function loadLayouts(rootDir) {
  const dir = path.join(rootDir, 'shared', 'layouts');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => resolveLayout(rootDir, readJson(path.join(dir, f))));
}

/** Un layout par id (pages fixes résolues) ; null si inconnu. */
function loadLayout(rootDir, layoutId) {
  if (!ID_RE.test(String(layoutId))) return null;
  const file = path.join(rootDir, 'shared', 'layouts', `${layoutId}.json`);
  if (!fs.existsSync(file)) return null;
  return resolveLayout(rootDir, readJson(file));
}

// Slots de texte d'un layout = tous les `textSlot` de ses pages fixes.
function layoutSlots(layout) {
  const slots = new Set();
  for (const page of Object.values(layout.fixedPages || {})) {
    for (const el of page.elements || []) {
      if (el.type === 'textSlot') slots.add(el.slot);
    }
  }
  return slots;
}

// Un layout PROPOSE-t-il des pages fixes ? (le boek décide ensuite de les utiliser)
function hasFixedPages(layout) {
  return Object.keys(layout.fixedPages || {}).length > 0;
}

module.exports = { loadLayouts, loadLayout, resolveFixedPages, layoutSlots, hasFixedPages };

},
"shared/i18n/i18n.js": function (module, exports, require) {
/* i18n.js — traduction de Tapigro Boeken (FR / NL), sans dépendance.
 *
 * Dictionnaires : shared/i18n/<langue>.json (mêmes clés dans chaque langue —
 * vérifié par tests/a/i18n.test.js). Une valeur est
 *   - une chaîne avec paramètres « {nom} » : "Pagina {n}" ;
 *   - ou un objet de pluriel {"one": "…", "other": "…"} choisi par params.n.
 * Clé absente dans la langue → langue de secours (nl) → la clé elle-même
 * (visible, donc repérable, jamais d'exception).
 *
 * Module UMD : serveur (server/i18n.js, vues EJS, messages d'API) et client
 * (servi avec le dictionnaire par GET /i18n/<langue>.js → window.TapigroI18n).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TapigroI18nCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LANGS = ['nl', 'fr'];
  const DEFAULT_LANG = 'nl';
  // Formats de dates et de nombres : Belgique.
  const LOCALES = { nl: 'nl-BE', fr: 'fr-BE' };

  function isLang(value) {
    return LANGS.includes(value);
  }

  function lookup(dict, key) {
    let node = dict;
    for (const part of String(key).split('.')) {
      if (node === null || typeof node !== 'object' || !(part in node)) return undefined;
      node = node[part];
    }
    return node;
  }

  function interpolate(template, params) {
    return String(template).replace(/\{(\w+)\}/g, (m, name) =>
      params && params[name] !== undefined && params[name] !== null ? String(params[name]) : m
    );
  }

  /**
   * @param {object} dict dictionnaire de la langue
   * @param {object} [fallback] dictionnaire de secours
   * @returns {(key: string, params?: object) => string}
   */
  function createTranslator(dict, fallback) {
    return function t(key, params) {
      let value = lookup(dict, key);
      if (value === undefined && fallback) value = lookup(fallback, key);
      if (value === undefined) return key;
      if (value && typeof value === 'object') {
        // Pluriel : « one » pour 1 (et 0 en français, comme l'usage).
        const n = params ? Number(params.n) : NaN;
        const lang = lookup(dict, '_lang') || DEFAULT_LANG;
        const one = n === 1 || (lang === 'fr' && n === 0);
        value = one && value.one !== undefined ? value.one : value.other;
        if (value === undefined) return key;
      }
      return interpolate(value, params);
    };
  }

  // Toutes les clés « a.b.c » d'un dictionnaire (objets de pluriel = une clé).
  function flattenKeys(dict, prefix = '') {
    const keys = [];
    for (const [k, v] of Object.entries(dict)) {
      const full = prefix ? `${prefix}.${k}` : k;
      const isPlural = v && typeof v === 'object' && Object.keys(v).every((x) => x === 'one' || x === 'other');
      if (v && typeof v === 'object' && !isPlural) keys.push(...flattenKeys(v, full));
      else keys.push(full);
    }
    return keys;
  }

  return { LANGS, DEFAULT_LANG, LOCALES, isLang, createTranslator, interpolate, flattenKeys, lookup };
});

},
"public/js/book-plan.js": function (module, exports, require) {
/* book-plan.js — règles PURES d'un boek, partagées par le serveur (bookService,
 * export PDF), le navigateur (éditeur, aperçu) et la démo statique. Une seule
 * écriture → l'aperçu, l'éditeur et le PDF ne peuvent pas diverger.
 *
 *  - printablePages / pageSequence : quelles pages sont imprimées et avec
 *    quel numéro (celui du PDF) ;
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
    printablePages,
    pageSequence,
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

},
"server/services/pdf/document.js": function (module, exports, require) {
'use strict';
// Composition d'un boek en pages pdfkit — partie PURE du rendu PDF, sans BDD
// ni système de fichiers propres : renderer.js (serveur) l'alimente depuis
// SQLite, la version démo statique (demo/, scripts/build-demo.js) depuis le
// navigateur. Un seul code d'ordonnancement → un seul résultat.
//
// Ordre : cover → page2 → pages de contenu (page_no croissant, `blank` rendues
// vides) → dos ; pages fixes seulement si le boek les utilise.
const { mmToPtPage } = require('./units');
const { drawFixedPage } = require('./drawFixedPage');
const { drawProductPage } = require('./drawProductPage');

// Quelles pages sont imprimées, dans quel ordre et avec quel numéro : UNE
// seule règle (public/js/book-plan.js pageSequence), partagée avec l'éditeur
// et l'aperçu. printablePages reste exporté (préchargement de la démo).
const { pageSequence, printablePages } = require('../../../public/js/book-plan');

/**
 * Dessine tout le boek dans `doc` (document pdfkit sans page, fontes déjà
 * enregistrées). N'appelle ni doc.pipe ni doc.end.
 *
 * @param {PDFDocument} doc
 * @param {object} book
 * @param {object} book.layout layout résolu (pages fixes partagées résolues)
 * @param {boolean} book.withFixedPages le boek utilise-t-il ses pages fixes ?
 * @param {Array<{kind: string, hasItems: boolean, items: () => Array}>} book.pages
 *   TOUTES les pages de contenu (ordre page_no) ; `items()` n'est appelé que
 *   pour les pages imprimées, page par page (mémoire plate pour les gros boeken)
 * @param {object} ctx { rootDir, imagesDir, texts, warn }
 * @returns {number} nombre de pages produites
 */
function drawBook(doc, { layout, withFixedPages, pages }, ctx) {
  // Dimensions de page depuis le layout, arrondies au centième de pt :
  // A4 210×297 mm → 595.28 × 841.89 pt exactement.
  const pageSize = [mmToPtPage(layout.page.widthMm), mmToPtPage(layout.page.heightMm)];
  const fixed = layout.fixedPages || {};
  // Séquence commune : cover → page2 → contenu (double page vide de fin omise,
  // pages `blank` vides) → dos ; un boek sans rien d'imprimable = 1 page vide
  // (un PDF sans page serait invalide).
  const sequence = pageSequence({ fixedPages: Boolean(withFixedPages), pages }, layout).filter((e) => e.printed);
  for (const entry of sequence) {
    doc.addPage({ size: pageSize, margin: 0 });
    if (entry.type === 'cover' || entry.type === 'page2' || entry.type === 'back') {
      drawFixedPage(doc, fixed[entry.type], ctx);
    } else if (entry.type === 'products') {
      drawProductPage(doc, layout, entry.page.items(), ctx);
    }
    // 'blank' : page vide.
  }
  return sequence.length;
}

module.exports = { drawBook, printablePages };

},
"server/services/pdf/fonts.js": function (module, exports, require) {
'use strict';
// Enregistrement des fontes embarquées dans pdfkit — les MÊMES fichiers que
// le @font-face de l'aperçu HTML (public/assets/fonts/, ARCHITECTURE §7) :
// mêmes métriques, donc même rendu. Sélection par (weight, style) du layout.
const fs = require('node:fs');
const path = require('node:path');

// Nom logique pdfkit → fichier. Pas de variante Bold-Italic dans le repo :
// bold prime sur italic si les deux sont demandés (cas absent des layouts v1).
const FACES = {
  sans: 'LiberationSans-Regular.ttf',
  'sans-bold': 'LiberationSans-Bold.ttf',
  'sans-italic': 'LiberationSans-Italic.ttf',
};

/**
 * Enregistre les fontes du repo dans le document pdfkit.
 * @param {PDFDocument} doc
 * @param {string} rootDir racine du repo (config.rootDir)
 */
function registerFonts(doc, rootDir) {
  const dir = path.join(rootDir, 'public', 'assets', 'fonts');
  for (const [name, file] of Object.entries(FACES)) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) {
      throw new Error(`Fonte manquante : ${full} (requise pour l'export PDF)`);
    }
    doc.registerFont(name, full);
  }
}

/** Nom de fonte pdfkit pour un élément de layout ({weight, style}). */
function fontFor(element) {
  if (element.weight === 'bold') return 'sans-bold';
  if (element.style === 'italic') return 'sans-italic';
  return 'sans';
}

module.exports = { registerFonts, fontFor, FACES };

},
"server/services/pdf/units.js": function (module, exports, require) {
'use strict';
// Conversion millimètre → point PDF (1 pt = 1/72 in, 1 in = 25.4 mm).
// Unité unique des layouts : le mm (shared/layout-schema.md) ; pdfkit
// travaille en pt. Toute la géométrie du PDF passe par ce module.

const PT_PER_MM = 72 / 25.4;

/** mm → pt, non arrondi (précision maximale pour le positionnement). */
function mmToPt(mm) {
  return mm * PT_PER_MM;
}

/**
 * mm → pt arrondi à 2 décimales — pour les dimensions de page uniquement,
 * afin d'obtenir le format A4 canonique 595.28 × 841.89 pt attendu par les
 * imprimeurs (210 mm = 595.27559… pt).
 */
function mmToPtPage(mm) {
  return Math.round(mmToPt(mm) * 100) / 100;
}

/**
 * Géométrie dérivée d'un layout (layout-schema.md §Dérivations) : capacité,
 * taille de cellule (mm) et position (mm) de la cellule i (ordre de lecture
 * gauche → droite puis haut → bas). Rien n'est stocké : tout vient du JSON.
 */
function gridGeometry(layout) {
  const { page, grid } = layout;
  const m = page.marginMm;
  const cellW =
    (page.widthMm - m.left - m.right - (grid.columns - 1) * grid.gapXMm) / grid.columns;
  const cellH =
    (page.heightMm - m.top - m.bottom - (grid.rows - 1) * grid.gapYMm) / grid.rows;
  const capacity = grid.columns * grid.rows;
  const cellPos = (i) => {
    const col = i % grid.columns;
    const row = Math.floor(i / grid.columns);
    return {
      xMm: m.left + col * (cellW + grid.gapXMm),
      yMm: m.top + row * (cellH + grid.gapYMm),
    };
  };
  return { capacity, cellWMm: cellW, cellHMm: cellH, cellPos };
}

module.exports = { PT_PER_MM, mmToPt, mmToPtPage, gridGeometry };

},
"server/services/pdf/drawFixedPage.js": function (module, exports, require) {
'use strict';
// Rendu des éléments de layout dans pdfkit — primitives communes (texte,
// image) + pages fixes (cover / page2 / back). drawProductPage.js réutilise
// `drawElement` : un seul chemin de rendu pour un seul contrat (le JSON en mm,
// shared/layout-schema.md). AUCUNE géométrie codée en dur : tout x/y/w/h/fonte
// vient de l'élément, seule l'épaisseur du cadre fin des boîtes d'image
// (style, pas mise en page) est fixée ici.
const fs = require('node:fs');
const path = require('node:path');
const { mmToPt } = require('./units');
const { fontFor } = require('./fonts');

// Cadre fin des boîtes d'image : photo toujours encadrée (fidélité au stock
// boek de référence), toute image absente/illisible → « cadre vide propre ».
const IMAGE_FRAME_WIDTH_MM = 0.2;
const IMAGE_FRAME_COLOR = '#999999';

// Interligne de l'aperçu HTML (layout-render.js : line-height 1.15) — le PDF
// DOIT replier et tronquer aux mêmes endroits que l'écran.
const LINE_HEIGHT_FACTOR = 1.15;
// Défaut de taille de fonte de l'aperçu (applyTextStyle : fontMm || 3).
const DEFAULT_FONT_MM = 3;

/** Valeur affichable d'un champ produit (minimum_stock : nombre tel quel, vide si NULL). */
function fieldText(product, field) {
  const v = product ? product[field] : undefined;
  if (v === null || v === undefined) return '';
  return String(v);
}

/**
 * Dessine UN élément de layout.
 * @param {PDFDocument} doc
 * @param {object} el élément du layout (label | field | textSlot | image)
 * @param {object} ctx {
 *   originXMm, originYMm : origine (mm) du repère des éléments (0,0 pour une
 *     page fixe ; coin intérieur de cellule pour une cellule produit),
 *   product   : ligne produit (cellules) avec photo_file/barcode_file,
 *   texts     : books.texts_json parsé (pages fixes),
 *   rootDir   : racine du repo (assets statiques),
 *   imagesDir : data/images,
 *   warn(msg) : collecte d'avertissements (jamais d'exception de rendu)
 * }
 */
function drawElement(doc, el, ctx) {
  const x = mmToPt(ctx.originXMm + el.xMm);
  const y = mmToPt(ctx.originYMm + el.yMm);

  if (el.type === 'image') {
    drawImage(doc, el, x, y, ctx);
    return;
  }

  let text;
  if (el.type === 'label') {
    text = el.text || '';
  } else if (el.type === 'field') {
    text = fieldText(ctx.product, el.field);
  } else if (el.type === 'textSlot') {
    // Sémantique de l'aperçu (layout-render.js) : la clé EXISTE dans
    // texts_json → sa valeur fait foi (null/'' compris → vide), sinon défaut.
    const texts = ctx.texts || {};
    if (Object.prototype.hasOwnProperty.call(texts, el.slot)) {
      text = texts[el.slot] === null || texts[el.slot] === undefined ? '' : String(texts[el.slot]);
    } else {
      text = el.default || '';
    }
  } else {
    ctx.warn(`élément de type inconnu ignoré : ${el.type}`);
    return;
  }
  if (text === '') return;

  const fontMm = el.fontMm || DEFAULT_FONT_MM; // même défaut que l'aperçu
  // colorHex (layout-schema.md) : même défaut que l'aperçu (applyTextStyle).
  doc.font(fontFor(el)).fontSize(mmToPt(fontMm)).fillColor(el.colorHex || '#000000');
  drawTextBox(doc, text, {
    xPt: x,
    yPt: y,
    wPt: mmToPt(el.wMm),
    hPt: el.hMm !== undefined ? mmToPt(el.hMm) : null,
    align: el.align || 'left',
    lineHeightPt: mmToPt(fontMm * LINE_HEIGHT_FACTOR),
  });
}

/**
 * Découpe un texte en lignes comme le CSS de l'aperçu : repli aux espaces
 * UNIQUEMENT (un mot plus large que la boîte reste entier sur sa ligne — il
 * sera rogné par le clipping, comme overflow:hidden à l'écran ; pdfkit, lui,
 * couperait au milieu du mot). Fonte/taille déjà posées sur `doc`.
 */
function wrapLines(doc, text, wPt) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = words[0];
    for (const word of words.slice(1)) {
      if (doc.widthOfString(`${line} ${word}`) <= wPt) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Texte replié puis tronqué dans sa boîte (layout-schema.md), à l'identique
 * de l'aperçu HTML : interligne 1.15 × fontMm et clipping au rect de la boîte
 * (équivalent d'overflow:hidden — un débordement horizontal ou vertical est
 * rogné, jamais répandu dans la cellule voisine). Une ligne qui démarre dans
 * la boîte est dessinée (partiellement visible si elle dépasse, comme à
 * l'écran) ; une ligne qui démarre après le bas de la boîte ne l'est pas.
 */
function drawTextBox(doc, text, { xPt, yPt, wPt, hPt, align, lineHeightPt }) {
  const lines = wrapLines(doc, text, wPt);
  // Sans hMm, la boîte CSS a une hauteur auto : pas de troncature verticale.
  const clipH = hPt !== null ? hPt : lines.length * lineHeightPt;
  doc.save();
  doc.rect(xPt, yPt, wPt, clipH).clip();
  let y = yPt;
  for (const line of lines) {
    if (y - yPt >= clipH) break; // démarre après le bas de la boîte
    if (line !== '') {
      const lineW = doc.widthOfString(line);
      let x = xPt;
      if (align === 'right') x += wPt - lineW;
      else if (align === 'center') x += (wPt - lineW) / 2;
      // Sans option width : pdfkit ne replie pas, la ligne est posée telle quelle.
      doc.text(line, x, y, { lineBreak: false });
    }
    y += lineHeightPt;
  }
  doc.restore();
}

function drawImage(doc, el, x, y, ctx) {
  const w = mmToPt(el.wMm);
  const h = mmToPt(el.hMm);
  let file = null;
  if (el.asset) {
    // Image statique du repo (pages fixes) — donnée du layout, pas du client.
    file = path.join(ctx.rootDir, 'public', 'assets', path.basename(el.asset));
  } else if (el.field === 'photo' || el.field === 'barcode') {
    const name = ctx.product ? ctx.product[`${el.field}_file`] : null;
    if (name) file = path.join(ctx.imagesDir, name);
  }

  let drawn = false;
  if (file) {
    if (!fs.existsSync(file)) {
      ctx.warn(`image introuvable sur le disque : ${file}`);
    } else {
      try {
        // fit : l'image est PLACÉE à l'échelle dans la boîte, pdfkit incorpore
        // les octets d'origine (PNG/JPEG) sans recompression ni resampling —
        // résolution native préservée (codes-barres lisibles au scanner).
        doc.image(file, x, y, { fit: [w, h], align: 'center', valign: 'center' });
        drawn = true;
      } catch (err) {
        ctx.warn(`image illisible (${err.message}) : ${file}`);
      }
    }
  }
  // Cadre vide propre si absente/illisible ; les photos sont toujours
  // encadrées (référence THE_ONE.pdf), les codes-barres/assets jamais.
  if (!drawn || el.field === 'photo') {
    doc
      .save()
      .lineWidth(mmToPt(IMAGE_FRAME_WIDTH_MM))
      .strokeColor(IMAGE_FRAME_COLOR)
      .rect(x, y, w, h)
      .stroke()
      .restore();
  }
}

/**
 * Dessine une page fixe (cover/page2/back) : éléments positionnés en mm par
 * rapport à la page entière (ni grille ni padding). La page doit déjà avoir
 * été ajoutée au document par l'appelant.
 */
function drawFixedPage(doc, fixedPageDef, ctx) {
  for (const el of fixedPageDef.elements || []) {
    drawElement(doc, el, { ...ctx, originXMm: 0, originYMm: 0, product: null });
  }
}

module.exports = { drawFixedPage, drawElement };

},
"server/services/pdf/drawProductPage.js": function (module, exports, require) {
'use strict';
// Rendu d'une page de contenu : grille columns × rows dérivée du layout JSON
// (shared/layout-schema.md §Dérivations), une cellule par item dans l'ordre de
// lecture (gauche → droite puis haut → bas, aligné sur book_items.position
// croissant). Pages `blank` : l'appelant ne passe aucun item → page vide.
const { mmToPt, gridGeometry } = require('./units');
const { drawElement } = require('./drawFixedPage');

/**
 * @param {PDFDocument} doc page courante déjà ajoutée
 * @param {object} layout layout JSON complet
 * @param {Array} items lignes produit ordonnées par position
 *   ({product_code, name, category, product_group, unit, minimum_stock,
 *     photo_file, barcode_file})
 * @param {object} ctx { rootDir, imagesDir, warn }
 */
function drawProductPage(doc, layout, items, ctx) {
  const geo = gridGeometry(layout);
  const cell = layout.cell || {};
  const padding = cell.paddingMm || 0;
  const count = Math.min(items.length, geo.capacity);
  if (items.length > geo.capacity) {
    ctx.warn(
      `page avec ${items.length} items pour une capacité de ${geo.capacity} : surplus ignoré`
    );
  }

  const borderW = cell.border && cell.border.widthMm ? cell.border.widthMm : 0;

  for (let i = 0; i < count; i++) {
    const { xMm, yMm } = geo.cellPos(i);

    if (borderW) {
      // CSS dessine la bordure À L'INTÉRIEUR de la cellule (box-sizing:
      // border-box) ; le trait pdfkit est centré sur le chemin → rect insetté
      // de widthMm/2 pour que le trait reste entièrement dans la cellule.
      doc
        .save()
        .lineWidth(mmToPt(borderW))
        .strokeColor(cell.border.color || '#000000')
        .rect(
          mmToPt(xMm + borderW / 2),
          mmToPt(yMm + borderW / 2),
          mmToPt(geo.cellWMm - borderW),
          mmToPt(geo.cellHMm - borderW)
        )
        .stroke()
        .restore();
    }

    // Coordonnées des éléments : relatives au coin haut-gauche de la zone
    // intérieure — après la bordure (l'aperçu positionne la zone intérieure
    // dans la boîte de padding, donc à bord + bordure + padding) puis padding.
    const elementCtx = {
      ...ctx,
      originXMm: xMm + borderW + padding,
      originYMm: yMm + borderW + padding,
      product: items[i],
      texts: null,
    };
    for (const el of cell.elements || []) {
      drawElement(doc, el, elementCtx);
    }
  }
}

module.exports = { drawProductPage };

}
  };
  const cache = {};
  function resolve(from, spec) {
    const parts = from.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    let target = parts.join('/');
    if (!target.endsWith('.js')) target += '.js';
    return target;
  }
  function load(id) {
    if (cache[id]) return cache[id].exports;
    const module = { exports: {} };
    cache[id] = module;
    defs[id](module, module.exports, (spec) => (spec in builtins ? builtins[spec] : load(resolve(id, spec))));
    return module.exports;
  }
  const out = { fs: vfs };
  function set(name, value) {
    const keys = name.split('.');
    let o = out;
    while (keys.length > 1) {
      const k = keys.shift();
      o = o[k] = o[k] || {};
    }
    o[keys[0]] = value;
  }
  set("errors", load("server/middleware/errors.js"));
  set("validate", load("server/middleware/validate.js"));
  set("productRules", load("server/services/productRules.js"));
  set("layouts", load("server/services/layouts.js"));
  set("i18n", load("shared/i18n/i18n.js"));
  set("bookPlan", load("public/js/book-plan.js"));
  set("pdf.document", load("server/services/pdf/document.js"));
  set("pdf.fonts", load("server/services/pdf/fonts.js"));
  global.TapigroShared = out;
})(typeof self !== 'undefined' ? self : globalThis);
