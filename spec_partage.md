---
title: Partager, exporter, publier
subtitle: Un seul point d'entrée pour tout ce qui sort de faustcode
author: Yann Orlarey
organization: EMERAUDE (GRAME/INRIA/INSA)
date: 15 novembre 2026
document-style: note-a4
language: fr
---

::: toc+
- **Objet** — pourquoi regrouper.
- **Ce qui existe** — sept gestes de sortie, dispersés.
- **La thèse** — *File* pour écrire, *Share* pour tout ce qui sort, rangé par destinataire.
- **Le panneau Share** — ses quatre onglets et ce qui leur est commun.
- **Le mode player** — le public joue, puis installe, depuis un QR code.
- Maquette : <https://claude.ai/artifact/XTBqf8RjLSNdymheM6ukaY> (privée).
- **Ce qui disparaît, ce qui reste** — et les trois décisions ouvertes.
- **Implémentation suggérée**, **Hors périmètre**, **Critères d'acceptation**.
:::

# Objet

faustcode a gagné en peu de temps plusieurs façons de faire sortir un module : lien et QR code, faustmodular, publication dans un store, documentation mathématique, diagrammes, PWA en `.zip`, application installée. Chacune est utile ; ensemble, elles manquent de cohérence et se découvrent mal, parce que le même geste — *donner ce module à quelqu'un ou à quelque chose* — est réparti entre un bouton d'en-tête, deux entrées du menu File, trois boutons Download différents selon la vue et un bouton propre à la vue Run.

Le cas qui doit devenir simple est celui de la **démonstration et du workshop** : le démonstrateur projette un QR code, le public le flashe avec son téléphone, joue le module tout de suite et peut l'installer comme application.

# Ce qui existe

| Où | Geste | Vers |
| :-- | :-- | :-- |
| **Share** (en-tête) | lien et QR code, mode projection ; lien avec le code, ou lien du store pour un module publié inchangé | des personnes |
| **faustmodular** (en-tête) | le module ouvert dans faustmodular, mis à jour à chaque sauvegarde | un outil |
| File ▸ Publish to … | publication dans un store GitHub, lien court copié | un dépôt |
| File ▸ Math documentation | `<nom>-mdoc.zip` (LaTeX), en quatre langues | un fichier |
| Download (vue dsp) | `.dsp` | un fichier |
| Download (vue svg) | `<nom>-svg.zip` | un fichier |
| Download (vue run) | `<nom>-pwa.zip` | un fichier |
| **pwa** (vue run) | application installée à `apps/<nom>/` | cet ordinateur |
| Rec (vue run) | enregistrement WAV | un fichier |

# La thèse

- **File** sert à *écrire* : nouveau, ouvrir, sauvegarder, versions, ouvrir depuis un store. Rien n'y sort de faustcode.
- **Share** est l'unique point d'entrée de *tout ce qui sort* de faustcode, rangé non par format mais par **destinataire**, parce que c'est la question qu'on se pose : *à qui, ou à quoi, est-ce que je le donne ?*

| Onglet | Destinataire | Question à laquelle il répond |
| :-- | :-- | :-- |
| **Audience** | des personnes, souvent sur téléphone | « Comment la salle joue-t-elle mon module ? » |
| **Apps** | une application, sur cet ordinateur ou dans faustmodular | « Où est-ce que je l'utilise ensuite ? » |
| **Files** | un fichier | « Quel fichier est-ce que je télécharge ? » |
| **Publish** | un store GitHub | « Comment le rendre durable et partageable par un lien court ? » |

Rec reste dans la vue Run : enregistrer est un geste de jeu, pas une sortie du module.

# Le panneau Share

## Ce qui est commun aux onglets

- **Ce qui est partagé** est la *version affichée* du fichier ouvert (`files.getOpen()`), celle que montre l'en-tête `organ.dsp · v3/5`. Si l'éditeur contient des modifications non sauvegardées, un bandeau le dit : *« Modifications non sauvegardées : Save pour les inclure »*. Rien n'est partagé d'un brouillon, comme pour Publish aujourd'hui.
- **Les voix** : un sélecteur *Mono / 1 / 2 / 4 / 8 / 16 / 32 / 64* dans l'en-tête du panneau, initialisé à la polyphonie de la vue Run (`state.runGlobal.polyVoices`). Il vaut pour le lien (`poly`), l'application installée et la PWA en `.zip` : on ne choisit les voix qu'une fois.
- **Un `.lib`** n'a pas de `process` : Audience, Apps et la PWA sont grisés, avec la raison ; Files propose le `.lib` lui-même ; Publish le refuse déjà.
- **Un code qui ne compile pas** : seuls Files ▸ `.dsp` et Audience ▸ *éditer* restent possibles.
- Le dernier onglet utilisé est retenu (`localStorage`, par confort seulement).

## Audience

Le contenu actuel du dialogue Share, avec un choix de plus.

- **Jouer** ou **éditer** : *jouer* ouvre le mode player (`view=play`, ci-dessous) ; *éditer* ouvre faustcode sur la vue dsp (`view=dsp`). Défaut : jouer.
- **Avec le code** ou **lien du store**, comme aujourd'hui ; le lien du store n'est proposé que pour un fichier publié et inchangé depuis.
- QR code, **Projection** (plein écran, nom du module), **Copy link**.
- Quand le lien dépasse la capacité d'un QR code (environ 2 950 octets en niveau L) ou sa lisibilité de loin (1 000 caractères), le message existant renvoie désormais vers l'onglet **Publish** : un module publié a un lien court.

## Apps

- **Installer sur cet ordinateur** : `installPwaApp` (aujourd'hui le bouton *pwa* de la vue Run). La fenêtre de l'application s'ouvre avec son bouton Installer.
- **Ouvrir dans faustmodular** : le module ouvert dans faustmodular et lié, mis à jour à chaque sauvegarde (aujourd'hui le bouton *faustmodular*).

## Files

| Fichier | Contenu | Aujourd'hui |
| :-- | :-- | :-- |
| `<nom>.dsp` (ou `.lib`) | le source de la version affichée | Download, vue dsp |
| `<nom>-svg.zip` | tous les diagrammes | Download, vue svg |
| `<nom>-mdoc.zip` | documentation mathématique, langue au choix | File ▸ Math documentation |
| `<nom>-pwa.zip` | la PWA à servir soi-même, aux voix choisies | Download, vue run |

## Publish

L'entrée *File ▸ Publish to …* déplacée ici, inchangée (`stores-ui.publishFile`) : un store en écriture, ou plusieurs au choix ; sans store en écriture, un lien vers *File ▸ Stores…* pour en suivre un et donner son jeton. Après publication, le lien court copié et l'onglet Audience proposé, son QR code prêt.

# Le mode player

## Ce qu'il est

Le lien *jouer* (`?code=…&view=play&poly=n`, ou `?file=…&view=play`) ne montre pas l'IDE : faustcode compile le module, l'installe comme application de son origine (`installPwaApp`, à `apps/<nom>/`) puis **remplace la page par celle de l'application** (`location.replace`). Le public arrive donc directement sur l'application elle-même : l'interface du module, le son qui démarre au premier geste (toucher n'importe où), capteurs et MIDI (ceux de `faust-pwa.js`), et le bouton **Installer** (Chrome et Edge sur Android) ou l'indication *Partager ▸ Sur l'écran d'accueil* (Safari sur iOS).

::: note [Pourquoi l'application elle-même]
Le player et l'application installée sont alors une seule et même page : rien à maintenir en double, et ce que le public installe est exactement ce qu'il vient de jouer. Sur iOS, *Sur l'écran d'accueil* installe la page affichée : il faut donc que ce soit `apps/<nom>/`, pas une adresse de faustcode chargée de paramètres.
:::

## Ce qu'il coûte

- Le téléphone charge faustcode et libfaust-wasm (environ 7 Mo, une fois, puis en cache HTTP), comme le lien actuel, puis compile : quelques secondes. Un écran *« Préparation de <nom>… »* les occupe.
- L'application vit dans le stockage du site `orlarey.github.io` *du téléphone* ; effacer les données de ce site la retire.
- Sans service worker (navigation privée de certains navigateurs), le player se replie sur la vue Run actuelle et son bouton *Tap to play*.

## Ce qu'il ne change pas

Les liens `view=run` existants (slides, QR déjà imprimés) gardent leur comportement.

# Ce qui disparaît, ce qui reste

| Élément | Devient |
| :-- | :-- |
| File ▸ Publish to … | Share ▸ Publish |
| File ▸ Math documentation | Share ▸ Files |
| Download des vues dsp, svg, run | Share ▸ Files *(décision 2)* |
| bouton *pwa* de la vue Run | Share ▸ Apps |
| bouton *faustmodular* | Share ▸ Apps, et raccourci conservé *(décision 1)* |
| Rec | reste dans la vue Run |
| File | nouveau, ouvrir, sauvegarder, versions, stores (lecture) |

::: important [Décisions ouvertes]
1. **Bouton faustmodular** — *proposition : le garder en raccourci.* Ce n'est pas un export ponctuel mais un lien vivant (chaque sauvegarde met le module à jour), utilisé à chaque séance avec faustmodular.
2. **Download des vues** — *proposition : les retirer.* Un seul endroit pour les fichiers ; la vue svg pourrait garder un clic droit *Enregistrer le diagramme* sur le diagramme affiché.
3. **Le player** — *proposition : l'application elle-même* (ci-dessus), plutôt qu'une vue Run allégée sur mobile.
:::

# Implémentation suggérée

- `share-ui.js` : le dialogue devient un panneau à onglets ; `buildQr`, la projection et la copie inchangés ; le sélecteur de voix et le bandeau de brouillon en tête.
- `share-link.js` : `play` ajouté à `SHARE_VIEWS` ; `encodeShareParams` inchangé par ailleurs.
- `boot.js` : `view=play` — après l'ouverture du lien (code ou store), `installPwaApp` puis `location.replace(url)` ; repli sur `view=run` en cas d'échec.
- `pwa-export.js`, `mathdoc-export.js`, `stores-ui.js` : réutilisés tels quels depuis le panneau.
- `app.js` : retrait des entrées du menu File, des Download et du bouton *pwa* ; le bouton *Share* ouvre le panneau sur le dernier onglet.
- MCP : un outil `get_share_link` (lien, `play` ou `dsp`, voix) rendrait le partage scriptable ; à prévoir dans `tools.json` et `MCP-SPEC.md`.

# Hors périmètre

- Publier une PWA sur GitHub Pages (lien permanent d'application, indépendant de faustcode).
- Faire communiquer plusieurs applications (bus de contrôle `BroadcastChannel`, audio entre applications).
- La mise en page de l'IDE sur téléphone, au-delà du player.

# Critères d'acceptation

1. Tout geste de sortie s'atteint par *Share* en deux clics au plus ; File ne contient plus d'action qui sorte de faustcode.
2. Le sélecteur de voix du panneau fixe la polyphonie du lien, de l'application installée et de la PWA en `.zip`.
3. Un brouillon non sauvegardé est signalé, et rien n'en est partagé.
4. Un QR *jouer* projeté, flashé avec un téléphone Android (Chrome) et un iPhone (Safari), ouvre `apps/<nom>/` : le module se joue après un geste, l'application s'installe (bouton, ou *Sur l'écran d'accueil*), puis fonctionne hors ligne.
5. Les liens `view=run` existants ouvrent toujours la vue Run.
6. Un `.lib` et un code qui ne compile pas grisent ce qui ne s'applique pas, avec la raison.
7. Les tests `node --test webapp/*.test.mjs` passent, dont ceux de `share-link` pour `view=play`.
