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
- **Le QR code mène à l'application** — la page player, ou l'application publiée.
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

- **Jouer** ou **éditer** : *jouer* mène à l'application (ci-dessous) ; *éditer* ouvre faustcode sur la vue dsp (`view=dsp`). Défaut : jouer.
- La source du lien : **avec le code** (toujours possible), **du store** (fichier publié et inchangé depuis), **application publiée** (publiée comme application, inchangée depuis, et servie). La meilleure disponible est choisie par défaut : application publiée, puis store, puis code.
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

Deux publications, dans le même store :

- **Le module** : l'entrée *File ▸ Publish to …* déplacée ici, inchangée (`stores-ui.publishFile`) ;
- **As an app** : la PWA compilée, à côté du module (voir *L'application publiée*).

Pour l'une comme pour l'autre : un store en écriture, ou plusieurs au choix ; sans store en écriture, un lien vers *File ▸ Stores…* pour en suivre un et donner son jeton. Après publication, le lien court copié et l'onglet Audience proposé, son QR code prêt.

# Le QR code mène à l'application

Le public ne doit jamais voir l'IDE : il flashe le QR code et arrive sur **l'application elle-même**, prête à jouer et à installer — l'interface du module, le son qui démarre au premier geste (toucher n'importe où), capteurs et MIDI (ceux de `faust-pwa.js`), le bouton **Installer** (Chrome et Edge sur Android) ou l'indication *Partager ▸ Sur l'écran d'accueil* (Safari sur iOS).

Une application doit être *compilée* et *servie* quelque part. D'où deux liens, selon qu'elle est déjà hébergée ou non.

| | Lien avec le code | Application publiée |
| :-- | :-- | :-- |
| le QR mène à | `play.html`, qui fabrique l'application sur le téléphone | l'application, déjà compilée et hébergée |
| premier scan | environ 7 Mo (libfaust) et quelques secondes de compilation | immédiat, comme un site |
| scans suivants | immédiat (application déjà dans le téléphone) | immédiat |
| longueur du lien | celle du code compressé (le QR peut saturer) | courte |
| prérequis | aucun | un store en écriture, servi par GitHub Pages |

## Le lien avec le code : la page player

- Adresse : `https://orlarey.github.io/faustcode/play.html?code=…&name=…&poly=n` (ou `?file=…` pour un module de store). C'est une **page distincte** de l'IDE : elle ne charge ni l'éditeur ni les vues, seulement faustwasm, libfaust-wasm et `pwa-export.js`.
- Elle affiche le nom du module et sa préparation (*« Preparing organ… »*, trois étapes), compile, installe l'application dans le stockage du téléphone (`installPwaApp`, à `apps/<nom>/`) puis **remplace la page par celle de l'application** (`location.replace`).
- Si le téléphone a déjà cette version exacte de l'application (même empreinte du code et des voix, notée dans son `manifest.json`), elle y va **tout de suite**, sans charger libfaust.
- En bas, discret : *« Open the code in faustcode »* pour qui veut voir le code.
- Sans service worker (navigation privée de certains navigateurs), elle se replie sur la vue Run de faustcode et son bouton *Tap to play*.

::: note [Pourquoi l'application elle-même]
Le player et l'application installée sont une seule et même page : rien à maintenir en double, et ce que le public installe est exactement ce qu'il vient de jouer. Sur iOS, *Sur l'écran d'accueil* installe la page affichée : il faut donc que ce soit `apps/<nom>/`, pas une adresse chargée de paramètres.
:::

## L'application publiée : le lien direct

- *Share ▸ Publish ▸ As an app* compile le module aux voix choisies et écrit la PWA (les fichiers de `pwaEntries`, son service worker compris) dans le store, à `apps/<nom>/`, en un commit, à côté du module.
- GitHub Pages sert alors l'application à `https://<owner>.github.io/<repo>/apps/<nom>/`, environ une minute après le commit. L'onglet Audience propose ce lien dès qu'il répond : court, immédiat, durable, indépendant de faustcode.
- Republier met l'application à jour ; le service worker de la PWA (nom de cache daté) remplace l'ancienne version chez ceux qui l'ont installée.

## Ce qu'il coûte, ce qu'il ne change pas

- Une application fabriquée par `play.html` vit dans le stockage du site `orlarey.github.io` *du téléphone* ; effacer les données de ce site la retire. Une application publiée n'a pas cette fragilité.
- Les liens `?code=…&view=run` existants (slides, QR déjà imprimés) ouvrent toujours la vue Run de faustcode.

# Ce qui disparaît, ce qui reste

| Élément | Devient |
| :-- | :-- |
| File ▸ Publish to … | Share ▸ Publish |
| File ▸ Math documentation | Share ▸ Files |
| Download des vues dsp, svg, run | Share ▸ Files *(décision 2)* |
| bouton *pwa* de la vue Run | Share ▸ Apps |
| QR code vers l'IDE (vue Run) | QR code vers l'application |
| bouton *faustmodular* | Share ▸ Apps, et raccourci conservé *(décision 1)* |
| Rec | reste dans la vue Run |
| File | nouveau, ouvrir, sauvegarder, versions, stores (lecture) |

::: important [Décisions ouvertes]
1. **Bouton faustmodular** — *proposition : le garder en raccourci.* Ce n'est pas un export ponctuel mais un lien vivant (chaque sauvegarde met le module à jour), utilisé à chaque séance avec faustmodular.
2. **Download des vues** — *proposition : les retirer.* Un seul endroit pour les fichiers ; la vue svg pourrait garder un clic droit *Enregistrer le diagramme* sur le diagramme affiché.
3. **L'hébergement des applications publiées** — *proposition : le dépôt du store lui-même*, à `apps/<nom>/`, avec GitHub Pages activé une fois pour toutes dans ses réglages (le jeton actuel, *Contents* en lecture et écriture, suffit pour les commits ; activer Pages demande les réglages du dépôt). L'autre voie, un dépôt dédié aux applications, sépare les sources des fichiers compilés mais demande un second jeton.
:::

# Implémentation suggérée

- `share-ui.js` : le dialogue devient un panneau à onglets ; `buildQr`, la projection et la copie inchangés ; le sélecteur de voix et le bandeau de brouillon en tête.
- `play.html`, `play.js` : la page player ; `share-link.js` lui fournit le décodage des liens (`decodeShareParams`) et la construction de son adresse (`buildPlayUrl`).
- `pwa-export.js` : l'empreinte du code et des voix dans le manifeste de l'application, pour reconnaître une application déjà installée.
- `stores-ui.js` : *Publish ▸ As an app* — les fichiers de `pwaEntries` dans le même commit que le module ; la disponibilité du lien (une requête `HEAD` sur l'adresse Pages).
- `pwa-export.js`, `mathdoc-export.js`, `stores-ui.js` : réutilisés tels quels depuis le panneau.
- `app.js` : retrait des entrées du menu File, des Download et du bouton *pwa* ; le bouton *Share* ouvre le panneau sur le dernier onglet.
- MCP : un outil `get_share_link` (lien, `play` ou `dsp`, voix) rendrait le partage scriptable ; à prévoir dans `tools.json` et `MCP-SPEC.md`.

# Hors périmètre

- Faire communiquer plusieurs applications (bus de contrôle `BroadcastChannel`, audio entre applications).
- La mise en page de l'IDE sur téléphone, au-delà du player.

# Critères d'acceptation

1. Tout geste de sortie s'atteint par *Share* en deux clics au plus ; File ne contient plus d'action qui sorte de faustcode.
2. Le sélecteur de voix du panneau fixe la polyphonie du lien, de l'application installée et de la PWA en `.zip`.
3. Un brouillon non sauvegardé est signalé, et rien n'en est partagé.
4. Un QR *jouer* projeté, flashé avec un téléphone Android (Chrome) et un iPhone (Safari), mène à l'application sans jamais montrer l'IDE : le module se joue après un geste, l'application s'installe (bouton, ou *Sur l'écran d'accueil*), puis fonctionne hors ligne ; un second scan du même module l'ouvre aussitôt.
5. Un module publié comme application donne un QR qui ouvre l'application hébergée, sans charger faustcode.
6. Les liens `view=run` existants ouvrent toujours la vue Run.
7. Un `.lib` et un code qui ne compile pas grisent ce qui ne s'applique pas, avec la raison.
8. Les tests `node --test webapp/*.test.mjs` passent, dont ceux de la page player (décodage, application déjà installée).
