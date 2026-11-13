'use strict';
// Tableau de bord (accueil) : cartes-compteurs cliquables comme Agricert —
// Produits (→ page Produits préfiltrée), Boeken (reprendre son travail),
// Imports (dernier import, admins). Tout vient des API existantes.
(() => {
  function card(href, label, value, extra = {}) {
    const a = document.createElement('a');
    a.className = 'card' + (extra.aFaire && value > 0 ? ' a-faire' : '');
    a.href = App.url(href);
    const l = document.createElement('div');
    l.className = 'l';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'v';
    v.textContent = String(value);
    a.appendChild(l);
    a.appendChild(v);
    if (extra.t) {
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = extra.t;
      a.appendChild(t);
    }
    return a;
  }

  async function renderProducts() {
    const zone = document.getElementById('home-products-cards');
    const s = await App.api('/api/products/stats');
    zone.append(
      card('/products?active=all', App.t('common.products'), s.total),
      card('/products', App.t('common.activeMany'), s.active),
      card('/products?active=0', App.t('common.retiredMany'), s.inactive),
      card('/products?photo=0', App.t('common.withoutPhoto'), s.withoutPhoto, { aFaire: true }),
      card('/products?barcode=0', App.t('common.withoutBarcode'), s.withoutBarcode, { aFaire: true })
    );
  }

  async function renderBooks() {
    const [{ items }, { layouts }] = await Promise.all([App.api('/api/books'), App.api('/api/layouts')]);
    // Nom du format dans la langue de l'interface (labels des layouts JSON).
    const layoutNames = Object.fromEntries(layouts.map((l) => [l.id, App.layoutLabel(l).name]));
    renderRecent(items).catch(App.flashError);
    const cards = document.getElementById('home-books-cards');
    const last = items[0]; // listBooks trie par updated_at desc
    cards.append(card('/books', App.t('home.cardBooks'), items.length, {
      t: last ? App.t('home.lastModified', { when: App.relativeDate(last.updatedAt) }) : undefined,
    }));

    const table = document.getElementById('home-books-table');
    const empty = document.getElementById('home-books-empty');
    empty.hidden = items.length > 0;
    table.hidden = items.length === 0;
    const tbody = table.querySelector('tbody');
    for (const b of items.slice(0, 5)) {
      const tr = document.createElement('tr');
      tr.className = 'lien';
      const tdName = document.createElement('td');
      const link = document.createElement('a');
      link.href = App.url(`/books/${b.id}/edit`);
      const strong = document.createElement('strong');
      strong.textContent = b.name;
      link.appendChild(strong);
      tdName.appendChild(link);
      const tdLayout = document.createElement('td');
      tdLayout.textContent = layoutNames[b.layoutId] || b.layoutId;
      const tdItems = document.createElement('td');
      tdItems.textContent = String(b.itemCount);
      const tdDate = document.createElement('td');
      tdDate.className = 'mut';
      tdDate.textContent = App.relativeDate(b.updatedAt);
      tdDate.title = b.updatedAt;
      const tdOpen = document.createElement('td');
      const open = document.createElement('a');
      open.className = 'btn sec petit';
      open.href = App.url(`/books/${b.id}/edit`);
      open.textContent = App.t('common.open');
      tdOpen.appendChild(open);
      tr.append(tdName, tdLayout, tdItems, tdDate, tdOpen);
      tr.addEventListener('click', (e) => {
        if (!e.target.closest('a')) window.location.href = App.url(`/books/${b.id}/edit`);
      });
      tbody.appendChild(tr);
    }
  }

  // « Dernières modifications » : derniers produits modifiés (sort=updated) et
  // derniers boeken édités, fusionnés par date décroissante.
  async function renderRecent(booksItems) {
    const { items: products } = await App.api('/api/products?sort=updated&active=all&limit=5');
    const rows = [
      ...products.map((p) => ({
        kind: App.t('home.kindProduct'),
        href: App.url(`/products/${p.id}`),
        label: `${p.code} — ${p.name}`,
        date: p.updatedAt,
      })),
      ...booksItems.slice(0, 5).map((b) => ({
        kind: App.t('home.kindBook'),
        href: App.url(`/books/${b.id}/edit`),
        label: b.name,
        date: b.updatedAt,
      })),
    ]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 6);

    const table = document.getElementById('home-recent-table');
    const empty = document.getElementById('home-recent-empty');
    empty.hidden = rows.length > 0;
    table.hidden = rows.length === 0;
    const tbody = table.querySelector('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.className = 'lien';
      const tdKind = document.createElement('td');
      tdKind.className = 'mut';
      tdKind.textContent = r.kind;
      const tdLabel = document.createElement('td');
      const link = document.createElement('a');
      link.href = r.href;
      const strong = document.createElement('strong');
      strong.textContent = r.label;
      link.appendChild(strong);
      tdLabel.appendChild(link);
      const tdDate = document.createElement('td');
      tdDate.className = 'mut';
      tdDate.textContent = App.relativeDate(r.date);
      tdDate.title = r.date;
      tr.append(tdKind, tdLabel, tdDate);
      tr.addEventListener('click', (e) => {
        if (!e.target.closest('a')) window.location.href = r.href;
      });
      tbody.appendChild(tr);
    }
  }

  async function renderImports(me) {
    if (!me || me.user.role !== 'admin') return;
    const panel = document.getElementById('home-imports');
    panel.hidden = false;
    const { items, total } = await App.api('/api/imports?limit=1');
    const empty = document.getElementById('home-imports-empty');
    if (total === 0) {
      empty.hidden = false;
      return;
    }
    const it = items[0];
    const zone = document.getElementById('home-imports-cards');
    zone.append(
      card('/imports', App.t('home.lastImport'), App.relativeDate(it.startedAt), {
        t: it.kind === 'excel'
          ? App.t('home.excelSummary', { created: it.created, updated: it.updated, deactivated: it.deactivated })
          : App.t('home.imagesSummary', { file: App.importFileName(it.fileName) }),
      }),
      card('/imports', App.t('home.importsTotal'), total)
    );
  }

  // ---- sauvegardes (admin) ----------------------------------------------------------

  function formatSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${App.formatNumber(Math.round(mb * 10) / 10)} MB` : `${App.formatNumber(Math.max(1, Math.round(bytes / 1024)))} kB`;
  }

  function backupCard(label, value, sub, warn) {
    const el = document.createElement('div');
    el.className = 'card' + (warn ? ' a-faire' : '');
    const l = document.createElement('div');
    l.className = 'l';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'v';
    v.textContent = value;
    el.append(l, v);
    if (sub) {
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = sub;
      el.appendChild(t);
    }
    return el;
  }

  function showBackup(st) {
    const zone = document.getElementById('home-backup-cards');
    zone.textContent = '';
    const last = st.last;
    const ok = last && last.lastSuccess;
    if (!last) {
      zone.appendChild(backupCard(App.t('backup.last'), App.t('backup.never'), '', true));
    } else {
      zone.appendChild(
        backupCard(
          App.t('backup.last'),
          ok ? App.relativeDate(last.lastSuccess.at.replace('T', ' ').slice(0, 19)) : App.t('backup.never'),
          ok ? `${App.formatDate(last.lastSuccess.at.replace('T', ' ').slice(0, 19))} · ${formatSize(last.lastSuccess.size)}` : '',
          !ok
        )
      );
      zone.appendChild(
        last.ok
          ? backupCard(App.t('backup.state'), App.t('backup.ok'), '', false)
          : backupCard(App.t('backup.state'), App.t('backup.failed'), last.error, true)
      );
    }
    zone.appendChild(backupCard(App.t('backup.kept'), String(st.count), formatSize(st.totalSize), false));
    document.getElementById('home-backup-info').textContent = App.t('backup.info', { hour: st.hour, keep: st.keep, dir: st.dir });
    const warn = document.getElementById('home-backup-warn');
    warn.textContent = App.t('backup.elsewhere');
    warn.hidden = !st.insideDataDir;
  }

  async function renderBackup(me) {
    if (!me || me.user.role !== 'admin') return;
    const panel = document.getElementById('home-backup');
    showBackup(await App.api('/api/backup'));
    panel.hidden = false;
    const btn = document.getElementById('backup-now');
    btn.addEventListener('click', async () => {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = App.t('backup.running');
      try {
        const st = await App.api('/api/backup', { method: 'POST' });
        showBackup(st);
        if (st.last && st.last.ok) App.flash('ok', App.t('backup.done', { file: st.last.file }));
        else App.flash('erreur', App.t('backup.failedFlash', { error: st.last ? st.last.error : '' }));
      } catch (err) {
        App.flashError(err);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (document.body.dataset.page !== 'home') return;
    App.fetchMe()
      .then(async (me) => {
        const canEdit = Boolean(me && me.user.role !== 'viewer');
        document.getElementById('home-new-book').hidden = !canEdit;
        await Promise.all([
          renderProducts(),
          renderBooks(),
          renderImports(me).catch(() => {}), // 403 si le rôle a changé : panneau masqué
          renderBackup(me).catch(() => {}),
        ]);
      })
      .catch(App.flashError);
  });
})();
