/* pdf-page.js — export PDF de la démo, SANS serveur : le vrai moteur de rendu
 * de l'app (server/services/pdf/document.js + drawFixedPage/drawProductPage,
 * regroupés dans demo/shared.js au build) tourne dans le navigateur avec la
 * version autonome de pdfkit (vendor/pdfkit.standalone.js). Mêmes layouts,
 * mêmes fontes, mêmes images → même PDF que l'app.
 *
 * Module UMD : renderPdf() est testé en Node contre le renderer du serveur
 * (tests/e/demo-pdf.test.js) ; le reste branche la page pdf.html.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.TapigroDemoPdfPage = api;
    api.mountPage(root);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Fichiers que le moteur va lire (chemins « serveur ») : fontes, logo des
   * pages fixes, photos et codes-barres des produits imprimés.
   */
  function neededFiles(shared, data, layout, pages) {
    const needed = Object.values(shared.pdf.fonts.FACES).map((f) => `public/assets/fonts/${f}`);
    if (data.withFixedPages) {
      for (const def of Object.values(layout.fixedPages || {})) {
        for (const el of def.elements || []) {
          if (el.type === 'image' && el.asset) needed.push(`public/assets/${el.asset}`);
        }
      }
    }
    for (const p of pages) {
      for (const it of p.items) {
        if (it.photo_file) needed.push(`data/images/${it.photo_file}`);
        if (it.barcode_file) needed.push(`data/images/${it.barcode_file}`);
      }
    }
    return [...new Set(needed)];
  }

  /**
   * Rend un boek en PDF.
   * @param {object} o
   * @param {Function} o.PDFDocument pdfkit (autonome dans le navigateur)
   * @param {object} o.shared demo/shared.js (TapigroShared)
   * @param {object} o.data GET /api/books/:id/pdf-data (demo/backend.js)
   * @param {object} o.layout layout résolu du boek
   * @param {(paths: string[]) => Promise<void>} o.preload remplit shared.fs.files
   * @param {(msg: string) => void} [o.warn]
   * @returns {Promise<{chunks: Uint8Array[], pageCount: number}>}
   */
  async function renderPdf({ PDFDocument, shared, data, layout, preload, warn = () => {} }) {
    const vfs = shared.fs;
    const { drawBook, printablePages } = shared.pdf.document;
    const pages = printablePages(data.pages);
    await preload(neededFiles(shared, data, layout, pages));

    const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Title: data.name } });
    // Le moteur passe des CHEMINS à pdfkit (registerFont, image) ; on lui
    // donne les octets préchargés. Une image utilisée plusieurs fois n'est
    // incorporée qu'une fois (comme le cache par chemin de pdfkit côté serveur).
    const registerFont = doc.registerFont.bind(doc);
    doc.registerFont = (name, src, family) =>
      registerFont(name, typeof src === 'string' ? vfs.readFileSync(src) : src, family);
    const image = doc.image.bind(doc);
    const images = new Map();
    doc.image = (src, ...rest) => {
      if (typeof src !== 'string') return image(src, ...rest);
      if (!images.has(src)) images.set(src, doc.openImage(vfs.readFileSync(src)));
      return image(images.get(src), ...rest);
    };

    const chunks = [];
    const done = new Promise((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', resolve);
      doc.on('error', reject);
    });
    shared.pdf.fonts.registerFonts(doc, '');
    const pageCount = drawBook(
      doc,
      {
        layout,
        withFixedPages: data.withFixedPages,
        pages: data.pages.map((p) => ({ kind: p.kind, hasItems: p.hasItems, items: () => p.items })),
      },
      { rootDir: '', imagesDir: 'data/images', texts: data.texts, warn }
    );
    doc.end();
    await done;
    return { chunks, pageCount };
  }

  // Nom du fichier téléchargé : même règle que le Content-Disposition du
  // serveur (server/routes/pdf.js).
  function fileName(name) {
    const cleaned = String(name || '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
    return `${cleaned || 'boek'}.pdf`;
  }

  // ---- page pdf.html ----------------------------------------------------------------

  function mountPage(win) {
    const doc = win.document;
    const shared = win.TapigroShared;
    // Chemin « serveur » → fichier de la démo (relatif : marche sous un sous-chemin).
    const fileUrl = (p) => (p.startsWith('public/') ? p.slice('public/'.length) : p);
    async function preload(paths) {
      await Promise.all(
        paths.map(async (p) => {
          if (shared.fs.files.has(p)) return;
          const res = await win.fetch(fileUrl(p));
          if (!res.ok) return; // absent : le moteur dessine un cadre vide (comme le serveur)
          shared.fs.files.set(p, await res.arrayBuffer());
        })
      );
    }

    doc.addEventListener('DOMContentLoaded', async () => {
      const status = doc.getElementById('pdf-statut');
      const bookId = Number(new URLSearchParams(win.location.search).get('id'));
      try {
        const data = await win.App.api(`/api/books/${bookId}/pdf-data`);
        const { layouts } = await win.App.api('/api/layouts');
        const layout = layouts.find((l) => l.id === data.layoutId);
        doc.getElementById('pdf-titre').textContent = win.App.t('demo.pdfTitleBook', { name: data.name });
        const { chunks, pageCount } = await renderPdf({
          PDFDocument: win.PDFDocument,
          shared,
          data,
          layout,
          preload,
          warn: (msg) => win.console.warn(`[pdf] ${msg}`),
        });
        const blob = new win.Blob(chunks, { type: 'application/pdf' });
        const href = win.URL.createObjectURL(blob);
        const link = doc.getElementById('pdf-download');
        link.href = href;
        link.download = fileName(data.name);
        link.hidden = false;
        const frame = doc.getElementById('pdf-apercu');
        frame.src = href;
        frame.hidden = false;
        status.textContent = win.App.t('demo.pdfReady', { n: pageCount });
        win.TapigroDemoPdf = { blob, pageCount }; // (tests de bout en bout)
      } catch (err) {
        status.textContent =
          err && err.status === 404
            ? win.App.t('demo.pdfNotFound')
            : win.App.t('demo.pdfFailed', { message: err && err.message ? err.message : String(err) });
        win.console.error(err);
      }
    });
  }

  return { renderPdf, neededFiles, fileName, mountPage };
});
