'use strict';
// Helper partagé par toutes les pages : fetch JSON + CSRF, session courante,
// messages flash, modales de confirmation/saisie (remplacent confirm()/prompt()),
// dates lisibles, et comportements des pages login / admin-users.
// Les autres pages (books, editor, imports, products, home) importent window.App.
window.App = (() => {
  let me = null; // { user, csrfToken }

  // URL d'une page ou d'un fichier de l'app, écrite comme une route du
  // serveur (« /products/12 », « /img/X/photo »). En production : inchangée.
  // Une version statique (démo GitHub Pages, demo/urls.js) peut fournir
  // window.TapigroUrlMap AVANT ce script pour la traduire (sous-chemin, pages
  // .html) — le reste du frontend n'en sait rien.
  function url(path) {
    return typeof window.TapigroUrlMap === 'function' ? window.TapigroUrlMap(path) : path;
  }

  async function fetchMe() {
    if (me) return me;
    const res = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    me = await res.json();
    return me;
  }

  // Messages d'erreur serveur (anglais, codes stables) → phrases françaises.
  const ERROR_MESSAGES = {
    BAD_CREDENTIALS: 'Nom d’utilisateur ou mot de passe incorrect.',
    UNAUTHENTICATED: 'Session expirée : reconnectez-vous.',
    FORBIDDEN: 'Vous n’avez pas les droits nécessaires pour cette action.',
    RATE_LIMITED: 'Trop de tentatives : patientez un instant puis réessayez.',
  };

  function frenchMessage(err) {
    return (err && ERROR_MESSAGES[err.code]) || (err && err.message) || 'Une erreur est survenue.';
  }

  // api('/api/x', {method, body}) → JSON ; ajoute X-CSRF-Token sur les mutations,
  // redirige vers /login si la session a expiré, jette Error(message) sinon.
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET' && method !== 'HEAD') {
      const session = await fetchMe();
      if (!session && path !== '/api/login') {
        window.location.href = url('/login');
        throw new Error('Session expirée');
      }
      if (session) headers['X-CSRF-Token'] = session.csrfToken;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && path !== '/api/login') {
      window.location.href = url('/login');
      throw new Error('Session expirée');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* réponse non JSON (ex. PDF) */
    }
    if (!res.ok) {
      const message = data && data.error ? data.error.message : `Erreur HTTP ${res.status}`;
      const err = new Error(message);
      err.code = data && data.error ? data.error.code : 'HTTP_' + res.status;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Upload multipart (imports, photo produit) : même session/CSRF que api().
  async function apiUpload(path, formData) {
    const session = await fetchMe();
    if (!session) {
      window.location.href = url('/login');
      throw new Error('Session expirée');
    }
    const res = await fetch(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': session.csrfToken },
      body: formData,
    });
    if (res.status === 401) {
      window.location.href = url('/login');
      throw new Error('Session expirée');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* réponse vide */
    }
    if (!res.ok) {
      const message = data && data.error ? data.error.message : `Erreur HTTP ${res.status}`;
      const err = new Error(message);
      err.code = data && data.error ? data.error.code : 'HTTP_' + res.status;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  // ---- dates lisibles ----------------------------------------------------------
  // La BDD stocke 'YYYY-MM-DD HH:MM:SS' en UTC (sqliteNow).
  function parseDbDate(s) {
    if (!s) return null;
    const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

  function formatDate(s) {
    const d = parseDbDate(s);
    if (!d) return s || '';
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} à ${h}:${m}`;
  }

  // « il y a 2 h », « hier »… pour les listes (le title= garde la date exacte).
  function relativeDate(s) {
    const d = parseDbDate(s);
    if (!d) return s || '';
    const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (sec < 60) return 'à l’instant';
    if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`;
    if (sec < 86400) return `il y a ${Math.floor(sec / 3600)} h`;
    const days = Math.floor(sec / 86400);
    if (days === 1) return 'hier';
    if (days < 31) return `il y a ${days} jours`;
    return formatDate(s).replace(/ à .*$/, '');
  }

  const ROLE_LABELS = { admin: 'Administrateur', editor: 'Éditeur', viewer: 'Lecture seule' };
  function roleLabel(role) {
    return ROLE_LABELS[role] || role;
  }

  // ---- messages flash ------------------------------------------------------------
  // flash('ok'|'erreur'|'info', message) : bandeau en haut de <main>. Les succès
  // disparaissent après 5 s ; les erreurs restent, avec une croix de fermeture.
  function flash(type, message) {
    const zone = document.getElementById('flash');
    if (!zone) {
      if (type === 'erreur') alert(message);
      return;
    }
    const el = document.createElement('div');
    el.className = `flash ${type}`;
    el.setAttribute('role', type === 'erreur' ? 'alert' : 'status');
    const texte = document.createElement('span');
    texte.className = 'texte';
    texte.textContent = message;
    el.appendChild(texte);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'fermer';
    close.setAttribute('aria-label', 'Fermer le message');
    close.textContent = '×';
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);
    zone.appendChild(el);
    if (type !== 'erreur') setTimeout(() => el.remove(), 5000);
  }

  function flashError(err) {
    flash('erreur', frenchMessage(err));
  }

  // ---- modale de confirmation ------------------------------------------------------
  // confirm({titre, texte, oui, danger}) → Promise<boolean>. Remplace confirm().
  function confirmDialog({ titre = 'Êtes-vous sûr ?', texte = '', oui = 'Oui', danger = false } = {}) {
    const dlg = document.getElementById('confirmation');
    if (!dlg) return Promise.resolve(window.confirm(texte || titre));
    dlg.querySelector('#confirmation-titre').textContent = titre;
    dlg.querySelector('#confirmation-texte').textContent = texte;
    const ouiBtn = dlg.querySelector('[data-reponse="oui"]');
    ouiBtn.textContent = oui;
    ouiBtn.classList.toggle('rouge', danger);
    return new Promise((resolve) => {
      const onClick = (e) => {
        let r = e.target.closest('[data-reponse]')?.dataset.reponse;
        if (e.target === dlg) r = 'non'; // clic à côté de la fenêtre = non
        if (!r) return;
        done(r === 'oui');
      };
      const onCancel = () => done(false); // Échap
      function done(result) {
        dlg.removeEventListener('click', onClick);
        dlg.removeEventListener('cancel', onCancel);
        if (dlg.open) dlg.close();
        resolve(result);
      }
      dlg.addEventListener('click', onClick);
      dlg.addEventListener('cancel', onCancel);
      dlg.showModal();
    });
  }

  // ---- modale de saisie ---------------------------------------------------------------
  // promptText({titre, label, valeur, type, oui}) → Promise<string|null>. Remplace prompt().
  function promptText({ titre = '', label = '', valeur = '', type = 'text', oui = 'Valider' } = {}) {
    const dlg = document.getElementById('saisie');
    if (!dlg) return Promise.resolve(window.prompt(label || titre, valeur));
    dlg.querySelector('#saisie-titre').textContent = titre;
    dlg.querySelector('#saisie-label').textContent = label;
    const champ = dlg.querySelector('#saisie-champ');
    champ.type = type;
    champ.value = valeur;
    dlg.querySelector('[data-reponse="oui"]').textContent = oui;
    return new Promise((resolve) => {
      const form = dlg.querySelector('#saisie-form');
      const onSubmit = (e) => {
        e.preventDefault();
        done(champ.value);
      };
      const onNon = (e) => {
        if (e.target.closest('[data-reponse="non"]') || e.target === dlg) done(null);
      };
      const onCancel = () => done(null);
      function done(result) {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('click', onNon);
        dlg.removeEventListener('cancel', onCancel);
        if (dlg.open) dlg.close();
        resolve(result);
      }
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('click', onNon);
      dlg.addEventListener('cancel', onCancel);
      dlg.showModal();
      champ.focus();
      champ.select();
    });
  }

  // Erreur inline (formulaires) — conservé pour compatibilité.
  function showError(el, err) {
    if (!el) return flashError(err);
    el.textContent = frenchMessage(err);
    el.hidden = false;
  }

  // ---- comportements communs -------------------------------------------------------
  function initLogout() {
    const btn = document.getElementById('logout-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        await api('/api/logout', { method: 'POST' });
      } finally {
        window.location.href = url('/login');
      }
    });
  }

  // ---- page login ---------------------------------------------------------------------
  function initLoginPage() {
    const form = document.getElementById('login-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('login-error');
      errEl.hidden = true;
      try {
        await api('/api/login', {
          method: 'POST',
          body: {
            username: form.username.value,
            password: form.password.value,
          },
        });
        window.location.href = '/';
      } catch (err) {
        showError(errEl, err);
      }
    });
  }

  // ---- page admin-users -----------------------------------------------------------------
  async function renderUsers() {
    const tbody = document.querySelector('#users-table tbody');
    const { items } = await api('/api/users');
    const session = await fetchMe();
    tbody.innerHTML = items
      .map((u) => {
        const self = session && session.user.id === u.id;
        return `<tr data-id="${u.id}">
          <td><strong>${esc(u.username)}</strong>${self ? ' <em>(vous)</em>' : ''}</td>
          <td>
            <select class="u-role" aria-label="Rôle de ${esc(u.username)}">
              ${['viewer', 'editor', 'admin']
                .map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${esc(roleLabel(r))}</option>`)
                .join('')}
            </select>
          </td>
          <td><span class="pill ${u.isActive ? 's-actif' : 's-inactif'}">${u.isActive ? 'Actif' : 'Désactivé'}</span></td>
          <td class="mut" title="${esc(u.createdAt)}">${esc(formatDate(u.createdAt))}</td>
          <td>
            <button class="u-toggle btn sec petit" type="button">${u.isActive ? 'Désactiver' : 'Réactiver'}</button>
            <button class="u-password btn sec petit" type="button">Mot de passe…</button>
            <button class="u-delete btn rouge petit" type="button">Supprimer</button>
          </td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('tr').forEach((tr) => {
      const id = tr.dataset.id;
      const user = items.find((u) => String(u.id) === id);
      tr.querySelector('.u-role').addEventListener('change', (e) => {
        patchUser(id, { role: e.target.value }, `Rôle de ${user.username} changé en « ${roleLabel(e.target.value)} ».`);
      });
      tr.querySelector('.u-toggle').addEventListener('click', async () => {
        if (user.isActive) {
          const ok = await confirmDialog({
            titre: `Désactiver ${user.username} ?`,
            texte: 'Cette personne ne pourra plus se connecter. Vous pourrez la réactiver plus tard.',
            oui: 'Oui, désactiver',
            danger: true,
          });
          if (!ok) return;
        }
        patchUser(id, { is_active: !user.isActive }, user.isActive ? `${user.username} est désactivé.` : `${user.username} est réactivé.`);
      });
      tr.querySelector('.u-password').addEventListener('click', async () => {
        const pw = await promptText({
          titre: `Mot de passe de ${user.username}`,
          label: 'Nouveau mot de passe (8 caractères minimum)',
          type: 'password',
          oui: 'Changer le mot de passe',
        });
        if (pw) patchUser(id, { password: pw }, `Mot de passe de ${user.username} changé.`);
      });
      tr.querySelector('.u-delete').addEventListener('click', async () => {
        const ok = await confirmDialog({
          titre: `Supprimer ${user.username} ?`,
          texte: 'Le compte est supprimé définitivement. Pour un départ temporaire, préférez « Désactiver ».',
          oui: 'Oui, supprimer',
          danger: true,
        });
        if (!ok) return;
        api(`/api/users/${id}`, { method: 'DELETE' })
          .then(() => {
            flash('ok', `${user.username} est supprimé.`);
            return renderUsers();
          })
          .catch(flashError);
      });
    });
  }

  function patchUser(id, body, message) {
    api(`/api/users/${id}`, { method: 'PATCH', body })
      .then(() => {
        if (message) flash('ok', message);
        return renderUsers();
      })
      .catch((err) => {
        flashError(err);
        renderUsers();
      });
  }

  function initAdminUsersPage() {
    if (!document.getElementById('users-table')) return;
    renderUsers().catch(flashError);
    const form = document.getElementById('user-create-form');
    const dlg = document.getElementById('user-create-dialog');
    const openBtn = document.getElementById('user-create-open');
    if (openBtn && dlg) {
      openBtn.addEventListener('click', () => dlg.showModal());
      dlg.querySelector('[data-reponse="non"]').addEventListener('click', () => dlg.close());
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('user-create-error');
      errEl.hidden = true;
      try {
        await api('/api/users', {
          method: 'POST',
          body: {
            username: form.username.value,
            password: form.password.value,
            role: form.role.value,
          },
        });
        const name = form.username.value;
        form.reset();
        if (dlg && dlg.open) dlg.close();
        flash('ok', `Utilisateur ${name} créé.`);
        await renderUsers();
      } catch (err) {
        showError(errEl, err);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initLogout();
    initLoginPage();
    initAdminUsersPage();
  });

  return {
    url,
    api,
    apiUpload,
    fetchMe,
    esc,
    showError,
    flash,
    flashError,
    frenchMessage,
    confirm: confirmDialog,
    promptText,
    formatDate,
    relativeDate,
    roleLabel,
  };
})();
