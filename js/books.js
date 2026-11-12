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
      const href = App.url(`/books/${b.id}/edit`);

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

      const tdActions = document.createElement('td');
      const open = document.createElement('a');
      open.className = 'btn sec petit';
      open.href = href;
      open.textContent = App.t('common.open');
      tdActions.appendChild(open);
      const pdf = document.createElement('a');
      pdf.className = 'btn sec petit';
      pdf.href = App.url(`/api/books/${b.id}/pdf`);
      pdf.textContent = App.t('books.exportPdf');
      tdActions.appendChild(pdf);
      if (canEdit) {
        const mk = (label, fn, danger) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = danger ? 'btn rouge petit' : 'btn sec petit';
          btn.textContent = label;
          btn.addEventListener('click', fn);
          tdActions.appendChild(btn);
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
        if (!e.target.closest('a, button')) window.location.href = href;
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

    async function init() {
      const [me, layoutsRes] = await Promise.all([App.fetchMe(), App.api('/api/layouts')]);
      canEdit = Boolean(me && (me.user.role === 'editor' || me.user.role === 'admin'));
      layoutsRes.layouts.forEach((layout, i) => {
        layoutNames[layout.id] = App.layoutLabel(layout).name;
        layoutsZone.appendChild(layoutCard(layout, i === 0));
      });
      openBtn.hidden = !canEdit;
      await refresh();
    }

    searchEl.addEventListener('input', render);
    openBtn.addEventListener('click', () => {
      dlg.showModal();
      document.getElementById('nb-name').focus();
    });
    dlg.querySelector('[data-reponse="non"]').addEventListener('click', () => dlg.close());

    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errCreate = document.getElementById('book-create-error');
      errCreate.hidden = true;
      try {
        const { book } = await App.api('/api/books', {
          method: 'POST',
          body: {
            name: createForm.name.value.trim(),
            layoutId: createForm.layoutId.value,
            fixedPages: fixedBox.checked,
          },
        });
        window.location.href = App.url(`/books/${book.id}/edit`);
      } catch (err) {
        App.showError(errCreate, err);
      }
    });

    init().catch(App.flashError);
  });
})();
