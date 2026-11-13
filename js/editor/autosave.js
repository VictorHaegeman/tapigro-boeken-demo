/* autosave.js — persistance de l'éditeur, sans jamais mentir sur l'état.
 *
 * Règle d'or : l'indicateur n'affiche « Opgeslagen » QUE si le serveur a
 * confirmé tout ce que l'utilisateur voit (aucun champ en attente, aucun
 * envoi en vol, aucune mutation de structure en cours, aucun problème).
 *
 * Briques (module UMD : navigateur → window.EditorAutosave, Node → tests) :
 *  - createSaver : machine d'états du nom et des textes des pages fixes.
 *    Seuls les champs MODIFIÉS partent (PATCH partiel, fusion côté serveur),
 *    débouncés (800 ms) ; chaque champ garde sa valeur de base (dernière
 *    valeur connue du serveur) pour détecter les vrais conflits. Échec →
 *    les champs restent « à envoyer », nouvel essai automatique (2 s, 5 s,
 *    15 s, 30 s, puis toutes les 30 s ; arrêtés après 10 minutes sans
 *    succès — bouton « Opnieuw proberen » seulement, brouillon gardé) sauf
 *    refus du serveur (400…) ou conflit de version (409 : en attente d'une
 *    décision). Les mutations de
 *    structure (dépôt, déplacement, retrait, pages) sont comptées (track) ;
 *    après l'échec de l'une d'elles, l'état reste « saving » jusqu'à la fin
 *    de la resynchronisation (structureOk / structureFailed, ou
 *    structureSettled s'il n'y a rien à recharger) ; si elle échoue,
 *    structureFailed() garde l'alerte et réessaie la resynchro.
 *  - createApi : fetch JSON + CSRF qui NE redirige PAS vers /login (la saisie
 *    resterait en plan) : session expirée → erreur 401, jeton CSRF relu après
 *    une reconnexion faite dans un autre onglet.
 *  - createQueue : une requête de l'éditeur à la fois (ordre garanti ; la
 *    version envoyée est toujours la dernière connue — jamais de conflit
 *    avec soi-même).
 *  - createDraftStore : brouillon dans localStorage (try/catch partout) —
 *    la saisie non enregistrée survit à un onglet fermé ou à une reconnexion.
 *  - renderStatus : l'indicateur de la barre d'outils.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditorAutosave = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEBOUNCE_MS = 800;
  const RETRY_DELAYS = [2000, 5000, 15000, 30000];
  // Après 10 minutes d'échecs sans un seul succès (réseau coupé, session
  // expirée…) : plus de nouvel essai automatique — le bouton « Opnieuw
  // proberen » seulement ; la saisie reste dans le brouillon local.
  const GIVE_UP_MS = 10 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 20000;
  // Textes dans la langue de l'interface (App.t, common.js) ; clé brute en Node.
  const tr = (key, params) => (typeof self !== 'undefined' && self.App ? self.App.t(key, params) : key);

  // ---- erreurs ------------------------------------------------------------------

  // Que faire après l'échec d'une requête ?
  //  'session'  : session expirée (401) — garder la saisie, réessayer après reconnexion ;
  //  'conflict' : 409 BOOK_CONFLICT — le boek a changé ailleurs, décision requise ;
  //  'offline'  : pas de réponse (réseau coupé, serveur arrêté, délai dépassé) ;
  //  'retry'    : erreur passagère du serveur (5xx, 408, 429) ;
  //  'rejected' : refus définitif (400, 403, 404, autre 409…) — pas de nouvel
  //               essai automatique (il échouerait pareil), bouton « opnieuw ».
  function classifyError(err) {
    if (!err) return 'retry';
    if (err.status === 401 || err.code === 'UNAUTHENTICATED') return 'session';
    if (err.code === 'BOOK_CONFLICT') return 'conflict';
    if (!err.status) return 'offline';
    if (err.status >= 500 || err.status === 408 || err.status === 429) return 'retry';
    return 'rejected';
  }

  function retryDelay(attempt) {
    return RETRY_DELAYS[Math.min(Math.max(0, attempt), RETRY_DELAYS.length - 1)];
  }

  // ---- file d'attente ---------------------------------------------------------------

  function createQueue() {
    let tail = Promise.resolve();
    return {
      // fn() → Promise ; exécutée quand les précédentes sont terminées.
      run(fn) {
        const p = tail.then(() => fn());
        tail = p.catch(() => {});
        return p;
      },
    };
  }

  // ---- API ------------------------------------------------------------------------------

  function offlineError(cause) {
    const err = new Error(tr('editor.offline'));
    err.status = 0;
    err.code = 'NETWORK';
    err.cause = cause;
    return err;
  }

  function sessionError() {
    const err = new Error(tr('editor.sessionExpired'));
    err.status = 401;
    err.code = 'UNAUTHENTICATED';
    return err;
  }

  // fetchImpl(url, init) : window.fetch (relu à chaque appel : la démo le remplace).
  function createApi({ fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    let token = null;

    async function rawFetch(path, init) {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        return await fetchImpl(path, ctrl ? { ...init, signal: ctrl.signal } : init);
      } catch (cause) {
        throw offlineError(cause);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // Jeton CSRF de la session courante (null : pas de session).
    async function csrfToken(force) {
      if (token && !force) return token;
      const res = await rawFetch('/api/me', { method: 'GET', headers: { Accept: 'application/json' } });
      if (!res.ok) {
        token = null;
        return null;
      }
      try {
        token = (await res.json()).csrfToken || null;
      } catch {
        token = null;
      }
      return token;
    }

    async function call(path, { method = 'GET', body } = {}, retried = false) {
      const headers = { Accept: 'application/json' };
      const mutating = method !== 'GET' && method !== 'HEAD';
      if (mutating) {
        const tok = await csrfToken(false);
        if (!tok) throw sessionError();
        headers['X-CSRF-Token'] = tok;
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await rawFetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* réponse vide ou non JSON */
      }
      if (res.ok) return data;
      const code = data && data.error ? data.error.code : `HTTP_${res.status}`;
      // Jeton CSRF refusé : session expirée (le serveur ne la connaît plus) ou
      // reconnexion faite ailleurs (nouveau jeton) → on relit le jeton une fois.
      if (mutating && res.status === 403 && code === 'CSRF' && !retried) {
        token = null;
        const tok = await csrfToken(true);
        if (!tok) throw sessionError();
        return call(path, { method, body }, true);
      }
      if (res.status === 401) {
        token = null;
        throw sessionError();
      }
      const err = new Error(data && data.error ? data.error.message : tr('common.httpError', { status: res.status }));
      err.status = res.status;
      err.code = code;
      if (data && data.book) err.book = data.book; // 409 BOOK_CONFLICT : état courant
      throw err;
    }

    return { call, csrfToken };
  }

  // ---- brouillon local ------------------------------------------------------------------

  // storage : window.localStorage par défaut ; toute erreur (navigation
  // privée, quota, stockage bloqué) est ignorée — le brouillon est un filet,
  // pas une condition. key : texte, ou fonction → texte | null (clé connue
  // plus tard, ex. l'utilisateur connecté ; null = rien n'est lu ni écrit).
  function createDraftStore(keyOrFn, storage) {
    const keyOf = () => (typeof keyOrFn === 'function' ? keyOrFn() : keyOrFn);
    const store = () => {
      if (storage) return storage;
      try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
      } catch {
        return null;
      }
    };
    return {
      load() {
        try {
          const key = keyOf();
          const s = key ? store() : null;
          const raw = s && s.getItem(key);
          if (!raw) return null;
          const data = JSON.parse(raw);
          return Array.isArray(data && data.entries) ? data.entries : null;
        } catch {
          return null;
        }
      },
      save(entries) {
        try {
          const key = keyOf();
          const s = key ? store() : null;
          if (s) s.setItem(key, JSON.stringify({ savedAt: new Date().toISOString(), entries }));
        } catch {
          /* stockage indisponible */
        }
      },
      clear() {
        try {
          const key = keyOf();
          const s = key ? store() : null;
          if (s) s.removeItem(key);
        } catch {
          /* stockage indisponible */
        }
      },
    };
  }

  // ---- machine d'états ---------------------------------------------------------------------

  /**
   * @param {object} o
   * @param {(fields: object) => Promise<any>} o.send envoie {champ: valeur}
   * @param {(result: any, sent: Map) => void} [o.onSaved] après un envoi réussi
   * @param {(err: Error) => void} [o.onConflict] 409 : le saver est en pause
   *   (held) jusqu'à resume() ou discardAll()
   * @param {() => Promise<void>} [o.resync] resynchronisation après l'échec
   *   d'une mutation de structure (nouvel essai automatique)
   * @param {(info: object) => void} [o.onChange] à chaque changement d'état
   * @param {{save(entries): void, clear(): void}} [o.draft] brouillon local
   */
  function createSaver({
    send,
    onSaved = null,
    onConflict = null,
    resync = null,
    onChange = null,
    draft = null,
    timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) },
    debounceMs = DEBOUNCE_MS,
  }) {
    const now = typeof timers.now === 'function' ? () => timers.now() : () => Date.now();
    let failingSince = null; // premier échec depuis le dernier succès
    let gaveUp = false; // nouveaux essais automatiques arrêtés (GIVE_UP_MS)
    const changes = new Map(); // champ → {value, base}
    let sending = null; // Map champ → valeur en cours d'envoi
    let sendPromise = null;
    let again = false; // envoi immédiat demandé pendant un envoi
    let structure = 0; // mutations de structure en vol
    // Mutations de structure ÉCHOUÉES dont la resynchronisation n'est pas
    // terminée (structureOk / structureFailed) : la vue peut montrer un état
    // qui n'existe pas (clone « en attente ») → jamais « Opgeslagen ».
    let resyncing = 0;
    let problem = null; // {kind, error, source: 'doc' | 'structure'}
    let attempt = 0;
    let held = false;
    let debounceTimer = null;
    let retryTimer = null;

    function info() {
      let state;
      if (sending) state = 'saving';
      else if (problem) state = problem.kind;
      else if (structure > 0 || resyncing > 0) state = 'saving';
      else if (changes.size > 0) state = 'pending';
      else state = 'saved';
      return {
        state,
        error: problem ? problem.error : null,
        source: problem ? problem.source : null,
        autoRetry: retryTimer !== null,
        gaveUp,
        unsaved: hasUnsaved(),
        held,
      };
    }

    function emit() {
      if (onChange) onChange(info());
    }

    function persist() {
      if (!draft) return;
      if (changes.size) draft.save(entries());
      else draft.clear();
    }

    function entries() {
      return Array.from(changes, ([field, c]) => [field, { value: c.value, base: c.base }]);
    }

    function hasUnsaved() {
      return changes.size > 0 || sending !== null || structure > 0 || resyncing > 0;
    }

    function stopDebounce() {
      if (debounceTimer !== null) timers.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    function stopRetry() {
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      retryTimer = null;
    }

    function scheduleDebounce() {
      stopDebounce();
      debounceTimer = timers.setTimeout(() => {
        debounceTimer = null;
        flush();
      }, debounceMs);
    }

    function scheduleRetry() {
      stopRetry();
      const delay = retryDelay(attempt);
      attempt += 1;
      retryTimer = timers.setTimeout(() => {
        retryTimer = null;
        retryNow();
      }, delay);
    }

    // Un envoi ou une resynchronisation a réussi : le compte à rebours des
    // 10 minutes repart de zéro, les essais automatiques aussi.
    function succeeded() {
      failingSince = null;
      gaveUp = false;
    }

    function fail(err, source) {
      const kind = classifyError(err);
      problem = { kind, error: err, source };
      if (kind === 'conflict') {
        held = true;
        stopRetry();
      } else if (kind !== 'rejected') {
        if (failingSince === null) failingSince = now();
        if (now() - failingSince >= GIVE_UP_MS) {
          gaveUp = true;
          stopRetry();
        } else {
          scheduleRetry();
        }
      }
      persist();
      emit();
      if (kind === 'conflict' && onConflict) onConflict(err);
    }

    // Champ modifié par l'utilisateur. base = dernière valeur connue du
    // serveur (ignorée si le champ est déjà en attente : la base d'origine
    // est gardée).
    function set(field, value, base) {
      const cur = changes.get(field);
      const entry = { value, base: cur ? cur.base : base };
      const inFlight = sending !== null && sending.has(field);
      if (entry.value === entry.base && !inFlight) changes.delete(field);
      else changes.set(field, entry);
      persist();
      emit();
      if (!held) scheduleDebounce();
    }

    // Envoie tout de suite les champs en attente. Ne rejette jamais : les
    // échecs passent par l'état (info().state) et les nouveaux essais.
    function flush() {
      stopDebounce();
      if (sending) {
        again = true;
        return sendPromise;
      }
      if (held || changes.size === 0) {
        emit();
        return Promise.resolve();
      }
      stopRetry();
      const batch = new Map(Array.from(changes, ([field, c]) => [field, c.value]));
      sending = batch;
      emit();
      sendPromise = (async () => {
        let result;
        try {
          result = await send(Object.fromEntries(batch));
        } catch (err) {
          sending = null;
          again = false;
          fail(err, 'doc');
          return;
        }
        sending = null;
        for (const [field, value] of batch) {
          const c = changes.get(field);
          if (!c) continue;
          if (c.value === value) changes.delete(field);
          else c.base = value; // modifié pendant l'envoi : le serveur a maintenant `value`
        }
        attempt = 0;
        succeeded();
        if (problem && problem.source === 'doc') problem = null;
        persist();
        if (onSaved) onSaved(result, batch);
        emit();
        if (changes.size && !held && !problem) {
          if (again) {
            again = false;
            flush();
          } else {
            scheduleDebounce();
          }
        }
        again = false;
      })();
      return sendPromise;
    }

    // Nouvel essai immédiat (bouton « Opnieuw proberen », retour du réseau,
    // minuterie de nouvel essai) : resynchronisation si une mutation de
    // structure l'attend, puis envoi des champs en attente.
    async function retryNow() {
      stopRetry();
      if (problem && problem.source === 'structure' && resync) {
        try {
          await resync();
          structureOk();
        } catch (err) {
          structureFailed(err);
          return;
        }
      }
      if (!held && changes.size) await flush();
      else emit();
    }

    // Suit une mutation de structure (requête déjà lancée). Si elle échoue,
    // l'état reste « saving » jusqu'à la fin de la resynchronisation que
    // l'appelant DOIT lancer : structureOk() ou structureFailed().
    async function track(promise) {
      structure += 1;
      emit();
      let failed = false;
      try {
        return await promise;
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        structure -= 1;
        if (failed) resyncing += 1;
        emit();
      }
    }

    function resyncDone() {
      if (resyncing > 0) resyncing -= 1;
    }

    // Mutation de structure échouée SANS rien à resynchroniser (refus du
    // serveur qui n'a rien changé : la vue est juste) : fin de l'attente.
    function structureSettled() {
      resyncDone();
      emit();
    }

    // La resynchronisation qui suit l'échec d'une mutation de structure a
    // échoué aussi : alerte gardée, nouvel essai automatique (resync).
    function structureFailed(err) {
      resyncDone();
      fail(err, 'structure');
    }

    // Resynchronisation réussie (ou rien à resynchroniser).
    function structureOk() {
      resyncDone();
      if (problem && problem.source === 'structure') {
        problem = null;
        attempt = 0;
        succeeded();
        stopRetry();
      }
      emit();
    }

    // Conflit détecté hors d'un envoi (resynchronisation) : pause + alerte.
    function markConflict(err) {
      stopDebounce();
      stopRetry();
      held = true;
      problem = { kind: 'conflict', error: err || null, source: 'doc' };
      emit();
    }

    // Conflit réglé (rebase fait par l'éditeur) : on reprend les envois.
    function resume() {
      held = false;
      if (problem && problem.kind === 'conflict') problem = null;
      attempt = 0;
      if (changes.size) return flush();
      emit();
      return Promise.resolve();
    }

    function discard(field) {
      if (!changes.delete(field)) return;
      persist();
      emit();
    }

    // Oublie toute la saisie en attente (après l'avoir mise de côté) et
    // lève la pause d'un conflit.
    function discardAll() {
      changes.clear();
      stopDebounce();
      stopRetry();
      held = false;
      if (problem && problem.source === 'doc') problem = null;
      attempt = 0;
      if (!problem) succeeded();
      persist();
      emit();
    }

    function has(field) {
      return changes.has(field);
    }

    emit();
    return {
      set,
      flush,
      retryNow,
      track,
      structureFailed,
      structureOk,
      structureSettled,
      markConflict,
      resume,
      discard,
      discardAll,
      has,
      entries,
      hasUnsaved,
      info,
    };
  }

  // ---- indicateur -------------------------------------------------------------------------------

  const STATUS = {
    saved: { cls: 'is-saved', key: 'editor.saved' },
    pending: { cls: 'is-saving', key: 'editor.saving' },
    saving: { cls: 'is-saving', key: 'editor.saving' },
    offline: { cls: 'is-error', key: 'editor.saveFailed' },
    retry: { cls: 'is-error', key: 'editor.saveFailed' },
    rejected: { cls: 'is-error', key: 'editor.saveFailed' },
    session: { cls: 'is-error', key: 'editor.notSaved' },
    conflict: { cls: 'is-error', key: 'editor.notSaved' },
  };

  function renderStatus(el, info) {
    if (!el) return;
    const s = STATUS[info.state] || STATUS.saving;
    el.classList.remove('is-saved', 'is-saving', 'is-error');
    el.classList.add(s.cls);
    el.textContent = tr(s.key);
    el.title = info.error && info.error.message ? info.error.message : '';
  }

  return {
    DEBOUNCE_MS,
    RETRY_DELAYS,
    GIVE_UP_MS,
    REQUEST_TIMEOUT_MS,
    classifyError,
    retryDelay,
    createQueue,
    createApi,
    createDraftStore,
    createSaver,
    renderStatus,
  };
});
