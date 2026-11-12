'use strict';
// Page « Produits » (liste : cartes-compteurs filtres, recherche, tableau à
// lignes cliquables, pagination, ajout manuel) et fiche produit (édition champ
// par champ, photo/code-barres, désactivation). Style « Base producteurs »
// d'Agricert — cf. docs/UX-REFONTE.md §4.6 et docs/API.md §Produits.
(() => {
  const LIMIT = 50;
  const esc = (s) => App.esc(s);

  // ---------------------------------------------------------------- liste ----
  function initListPage() {
    const table = document.getElementById('products-table');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    const cardsZone = document.getElementById('products-cards');
    const countEl = document.getElementById('products-count');
    const emptyEl = document.getElementById('products-empty');
    const noResEl = document.getElementById('products-noresult');
    const pager = document.getElementById('products-pager');
    const pagerInfo = document.getElementById('pager-info');
    const form = document.getElementById('products-toolbar');
    const fQ = document.getElementById('pf-q');
    const fCat = document.getElementById('pf-category');
    const fGroup = document.getElementById('pf-group');
    const fActive = document.getElementById('pf-active');
    const clearBtn = document.getElementById('pf-clear');

    // État des filtres, initialisé depuis l'URL (les cartes du tableau de bord
    // pointent vers /products?photo=0, ?active=0, etc.).
    const url = new URLSearchParams(window.location.search);
    const state = {
      q: url.get('q') || '',
      category: url.get('category') || '',
      group: url.get('group') || '',
      active: ['1', '0', 'all'].includes(url.get('active')) ? url.get('active') : '1',
      photo: ['1', '0', 'all'].includes(url.get('photo')) ? url.get('photo') : 'all',
      barcode: ['1', '0', 'all'].includes(url.get('barcode')) ? url.get('barcode') : 'all',
      offset: 0,
    };
    let total = 0;
    let stats = null;

    function hasFilters() {
      return (
        state.q !== '' || state.category !== '' || state.group !== '' ||
        state.active !== '1' || state.photo !== 'all' || state.barcode !== 'all'
      );
    }

    function syncUrl() {
      const p = new URLSearchParams();
      if (state.q) p.set('q', state.q);
      if (state.category) p.set('category', state.category);
      if (state.group) p.set('group', state.group);
      if (state.active !== '1') p.set('active', state.active);
      if (state.photo !== 'all') p.set('photo', state.photo);
      if (state.barcode !== 'all') p.set('barcode', state.barcode);
      const qs = p.toString();
      history.replaceState(null, '', App.url(qs ? `/products?${qs}` : '/products'));
    }

    // Cartes-compteurs = raccourcis de filtre (A5) ; la carte active est marquée.
    const CARDS = [
      { label: App.t('common.products'), stat: 'total', filter: { active: 'all', photo: 'all', barcode: 'all' } },
      { label: App.t('common.activeMany'), stat: 'active', filter: { active: '1', photo: 'all', barcode: 'all' } },
      { label: App.t('common.retiredMany'), stat: 'inactive', filter: { active: '0', photo: 'all', barcode: 'all' } },
      { label: App.t('common.withoutPhoto'), stat: 'withoutPhoto', aFaire: true, filter: { active: '1', photo: '0', barcode: 'all' } },
      { label: App.t('common.withoutBarcode'), stat: 'withoutBarcode', aFaire: true, filter: { active: '1', photo: 'all', barcode: '0' } },
    ];

    function renderCards() {
      cardsZone.textContent = '';
      for (const c of CARDS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isOn =
          state.active === c.filter.active &&
          state.photo === c.filter.photo &&
          state.barcode === c.filter.barcode;
        btn.className = 'card' + (c.aFaire && stats[c.stat] > 0 ? ' a-faire' : '') + (isOn ? ' on' : '');
        btn.innerHTML = `<span class="l">${esc(c.label)}</span><span class="v">${stats[c.stat]}</span>`;
        btn.addEventListener('click', () => {
          Object.assign(state, c.filter, { offset: 0 });
          fActive.value = c.filter.active;
          refresh().catch(App.flashError);
        });
        cardsZone.appendChild(btn);
      }
    }

    function row(p) {
      const tr = document.createElement('tr');
      tr.className = 'lien';
      const thumb = p.hasPhoto
        ? `<img class="thumb" src="${esc(App.url(`/img/${encodeURIComponent(p.code)}/thumb`))}" alt="" loading="lazy">`
        : `<span class="thumb absente" title="${esc(App.t('products.noPhoto'))}">·</span>`;
      tr.innerHTML = `
        <td class="vignette">${thumb}</td>
        <td><a href="${esc(App.url(`/products/${p.id}`))}"><strong>${esc(p.code)}</strong></a></td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.category)}</td>
        <td>${esc(p.group)}</td>
        <td>${esc(p.unit)}</td>
        <td class="num">${p.minimumStock == null ? '<span class="mut">—</span>' : esc(App.formatNumber(p.minimumStock))}</td>
        <td><span class="pill ${p.isActive ? 's-actif' : 's-retire'}">${esc(p.isActive ? App.t('common.active') : App.t('common.retired'))}</span></td>
        <td>${p.hasPhoto ? `<span class="tag" title="${esc(App.t('products.photoAvailable'))}">📷</span>` : ''}${
          p.hasBarcode ? `<span class="tag" title="${esc(App.t('products.barcodeAvailable'))}">▮▮</span>` : ''
        }</td>`;
      tr.addEventListener('click', (e) => {
        if (!e.target.closest('a')) window.location.href = App.url(`/products/${p.id}`);
      });
      return tr;
    }

    async function refresh() {
      syncUrl();
      const p = new URLSearchParams({
        q: state.q, category: state.category, group: state.group,
        active: state.active, photo: state.photo, barcode: state.barcode,
        limit: String(LIMIT), offset: String(state.offset),
      });
      const [list, s] = await Promise.all([
        App.api(`/api/products?${p}`),
        App.api('/api/products/stats'),
      ]);
      stats = s;
      total = list.total;
      renderCards();
      tbody.textContent = '';
      for (const item of list.items) tbody.appendChild(row(item));
      table.hidden = list.items.length === 0;
      emptyEl.hidden = !(s.total === 0);
      noResEl.hidden = !(s.total > 0 && list.items.length === 0);
      countEl.textContent = App.t('products.count', { n: total });
      clearBtn.hidden = !hasFilters();
      const pages = Math.max(1, Math.ceil(total / LIMIT));
      const page = Math.floor(state.offset / LIMIT) + 1;
      pager.hidden = pages <= 1;
      pagerInfo.textContent = App.t('products.pagerInfo', { page, pages });
      document.getElementById('pager-prev').disabled = page <= 1;
      document.getElementById('pager-next').disabled = page >= pages;
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      Object.assign(state, {
        q: fQ.value.trim(), category: fCat.value, group: fGroup.value,
        active: fActive.value, offset: 0,
      });
      refresh().catch(App.flashError);
    });
    for (const sel of [fCat, fGroup, fActive]) {
      sel.addEventListener('change', () => {
        Object.assign(state, {
          q: fQ.value.trim(), category: fCat.value, group: fGroup.value,
          active: fActive.value, offset: 0,
        });
        refresh().catch(App.flashError);
      });
    }
    clearBtn.addEventListener('click', () => {
      Object.assign(state, { q: '', category: '', group: '', active: '1', photo: 'all', barcode: 'all', offset: 0 });
      fQ.value = ''; fCat.value = ''; fGroup.value = ''; fActive.value = '1';
      refresh().catch(App.flashError);
    });
    document.getElementById('pager-prev').addEventListener('click', () => {
      state.offset = Math.max(0, state.offset - LIMIT);
      refresh().catch(App.flashError);
    });
    document.getElementById('pager-next').addEventListener('click', () => {
      state.offset += LIMIT;
      refresh().catch(App.flashError);
    });

    // ---- ajout manuel (modale) ----
    const dlg = document.getElementById('product-create-dialog');
    const openBtn = document.getElementById('product-create-open');
    const createForm = document.getElementById('product-create-form');
    openBtn.addEventListener('click', () => dlg.showModal());
    dlg.querySelector('[data-reponse="non"]').addEventListener('click', () => dlg.close());
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('product-create-error');
      errEl.hidden = true;
      const body = {
        code: createForm.code.value.trim(),
        name: createForm.name.value.trim(),
        category: createForm.category.value.trim(),
        group: createForm.group.value.trim(),
        unit: createForm.unit.value.trim(),
      };
      if (createForm.minimumStock.value !== '') body.minimumStock = Number(createForm.minimumStock.value);
      try {
        const { product } = await App.api('/api/products', { method: 'POST', body });
        window.location.href = App.url(`/products/${product.id}`);
      } catch (err) {
        App.showError(errEl, err);
      }
    });

    async function init() {
      fQ.value = state.q;
      fActive.value = state.active;
      const [me, meta] = await Promise.all([App.fetchMe(), App.api('/api/products/meta')]);
      const canEdit = Boolean(me && me.user.role !== 'viewer');
      openBtn.hidden = !canEdit;
      for (const [sel, list, values] of [
        [fCat, document.getElementById('np-categories'), meta.categories],
        [fGroup, document.getElementById('np-groups'), meta.groups],
      ]) {
        for (const v of values) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          sel.appendChild(opt);
          list.appendChild(opt.cloneNode(true));
        }
      }
      fCat.value = state.category;
      fGroup.value = state.group;
      await refresh();
    }
    init().catch(App.flashError);
  }

  // ---------------------------------------------------------------- fiche ----
  function initFichePage() {
    const root = document.getElementById('product-fiche');
    if (!root) return;
    const id = root.dataset.productId;
    const form = document.getElementById('fiche-form');
    const toggleBtn = document.getElementById('fiche-toggle');
    const releaseBtn = document.getElementById('fiche-release');
    let product = null;
    let canEdit = false;

    const SOURCE_LABELS = {
      import: App.t('product.sourceImport'),
      manual: App.t('product.sourceManual'),
    };

    function fill() {
      document.getElementById('fiche-titre').textContent = `${product.code} — ${product.name}`;
      document.title = `${product.code} — ${product.name} — Tapigro Boeken`;
      const sub = document.getElementById('fiche-sub');
      const source = SOURCE_LABELS[product.source] || product.source;
      sub.textContent = App.t(product.isActive ? 'product.subActive' : 'product.subRetired', { source });
      document.getElementById('fp-code').value = product.code;
      document.getElementById('fp-name').value = product.name;
      document.getElementById('fp-category').value = product.category;
      document.getElementById('fp-group').value = product.group;
      document.getElementById('fp-unit').value = product.unit;
      document.getElementById('fp-minstock').value = product.minimumStock == null ? '' : product.minimumStock;

      const meta = document.getElementById('fiche-meta');
      const lines = [
        App.t('product.meta', {
          created: App.formatDate(product.createdAt),
          modified: App.relativeDate(product.updatedAt),
        }),
      ];
      if (product.modifiedManuallyAt) {
        const date = App.formatDate(product.modifiedManuallyAt);
        lines.push(App.t(product.source === 'import' ? 'product.metaLocked' : 'product.metaManual', { date }));
      } else if (product.source === 'import') {
        lines.push(App.t('product.metaImport'));
      }
      meta.textContent = lines.join(' ');

      toggleBtn.textContent = App.t(product.isActive ? 'product.retire' : 'product.reinstate');
      toggleBtn.classList.toggle('rouge', product.isActive);
      toggleBtn.classList.toggle('sec', !product.isActive);
      // Verrou « saisie manuelle » : n'existe que sur un produit importé retouché.
      releaseBtn.hidden = !(canEdit && product.source === 'import' && product.modifiedManuallyAt);

      renderImage('photo', product.hasPhoto);
      renderImage('barcode', product.hasBarcode);
    }

    function renderImage(kind, has) {
      const zone = document.getElementById(`fiche-${kind}-zone`);
      zone.textContent = '';
      if (has) {
        const img = document.createElement('img');
        img.src = App.url(`/img/${encodeURIComponent(product.code)}/${kind}?t=${Date.now()}`);
        img.alt = App.t(kind === 'photo' ? 'product.photoAlt' : 'product.barcodeAlt', { name: product.name });
        zone.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'absente';
        ph.textContent = App.t(kind === 'photo' ? 'product.noPhotoYet' : 'product.noBarcodeYet');
        zone.appendChild(ph);
      }
      if (canEdit) {
        const cap = document.createElement('figcaption');
        cap.textContent = App.t(has ? 'product.chooseReplace' : 'product.chooseAdd');
        zone.appendChild(cap);
      }
    }

    async function save(e) {
      e.preventDefault();
      const body = {};
      const name = document.getElementById('fp-name').value.trim();
      if (name !== product.name) body.name = name;
      for (const [input, key] of [
        ['fp-category', 'category'], ['fp-group', 'group'], ['fp-unit', 'unit'],
      ]) {
        const v = document.getElementById(input).value.trim();
        if (v !== product[key]) body[key] = v;
      }
      const raw = document.getElementById('fp-minstock').value;
      const min = raw === '' ? null : Number(raw);
      if (min !== (product.minimumStock ?? null)) body.minimumStock = min;
      if (Object.keys(body).length === 0) {
        App.flash('info', App.t('product.noChange'));
        return;
      }
      try {
        const res = await App.api(`/api/products/${id}`, { method: 'PATCH', body });
        product = res.product;
        fill();
        if (!res.changed) {
          App.flash('info', App.t('product.noChange'));
          return;
        }
        const n = Object.keys(body).length;
        App.flash('ok', App.t('product.saved', { n }));
      } catch (err) {
        App.flashError(err);
      }
    }

    async function toggleActive() {
      if (product.isActive) {
        const ok = await App.confirm({
          titre: App.t('product.retireConfirmTitle', { name: product.name }),
          texte: App.t('product.retireConfirmText'),
          oui: App.t('product.retireConfirmYes'),
          danger: true,
        });
        if (!ok) return;
      }
      try {
        ({ product } = await App.api(`/api/products/${id}`, {
          method: 'PATCH',
          body: { isActive: !product.isActive },
        }));
        fill();
        App.flash('ok', App.t(product.isActive ? 'product.reinstated' : 'product.retired'));
      } catch (err) {
        App.flashError(err);
      }
    }

    async function release() {
      const ok = await App.confirm({
        titre: App.t('product.releaseConfirmTitle'),
        texte: App.t('product.releaseConfirmText'),
        oui: App.t('product.releaseConfirmYes'),
      });
      if (!ok) return;
      try {
        ({ product } = await App.api(`/api/products/${id}/release`, { method: 'POST' }));
        fill();
        App.flash('ok', App.t('product.released'));
      } catch (err) {
        App.flashError(err);
      }
    }

    function initUpload(kind) {
      const input = document.getElementById(`fiche-${kind}-file`);
      input.hidden = !canEdit;
      input.addEventListener('change', async () => {
        if (!input.files[0]) return;
        const fd = new FormData();
        fd.append('file', input.files[0]);
        try {
          ({ product } = await App.apiUpload(`/api/products/${id}/${kind}`, fd));
          fill();
          App.flash('ok', App.t(kind === 'photo' ? 'product.photoSaved' : 'product.barcodeSaved'));
        } catch (err) {
          App.flashError(err);
        } finally {
          input.value = '';
        }
      });
    }

    async function init() {
      const [me, res] = await Promise.all([App.fetchMe(), App.api(`/api/products/${id}`)]);
      product = res.product;
      canEdit = Boolean(me && me.user.role !== 'viewer');
      document.getElementById('fiche-actions').hidden = !canEdit;
      document.getElementById('fiche-save-zone').hidden = !canEdit;
      for (const el of form.querySelectorAll('input:not([readonly])')) el.disabled = !canEdit;
      initUpload('photo');
      initUpload('barcode');
      fill();
      form.addEventListener('submit', save);
      toggleBtn.addEventListener('click', () => { toggleActive().catch(App.flashError); });
      releaseBtn.addEventListener('click', () => { release().catch(App.flashError); });
    }
    init().catch(App.flashError);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const page = document.body.dataset.page;
    if (page === 'products') initListPage();
    if (page === 'product') initFichePage();
  });
})();
