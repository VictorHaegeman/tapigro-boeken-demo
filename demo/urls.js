/* urls.js — traduction des URL de l'app vers la démo statique (GitHub Pages).
 *
 * Le frontend écrit ses URL comme des routes du serveur (« /products/12 »,
 * « /img/1-TA-0001/photo ») et les fait passer par App.url (common.js) ; les
 * vues EJS par url(). En production c'est l'identité. Dans la démo, toutes
 * les pages sont des fichiers .html à la RACINE du site, et toutes les URL
 * produites sont RELATIVES : le site marche aussi bien à la racine d'un
 * serveur local que sous https://<compte>.github.io/tapigro-boeken-demo/.
 *
 *   /                  → index.html            /books/12/edit  → editor.html?id=12
 *   /products?x=1      → products.html?x=1     /api/books/12/pdf → pdf.html?id=12
 *   /products/12       → product.html?id=12    /imports, /admin/users → pages « non disponible »
 *   /img/CODE/photo    → data/images/<fichier> (manifeste du catalogue)
 *   /css/x, /assets/x… → css/x, assets/x…      /api/…          → inchangé (fetch simulé, demo.js)
 *
 * Langues : les pages existent dans chaque langue — « products.html » dans la
 * langue par défaut de la démo, « products.fr.html » pour l'autre. Les liens
 * restent dans la langue de la page affichée.
 *
 * Module UMD : utilisé au build (Node, rendu des vues) et dans le navigateur.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.TapigroDemoUrls = factory();
    const catalog = root.TapigroDemoCatalog || {};
    root.TapigroUrlMap = root.TapigroDemoUrls.createUrlMap(catalog.images || {}, {
      lang: root.document ? root.document.documentElement.lang : undefined,
      defaultLang: catalog.defaultLang,
    });
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // GIF transparent : une image demandée sans fichier ne provoque pas de 404.
  const NO_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

  /**
   * @param {Object<string, {photo?: string, barcode?: string, thumb?: string}>} images
   *   manifeste CODE (majuscules) → chemins relatifs des fichiers
   * @returns {(path: string) => string}
   */
  // « products.html » → « products.fr.html » hors langue par défaut.
  function pageName(file, lang, defaultLang) {
    return !lang || !defaultLang || lang === defaultLang ? file : file.replace(/\.html$/, `.${lang}.html`);
  }

  function createUrlMap(images = {}, { lang, defaultLang } = {}) {
    const page = (file) => pageName(file, lang, defaultLang);
    return function map(path) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return path;
      const cut = path.search(/[?#]/);
      const pathname = cut === -1 ? path : path.slice(0, cut);
      const query = cut === -1 ? '' : path.slice(cut);
      let m;
      if (pathname === '/' || pathname === '/login') return page('index.html');
      if (pathname === '/products') return `${page('products.html')}${query}`;
      if ((m = /^\/products\/(\d+)$/.exec(pathname))) return `${page('product.html')}?id=${m[1]}`;
      if (pathname === '/books') return page('books.html');
      if ((m = /^\/books\/(\d+)\/edit$/.exec(pathname))) return `${page('editor.html')}?id=${m[1]}`;
      if ((m = /^\/api\/books\/(\d+)\/pdf$/.exec(pathname))) return `${page('pdf.html')}?id=${m[1]}`;
      if (pathname === '/imports') return page('imports.html');
      if (pathname === '/admin/users') return page('users.html');
      if (pathname.startsWith('/api/')) return path; // intercepté par le fetch simulé
      if ((m = /^\/img\/([^/]+)\/(photo|barcode|thumb)$/.exec(pathname))) {
        // ?t=… (anti-cache de la fiche) ignoré : les fichiers ne changent pas.
        let code = m[1];
        try {
          code = decodeURIComponent(code);
        } catch {
          /* code mal encodé : tel quel */
        }
        const entry = images[code.toUpperCase()];
        return (entry && entry[m[2]]) || NO_IMAGE;
      }
      return pathname.slice(1) + query; // fichiers statiques : relatifs
    };
  }

  return { createUrlMap, pageName, NO_IMAGE };
});
