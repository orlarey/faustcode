---
title: Partager un DSP par lien et QR code
subtitle: Ouverture par URL, bouton Share et jeu sur téléphone dans faustcode
author: Yann Orlarey
organization: EMERAUDE (GRAME/INRIA/INSA)
date: 26 octobre 2026
document-style: note-a4
language: fr
---

::: toc+
- **Objet** — ce que la fonction apporte au workshop et au-delà.
- **Ouvrir un DSP depuis une URL** — format du lien et comportement au chargement.
- **Le bouton Share** — lien, QR code, mode projection.
- **Jouer sur téléphone** — démarrage tactile, accéléromètres, mise en page étroite.
- **Implémentation suggérée** — points d'ancrage dans le code existant.
- **Hors périmètre** — ce que cette version ne fait pas.
- **Critères d'acceptation** — ce qui doit être vérifié avant de livrer.
:::

# Objet

Pendant le workshop IS2, chaque exemple projeté doit pouvoir être ouvert par les participants sur leur ordinateur ou leur **téléphone** en scannant un QR code, puis joué, y compris collectivement avec les accéléromètres. Aujourd'hui les QR codes des slides ouvrent FaustIDE, car faustcode ne sait pas charger un DSP depuis une URL (`boot.js` ne lit que `?mcp=` et `?token=`).

La fonction comporte trois parties, à livrer dans cet ordre, chacune utile seule :

1. **Ouvrir un DSP depuis une URL** : les slides et la version publiée sur effractionmusicale.fr en dépendent.
2. **Le bouton Share** : produire ce lien et son QR code depuis faustcode même.
3. **Jouer sur téléphone** : démarrage tactile, accéléromètres et gyroscope, vue Run utilisable sur un écran étroit.

::: important [Priorité]
Indispensable pour le workshop IEEE IS2 du 30 octobre 2026, juste après Record WAV. Si la partie 3 ne peut pas être prête à temps, la jam sur téléphone utilisera les PWA Wahoo et Kisana existantes ; les parties 1 et 2 restent indispensables.
:::

# Ouvrir un DSP depuis une URL

## Format du lien

```
https://orlarey.github.io/faustcode/?code=<données>&name=<nom>&view=run&poly=<n>
```

| Paramètre | Obligatoire | Valeur |
| :-- | :-- | :-- |
| `code` | oui | source Faust en UTF-8, compressé en **deflate brut** (RFC 1951, sans en-tête zlib), puis encodé en **base64url** (RFC 4648 §5, sans `=` de remplissage) |
| `name` | non | nom de fichier de la session ; `.dsp` ajouté s'il manque ; défaut `shared.dsp` |
| `view` | non | vue à afficher : `run` (défaut), `dsp`, `svg`, `signals`, `tasks` |
| `poly` | non | nombre de voix en vue Run : `0` (mono, défaut), `1`, `2`, `4`, `8`, `16`, `32`, `64` |

Côté navigateur, compression et décompression utilisent `CompressionStream` / `DecompressionStream` avec le format `"deflate-raw"`. Le même format se produit hors navigateur, par exemple en Python avec `zlib.compressobj(9, zlib.DEFLATED, -15)`, ce que fera le script de génération des slides.

::: note [Pourquoi compresser]
Un QR code projeté reste lisible jusqu'à environ 1 000 caractères. Les démos de l'atelier font 340 à 410 octets de source : leur lien passe d'environ 500 caractères à 330–380 une fois compressé. La corne de brume fait 2,6 Ko : son lien passe de 3 520 à 1 780 caractères.
:::

## Comportement au chargement

1. Si `code` est présent, le décoder. En cas d'échec (base64url invalide, décompression impossible, résultat vide), afficher un message clair, *« Ce lien ne contient pas de code Faust lisible »*, et démarrer normalement.
2. Créer la session par le même chemin que `POST /api/submit` (`compileAndStore(code, name)`), une fois les sessions OPFS chargées et libfaust-wasm prêt. Comme les sessions sont identifiées par le sha1 du code, ouvrir deux fois le même lien ne crée pas de doublon : la session existante est réactivée.
3. Rendre cette session active, afficher la vue `view`, régler la polyphonie `poly`.
4. Retirer `code`, `name`, `view` et `poly` de l'adresse avec `history.replaceState`, en conservant `mcp` et `token`. Recharger la page ne réimporte donc pas le lien, et l'adresse reste propre.
5. Une erreur de compilation n'empêche pas l'ouverture : la session est créée et ses erreurs s'affichent comme pour un fichier déposé.

# Le bouton Share

## Placement et contenu

Un bouton **Share** est ajouté dans `.header-controls`, à gauche d'**Archive**. Il est désactivé quand aucune session n'est active. Il ouvre une fenêtre qui contient :

- le **QR code** du lien de la session active, de grande taille ;
- le **lien** en texte sélectionnable et un bouton **Copy link** ;
- le nom de la session et la longueur du lien en caractères ;
- un bouton **Projection**, qui affiche le QR code en plein écran sur fond blanc, à la plus grande taille possible, avec le nom de la session en dessous, pour qu'une salle puisse le scanner ; `Échap` ou un clic ferment ce mode.

## Construction du lien

- Le lien encode le **code de la session active**, son `filename` et la vue `run` ; il inclut `poly` si la polyphonie de la vue Run n'est pas mono.
- **Base du lien** : `location.origin + location.pathname`, **sauf** si l'hôte est `localhost`, `127.0.0.1` ou une adresse privée. Dans ce cas, utiliser l'adresse publique `https://orlarey.github.io/faustcode/`, car un téléphone ne peut pas joindre le serveur local de l'ordinateur.
- Les paramètres `mcp` et `token` ne sont **jamais** inclus dans le lien.

## Lisibilité du QR code

- Niveau de correction d'erreur **M**, et module d'au moins 4 pixels à l'écran.
- Au-delà de 1 000 caractères, afficher un avertissement : *« Lien long : le QR code peut être difficile à scanner à distance »*, et passer au niveau **L**.
- Au-delà de la capacité maximale d'un QR code (≈ 2 900 octets en niveau L), ne pas afficher de QR code, mais garder le lien et le bouton **Copy link**.

# Jouer sur téléphone

## Démarrage tactile

Sur un appareil tactile, à l'ouverture d'un lien partagé, la vue Run affiche un grand bouton **Tap to play** au centre. Ce seul geste :

1. débloque l'audio (`AudioContext.resume()`), puis met l'audio en marche ;
2. sur iOS, demande l'autorisation des capteurs (`DeviceMotionEvent.requestPermission()` et `DeviceOrientationEvent.requestPermission()`), qui doit être appelée dans un geste de l'utilisateur.

Si l'autorisation des capteurs est refusée, le son démarre quand même ; un message discret indique que les accéléromètres sont inactifs.

## Accéléromètres et gyroscope

Quand le DSP déclare des métadonnées `[acc:…]` ou `[gyr:…]`, c'est-à-dire quand le nœud faustwasm répond vrai à `hasAccInput` ou `hasGyrInput`, la vue Run écoute :

- `devicemotion` et transmet `accelerationIncludingGravity` à `node.propagateAcc(…)` ;
- `deviceorientation` et transmet l'événement à `node.propagateGyr(…)`.

Les écouteurs sont retirés dans `cleanupAudio()`. Les conventions d'axes d'iOS et d'Android sont celles qu'applique déjà faustwasm (voir ses appels `propagateAcc({x, y, z}, isAndroid)`) ; le comportement doit être identique à celui des PWA produites par `faust2wasm` pour un même DSP, par exemple Wahoo.

## Mise en page étroite

Jusqu'à 400 px de large, sans défilement horizontal :

- l'en-tête tient sur une ligne ou se replie proprement ; les commandes secondaires (Archive, Delete, MCP) peuvent passer dans un menu ;
- la vue Run donne la priorité aux commandes du DSP : sliders et boutons utilisables au doigt (cible d'au moins 44 px), oscilloscope et spectre repliés par défaut ;
- l'orientation portrait et paysage fonctionnent toutes deux.

# Implémentation suggérée

- **Décodage et encodage** : un module `share-link.js` qui exporte `encodeShareParams({code, name, view, poly})` et `decodeShareParams(searchParams)`, testable hors navigateur ; base64url et deflate brut via `CompressionStream` / `DecompressionStream`.
- **Chargement** : dans la séquence de démarrage de `boot.js`, après `initSessions()` et une fois libfaust-wasm prêt, appeler `compileAndStore` (`api-shim.js`), puis `setActiveSha1` et `setActiveView` (`sessions.js`).
- **QR code** : une petite bibliothèque sous licence MIT incluse dans `webapp/vendor/` (par exemple *qrcode-generator* de Kazuhiko Arase), rendue en SVG, sans dépendance réseau.
- **Bouton Share** : dans `index.html` (`.header-controls`) et son gestionnaire à côté de celui d'**Archive**.
- **Capteurs et démarrage tactile** : dans `webapp/views/run.js`, à côté de la création de `dspNode`, avec retrait des écouteurs dans `cleanupAudio()`.

# Hors périmètre

- Liens vers un fichier distant (`?url=…`) : seul le code inclus dans le lien est pris en charge.
- Raccourcisseur d'URL ou stockage du code côté serveur.
- Partage de plusieurs fichiers (`.lib` inclus) : seul le source de la session est partagé.
- Partage de l'état des paramètres (valeurs des sliders).
- Outil MCP de partage.

# Critères d'acceptation

- [ ] Un lien `?code=` produit par le script Python des slides ouvre le bon DSP dans faustcode, en vue Run.
- [ ] Ouvrir deux fois le même lien ne crée qu'une session.
- [ ] Après chargement, l'adresse ne contient plus `code`, `name`, `view` ni `poly`.
- [ ] Un lien corrompu affiche le message d'erreur et faustcode démarre normalement.
- [ ] **Share** sur une démo de l'atelier (≈ 400 octets) produit un QR code scannable à 3 m sur un écran projeté, en mode Projection.
- [ ] **Share** sur la corne de brume (2,6 Ko) affiche l'avertissement de lien long et un QR code scannable de près.
- [ ] Servi en local (`scripts/serve.py`), **Share** produit un lien vers `https://orlarey.github.io/faustcode/`.
- [ ] Sur iPhone (Safari) et sur Android (Chrome) : scan du QR code, **Tap to play**, son, et Wahoo répond à l'inclinaison du téléphone comme sa PWA.
- [ ] Refus des capteurs sur iOS : le son démarre quand même.
- [ ] À 390 × 844, aucun défilement horizontal et tous les sliders de Wahoo sont utilisables au doigt.
