/* title-follow.js — règle « le titre de couverture suit le nom du boek »
 * (docs/API.md §Pages fixes), côté éditeur. Fonction pure, testée en Node.
 *
 * Le titre suit le renommage TANT QU'IL EST IDENTIQUE au nom (jamais
 * personnalisé). Comparaison et écriture sans les blancs de bord, comme le
 * serveur (qui enregistre le nom trimmé). Un nom vide ne lie jamais rien, ni
 * comme ancien nom (sinon un titre vidé exprès se retrouverait relié à un nom
 * en cours de saisie : « '' === '' »), ni comme nouveau nom (champ effacé
 * avant d'être retapé : le titre attend le prochain nom non vide — l'appelant
 * garde donc en `oldName` le DERNIER NOM NON VIDE).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditorTitleFollow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // → nouveau titre (chaîne) si le titre doit suivre, sinon null (ne rien toucher).
  function followTitle(oldName, newName, title) {
    if (typeof title !== 'string') return null; // aucun titre enregistré : défaut du layout
    const before = String(oldName == null ? '' : oldName).trim();
    if (before === '') return null; // nom vide : jamais de lien
    if (title.trim() !== before) return null; // titre personnalisé
    const after = String(newName == null ? '' : newName).trim();
    return after === '' ? null : after; // nom en cours d'effacement : on attend
  }

  return { followTitle };
});
