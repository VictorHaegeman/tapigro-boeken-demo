/* demo/shared.js — GÉNÉRÉ par scripts/build-demo.js, ne pas modifier.
 * Code du serveur réutilisé tel quel dans la démo statique :
 * server/middleware/errors.js, server/middleware/validate.js, server/services/productRules.js, server/services/layouts.js, server/services/pdf/document.js, server/services/pdf/fonts.js. */
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

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
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

function errorHandler(config) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = Number.isInteger(err.status) ? err.status : 500;
    const code = typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) ? err.code : 'INTERNAL';
    let message = err.message || 'Error';
    if (status >= 500) {
      console.error(err);
      if (config.env === 'production') message = 'Internal server error';
    }
    if (res.headersSent) return;
    const sendJson = () => res.status(status).json({ error: { code, message } });
    if (prefersHtmlPage(req)) {
      // render() avec callback : si la vue échoue, on retombe sur le JSON.
      return res.status(status).render(
        'layout',
        { title: `Erreur ${status}`, page: 'error', status, code, message },
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

module.exports = { HttpError, notFound, errorHandler };

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

function fail(message) {
  return new HttpError(400, 'VALIDATION', message);
}

function coerce(key, value, rule) {
  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string') throw fail(`${key} must be a string`);
      if (rule.trim !== false) value = value.trim();
      const maxLength = rule.maxLength ?? 500;
      if (value.length > maxLength) throw fail(`${key} must be at most ${maxLength} characters`);
      if (rule.minLength && value.length < rule.minLength) {
        throw fail(`${key} must be at least ${rule.minLength} characters`);
      }
      if (rule.pattern && !rule.pattern.test(value)) throw fail(`${key} has an invalid format`);
      return value;
    }
    case 'integer':
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value));
      if (!Number.isFinite(n)) throw fail(`${key} must be a number`);
      if (rule.type === 'integer' && !Number.isInteger(n)) throw fail(`${key} must be an integer`);
      if (rule.min !== undefined && n < rule.min) throw fail(`${key} must be >= ${rule.min}`);
      if (rule.max !== undefined && n > rule.max) throw fail(`${key} must be <= ${rule.max}`);
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1' || value === 1) return true;
      if (value === 'false' || value === '0' || value === 0) return false;
      throw fail(`${key} must be a boolean`);
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
          if (rule.required) throw fail(`${key} is required`);
          if ('default' in rule) out[key] = rule.default;
          continue;
        }
        const value = coerce(key, raw, rule);
        if (rule.enum && !rule.enum.includes(value)) {
          throw fail(`${key} must be one of: ${rule.enum.join(', ')}`);
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

/**
 * Pages de contenu à imprimer. L'éditeur maintient toujours une double page
 * vide en fin de boek : la séquence FINALE de pages 'products' sans items
 * n'est pas imprimée. Les pages 'blank' (pages blanches voulues) et les pages
 * vides SUIVIES d'une page avec items restent rendues.
 * @param {Array<{kind: string, hasItems: boolean}>} allPages ordre page_no
 * @returns la même liste, tronquée
 */
function printablePages(allPages) {
  let lastKeep = -1;
  for (let i = 0; i < allPages.length; i++) {
    if (allPages[i].kind !== 'products' || allPages[i].hasItems) lastKeep = i;
  }
  return allPages.slice(0, lastKeep + 1);
}

/**
 * Dessine tout le boek dans `doc` (document pdfkit sans page, fontes déjà
 * enregistrées). N'appelle ni doc.pipe ni doc.end.
 *
 * @param {PDFDocument} doc
 * @param {object} book
 * @param {object} book.layout layout résolu (pages fixes partagées résolues)
 * @param {boolean} book.withFixedPages le boek utilise-t-il ses pages fixes ?
 * @param {Array<{kind: string, items: () => Array}>} book.pages pages à
 *   imprimer (printablePages) ; `items()` est appelé page par page (mémoire
 *   plate pour les gros boeken)
 * @param {object} ctx { rootDir, imagesDir, texts, warn }
 * @returns {number} nombre de pages produites
 */
function drawBook(doc, { layout, withFixedPages, pages }, ctx) {
  // Dimensions de page depuis le layout, arrondies au centième de pt :
  // A4 210×297 mm → 595.28 × 841.89 pt exactement.
  const pageSize = [mmToPtPage(layout.page.widthMm), mmToPtPage(layout.page.heightMm)];
  let pageCount = 0;
  const addPage = () => {
    doc.addPage({ size: pageSize, margin: 0 });
    pageCount++;
  };

  // Les pages fixes sont un choix du BOEK (migration 004) ; le layout ne fait
  // que les proposer. Même règle que l'éditeur (editor.js).
  const fixed = withFixedPages ? layout.fixedPages || {} : {};
  if (fixed.cover) {
    addPage();
    drawFixedPage(doc, fixed.cover, ctx);
  }
  if (fixed.page2) {
    addPage();
    drawFixedPage(doc, fixed.page2, ctx);
  }
  for (const page of pages) {
    addPage();
    if (page.kind === 'products') drawProductPage(doc, layout, page.items(), ctx);
    // kind 'blank' : page vide.
  }
  if (fixed.back) {
    addPage();
    drawFixedPage(doc, fixed.back, ctx);
  }
  // Boek entièrement vide sans pages fixes : un PDF sans aucune page serait
  // invalide → une page vide.
  if (pageCount === 0) addPage();
  return pageCount;
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
  set("pdf.document", load("server/services/pdf/document.js"));
  set("pdf.fonts", load("server/services/pdf/fonts.js"));
  global.TapigroShared = out;
})(typeof self !== 'undefined' ? self : globalThis);
