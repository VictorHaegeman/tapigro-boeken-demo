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

  // ---- langue (FR / NL) ----------------------------------------------------------
  // Dictionnaire de la page : GET /i18n/<langue>.js (window.TapigroI18n), chargé
  // juste avant ce script. Même cœur de traduction que le serveur
  // (shared/i18n/i18n.js).
  const I18N = window.TapigroI18n || { lang: 'nl', locale: 'nl-BE', messages: {}, fallback: null };
  const t = window.TapigroI18nCore
    ? window.TapigroI18nCore.createTranslator(I18N.messages, I18N.fallback || I18N.messages)
    : (key) => key;
  const lang = I18N.lang;
  const locale = I18N.locale;

  // Le serveur renvoie ses messages d'erreur déjà traduits (langue de
  // l'utilisateur) ; repli générique si la réponse n'en contient pas.
  function errorMessage(err) {
    return (err && err.message) || t('common.genericError');
  }

  // Nombres au format de la langue (nl-BE : 2,5 ; fr-BE : 2,5).
  function formatNumber(n) {
    if (n === null || n === undefined || n === '') return '';
    const num = Number(n);
    return Number.isFinite(num) ? new Intl.NumberFormat(locale).format(num) : String(n);
  }

  // ---- session expirée ----------------------------------------------------------
  // Page de connexion, avec retour à la page actuelle après connexion.
  function loginUrl() {
    const here = window.location.pathname + window.location.search;
    if (/^\/login(\?|$)/.test(here)) return url('/login');
    return `${url('/login')}?next=${encodeURIComponent(here)}`;
  }

  // Une page qui garde une saisie non enregistrée (l'éditeur) s'inscrit ici :
  // handler(err) → true = « je m'en charge » (pas de redirection brutale, la
  // saisie reste à l'écran) ; false = redirection vers la connexion.
  let sessionExpiredHandler = null;
  function onSessionExpired(handler) {
    sessionExpiredHandler = typeof handler === 'function' ? handler : null;
  }

  // Brouillons de l'éditeur (public/js/editor : tapigro-editor-draft-<user>-<boek>,
  // -stash-…) : effacés à la déconnexion et quand une session expirée est
  // constatée sans saisie à protéger — sur un poste partagé, rien ne reste
  // pour la personne suivante (revue 1.1.0).
  const EDITOR_KEY_PREFIX = 'tapigro-editor-';
  function clearEditorStorage() {
    try {
      const s = window.localStorage;
      if (!s) return;
      const keys = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (typeof k === 'string' && k.startsWith(EDITOR_KEY_PREFIX)) keys.push(k);
      }
      for (const k of keys) s.removeItem(k);
    } catch {
      /* stockage indisponible */
    }
  }

  // 401 / plus de session : erreur 401 (status, code UNAUTHENTICATED), et
  // redirection vers /login?next=<cette page> sauf si la page s'en charge
  // (elle garde alors une saisie : ses brouillons ne sont pas effacés).
  function sessionExpired() {
    const err = new Error(t('common.sessionExpired'));
    err.status = 401;
    err.code = 'UNAUTHENTICATED';
    me = null;
    let handled = false;
    try {
      handled = Boolean(sessionExpiredHandler && sessionExpiredHandler(err) === true);
    } catch {
      handled = false;
    }
    err.handled = handled;
    if (!handled) {
      clearEditorStorage();
      window.location.href = loginUrl();
    }
    return err;
  }

  // Adresse de retour après connexion : un chemin de CETTE app seulement
  // (« /books/3/edit »), jamais « //autre-site » ni « https://… ». Tout
  // caractère de contrôle est refusé (le navigateur retire tabulations et
  // retours à la ligne d'une URL : « /\t/evil » deviendrait « //evil ») ;
  // l'adresse est résolue par le navigateur lui-même et doit rester sur la
  // même origine (revue 1.1.0) — on n'y va que par son chemin.
  function safeNext(value) {
    if (typeof value !== 'string' || !/^\/(?![\/\\])/.test(value)) return null;
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/.test(value)) return null;
    let u;
    try {
      u = new URL(value, window.location.origin);
    } catch {
      return null;
    }
    if (u.origin !== window.location.origin) return null;
    if (u.pathname === '/login') return null;
    return u.pathname + u.search + u.hash;
  }

  // api('/api/x', {method, body}) → JSON ; ajoute X-CSRF-Token sur les mutations,
  // session expirée → sessionExpired() ; jette Error(message) sinon.
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET' && method !== 'HEAD') {
      const session = await fetchMe();
      if (!session && path !== '/api/login') throw sessionExpired();
      if (session) headers['X-CSRF-Token'] = session.csrfToken;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && path !== '/api/login') throw sessionExpired();
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* réponse non JSON (ex. PDF) */
    }
    if (!res.ok) {
      const message = data && data.error ? data.error.message : t('common.httpError', { status: res.status });
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
    if (!session) throw sessionExpired();
    const res = await fetch(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': session.csrfToken },
      body: formData,
    });
    if (res.status === 401) throw sessionExpired();
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* réponse vide */
    }
    if (!res.ok) {
      const message = data && data.error ? data.error.message : t('common.httpError', { status: res.status });
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

  // « 12 nov. 2026 om 14:38 » (nl-BE) / « 12 nov. 2026 à 14:38 » (fr-BE).
  function formatDate(s) {
    const d = parseDbDate(s);
    if (!d) return s || '';
    const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d);
    return t('time.dateAt', { date, time });
  }

  function formatDay(s) {
    const d = parseDbDate(s);
    if (!d) return s || '';
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }

  // « 2 u geleden », « gisteren »… pour les listes (le title= garde la date exacte).
  function relativeDate(s) {
    const d = parseDbDate(s);
    if (!d) return s || '';
    const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (sec < 60) return t('time.justNow');
    if (sec < 3600) return t('time.minutesAgo', { n: Math.floor(sec / 60) });
    if (sec < 86400) return t('time.hoursAgo', { n: Math.floor(sec / 3600) });
    const days = Math.floor(sec / 86400);
    if (days === 1) return t('time.yesterday');
    if (days < 31) return t('time.daysAgo', { n: days });
    return formatDay(s);
  }

  function roleLabel(role) {
    return t(`roles.${role}`);
  }

  // Libellé et description d'un format de page (layout JSON) dans la langue
  // de l'interface : layout.labels[lang], sinon name / description.
  function layoutLabel(layout) {
    const l = (layout && layout.labels && layout.labels[lang]) || {};
    return { name: l.name || layout.name, description: l.description || layout.description || '' };
  }

  // ---- messages flash ------------------------------------------------------------
  // flash('ok'|'erreur'|'info', message) : bandeau en haut de <main>. Les succès
  // disparaissent après 5 s ; les erreurs restent, avec une croix de fermeture.
  // action (facultatif) : {label, onClick} → bouton dans le message (ex.
  // « Ongedaan maken ») ; le message se ferme quand on clique dessus.
  function flash(type, message, action) {
    const zone = document.getElementById('flash');
    if (!zone) {
      if (type === 'erreur') alert(message);
      return null;
    }
    const el = document.createElement('div');
    el.className = `flash ${type}`;
    el.setAttribute('role', type === 'erreur' ? 'alert' : 'status');
    const texte = document.createElement('span');
    texte.className = 'texte';
    texte.textContent = message;
    el.appendChild(texte);
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'flash-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        el.remove();
        action.onClick();
      });
      el.appendChild(btn);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'fermer';
    close.setAttribute('aria-label', t('common.closeMessage'));
    close.textContent = '×';
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);
    zone.appendChild(el);
    if (type !== 'erreur') setTimeout(() => el.remove(), action ? 8000 : 5000);
    return el;
  }

  function flashError(err) {
    flash('erreur', errorMessage(err));
  }

  // Nom de fichier d'un import : la commande `npm run charger` l'enregistre
  // avec le suffixe « (ligne de commande) » — affiché dans la langue de
  // l'interface.
  function importFileName(name) {
    return String(name || '').replace(/ \(ligne de commande\)$/, ` (${t('imports.viaCli')})`);
  }

  // ---- modale de confirmation ------------------------------------------------------
  // confirm({titre, texte, oui, danger}) → Promise<boolean>. Remplace confirm().
  function confirmDialog({ titre = t('common.areYouSure'), texte = '', oui = t('common.yes'), danger = false } = {}) {
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
  function promptText({ titre = '', label = '', valeur = '', type = 'text', oui = t('common.confirm') } = {}) {
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
    el.textContent = errorMessage(err);
    el.hidden = false;
  }

  // ---- comportements communs -------------------------------------------------------
  function initLogout() {
    const btn = document.getElementById('logout-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        await api('/api/logout', { method: 'POST' });
      } catch {
        /* déjà déconnecté */
      } finally {
        clearEditorStorage();
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
        // Retour à la page demandée avant la connexion (?next=…), sinon l'accueil.
        window.location.href = safeNext(new URLSearchParams(window.location.search).get('next')) || url('/');
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
          <td><strong>${esc(u.username)}</strong>${self ? ` <em>${esc(t('users.you'))}</em>` : ''}</td>
          <td>
            <select class="u-role" aria-label="${esc(t('users.roleOf', { name: u.username }))}">
              ${['viewer', 'editor', 'admin']
                .map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${esc(roleLabel(r))}</option>`)
                .join('')}
            </select>
          </td>
          <td><span class="pill ${u.isActive ? 's-actif' : 's-inactif'}">${esc(u.isActive ? t('users.statusActive') : t('users.statusDisabled'))}</span>${
            u.locked ? ` <span class="pill s-retire" title="${esc(t('users.lockedTitle'))}">${esc(t('users.locked'))}</span>` : ''
          }</td>
          <td class="mut" title="${esc(u.createdAt)}">${esc(formatDate(u.createdAt))}</td>
          <td>
            ${u.locked ? `<button class="u-unlock btn petit" type="button">${esc(t('users.unlock'))}</button>` : ''}
            <button class="u-toggle btn sec petit" type="button">${esc(u.isActive ? t('users.disable') : t('users.enable'))}</button>
            <button class="u-password btn sec petit" type="button">${esc(t('users.passwordBtn'))}</button>
            <button class="u-delete btn rouge petit" type="button">${esc(t('common.delete'))}</button>
          </td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('tr').forEach((tr) => {
      const id = tr.dataset.id;
      const user = items.find((u) => String(u.id) === id);
      tr.querySelector('.u-role').addEventListener('change', (e) => {
        patchUser(id, { role: e.target.value }, t('users.roleChanged', { name: user.username, role: roleLabel(e.target.value) }));
      });
      const unlockBtn = tr.querySelector('.u-unlock');
      if (unlockBtn) {
        unlockBtn.addEventListener('click', () => {
          api(`/api/users/${id}/unlock`, { method: 'POST' })
            .then(() => {
              flash('ok', t('users.unlocked', { name: user.username }));
              return renderUsers();
            })
            .catch(flashError);
        });
      }
      tr.querySelector('.u-toggle').addEventListener('click', async () => {
        if (user.isActive) {
          const ok = await confirmDialog({
            titre: t('users.disableTitle', { name: user.username }),
            texte: t('users.disableText'),
            oui: t('users.disableYes'),
            danger: true,
          });
          if (!ok) return;
        }
        patchUser(
          id,
          { is_active: !user.isActive },
          t(user.isActive ? 'users.disabled' : 'users.enabled', { name: user.username })
        );
      });
      tr.querySelector('.u-password').addEventListener('click', async () => {
        const pw = await promptText({
          titre: t('users.passwordTitle', { name: user.username }),
          label: t('admin.passwordNewLabel'),
          type: 'password',
          oui: t('users.passwordSubmit'),
        });
        if (pw) patchUser(id, { password: pw }, t('users.passwordChanged', { name: user.username }));
      });
      tr.querySelector('.u-delete').addEventListener('click', async () => {
        const ok = await confirmDialog({
          titre: t('users.deleteTitle', { name: user.username }),
          texte: t('users.deleteText'),
          oui: t('users.deleteYes'),
          danger: true,
        });
        if (!ok) return;
        api(`/api/users/${id}`, { method: 'DELETE' })
          .then(() => {
            flash('ok', t('users.deleted', { name: user.username }));
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
        flash('ok', t('users.created', { name }));
        await renderUsers();
      } catch (err) {
        showError(errEl, err);
      }
    });
  }

  // Sélecteur NL / FR du menu : mémorisé pour l'utilisateur (PATCH /api/me),
  // puis la page est rechargée dans la nouvelle langue.
  function initLangSwitch() {
    document.querySelectorAll('aside#menu .lang-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.lang === lang) return;
        try {
          await api('/api/me', { method: 'PATCH', body: { lang: btn.dataset.lang } });
          window.location.reload();
        } catch (err) {
          flashError(err);
        }
      });
    });
  }

  // Liens « PDF » (a[data-pdf]) : téléchargement par un GET ordinaire (le
  // navigateur écrit le fichier au fil de l'eau : jamais tout le PDF en
  // mémoire dans un Blob), dans un cadre caché, avec un état visible
  // (« PDF wordt gemaakt… », lien désactivé) — un gros boek prend plusieurs
  // secondes. Le serveur pose le cookie `tapigro_pdf_dl` (routes/pdf.js) :
  // « <jeton> » = le PDF arrive ; « <jeton>-<CODE> » = refusé (429 : déjà un
  // PDF en cours ; 413/400 : trop de pages…). Hors serveur (démo statique : le
  // lien mène à une page), le lien est suivi normalement.
  const PDF_COOKIE = 'tapigro_pdf_dl';
  const PDF_TIMEOUT_MS = 10 * 60 * 1000;

  function readCookie(name) {
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return null;
  }

  function clearPdfCookie() {
    document.cookie = `${PDF_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict`;
  }

  function newToken() {
    const bytes = new Uint8Array(12);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Message d'un refus du serveur : corps JSON du cadre si lisible, sinon
  // message de la langue de l'interface pour ce code.
  function pdfErrorMessage(code, frame) {
    if (code === 'RATE_LIMITED') return t('common.pdfWait');
    try {
      const data = JSON.parse(frame.contentDocument.body.textContent);
      if (data && data.error && data.error.message) return data.error.message;
    } catch {
      /* pas de JSON lisible */
    }
    if (code === 'BOOK_TOO_LARGE' || code === 'QUOTA') return t(`apiErrors.${code}`);
    return t('common.pdfFailed');
  }

  function downloadPdf(link) {
    if (link.getAttribute('aria-disabled') === 'true') return;
    const label = link.textContent;
    link.setAttribute('aria-disabled', 'true');
    link.classList.add('is-busy');
    link.textContent = t('common.pdfBusy');
    const token = newToken();
    clearPdfCookie();
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    let timer = null;
    let finished = false;
    const finish = (message) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      clearPdfCookie();
      link.textContent = label;
      link.removeAttribute('aria-disabled');
      link.classList.remove('is-busy');
      // Le cadre reste le temps que le navigateur termine le téléchargement.
      setTimeout(() => frame.remove(), 60 * 1000);
      if (message) flash('erreur', message);
    };
    const started = Date.now();
    timer = setInterval(() => {
      const value = readCookie(PDF_COOKIE);
      if (value === token) return finish(null); // le PDF arrive
      if (value && value.startsWith(`${token}-`)) return finish(pdfErrorMessage(value.slice(token.length + 1), frame));
      if (Date.now() - started > PDF_TIMEOUT_MS) finish(t('common.pdfFailed'));
      return undefined;
    }, 250);
    // Le cadre ne se « charge » que si le serveur répond par une page (une
    // erreur) : un téléchargement ne déclenche pas load.
    frame.addEventListener('load', () => {
      setTimeout(async () => {
        if (finished) return;
        const value = readCookie(PDF_COOKIE);
        if (value && value.startsWith(token)) return; // l'intervalle s'en charge
        // Refus sans cookie : session expirée (401) ou autre erreur.
        const alive = await fetch('/api/me', { headers: { Accept: 'application/json' } })
          .then((r) => r.ok)
          .catch(() => true); // réseau : on ne conclut pas à une session expirée
        if (!alive) {
          finish(null);
          sessionExpired();
          return;
        }
        finish(pdfErrorMessage(null, frame));
      }, 300);
    });
    const href = link.getAttribute('href');
    frame.src = `${href}${href.includes('?') ? '&' : '?'}dl=${token}`;
    document.body.appendChild(frame);
  }

  function initPdfLinks() {
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-pdf]');
      if (!link || !/^\/api\//.test(link.getAttribute('href') || '')) return;
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      downloadPdf(link);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initPdfLinks();
    initLangSwitch();
    initLogout();
    initLoginPage();
    initAdminUsersPage();
  });

  return {
    url,
    loginUrl,
    onSessionExpired,
    clearEditorStorage,
    safeNext,
    api,
    apiUpload,
    fetchMe,
    esc,
    showError,
    flash,
    flashError,
    errorMessage,
    t,
    lang,
    locale,
    formatNumber,
    formatDay,
    layoutLabel,
    confirm: confirmDialog,
    promptText,
    formatDate,
    relativeDate,
    roleLabel,
    importFileName,
  };
})();
