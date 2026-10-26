---
title: Ouvrir les liens partagés dans l'onglet existant
subtitle: Transmission entre onglets, dialogue audio et rapidité d'ouverture dans faustcode
author: Yann Orlarey
organization: EMERAUDE (GRAME/INRIA/INSA)
date: 26 octobre 2026
document-style: note-a4
language: fr
---

::: toc+
- **Objet** — le problème constaté et pourquoi il compte pour le workshop.
- **Transmettre le DSP à l'onglet existant** — protocole entre onglets et comportement des deux côtés.
- **Ne pas voler la connexion MCP** — règles de connexion automatique pour un onglet ouvert par un lien.
- **Sauter le dialogue quand le son peut démarrer** — sonde audio au démarrage.
- **Ouvrir plus vite** — vitrine et compilation anticipée.
- **Implémentation suggérée** — points d'ancrage dans le code existant.
- **Hors périmètre** — ce que cette version ne fait pas.
- **Critères d'acceptation** — ce qui doit être vérifié avant de livrer.
:::

# Objet

Chaque lien `?code=` (QR code, bouton « Ouvrir dans faustcode » des slides ou de la page effractionmusicale.fr) ouvre un **nouvel onglet**, donc une nouvelle page. Trois conséquences :

1. **Le dialogue « WELCOME TO FAUSTCODE » réapparaît à chaque fois.** Le démarrage l'impose (`app.js` : *« Require explicit audio unlock per opened tab »*), et les navigateurs attachent l'autorisation audio à une page : un nouvel onglet ne peut pas réutiliser le contexte audio d'un autre.
2. **L'ouverture est lente** : rechargement complet de libfaust-wasm, de la vitrine d'accueil, puis compilation du DSP après le clic sur ENTER.
3. **Le nouvel onglet prend la connexion MCP.** Le pont n'accepte qu'un onglet (`4001 superseded-by-new-tab`) et faustcode se reconnecte automatiquement s'il connaît une adresse enregistrée (`getLastMcpUrl()`). Pendant la démo de la corne de brume, un clic sur un bouton des slides couperait l'IA de faustcode.

La solution principale consiste à **envoyer le DSP à l'onglet faustcode déjà ouvert** au lieu de le charger dans le nouveau.

::: important [Priorité]
Parties « Transmettre le DSP à l'onglet existant » et « Ne pas voler la connexion MCP » : indispensables pour le workshop IEEE IS2 du 30 octobre 2026. Parties « Sauter le dialogue » et « Ouvrir plus vite » : confort, à faire si le temps le permet.
:::

# Transmettre le DSP à l'onglet existant

## Protocole

Les onglets faustcode d'un même navigateur et d'une même origine communiquent par un `BroadcastChannel` nommé `faustcode`. Chaque onglet a un identifiant aléatoire (`tabId`) tiré au démarrage.

| Message | Émetteur | Contenu | Rôle |
| :-- | :-- | :-- | :-- |
| `probe` | nouvel onglet | `requestId` | « Y a-t-il un onglet faustcode ouvert ? » |
| `here` | onglets existants | `requestId`, `tabId`, `audioUnlocked`, `mcpConnected`, `lastActiveAt` | réponse à `probe` |
| `open` | nouvel onglet | `requestId`, `to` (`tabId`), `code`, `name`, `view`, `poly` | demande d'ouverture adressée à un onglet |
| `opened` | onglet choisi | `requestId`, `ok`, `sha1` ou `error` | accusé de réception |

`lastActiveAt` est la date du dernier passage de l'onglet au premier plan (`visibilitychange`, `focus`).

## Côté nouvel onglet

Dès le démarrage, **avant** de charger libfaust-wasm, la vitrine ou le MCP, si l'adresse contient `code` :

1. Décoder le lien (comme aujourd'hui). S'il est illisible, démarrer normalement avec le message d'erreur existant.
2. Envoyer `probe` et attendre les réponses pendant **300 ms**.
3. Sans réponse : charger le DSP **dans cet onglet**, comme aujourd'hui.
4. Sinon, choisir l'onglet destinataire, dans cet ordre de préférence :
   1. celui qui tient la connexion MCP (`mcpConnected`) ;
   2. parmi ceux dont l'audio est débloqué (`audioUnlocked`), le plus récemment actif ;
   3. le plus récemment actif.
5. Lui envoyer `open` et attendre `opened` pendant **2 s**.
6. Sur `opened` avec `ok` : afficher une page simple, *« Opened in your faustcode tab: <name> »*, avec un bouton **Open here instead**, puis tenter `window.close()`. Un onglet ouvert par un lien et sans historique peut être fermé par script ; si la fermeture échoue, la page reste affichée.
7. Sans accusé de réception dans le délai, ou avec une erreur : charger le DSP dans cet onglet.

**Open here instead** charge le DSP dans cet onglet, en suivant les règles de la partie suivante pour le MCP.

## Côté onglet existant

À la réception d'un `open` qui lui est adressé :

1. Créer la session par le chemin habituel (`compileAndStore(code, name)`) ; le sha1 évite les doublons.
2. La rendre active, afficher la vue `view`, régler la polyphonie `poly`.
3. Répondre `opened`.
4. Afficher une notification discrète : *« Opened from a shared link: <name> »*.
5. Appeler `window.focus()`. Les navigateurs l'ignorent souvent : l'utilisateur revient alors lui-même à l'onglet.

La connexion MCP, l'état audio et les autres sessions de l'onglet ne sont pas modifiés. Si l'audio de cet onglet n'est pas encore débloqué, le dialogue habituel reste affiché.

# Ne pas voler la connexion MCP

Pour un onglet dont l'adresse contient `code` :

- la connexion MCP automatique (paramètre `mcp` ou adresse enregistrée) est **différée** jusqu'à la décision du protocole ci-dessus ;
- si le DSP a été transmis à un autre onglet, l'onglet ne se connecte jamais au MCP ;
- s'il charge le DSP lui-même **et** qu'un autre onglet a répondu à `probe` (accusé manquant, ou **Open here instead**), il ne se connecte pas automatiquement : la connexion reste possible avec le bouton **Connect** du tiroir MCP ;
- s'il charge le DSP lui-même et qu'aucun autre onglet n'a répondu, le comportement actuel s'applique.

# Sauter le dialogue quand le son peut démarrer

Au démarrage, avant d'afficher le dialogue :

1. Créer un `AudioContext` de test, appeler `resume()` et attendre au plus **150 ms**.
2. S'il est dans l'état `running`, considérer l'audio comme débloqué et ne pas afficher le dialogue, **sauf** sur iOS si le DSP déclare des capteurs (`[acc:…]`, `[gyr:…]`) : l'autorisation des capteurs exige un geste, et « Tap to play » reste donc nécessaire.
3. Sinon, afficher le dialogue comme aujourd'hui.

Selon le navigateur et son historique d'utilisation du site, cette sonde réussira plus ou moins souvent. Il faut **mesurer** et indiquer dans le compte rendu de livraison ce qu'il en est sur Chrome macOS, Safari macOS et Chrome Android.

# Ouvrir plus vite

Quand l'adresse contient `code` et que le DSP est chargé dans l'onglet :

- **Pas de vitrine.** Ne pas lancer la session de démonstration qui défile derrière le dialogue (`startShowcasePreview`).
- **Compilation anticipée.** Compiler le DSP partagé dès que libfaust-wasm est prêt, pendant que le dialogue est affiché, pour qu'il joue aussitôt après ENTER ou « Tap to play ».

Indiquer dans le compte rendu de livraison le temps entre l'ouverture du lien et le premier son, avant et après, pour la démo `1-composition` sur le même ordinateur.

# Implémentation suggérée

- **Module `tab-handoff.js`** : `BroadcastChannel`, identifiant d'onglet, `lastActiveAt`, réponses `here` et traitement des `open`. La fonction de décision (choix du destinataire) est pure et testable hors navigateur.
- **`boot.js`** : décision de transmission avant `initSessions()` et avant `startConnect()` ; report de la connexion MCP automatique.
- **`app.js`** : sonde audio avant `showAudioGate()`, suppression de `startShowcasePreview()` pour un lien partagé, compilation anticipée.
- **Création de session côté destinataire** : même chemin que le chargement d'un lien (`compileAndStore`, `setActiveSha1`, `setActiveView`).

# Hors périmètre

- Transmission entre navigateurs différents ou entre appareils (le `BroadcastChannel` ne relie que les onglets d'un même navigateur et d'une même origine).
- Transmission entre la version publiée et une version servie en local (origines différentes).
- Fenêtres de navigation privée, qui sont isolées : elles chargent le DSP elles-mêmes.

# Critères d'acceptation

- [ ] faustcode ouvert, audio débloqué ; un clic sur un lien `?code=` ouvre le DSP dans cet onglet, sans dialogue ni rechargement, et le nouvel onglet affiche *« Opened in your faustcode tab »* puis se ferme s'il le peut.
- [ ] Deux liens différents ouverts coup sur coup créent deux sessions dans l'onglet existant.
- [ ] Pendant une session MCP active (Claude Code connecté), un clic sur un bouton « Ouvrir dans faustcode » des slides ne coupe pas la connexion : la pastille MCP reste verte.
- [ ] Aucun onglet faustcode ouvert : comportement inchangé, le lien s'ouvre dans le nouvel onglet.
- [ ] **Open here instead** charge le DSP dans le nouvel onglet sans se connecter automatiquement au MCP.
- [ ] Onglet existant figé ou fermé pendant l'échange : au bout de 2 s, le nouvel onglet charge le DSP lui-même.
- [ ] Sur téléphone Android, scanner deux QR codes de suite ouvre le second dans l'onglet faustcode du premier.
- [ ] La sonde audio ne masque jamais le dialogue quand le son ne peut pas démarrer ; résultats mesurés sur Chrome macOS, Safari macOS et Chrome Android.
- [ ] Temps entre l'ouverture d'un lien et le premier son, avant et après, indiqué dans le compte rendu.
