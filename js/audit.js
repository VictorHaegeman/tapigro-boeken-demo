'use strict';
// Page /admin/audit « Logboek » (admin, lecture seule) : filtres utilisateur /
// action / période, pagination. Dépend de window.App (public/js/common.js).
// Aucun script inline (CSP stricte).
(() => {
  const PAGE_SIZE = 50;
  const App = window.App;
  const t = (key, params) => App.t(key, params);
  const esc = (s) => App.esc(s);
  let offset = 0;
  let total = 0;

  const $ = (id) => document.getElementById(id);

  // Libellé traduit d'une action (« auth.login » → audit.actions.auth_login),
  // sinon l'identifiant brut.
  function actionLabel(action) {
    const key = `audit.actions.${String(action).replace(/\./g, '_')}`;
    const label = t(key);
    return label && label !== key ? label : action;
  }

  function familyLabel(family) {
    const key = `audit.families.${family}`;
    const label = t(key);
    return label && label !== key ? label : family;
  }

  function detailsText(item) {
    const d = item.details || {};
    if (item.action.startsWith('http.')) {
      return `${d.method || ''} ${d.route || ''} → ${d.status ?? ''}`.trim();
    }
    return Object.entries(d)
      .filter(([k, v]) => k !== 'method' && k !== 'route' && v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' · ');
  }

  function filters() {
    const params = new URLSearchParams();
    if ($('af-user').value) params.set('userId', $('af-user').value);
    if ($('af-action').value) params.set('action', $('af-action').value);
    if ($('af-from').value) params.set('from', $('af-from').value);
    if ($('af-to').value) params.set('to', $('af-to').value);
    return params;
  }

  async function loadMeta() {
    const meta = await App.api('/api/audit/meta');
    const users = $('af-user');
    for (const u of meta.users) {
      const o = document.createElement('option');
      o.value = String(u.id);
      o.textContent = u.username;
      users.appendChild(o);
    }
    const actions = $('af-action');
    const families = [...new Set(meta.actions.map((a) => a.split('.')[0]))];
    for (const family of families) {
      const group = document.createElement('optgroup');
      group.label = familyLabel(family);
      const all = document.createElement('option');
      all.value = `${family}.`;
      all.textContent = t('audit.allOfFamily', { family: familyLabel(family) });
      group.appendChild(all);
      for (const a of meta.actions.filter((x) => x.split('.')[0] === family)) {
        const o = document.createElement('option');
        o.value = a;
        o.textContent = actionLabel(a);
        group.appendChild(o);
      }
      actions.appendChild(group);
    }
    $('audit-keep').textContent = t('audit.keepDays', { n: meta.keepDays });
  }

  async function load() {
    const params = filters();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    const data = await App.api(`/api/audit?${params}`);
    total = data.total;
    const tbody = document.querySelector('#audit-table tbody');
    tbody.innerHTML = data.items
      .map(
        (it) => `<tr>
          <td class="mut" title="${esc(it.at)} UTC">${esc(App.formatDate(it.at))}</td>
          <td>${it.username ? esc(it.username) : `<em class="mut">${esc(t('audit.nobody'))}</em>`}</td>
          <td><span class="tag">${esc(actionLabel(it.action))}</span></td>
          <td>${it.targetType ? esc(`${it.targetType}${it.targetId ? ` #${it.targetId}` : ''}`) : ''}</td>
          <td class="audit-details">${esc(detailsText(it))}</td>
          <td class="mut">${esc(it.ip || '')}</td>
        </tr>`
      )
      .join('');
    $('audit-empty').hidden = data.items.length > 0;
    $('audit-count').textContent = total
      ? t('audit.count', { from: offset + 1, to: offset + data.items.length, total })
      : '';
    $('audit-prev').disabled = offset === 0;
    $('audit-next').disabled = offset + PAGE_SIZE >= total;
    $('af-clear').hidden = [...filters().keys()].length === 0;
  }

  function reload() {
    load().catch(App.flashError);
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('audit-table')) return;
    $('audit-filters').addEventListener('submit', (e) => {
      e.preventDefault();
      offset = 0;
      reload();
    });
    $('af-clear').addEventListener('click', () => {
      for (const id of ['af-user', 'af-action', 'af-from', 'af-to']) $(id).value = '';
      offset = 0;
      reload();
    });
    $('audit-prev').addEventListener('click', () => {
      offset = Math.max(0, offset - PAGE_SIZE);
      reload();
    });
    $('audit-next').addEventListener('click', () => {
      if (offset + PAGE_SIZE < total) offset += PAGE_SIZE;
      reload();
    });
    loadMeta().catch(App.flashError).finally(reload);
  });
})();
