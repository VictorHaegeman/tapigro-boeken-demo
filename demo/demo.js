/* demo.js — branchement de la démo statique (GitHub Pages) sur le VRAI
 * frontend de Tapigro Boeken. Chargé dans <head>, avant tout script de l'app :
 *  1. crée l'API simulée (backend.js, état dans localStorage) ;
 *  2. remplace window.fetch pour les seules URL /api/… (le reste du réseau —
 *     images, scripts — passe normalement) ;
 *  3. au chargement, fournit aux pages ce que le serveur injecte d'habitude
 *     (id du produit / du boek lus dans ?id=…) ;
 *  4. ajoute le bandeau « Démo » et le bouton « Réinitialiser la démo ».
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'tapigro-boeken-demo';
  const LANG_KEY = 'tapigro-boeken-demo-lang';
  const catalog = window.TapigroDemoCatalog;
  const pageLang = document.documentElement.lang;

  // ---- langue -------------------------------------------------------------------
  // Chaque page existe en NL et en FR (index.html / index.fr.html…). Le choix
  // du sélecteur NL / FR est mémorisé dans ce navigateur ; une page ouverte
  // dans l'autre langue est aussitôt remplacée par sa version dans la langue
  // choisie (avant tout affichage).
  function storedLang() {
    try {
      return window.localStorage.getItem(LANG_KEY);
    } catch {
      return null;
    }
  }
  function urlInLang(lang) {
    const file = window.location.pathname.split('/').pop() || 'index.html';
    const base = file.replace(/\.(nl|fr)\.html$/, '.html');
    const target = window.TapigroDemoUrls.pageName(base, lang, catalog.defaultLang);
    return target + window.location.search + window.location.hash;
  }
  const preferred = storedLang();
  if ((preferred === 'nl' || preferred === 'fr') && preferred !== pageLang) {
    window.location.replace(urlInLang(preferred));
  }

  const backend = window.TapigroDemoBackend.createBackend({
    catalog,
    storage: window.TapigroDemoBackend.browserStorage(STORAGE_KEY),
    lang: pageLang,
    // PATCH /api/me {lang} (sélecteur du menu) : common.js recharge ensuite la
    // page, que la redirection ci-dessus remet dans la bonne langue.
    onLang: (lang) => {
      try {
        window.localStorage.setItem(LANG_KEY, lang);
      } catch {
        /* stockage indisponible : on change quand même de page tout de suite */
        window.location.replace(urlInLang(lang));
      }
    },
  });
  window.TapigroDemo = { backend };
  document.documentElement.classList.add('demo');

  // ---- fetch simulé pour /api/… ------------------------------------------------

  const realFetch = window.fetch.bind(window);

  function apiPath(input) {
    const raw = typeof input === 'string' ? input : input && input.url;
    if (typeof raw !== 'string') return null;
    if (raw.startsWith('/api/')) return raw;
    try {
      const u = new URL(raw, window.location.href);
      if (u.origin === window.location.origin && u.pathname.includes('/api/')) {
        return u.pathname.slice(u.pathname.indexOf('/api/')) + u.search;
      }
    } catch {
      /* URL invalide : réseau normal */
    }
    return null;
  }

  window.fetch = function demoFetch(input, init = {}) {
    const path = apiPath(input);
    if (!path) return realFetch(input, init);
    let body;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    }
    // (FormData — envoi d'images — : pas de JSON, la route répond « non disponible ».)
    const res = backend.handle(init.method || 'GET', path, body);
    return Promise.resolve(
      new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  };

  // ---- ce que le serveur injecte d'habitude dans les pages ----------------------------

  const params = new URLSearchParams(window.location.search);
  const idParam = Number(params.get('id'));
  const url = (p) => window.TapigroUrlMap(p);

  function exists(path) {
    return backend.handle('GET', path).status === 200;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const page = document.body.dataset.page;

    if (page === 'product') {
      if (!exists(`/api/products/${idParam}`)) return window.location.replace(url('/products'));
      document.getElementById('product-fiche').dataset.productId = String(idParam);
    }
    if (page === 'editor') {
      if (!exists(`/api/books/${idParam}`)) return window.location.replace(url('/books'));
      document.getElementById('editor-root').dataset.bookId = String(idParam);
      document.getElementById('pdf-link').href = url(`/api/books/${idParam}/pdf`);
      document.getElementById('preview-link').href = url(`/books/${idParam}/preview`);
      document.title = `${backend.handle('GET', `/api/books/${idParam}`).body.name} — Tapigro Boeken`;
    }
    if (page === 'preview') {
      if (!exists(`/api/books/${idParam}`)) return window.location.replace(url('/books'));
      document.getElementById('preview-root').dataset.bookId = String(idParam);
      document.getElementById('pv-pdf').href = url(`/api/books/${idParam}/pdf`);
      document.getElementById('pv-welcome-edit').href = url(`/books/${idParam}/edit`);
      document.title = `${backend.handle('GET', `/api/books/${idParam}`).body.name} — Tapigro Boeken`;
    }
    if (page === 'demo-pdf') {
      document.getElementById('pdf-retour').href = url(`/books/${idParam}/edit`);
    }

    addBanner();
  });

  // ---- bandeau --------------------------------------------------------------------------

  function addBanner() {
    const t = window.App.t;
    const bar = document.createElement('div');
    bar.className = 'demo-bandeau';
    bar.setAttribute('role', 'note');
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = t('demo.bannerLabel');
    text.append(strong, t('demo.bannerText'));
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'demo-reset';
    reset.textContent = t('demo.reset');
    reset.addEventListener('click', async () => {
      const ok = await window.App.confirm({
        titre: t('demo.resetTitle'),
        texte: t('demo.resetText'),
        oui: t('demo.resetYes'),
        danger: true,
      });
      if (!ok) return;
      backend.reset();
      window.location.href = url('/');
    });
    bar.append(text, reset);
    document.body.prepend(bar);
  }
})();
