'use strict';
/* books.js — liste des boeken (tâche C, restylée refonte UX) : recherche par
 * nom, lignes cliquables, création par modale (nom + modèle de mise en page),
 * renommer/dupliquer/supprimer via les modales maison (App.promptText /
 * App.confirm) et retours par App.flash. Mutations réservées aux editors. */
(function () {
  document.addEventListener('DOMContentLoaded', () => {
    const table = document.getElementById('books-table');
    if (!table || document.body.dataset.page !== 'books') return;
    const tbody = table.querySelector('tbody');
    const emptyEl = document.getElementById('books-empty');
    const noResEl = document.getElementById('books-noresult');
    const countEl = document.getElementById('books-count');
    const searchEl = document.getElementById('books-search');
    const openBtn = document.getElementById('book-create-open');
    const dlg = document.getElementById('book-create-dialog');
    const createForm = document.getElementById('book-create-form');
    const layoutsZone = document.getElementById('nb-layouts');
    const fixedBox = document.getElementById('nb-fixed');

    let canEdit = false;
    let items = [];
    const layoutNames = {};

    // Carte de choix d'un format : mini-vignette de la grille (colonnes × rangées
    // du layout), nom clair et phrase d'explication (champ `description`).
    function layoutCard(layout, checked) {
      const label = document.createElement('label');
      label.className = 'format';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'layoutId';
      radio.value = layout.id;
      radio.checked = checked;
      const mini = document.createElement('span');
      mini.className = 'mini-page';
      mini.setAttribute('aria-hidden', 'true');
      mini.style.gridTemplateColumns = `repeat(${layout.grid.columns}, 1fr)`;
      mini.style.gridTemplateRows = `repeat(${layout.grid.rows}, 1fr)`;
      for (let i = 0; i < layout.grid.columns * layout.grid.rows; i++) {
        mini.appendChild(document.createElement('i'));
      }
      const text = document.createElement('span');
      text.className = 'format-txt';
      const names = App.layoutLabel(layout); // nom et explication dans la langue de l'interface
      const name = document.createElement('strong');
      name.textContent = names.name;
      const desc = document.createElement('span');
      desc.className = 'mut';
      desc.textContent = names.description;
      text.append(name, desc);
      label.append(radio, mini, text);
      return label;
    }

    function row(b) {
      const tr = document.createElement('tr');
      tr.className = 'lien';
      const href = App.url(canEdit ? `/books/${b.id}/edit` : `/books/${b.id}/preview`);

      const tdName = document.createElement('td');
      const link = document.createElement('a');
      link.href = href;
      const strong = document.createElement('strong');
      strong.textContent = b.name;
      link.appendChild(strong);
      tdName.appendChild(link);

      const tdLayout = document.createElement('td');
      tdLayout.textContent = layoutNames[b.layoutId] || b.layoutId;

      const tdPages = document.createElement('td');
      tdPages.className = 'num';
      tdPages.textContent = String(b.pageCount);

      const tdItems = document.createElement('td');
      tdItems.className = 'num';
      if (b.itemCount === 0) {
        const pill = document.createElement('span');
        pill.className = 'pill s-retire';
        pill.title = App.t('books.emptyTitle');
        pill.textContent = App.t('common.empty');
        tdItems.appendChild(pill);
      } else {
        tdItems.textContent = String(b.itemCount);
      }

      const tdDate = document.createElement('td');
      tdDate.className = 'mut';
      tdDate.textContent = App.relativeDate(b.updatedAt);
      tdDate.title = b.updatedAt;

      // Actions : « Openen » et « Voorbeeld » bien visibles, le PDF, puis le
      // reste (renommer, dupliquer, supprimer) dans le menu « ⋯ ».
      const tdActions = document.createElement('td');
      tdActions.className = 'acties';
      if (canEdit) {
        const open = document.createElement('a');
        open.className = 'btn petit';
        open.href = href;
        open.textContent = App.t('common.open');
        tdActions.appendChild(open);
      }
      const preview = document.createElement('a');
      preview.className = canEdit ? 'btn sec petit' : 'btn petit';
      preview.href = App.url(`/books/${b.id}/preview`);
      preview.textContent = App.t('books.preview');
      preview.title = App.t('books.previewTitle');
      tdActions.appendChild(preview);
      const pdf = document.createElement('a');
      pdf.className = 'btn sec petit';
      pdf.href = App.url(`/api/books/${b.id}/pdf`);
      pdf.dataset.pdf = '';
      pdf.textContent = App.t('books.exportPdf');
      tdActions.appendChild(pdf);
      if (canEdit) {
        const menu = document.createElement('details');
        menu.className = 'menu-plus';
        const summary = document.createElement('summary');
        summary.className = 'btn sec petit';
        summary.textContent = '⋯';
        summary.title = App.t('books.moreActions');
        summary.setAttribute('aria-label', App.t('books.moreActions'));
        const list = document.createElement('div');
        list.className = 'menu-liste';
        menu.append(summary, list);
        tdActions.appendChild(menu);
        const mk = (label, fn, danger) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = danger ? 'menu-item rouge' : 'menu-item';
          btn.textContent = label;
          btn.addEventListener('click', () => {
            menu.open = false;
            fn();
          });
          list.appendChild(btn);
        };
        mk(App.t('books.rename'), async () => {
          const name = await App.promptText({
            titre: App.t('books.renameTitle', { name: b.name }),
            label: App.t('books.newName'),
            valeur: b.name,
            oui: App.t('books.rename'),
          });
          if (name && name.trim() && name.trim() !== b.name) {
            App.api(`/api/books/${b.id}`, { method: 'PATCH', body: { name: name.trim() } })
              .then(() => {
                App.flash('ok', App.t('books.renamed', { name: name.trim() }));
                return refresh();
              })
              .catch(App.flashError);
          }
        });
        mk(App.t('books.duplicate'), () => {
          App.api(`/api/books/${b.id}/duplicate`, { method: 'POST' })
            .then(() => {
              App.flash('ok', App.t('books.duplicated', { name: b.name }));
              return refresh();
            })
            .catch(App.flashError);
        });
        mk(App.t('common.delete'), async () => {
          const ok = await App.confirm({
            titre: App.t('books.deleteTitle', { name: b.name }),
            texte: App.t('books.deleteText'),
            oui: App.t('books.deleteYes'),
            danger: true,
          });
          if (!ok) return;
          App.api(`/api/books/${b.id}`, { method: 'DELETE' })
            .then(() => {
              App.flash('ok', App.t('books.deleted', { name: b.name }));
              return refresh();
            })
            .catch(App.flashError);
        }, true);
      }

      tr.append(tdName, tdLayout, tdPages, tdItems, tdDate, tdActions);
      tr.addEventListener('click', (e) => {
        if (!e.target.closest('a, button, details')) window.location.href = href;
      });
      return tr;
    }

    function render() {
      const q = searchEl.value.trim().toLowerCase();
      const visible = q ? items.filter((b) => b.name.toLowerCase().includes(q)) : items;
      tbody.textContent = '';
      for (const b of visible) tbody.appendChild(row(b));
      table.hidden = visible.length === 0;
      emptyEl.hidden = items.length > 0;
      noResEl.hidden = !(items.length > 0 && visible.length === 0);
      countEl.textContent = App.t('books.count', { n: visible.length });
    }

    async function refresh() {
      ({ items } = await App.api('/api/books'));
      render();
    }

    // ---- fenêtre « Nieuw boek » ------------------------------------------------

    const autoBox = document.getElementById('nb-auto');
    const scopeSel = document.getElementById('nb-scope');
    const pickBox = document.getElementById('nb-pick');
    const selectionEl = document.getElementById('nb-selection');
    const estimateEl = document.getElementById('nb-estimate');
    const submitBtn = document.getElementById('nb-submit');
    const perCatBox = document.getElementById('nb-percat');
    const layoutsById = {};
    let meta = { categories: [], groups: [] };
    let catalog = null; // produits actifs (estimation), chargés à la demande
    let selection = null; // filtres reçus de la page Producten

    const isAuto = () => createForm.content.value === 'auto';

    // Options de remplissage envoyées au serveur (book-plan.js normalizeFill).
    function fillOptions() {
      const scope = scopeSel.value;
      const picked = Array.from(pickBox.querySelectorAll('input:checked')).map((i) => i.value);
      const fill = {
        sort: createForm.sort.value,
        newPagePerCategory: perCatBox.checked,
      };
      if (scope === 'categories') fill.categories = picked;
      if (scope === 'groups') fill.groups = picked;
      if (scope === 'selection' && selection) Object.assign(fill, selection);
      return fill;
    }

    async function loadCatalog() {
      if (catalog) return catalog;
      const all = [];
      for (let offset = 0; ; offset += 200) {
        const { items, total } = await App.api(`/api/products?active=1&limit=200&offset=${offset}`);
        all.push(...items);
        if (all.length >= total || items.length === 0) break;
      }
      catalog = all;
      return catalog;
    }

    // Choix incomplet (« certaines catégories » sans case cochée, sélection
    // introuvable) → clé du message à montrer, sinon null. On n'envoie jamais
    // ce cas au serveur : une liste vide n'est PAS « tout le catalogue ».
    function fillProblem() {
      const scope = scopeSel.value;
      const picked = pickBox.querySelectorAll('input:checked').length;
      if (scope === 'categories' && !picked) return 'books.pickAtLeastOneCategory';
      if (scope === 'groups' && !picked) return 'books.pickAtLeastOneGroup';
      if (scope === 'selection' && !selection) return 'books.selectionMissing';
      return null;
    }

    // Estimation exacte : mêmes règles que le serveur (book-plan.js).
    async function updateEstimate() {
      if (!isAuto()) return;
      estimateEl.classList.remove('is-empty');
      const problem = fillProblem();
      if (problem) {
        estimateEl.textContent = App.t(problem);
        estimateEl.classList.add('is-empty');
        return;
      }
      if (!catalog) estimateEl.textContent = App.t('books.estimateLoading');
      const products = await loadCatalog();
      const options = TapigroBookPlan.normalizeFill(fillOptions());
      const layout = layoutsById[createForm.layoutId.value];
      if (!options || !layout) return;
      const chosen = products.filter((p) => TapigroBookPlan.matchesFill(p, options));
      const pages = TapigroBookPlan.planFill(chosen, {
        capacity: layout.grid.columns * layout.grid.rows,
        sort: options.sort,
        newPagePerCategory: options.newPagePerCategory,
      }).length;
      estimateEl.textContent = chosen.length
        ? App.t('books.estimate', { n: chosen.length, pages })
        : App.t('books.estimateEmpty');
      estimateEl.classList.toggle('is-empty', chosen.length === 0);
    }

    function renderPick() {
      const scope = scopeSel.value;
      pickBox.textContent = '';
      pickBox.hidden = scope !== 'categories' && scope !== 'groups';
      selectionEl.hidden = scope !== 'selection';
      if (pickBox.hidden) return;
      pickBox.setAttribute('aria-label', App.t(scope === 'categories' ? 'books.pickCategories' : 'books.pickGroups'));
      for (const value of scope === 'categories' ? meta.categories : meta.groups) {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = value;
        label.append(box, document.createTextNode(` ${value}`));
        pickBox.appendChild(label);
      }
    }

    function syncContent() {
      autoBox.hidden = !isAuto();
      submitBtn.textContent = App.t(isAuto() ? 'books.createAuto' : 'books.createSubmit');
      if (isAuto()) updateEstimate().catch(App.flashError);
    }

    // Format choisi → couverture proposée selon le format (layout
    // defaultFixedPages : un vel etiketten se fait d'habitude sans).
    function syncFixedDefault() {
      const layout = layoutsById[createForm.layoutId.value];
      if (layout) fixedBox.checked = layout.defaultFixedPages !== false;
    }

    function openDialog() {
      createForm.reset();
      document.getElementById('book-create-error').hidden = true;
      submitBtn.disabled = false;
      const preferred = layoutsById['stock-6'] ? 'stock-6' : Object.keys(layoutsById)[0];
      const radio = layoutsZone.querySelector(`input[value="${preferred}"]`);
      if (radio) radio.checked = true;
      syncFixedDefault();
      if (selection) {
        createForm.content.value = 'auto';
        scopeSel.value = 'selection';
      }
      renderPick();
      syncContent();
      dlg.showModal();
      document.getElementById('nb-name').focus();
    }

    // Filtres de la page Producten (« Boek maken van deze selectie ») →
    // option « Mijn selectie » et phrase qui la décrit.
    function readSelection() {
      const params = new URLSearchParams(window.location.search);
      if (params.get('nieuw') !== 'selectie') return null;
      const sel = {};
      const parts = [];
      if (params.get('q')) {
        sel.q = params.get('q');
        parts.push(App.t('books.selectionSearch', { q: sel.q }));
      }
      if (params.get('category')) {
        sel.categories = [params.get('category')];
        parts.push(params.get('category'));
      }
      if (params.get('group')) {
        sel.groups = [params.get('group')];
        parts.push(params.get('group'));
      }
      for (const [key, present, missing] of [
        ['photo', 'books.selectionPhotoPresent', 'books.selectionPhotoMissing'],
        ['barcode', 'books.selectionBarcodePresent', 'books.selectionBarcodeMissing'],
      ]) {
        const v = params.get(key);
        if (v === '1' || v === '0') {
          sel[key] = v;
          parts.push(App.t(v === '1' ? present : missing));
        }
      }
      selectionEl.textContent = App.t('books.selectionText', {
        what: parts.length ? parts.join(', ') : App.t('books.selectionAll'),
      });
      return sel;
    }

    async function init() {
      const [me, layoutsRes, metaRes] = await Promise.all([
        App.fetchMe(),
        App.api('/api/layouts'),
        App.api('/api/products/meta'),
      ]);
      meta = metaRes;
      canEdit = Boolean(me && (me.user.role === 'editor' || me.user.role === 'admin'));
      layoutsRes.layouts.forEach((layout) => {
        layoutsById[layout.id] = layout;
        layoutNames[layout.id] = App.layoutLabel(layout).name;
        layoutsZone.appendChild(layoutCard(layout, false));
      });
      openBtn.hidden = !canEdit;
      await refresh();
      if (canEdit) {
        selection = readSelection();
        if (selection) {
          scopeSel.querySelector('option[value="selection"]').hidden = false;
          // L'URL redevient celle de la liste (F5 ne rouvre pas la fenêtre).
          window.history.replaceState(null, '', App.url('/books'));
          openDialog();
        }
      }
    }

    searchEl.addEventListener('input', render);
    openBtn.addEventListener('click', openDialog);
    dlg.querySelector('[data-reponse="non"]').addEventListener('click', () => dlg.close());
    layoutsZone.addEventListener('change', () => {
      syncFixedDefault();
      updateEstimate().catch(App.flashError);
    });
    createForm.querySelectorAll('input[name="content"]').forEach((r) => r.addEventListener('change', syncContent));
    scopeSel.addEventListener('change', () => {
      renderPick();
      updateEstimate().catch(App.flashError);
    });
    // Catégories / groupes cochés, ordre, « nouvelle page » → nouvelle estimation.
    autoBox.addEventListener('change', (e) => {
      if (e.target !== scopeSel) updateEstimate().catch(App.flashError);
    });
    // Un clic hors d'un menu « ⋯ » ouvert le referme.
    document.addEventListener('click', (e) => {
      document.querySelectorAll('details.menu-plus[open]').forEach((m) => {
        if (!m.contains(e.target)) m.open = false;
      });
    });

    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errCreate = document.getElementById('book-create-error');
      errCreate.hidden = true;
      const auto = isAuto();
      const body = {
        name: createForm.name.value.trim(),
        layoutId: createForm.layoutId.value,
        fixedPages: fixedBox.checked,
      };
      if (auto) {
        const problem = fillProblem();
        if (problem) {
          App.showError(errCreate, new Error(App.t(problem)));
          return;
        }
        body.fill = fillOptions();
      }
      submitBtn.disabled = true;
      try {
        const { book } = await App.api('/api/books', { method: 'POST', body });
        // Généré : on montre d'abord le résultat (aperçu) ; vide : l'éditeur.
        window.location.href = App.url(auto ? `/books/${book.id}/preview?nieuw=1` : `/books/${book.id}/edit`);
      } catch (err) {
        App.showError(errCreate, err);
        submitBtn.disabled = false;
      }
    });

    init().catch(App.flashError);
  });
})();
