/* layout-render.js — LE rendu d'aperçu des pages (tâche C).
 *
 * Consomme les layouts JSON de shared/layouts/ (contrat : shared/layout-schema.md)
 * et produit le DOM d'une page A4 en millimètres : conteneur 210×297 mm,
 * positionnement CSS en mm, mis à l'échelle par transform: scale() par
 * l'appelant. La tâche D (pdfkit) doit produire le même résultat depuis le
 * même JSON — ne pas introduire ici de géométrie absente du layout.
 *
 * Module UMD : utilisable dans le navigateur (window.LayoutRender) et en
 * Node pour tester la géométrie pure (cellSize, cellOrigin, pageCapacity).
 * Les styles sont posés via CSSOM (el.style) : compatibles CSP stricte.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LayoutRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- géométrie pure (shared/layout-schema.md §Dérivations) -----------------

  function pageCapacity(layout) {
    return layout.grid.columns * layout.grid.rows;
  }

  function cellSize(layout) {
    const { page, grid } = layout;
    const m = page.marginMm;
    return {
      wMm: (page.widthMm - m.left - m.right - (grid.columns - 1) * grid.gapXMm) / grid.columns,
      hMm: (page.heightMm - m.top - m.bottom - (grid.rows - 1) * grid.gapYMm) / grid.rows,
    };
  }

  // Coin haut-gauche de la cellule i (ordre de lecture : gauche→droite, haut→bas).
  function cellOrigin(layout, i) {
    const { page, grid } = layout;
    const { wMm, hMm } = cellSize(layout);
    const col = i % grid.columns;
    const row = Math.floor(i / grid.columns);
    return {
      xMm: page.marginMm.left + col * (wMm + grid.gapXMm),
      yMm: page.marginMm.top + row * (hMm + grid.gapYMm),
    };
  }

  // ---- rendu DOM ---------------------------------------------------------------

  // URL d'un fichier servi par l'app (« /img/… », « /assets/… ») : traduite par
  // App.url quand il existe (navigateur, cf. common.js), inchangée sinon (Node).
  function appUrl(path) {
    const app = typeof self !== 'undefined' ? self.App : null;
    return app && typeof app.url === 'function' ? app.url(path) : path;
  }

  function mm(n) {
    return `${n}mm`;
  }

  function div(className) {
    const el = document.createElement('div');
    el.className = className;
    return el;
  }

  function applyTextStyle(el, spec) {
    el.style.fontSize = mm(spec.fontMm || 3);
    el.style.lineHeight = '1.15';
    el.style.textAlign = spec.align || 'left';
    el.style.fontWeight = spec.weight === 'bold' ? '700' : '400';
    el.style.fontStyle = spec.style === 'italic' ? 'italic' : 'normal';
    // colorHex (layout-schema.md) : même défaut que le PDF (drawFixedPage.js).
    el.style.color = spec.colorHex || '#000000';
  }

  function placeBox(el, spec) {
    el.style.position = 'absolute';
    el.style.left = mm(spec.xMm);
    el.style.top = mm(spec.yMm);
    el.style.width = mm(spec.wMm);
    if (spec.hMm !== undefined) el.style.height = mm(spec.hMm);
    el.style.overflow = 'hidden';
  }

  function fieldValue(product, field) {
    if (!product) return '';
    const map = {
      product_code: product.code,
      name: product.name,
      category: product.category,
      product_group: product.group,
      unit: product.unit,
      minimum_stock: product.minimumStock,
    };
    const v = map[field];
    return v === null || v === undefined ? '' : String(v);
  }

  function imageUrl(product, field) {
    if (!product) return null;
    if (field === 'photo') return product.hasPhoto ? appUrl(`/img/${encodeURIComponent(product.code)}/photo`) : null;
    if (field === 'barcode') return product.hasBarcode ? appUrl(`/img/${encodeURIComponent(product.code)}/barcode`) : null;
    return null;
  }

  // Un élément de layout → un nœud DOM. `ctx` : {product?, texts?, slotNodes?}.
  function renderElement(spec, ctx) {
    switch (spec.type) {
      case 'label': {
        const el = div('lr-label');
        placeBox(el, spec);
        applyTextStyle(el, spec);
        el.textContent = spec.text;
        return el;
      }
      case 'field': {
        const el = div('lr-field');
        placeBox(el, spec);
        applyTextStyle(el, spec);
        el.textContent = fieldValue(ctx.product, spec.field);
        return el;
      }
      case 'image': {
        const el = div('lr-imgbox');
        placeBox(el, spec);
        const url = spec.asset ? appUrl(`/assets/${encodeURIComponent(spec.asset)}`) : imageUrl(ctx.product, spec.field);
        if (url) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          img.draggable = false;
          img.style.width = '100%';
          img.style.height = '100%';
          img.style.objectFit = spec.fit === 'contain' ? 'contain' : 'fill';
          // Image absente → boîte vide, pas d'icône d'image cassée.
          img.addEventListener('error', () => img.remove());
          el.appendChild(img);
        }
        return el;
      }
      case 'textSlot': {
        const el = div('lr-slot');
        placeBox(el, spec);
        applyTextStyle(el, spec);
        el.style.whiteSpace = 'pre-wrap';
        el.dataset.slot = spec.slot;
        // Indication À L'ÉCRAN pour un texte vide (l'éditeur l'affiche en
        // grisé via CSS) — jamais imprimée : le PDF ignore `placeholder`.
        if (spec.placeholder) el.dataset.placeholder = spec.placeholder;
        const texts = ctx.texts || {};
        el.textContent =
          Object.prototype.hasOwnProperty.call(texts, spec.slot) ? texts[spec.slot] : spec.default || '';
        if (ctx.slotNodes) ctx.slotNodes.push(el);
        return el;
      }
      default:
        return div('lr-unknown');
    }
  }

  function basePage(layout, className) {
    const page = div(`lr-page ${className}`);
    page.style.position = 'relative';
    page.style.width = mm(layout.page.widthMm);
    page.style.height = mm(layout.page.heightMm);
    return page;
  }

  // Une cellule produit (contenu d'un item). item = {id, product}.
  // La cellule N'EST PAS positionnée : la page de contenu est une grille CSS
  // dont l'ordre DOM = ordre de lecture = book_items.position croissant.
  function renderCell(layout, item) {
    const { wMm, hMm } = cellSize(layout);
    const cell = div('lr-cell');
    cell.style.position = 'relative';
    cell.style.width = mm(wMm);
    cell.style.height = mm(hMm);
    cell.style.overflow = 'hidden';
    const border = layout.cell.border;
    if (border) {
      cell.style.border = `${border.widthMm}mm solid ${border.color}`;
    }
    if (item && item.id !== undefined) cell.dataset.itemId = String(item.id);
    const inner = div('lr-cell-inner');
    inner.style.position = 'absolute';
    const pad = layout.cell.paddingMm || 0;
    const bw = border ? border.widthMm : 0;
    inner.style.left = mm(pad);
    inner.style.top = mm(pad);
    inner.style.width = mm(wMm - 2 * pad - 2 * bw);
    inner.style.height = mm(hMm - 2 * pad - 2 * bw);
    cell.appendChild(inner);
    for (const spec of layout.cell.elements) {
      inner.appendChild(renderElement(spec, { product: item ? item.product : null }));
    }
    return cell;
  }

  // Page de contenu : grille CSS aux dimensions du layout. items = [{id, product}]
  // dans l'ordre des positions. Retourne {page, grid} — `grid` est le conteneur
  // des cellules (cible SortableJS : l'ordre DOM y fait foi).
  function renderContentPage(layout, items) {
    const page = basePage(layout, 'lr-content');
    const { wMm, hMm } = cellSize(layout);
    const grid = div('lr-grid');
    grid.style.position = 'absolute';
    grid.style.left = mm(layout.page.marginMm.left);
    grid.style.top = mm(layout.page.marginMm.top);
    grid.style.right = mm(layout.page.marginMm.right);
    grid.style.bottom = mm(layout.page.marginMm.bottom);
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = `repeat(${layout.grid.columns}, ${mm(wMm)})`;
    grid.style.gridAutoRows = mm(hMm);
    grid.style.columnGap = mm(layout.grid.gapXMm);
    grid.style.rowGap = mm(layout.grid.gapYMm);
    grid.style.alignContent = 'start';
    for (const item of items) grid.appendChild(renderCell(layout, item));
    page.appendChild(grid);
    return { page, grid };
  }

  // Page fixe (cover | page2 | back) : éléments positionnés par rapport à la
  // page entière. Retourne {page, slotNodes} — slotNodes = les textSlot (à
  // rendre éditables par l'éditeur).
  function renderFixedPage(layout, key, texts) {
    const fixed = (layout.fixedPages || {})[key];
    if (!fixed) return null;
    const page = basePage(layout, `lr-fixed lr-fixed-${key}`);
    const slotNodes = [];
    for (const spec of fixed.elements || []) {
      page.appendChild(renderElement(spec, { texts, slotNodes }));
    }
    return { page, slotNodes };
  }

  // Page blanche (kind='blank') ou placeholder vide.
  function renderBlankPage(layout) {
    return basePage(layout, 'lr-blank');
  }

  return {
    pageCapacity,
    cellSize,
    cellOrigin,
    fieldValue,
    renderCell,
    renderContentPage,
    renderFixedPage,
    renderBlankPage,
  };
});
