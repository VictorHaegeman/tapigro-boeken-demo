'use strict';
// Page /imports (admin) : envoi des formulaires multipart (Excel, images) et
// affichage du journal. Dépend de window.App (public/js/common.js) pour la
// session/CSRF. Aucun script inline (CSP stricte).
(() => {
  const PAGE_SIZE = 20;
  let shown = 0;

  // App.api() ne parle que JSON : les uploads multipart passent par ce helper,
  // qui pose le même en-tête X-CSRF-Token.
  async function apiUpload(path, formData) {
    const session = await window.App.fetchMe();
    if (!session) {
      window.location.href = window.App.url('/login');
      throw new Error('Session expirée');
    }
    const res = await fetch(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': session.csrfToken },
      body: formData,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* réponse vide */
    }
    if (res.status === 401) {
      window.location.href = window.App.url('/login');
      throw new Error('Session expirée');
    }
    if (!res.ok) {
      throw new Error(data && data.error ? data.error.message : `Erreur HTTP ${res.status}`);
    }
    return data;
  }

  const esc = (s) => window.App.esc(s);

  function renderCounts(parts) {
    return parts
      .filter(([, n]) => n !== undefined)
      .map(([label, n]) => `<strong>${n}</strong> ${label}`)
      .join(', ');
  }

  function renderDetails(title, lines, kind) {
    if (!lines.length) return '';
    const cls = kind === 'error' ? ' class="detail-error"' : kind === 'warning' ? ' class="detail-warning"' : '';
    const items = lines.map((l) => `<li>${esc(l)}</li>`).join('');
    return `<details${cls}><summary>${esc(title)} (${lines.length})</summary><ul>${items}</ul></details>`;
  }

  // Les doublons (marqués `warning: true` par le serveur) sont un comportement
  // NORMAL des exports Optedo : affichés en neutre, séparés des vraies erreurs.
  function splitWarnings(entries) {
    const warnings = [];
    const errors = [];
    for (const e of entries) (e.warning ? warnings : errors).push(e);
    return { warnings, errors };
  }

  function formatEntry(e) {
    return e.sheet ? `${e.sheet} ligne ${e.row} : ${e.message}` : e.message;
  }

  function showResult(el, html, ok) {
    el.innerHTML = html;
    el.classList.toggle('import-result-ok', ok);
    el.hidden = false;
  }

  // ---- journal ------------------------------------------------------------------
  async function loadJournal(reset) {
    if (reset) shown = 0;
    const { items, total } = await window.App.api(
      `/api/imports?limit=${PAGE_SIZE}&offset=${shown}`
    );
    const tbody = document.querySelector('#imports-table tbody');
    if (reset) tbody.innerHTML = '';
    tbody.insertAdjacentHTML(
      'beforeend',
      items
        .map((it) => {
          const { warnings, errors } = splitWarnings(it.errors);
          const detail =
            renderDetails('Avertissements', warnings.map(formatEntry), 'warning') +
            renderDetails('Erreurs', errors.map(formatEntry), 'error');
          return `<tr>
            <td>${esc(it.startedAt)}</td>
            <td>${esc(it.username)}</td>
            <td>${esc(it.kind)}</td>
            <td>${esc(it.fileName)}</td>
            <td>${it.created}</td>
            <td>${it.updated}</td>
            <td>${it.unchanged}</td>
            <td>${it.skippedManual || 0}</td>
            <td>${it.deactivated}</td>
            <td>${detail || '0'}</td>
          </tr>`;
        })
        .join('')
    );
    shown += items.length;
    document.getElementById('imports-empty').hidden = total > 0;
    document.getElementById('imports-more').hidden = shown >= total;
  }

  // ---- formulaire Excel -----------------------------------------------------------
  function initExcelForm() {
    const form = document.getElementById('excel-form');
    const errEl = document.getElementById('excel-error');
    const resultEl = document.getElementById('excel-result');
    const submit = document.getElementById('excel-submit');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      resultEl.hidden = true;
      const file = document.getElementById('excel-file').files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      if (document.getElementById('excel-allow-deactivation').checked) {
        fd.append('allowDeactivation', 'true');
      }
      submit.disabled = true;
      try {
        const r = await apiUpload('/api/imports/excel', fd);
        // Seules les VRAIES erreurs empêchent l'affichage « succès » : les
        // avertissements (doublons) sont normaux sur les exports Optedo.
        const { warnings, errors } = splitWarnings(r.errors);
        showResult(
          resultEl,
          renderCounts([
            ['créés', r.created],
            ['modifiés', r.updated],
            ['inchangés', r.unchanged],
            ['ignorés (modifiés à la main)', r.skippedManual || 0],
            ['désactivés', r.deactivated],
          ]) +
            renderDetails('Avertissements', warnings.map(formatEntry), 'warning') +
            renderDetails('Erreurs', errors.map(formatEntry), 'error'),
          errors.length === 0
        );
        form.reset();
        await loadJournal(true);
      } catch (err) {
        window.App.showError(errEl, err);
      } finally {
        submit.disabled = false;
      }
    });
  }

  // ---- formulaire images ----------------------------------------------------------
  function initImagesForm() {
    const form = document.getElementById('images-form');
    const errEl = document.getElementById('images-error');
    const resultEl = document.getElementById('images-result');
    const submit = document.getElementById('images-submit');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      resultEl.hidden = true;
      const files = [...document.getElementById('images-files').files];
      if (!files.length) return;
      const zips = files.filter((f) => /\.zip$/i.test(f.name));
      const fd = new FormData();
      if (zips.length === 1 && files.length === 1) {
        fd.append('zip', zips[0]);
      } else if (zips.length > 0) {
        window.App.showError(errEl, new Error('Envoyez soit UN zip, soit des images — pas les deux.'));
        return;
      } else {
        for (const f of files) fd.append('files', f);
      }
      submit.disabled = true;
      try {
        const r = await apiUpload('/api/imports/images', fd);
        showResult(
          resultEl,
          renderCounts([
            ['associées', r.matched],
            ['remplacées', r.replaced],
            ['ignorées', r.ignored.length],
          ]) + renderDetails('Fichiers ignorés', r.ignored.map((i) => `${i.file} : ${i.reason}`)),
          r.ignored.length === 0
        );
        form.reset();
        await loadJournal(true);
      } catch (err) {
        window.App.showError(errEl, err);
      } finally {
        submit.disabled = false;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('excel-form')) return;
    initExcelForm();
    initImagesForm();
    document.getElementById('imports-more').addEventListener('click', () => {
      loadJournal(false).catch((err) => alert(err.message));
    });
    loadJournal(true).catch((err) => alert(err.message));
  });
})();
