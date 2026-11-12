/* preview.js — aperçu d'un boek en lecture seule (/books/:id/preview).
 *
 * Une seule vérité : le PDF. Les pages montrées sont EXACTEMENT celles du PDF,
 * dans le même ordre et avec les mêmes numéros (book-plan.js pageSequence,
 * règle partagée avec server/services/pdf/document.js), dessinées par le même
 * moteur que l'éditeur (layout-render.js, depuis le layout JSON).
 *
 * Écran : double page comme un livre ouvert (1re page seule à droite), flèches
 * et clavier ← → (Début / Fin), zoom, Échap = retour. Écran étroit : une page à
 * la fois, on balaie du doigt. « Afdrukken » imprime toutes les pages en A4
 * réel (feuille de style d'impression) ; « PDF downloaden » télécharge le PDF.
 */
(function () {
  'use strict';

  const PX_PER_MM = 96 / 25.4;
  const NARROW = '(max-width: 760px)';
  const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

  document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('preview-root');
    if (!root) return;
    const bookId = Number(root.dataset.bookId);
    const stage = document.getElementById('pv-stage');
    const spreadEl = document.getElementById('pv-spread');
    const posEl = document.getElementById('pv-pos');
    const prevBtn = document.getElementById('pv-prev');
    const nextBtn = document.getElementById('pv-next');
    const fitBtn = document.getElementById('pv-zoom-fit');
    const backLink = document.getElementById('pv-back');

    let layout = null;
    let book = null;
    let printed = []; // pages imprimées (pageSequence), dans l'ordre du PDF
    let spreads = [];
    let index = 0;
    let zoom = 1; // multiplicateur de l'échelle « passend »
    let narrow = window.matchMedia(NARROW).matches;

    // ---- rendu d'une page -------------------------------------------------------

    function pageNode(entry) {
      if (entry.type === 'cover' || entry.type === 'page2' || entry.type === 'back') {
        return LayoutRender.renderFixedPage(layout, entry.type, book.texts).page;
      }
      if (entry.type === 'products') {
        const { page } = LayoutRender.renderContentPage(layout, entry.page.items);
        // Produit retiré du catalogue : signalé comme dans l'éditeur (écran seulement).
        page.querySelectorAll('.lr-cell').forEach((cell, i) => {
          if (entry.page.items[i] && entry.page.items[i].product.isActive === false) {
            const badge = document.createElement('div');
            badge.className = 'cell-inactive';
            badge.textContent = App.t('editor.retired');
            cell.appendChild(badge);
          }
        });
        return page;
      }
      return LayoutRender.renderBlankPage(layout);
    }

    function caption(entry) {
      const c = TapigroBookPlan.captionOf(entry);
      const text = App.t(c.key, c.params);
      return entry.type === 'blank' && entry.page ? App.t('editor.blankSuffix', { caption: text }) : text;
    }

    function framed(entry, scale) {
      const slot = document.createElement('figure');
      slot.className = 'pv-page';
      const box = document.createElement('div');
      box.className = 'page-box';
      box.style.width = `${layout.page.widthMm * PX_PER_MM * scale}px`;
      box.style.height = `${layout.page.heightMm * PX_PER_MM * scale}px`;
      const page = pageNode(entry);
      page.style.transformOrigin = '0 0';
      page.style.transform = `scale(${scale})`;
      box.appendChild(page);
      const cap = document.createElement('figcaption');
      cap.textContent = caption(entry);
      slot.append(box, cap);
      return slot;
    }

    // Échelle « passend » : la double page tient dans la zone visible ; sur
    // gsm, la page prend toute la largeur (on fait défiler en hauteur — une
    // page réduite à la hauteur de l'écran serait illisible). Le zoom la
    // multiplie.
    function fitScale() {
      const pageW = layout.page.widthMm * PX_PER_MM;
      const pageH = layout.page.heightMm * PX_PER_MM;
      if (narrow) return Math.max(120, stage.clientWidth - 16) / pageW;
      const availW = Math.max(200, stage.clientWidth - 120);
      const availH = Math.max(200, stage.clientHeight - 48);
      return Math.min(availW / (2 * pageW + 6), availH / pageH);
    }

    function render() {
      const spread = spreads[index] || [];
      const scale = fitScale() * zoom;
      const frag = document.createDocumentFragment();
      // Livre ouvert : la 1re page seule est à DROITE, la dernière seule à GAUCHE.
      const lone = !narrow && spread.length === 1 && spreads.length > 1;
      if (lone && index === 0) frag.appendChild(placeholder(scale));
      for (const entry of spread) frag.appendChild(framed(entry, scale));
      if (lone && index > 0) frag.appendChild(placeholder(scale));
      spreadEl.replaceChildren(frag);
      spreadEl.classList.toggle('is-zoomed', zoom > 1);

      const numbers = spread.map((e) => e.number);
      posEl.textContent =
        numbers.length > 1
          ? App.t('preview.position', { from: numbers[0], to: numbers[numbers.length - 1], total: printed.length })
          : App.t('preview.positionOne', { n: numbers[0] || 1, total: printed.length });
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index >= spreads.length - 1;
      fitBtn.textContent = zoom === 1 ? App.t('preview.zoomFit') : App.t('preview.zoomPct', { pct: Math.round(zoom * 100) });
    }

    function placeholder(scale) {
      const el = document.createElement('div');
      el.className = 'pv-page';
      el.classList.add('pv-placeholder');
      el.style.width = `${layout.page.widthMm * PX_PER_MM * scale}px`;
      return el;
    }

    function buildSpreads() {
      const current = spreads[index] && spreads[index][0];
      spreads = narrow ? printed.map((e) => [e]) : TapigroBookPlan.bookSpreads(printed);
      // On reste sur la même page en changeant de mode (rotation, fenêtre).
      if (current) index = Math.max(0, spreads.findIndex((s) => s.includes(current)));
      if (index >= spreads.length) index = spreads.length - 1;
    }

    function go(delta) {
      const next = Math.min(spreads.length - 1, Math.max(0, index + delta));
      if (next === index) return;
      index = next;
      render();
    }

    function setZoom(z) {
      zoom = z;
      render();
    }

    function zoomStep(dir) {
      const i = ZOOMS.indexOf(zoom);
      const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i === -1 ? 2 : i) + dir))];
      setZoom(next);
    }

    // ---- impression : toutes les pages en A4 réel -----------------------------

    function printAll() {
      const zone = document.getElementById('pv-print-all');
      if (!zone.childElementCount) {
        for (const entry of printed) {
          const page = pageNode(entry);
          page.classList.add('pv-print-page');
          zone.appendChild(page);
        }
      }
      window.print();
    }

    // ---- événements ----------------------------------------------------------------

    function wire() {
      prevBtn.addEventListener('click', () => go(-1));
      nextBtn.addEventListener('click', () => go(1));
      document.getElementById('pv-zoom-in').addEventListener('click', () => zoomStep(1));
      document.getElementById('pv-zoom-out').addEventListener('click', () => zoomStep(-1));
      fitBtn.addEventListener('click', () => setZoom(1));
      document.getElementById('pv-print').addEventListener('click', printAll);

      document.addEventListener('keydown', (e) => {
        if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (document.querySelector('dialog[open]')) return;
        if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
        else if (e.key === 'Home') go(-spreads.length);
        else if (e.key === 'End') go(spreads.length);
        else if (e.key === '+' || e.key === '=') zoomStep(1);
        else if (e.key === '-') zoomStep(-1);
        else if (e.key === 'Escape') window.location.href = backLink.href;
        else return;
        e.preventDefault();
      });

      // Balayage (doigt) : une page par écran sur gsm.
      let start = null;
      stage.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse') start = { x: e.clientX, y: e.clientY };
      });
      stage.addEventListener('pointerup', (e) => {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        start = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && zoom === 1) go(dx < 0 ? 1 : -1);
      });
      stage.addEventListener('pointercancel', () => {
        start = null;
      });

      let timer = null;
      window.addEventListener('resize', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const wasNarrow = narrow;
          narrow = window.matchMedia(NARROW).matches;
          if (wasNarrow !== narrow) buildSpreads();
          render();
        }, 120);
      });
    }

    function welcome() {
      // Arrivée juste après une génération automatique (books.js : ?nieuw=1).
      const params = new URLSearchParams(window.location.search);
      if (params.get('nieuw') !== '1') return;
      const n = book.pages.reduce((sum, p) => sum + p.items.length, 0);
      document.getElementById('pv-welcome-text').textContent = App.t('preview.welcome', { n, pages: printed.length });
      const box = document.getElementById('pv-welcome');
      box.hidden = false;
      document.getElementById('pv-welcome-close').addEventListener('click', () => {
        box.hidden = true;
      });
      // L'URL redevient celle de l'aperçu (F5 ne remontre pas le message).
      params.delete('nieuw');
      const qs = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }

    async function init() {
      const [me, layoutsRes, bookRes] = await Promise.all([
        App.fetchMe(),
        App.api('/api/layouts'),
        App.api(`/api/books/${bookId}`),
      ]);
      book = bookRes;
      layout = layoutsRes.layouts.find((l) => l.id === book.layoutId);
      if (!layout) throw new Error(App.t('editor.unknownLayout', { id: book.layoutId }));
      const canEdit = Boolean(me && me.user.role !== 'viewer');
      if (canEdit) {
        backLink.href = App.url(`/books/${bookId}/edit`);
        backLink.textContent = App.t('preview.backToEditor');
      } else {
        document.getElementById('pv-welcome-edit').hidden = true;
      }
      document.getElementById('pv-title').textContent = book.name;
      printed = TapigroBookPlan.pageSequence(book, layout).filter((e) => e.printed);
      if (!book.pages.some((p) => p.items.length)) {
        const empty = document.getElementById('pv-empty');
        empty.textContent = App.t('preview.empty');
        empty.hidden = false;
      }
      buildSpreads();
      wire();
      welcome();
      render();
      stage.focus({ preventScroll: true });
    }

    init().catch(App.flashError);
  });
})();
