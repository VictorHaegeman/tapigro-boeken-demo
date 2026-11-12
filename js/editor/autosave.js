/* autosave.js — persistance de l'éditeur (tâche C).
 *
 * Deux mécanismes, un seul indicateur « enregistré / en cours » :
 *  - track(promise) : les mutations granulaires (drop, move, remove) sont déjà
 *    des appels API immédiats, on ne fait que compter celles en vol ;
 *  - scheduleDoc(fn) : nom + textes des pages fixes, débouncés (800 ms) et
 *    envoyés en un PATCH /api/books/:id ; flush() force l'envoi immédiat
 *    (bouton Enregistrer).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditorAutosave = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEBOUNCE_MS = 800;
  // Textes dans la langue de l'interface (App.t, common.js) ; clé brute en Node.
  const tr = (key, params) => (typeof self !== 'undefined' && self.App ? self.App.t(key, params) : key);

  // statusEl : l'élément de l'indicateur. États : is-saved / is-saving / is-error.
  function createSaver(statusEl) {
    let pending = 0; // mutations granulaires en vol
    let dirty = false; // nom/textes modifiés pas encore envoyés
    let timer = null;
    let docSave = null; // fonction async qui envoie {name, texts}

    function render(error) {
      if (!statusEl) return;
      statusEl.classList.remove('is-saved', 'is-saving', 'is-error');
      if (error) {
        statusEl.classList.add('is-error');
        statusEl.textContent = tr('common.error', { message: error.message });
      } else if (pending > 0 || dirty) {
        statusEl.classList.add('is-saving');
        statusEl.textContent = tr('editor.saving');
      } else {
        statusEl.classList.add('is-saved');
        statusEl.textContent = tr('editor.saved');
      }
    }

    // Suit une mutation granulaire déjà lancée (POST/PATCH/DELETE item…).
    async function track(promise) {
      pending += 1;
      render();
      try {
        return await promise;
      } catch (err) {
        render(err);
        throw err;
      } finally {
        pending -= 1;
        if (pending === 0 && !dirty) render();
      }
    }

    // Déclare la fonction d'envoi du document (une seule, posée à l'init).
    function setDocSave(fn) {
      docSave = fn;
    }

    async function flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!dirty || !docSave) return;
      dirty = false;
      await track(docSave());
    }

    // Nom ou texte modifié : envoi débouncé.
    function scheduleDoc() {
      dirty = true;
      render();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        flush().catch(() => {});
      }, DEBOUNCE_MS);
    }

    render();
    return { track, scheduleDoc, flush, setDocSave };
  }

  return { createSaver, DEBOUNCE_MS };
});
