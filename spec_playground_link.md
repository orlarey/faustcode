---
title: Éditer les modules de FaustPlayground dans faustcode
subtitle: Lien entre deux fenêtres par postMessage, protocole et comportement
author: Yann Orlarey
organization: EMERAUDE (GRAME/INRIA/INSA)
date: 31 octobre 2026
document-style: note-a4
language: fr
---

::: toc+
- **Objet** — pourquoi relier les deux applications.
- **Protocole** — messages, identifiants, origines.
- **Comportement dans faustcode** — sessions liées, sauvegardes, erreurs.
- **Comportement dans FaustPlayground** — ouverture, application du code, éditeur intégré.
- **Implémentation** — points d'ancrage dans le code.
- **Hors périmètre** — ce que cette version ne fait pas.
- **Critères d'acceptation** — ce qui est vérifié par les tests.
:::

# Objet

L'éditeur intégré de FaustPlayground est une simple zone de texte : ni coloration, ni numéros de ligne, et une erreur de compilation vidait le module. faustcode a tout ce qui manque (CodeMirror, complétion, erreurs à la ligne, diagramme, oscilloscope, spectre, documentation, MCP). Le crayon d'un module du playground ouvre donc son code dans faustcode, et chaque sauvegarde qui compile met le module à jour en place.

# Protocole

Le playground ouvre faustcode avec `?link=playground` dans une fenêtre nommée `faustcode-playground`, réutilisée pour tous les modules. Les deux pages peuvent avoir des origines différentes (`faustplayground.grame.fr`, `orlarey.github.io`) : elles communiquent par `postMessage`. Chaque message porte `type` et `protocol` (version, actuellement 1).

| Sens | `type` | Champs | Rôle |
| :-- | :-- | :-- | :-- |
| faustcode → playground | `faustcode-link-ready` | — | prêt à éditer |
| playground → faustcode | `faustcode-link-edit` | `id`, `name`, `code` | éditer ce code |
| faustcode → playground | `faustcode-link-code` | `id`, `code` | nouveau code, compilé sans erreur |
| playground → faustcode | `faustcode-link-result` | `id`, `ok`, `error?` | code appliqué ou non |
| playground → faustcode | `faustcode-link-close` | `id` | module supprimé |

- `id` désigne un module de la page du playground. Il est tiré au hasard, pour qu'une fenêtre faustcode restée ouverte ne mette pas à jour le module homonyme d'un patch chargé plus tard.
- `code` est le code de l'utilisateur, sans l'enveloppe `process = vgroup("<nom>", environment{ … }.process);` que le playground ajoute à chaque module ; le playground la remet en place.
- **Origines.** faustcode n'accepte que les messages de `window.opener`, et seulement de l'origine de son premier message ; ses réponses vont à cette origine seule. Le playground n'accepte que les messages de la fenêtre qu'il a ouverte, avec l'origine de l'URL de faustcode, et n'écrit qu'à cette origine. Le message `ready` est envoyé à `*` : il ne contient rien.

# Comportement dans faustcode

1. **Ouverture.** Le code reçu devient une session (`<nom>.dsp`), soumise comme une session MCP. Elle est affichée en vue dsp : directement si l'audio est déjà débloqué, sinon après ENTER (même mécanisme que les liens partagés).
2. **Sessions liées.** Les sessions sont identifiées par le sha1 de leur code : chaque sauvegarde en crée une nouvelle. Une session sauvegardée alors qu'une session liée était active est liée au même module. Toute compilation est annoncée par l'événement `faustcode:submitted` (`{ sha1, previous, code, filename, errors }`), émis par le shim (`/api/submit` : vue dsp, éditeur flottant) et par le `submit` MCP ; ainsi Claude peut aussi éditer un module du playground.
3. **Erreurs.** Un code avec erreurs n'est pas envoyé : il reste dans faustcode, avec son bandeau d'erreur. Le module continue de jouer sa dernière version valide.
4. **Retour.** Le résultat du playground est affiché en notice : « updated », ou la raison du refus (plus de 32 canaux, module supprimé…).
5. **MCP.** Comme pour un lien partagé, une fenêtre ouverte par le playground ne prend pas le pont MCP si un autre onglet faustcode est ouvert.

# Comportement dans FaustPlayground

- Le crayon ouvre (ou réutilise) la fenêtre faustcode et lui envoie le code du module dès qu'elle est prête. Sans réponse au bout de 30 s, un message indique que cette version de faustcode ne connaît peut-être pas le lien.
- Un code reçu est remis dans le groupe du module (les paramètres gardent leurs adresses et leurs valeurs) et recompilé avec ses modulations, sans couper le son ; les connexions dont les ports existent encore sont gardées.
- L'URL de faustcode est `https://orlarey.github.io/faustcode/`, modifiable par le paramètre `?faustcode=<url>` du playground (faustcode local, tests).
- Le bouton `</>` ouvre l'éditeur intégré, qui reste disponible sans faustcode.

# Implémentation

- faustcode : `webapp/playground-link.js` (protocole, table des liens, partie testée par `node --test`), branché dans `webapp/boot.js` ; `announceSubmit` dans `webapp/api-shim.js` et `webapp/handlers.js` ; `probeTabs` extrait de `webapp/tab-handoff.js`.
- FaustPlayground : `src/FaustcodeLink.ts`, `src/model/ModuleCode.ts`, `Scene.editModuleCode`.

# Hors périmètre

- Les liens ne survivent pas à un rechargement de la fenêtre faustcode : un nouveau clic sur le crayon les rétablit.
- faustcode joue aussi le module s'il est affiché en vue Run ; la vue dsp ne produit pas de son.
- Pas de synchronisation dans l'autre sens (un code déposé sur le module dans le playground ne met pas à jour la session faustcode).

# Critères d'acceptation

- `webapp/playground-link.test.mjs` : reconnaissance de l'URL, noms de session, validation des messages, suivi des sessions sauvegardées, plusieurs modules, oubli d'un module supprimé.
- Tests de bout en bout du playground (`tests/e2e/code-editing.test.ts`) : avec un faux faustcode (messages, origines, refus, fenêtre réutilisée, suppression) et avec ce dépôt servi en local (`FAUSTCODE_DIR`) : Ctrl-S dans CodeMirror met le module à jour, une erreur reste dans faustcode.
