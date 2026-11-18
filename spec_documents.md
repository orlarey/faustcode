---
title: Documents et origines dans faustcode
subtitle: Un modèle de fichiers simple, inspiré de markpage, sans sessions
author: Yann Orlarey
organization: EMERAUDE (GRAME/INRIA/INSA)
date: 16 novembre 2026
document-style: note-a4
language: fr
---

::: toc+
- **Objet** — pourquoi abandonner les sessions, ce que l'on gagne.
- **Décisions prises** — les choix du 16 novembre 2026.
- **Le modèle** — document, origine, volume ; les invariants.
- **Enregistrer et compiler** — la copie de travail, Enregistrer, la vue Run.
- **Les volumes** — Bibliothèque, Disque, Magasins, faustmodular.
- **L'origine faustmodular** — une ressource de scène, un fichier partagé, la sonnette.
- **Les surfaces** — le menu Fichier, la boîte Ouvrir, l'en-tête.
- **Les bibliothèques `.lib`** — leur résolution.
- **Export, liens, onglets, MCP** — ce qui change autour.
- **Le stockage et la migration** — OPFS, ce que deviennent les sessions.
- **Ce qui disparaît**, **Hors périmètre**, **Décisions à valider**.
- **Critères d'acceptation** et **Plan de réalisation**.
:::

# Objet

faustcode est né autour des **sessions** : un code soumis est rangé sous le SHA-1 de son contenu, et ne change plus. Chaque enregistrement crée donc une session nouvelle. Les **fichiers** (0.16.0, `spec_files_store.md`) ont été posés par-dessus, comme un nom et une suite de versions. Puis chaque origine externe a reçu son propre mécanisme : le fichier du disque, le module d'un magasin, le module de faustmodular.

Le résultat est un empilement de cinq notions : session, fichier, version, brouillon, lien. L'utilisateur ne voit pas les sessions, mais il en subit les effets.

Le lien avec faustmodular en est l'exemple. Il n'a jamais été rattaché aux fichiers et suit encore les sessions. À chaque enregistrement, il doit deviner que la nouvelle session, de nouveau SHA-1, prolonge la session liée (`LinkTable.follow`, d'après la session « précédente » ou « éditée »). Dès que cette déduction échoue, la sauvegarde n'atteint plus le module, sans un mot. C'est ce qui arrive en pratique.

markpage a résolu le même problème par un modèle d'application de bureau (`docs/FILESYSTEM-BLUEPRINT.md` de markpage) : un **document** à identité stable, une **origine** unique où l'on édite en place, une seule commande *Ouvrir* sur des **volumes**. Le blueprint cite d'ailleurs faustcode comme le cas où des sessions adressées par contenu empêchent l'origine de vivre sur le document. Cette spécification fait ce pas : les sessions disparaissent.

# Décisions prises

Le 16 novembre 2026 :

1. **Les sessions sont supprimées**, comme concept et comme stockage. Les versions (◀ ▶) disparaissent avec elles. L'historique d'un document est celui de son origine (git pour un magasin), et non celui de faustcode.
2. **Enregistrer est explicite**, et la **copie de travail est gardée automatiquement** : un rechargement ou un plantage ne perd rien.
3. **Migration** : chaque fichier actuel devient un document de la Bibliothèque. Les anciennes versions sont mises de côté (`legacy/`), pas migrées.
4. **Tout d'un coup** : le noyau, le disque, les magasins et faustmodular, dans une seule version, **faustcode 0.26.0**.
5. **Enregistrer écrit même avec des erreurs** dans la Bibliothèque et sur le disque.
6. **Les magasins sont un volume en lecture** : un module ouvert devient un document de la Bibliothèque, avec sa provenance, et publier reste dans Export.
7. **faustcode édite les ressources des scènes de faustmodular, pas leurs instances** : une scène contient ses ressources (un nom, un code), et ses modules en sont des instances. C'est le modèle de faustdaw, décrit dans `Documentation/SCENE-RESOURCES-SPEC.md` de faustmodular.
8. **Les deux applications communiquent par le système de fichiers du navigateur**, qu'elles partagent (même origine) : une ressource est un fichier, et un `BroadcastChannel` sert de sonnette. Le lien par `postMessage` est supprimé.
9. **MCP** passe à des outils de document, et garde une version les anciens noms.

# Le modèle

## Vocabulaire

Document
: L'unité éditée : un `.dsp` ou un `.lib`. Il a un **identifiant** stable (uuid), un **nom**, un **contenu enregistré** et une **copie de travail**. Le point ● de l'en-tête signale une copie de travail différente du contenu enregistré.

Origine
: Le lieu **unique** auquel un document appartient. *Enregistrer* y écrit, et nulle part ailleurs. Une origine est un couple (volume, emplacement) : `Bibliothèque ▸ Wahoo.dsp`, `Disque ▸ ~/faust/echo.dsp`, `faustmodular ▸ Ma scène ▸ VCO` (une ressource de scène).

Volume
: Un lieu de stockage que la boîte *Ouvrir* parcourt : **Bibliothèque** (le stockage privé du navigateur), **Disque**, **Magasins**, **faustmodular**.

Compilation
: Le résultat de libfaust pour un contenu : erreurs, diagrammes, DSP de la vue Run. C'est un **cache interne**, indexé par l'empreinte du contenu. Il n'est jamais montré comme tel et peut être vidé à tout moment.

## Invariants

**D1 — Un document, une identité.** L'identifiant ne change pas quand on enregistre, renomme ou modifie le contenu. Tout ce qui désigne un document (le lien avec faustmodular, l'onglet, MCP) le désigne par cet identifiant, jamais par son contenu.

**D2 — Une origine unique, édition en place.** *Enregistrer* écrit dans l'origine. *Enregistrer sous…* choisit une autre origine et crée un nouveau document ; l'original redevient propre. Lier un document à un lieu, c'est l'y enregistrer.

**D3 — Aucune perte.** La copie de travail est écrite dans la Bibliothèque au plus tard une seconde après la dernière frappe. Un enregistrement qui échoue (permission refusée, faustmodular fermé, module supprimé) laisse le document modifié (●) et dit pourquoi. Il ne le marque jamais comme enregistré.

**D4 — Une seule commande *Ouvrir*.** Il n'y a pas d'« Ouvrir depuis un magasin » ni d'« Importer » séparés. Ce sont des volumes de la même boîte de dialogue.

**D5 — Pas de déduction.** Aucun comportement ne dépend d'une correspondance devinée entre deux contenus. Le lien d'un document à son origine est un champ du document.

**D6 — Écriture conditionnelle.** Enregistrer dans une origine que d'autres peuvent modifier (Disque, faustmodular) vérifie d'abord que l'origine a toujours le contenu lu. Sinon, rien n'est écrit, et un bandeau propose *Recharger* (perdre la copie de travail) ou *Écraser*.

# Enregistrer et compiler

- **La copie de travail** est ce que montre l'éditeur, dans la vue dsp ou l'éditeur flottant ; les deux sont synchronisés. Elle est gardée automatiquement (D3) et retrouvée au rechargement, avec ●.
- **Enregistrer** (Cmd/Ctrl-S) compile la copie de travail, puis l'écrit dans l'origine :
  - **Bibliothèque, Disque** : le contenu est écrit **même avec des erreurs**, car un éditeur enregistre ce qu'on tape. Les erreurs sont affichées à leur ligne.
  - **faustmodular** : le contenu n'est écrit dans la ressource que s'il compile. Avec des erreurs, rien n'est écrit, le document reste modifié (●) et les instances continuent de jouer leur version.
  - **Magasin** : un document ne s'enregistre pas dans un magasin. Écrire dans un magasin est un acte public, qui passe par *Export ▸ Publish* (voir les volumes).
- **La vue Run** joue la dernière compilation **réussie** du contenu enregistré. Un enregistrement avec erreurs ne coupe pas le son.
- **Revenir à la version enregistrée** (*Revert*) remplace la copie de travail par le contenu enregistré.
- **Compiler sans enregistrer** n'existe pas : c'est Enregistrer. Une Bibliothèque sans versions rend Enregistrer gratuit.

# Les volumes

## Bibliothèque

Le stockage privé du navigateur (OPFS), toujours disponible, hors ligne. C'est l'origine par défaut de *Nouveau*, d'un lien `?code=`, d'un fichier déposé sur la page, et de tout document migré. Les noms y sont uniques : une collision reçoit `-2`, `-3` avant l'extension. La Bibliothèque est plate ; les dossiers sont hors périmètre.

## Disque

Avec l'API File System Access (Chromium) :

- **Ouvrir un fichier de l'appareil** ouvre un `.dsp` ou un `.lib` **en place**. Son *handle* est retenu (IndexedDB), et Enregistrer réécrit le fichier. Après un rechargement, le navigateur redemande la permission d'écrire, au premier Enregistrer.
- **Monter un dossier** l'ajoute au volume Disque. La boîte *Ouvrir* le parcourt, et ses `.lib` servent aux documents de ce dossier (voir les bibliothèques). Le montage survit au rechargement. Démonter un dossier dont un document est ouvert est refusé.
- **Changement externe.** À chaque retour du focus sur la page, la date de modification du fichier est relue. Si le fichier a changé et que le document n'est pas modifié, il est rechargé. S'il est modifié, un bandeau propose *Recharger* (perdre la copie de travail) ou *Garder la mienne* (le prochain Enregistrer écrase le fichier).

Sans l'API (Firefox, Safari) : *Ouvrir un fichier de l'appareil* lit le fichier et en fait un document de la **Bibliothèque**, qui est donc une copie. *Enregistrer sous… ▸ Disque* télécharge le fichier.

## Magasins

Les magasins suivis (les dépôts GitHub de faustmodular, avec les clés partagées `faustmodular:stores` et `faustmodular:store-tokens`) sont un volume en **lecture**. Ouvrir un module :

- crée un document de la **Bibliothèque**, avec sa **provenance** : magasin, chemin, commit lu, empreinte du code. Rouvrir le même module au même code ouvre ce document, sans en créer un autre ;
- garde *Export ▸ Publish* inchangé (`webapp/publish-plan.js`) : publier la version enregistrée, comme nouvelle version du module dont le document provient, avec ses avertissements. La pastille ⇡ signale un contenu enregistré différent du code publié.

La provenance n'est pas une origine. Enregistrer écrit dans la Bibliothèque, et publier reste un geste distinct et public.

## faustmodular

Les scènes de faustmodular, puis leurs **ressources** : les fichiers `faustmodular/documents/<uuid>/resources/<Nom>.dsp` de l'OPFS, que faustcode partage. Le contrat (ce que faustcode lit et écrit, les verrous, la sonnette) est celui de `SCENE-RESOURCES-SPEC.md` de faustmodular ; la section suivante en donne le comportement vu de faustcode.

# L'origine faustmodular

Une **ressource** d'une scène est un nom et un code ; les modules de la scène en sont des instances (faustmodular, `SCENE-RESOURCES-SPEC.md`). faustcode édite la ressource, donc toutes ses instances à la fois. Il n'édite jamais une instance.

## Ouvrir

1. **Par le crayon** d'un module dans faustmodular. faustmodular sonne `open-resource` ; un onglet faustcode ouvert répond `opened` et ouvre la ressource. Sinon, faustmodular ouvre `faustcode/?open=faustmodular:<uuid>/<Nom>` dans une fenêtre nommée `faustcode`.
2. **Par la boîte *Ouvrir* ▸ faustmodular ▸ Ma scène ▸ VCO.dsp.**
3. Dans les deux cas, faustcode ouvre le document dont l'origine est ce fichier, ou le crée. Il n'y a donc pas de doublon. Le document s'affiche **directement dans la vue dsp**. faustcode n'a plus d'écran ENTER (0.28.0) : le son se lance par le haut-parleur de la vue Run, et seul un lien partagé ouvert sur un téléphone garde son *Tap to play* (`spec_share_url.md`).
4. L'en-tête montre l'origine : `VCO.dsp — faustmodular ▸ Ma scène ▸ VCO`.

## Enregistrer

5. Cmd/Ctrl-S compile. Si le code compile, faustcode écrit le fichier de la ressource, sous le verrou `faustmodular:document:<uuid>` et de façon conditionnelle (D6), puis sonne `resource-changed`.
6. Si faustmodular a la scène ouverte, il recompile toutes les instances de la ressource sans couper le son, en gardant valeurs, connexions et modulations, puis répond `applied`. faustcode affiche « VCO mis à jour (2 instances) », ou l'erreur que faustmodular rapporte (plus de 32 canaux, environnement différent…).
7. Si faustmodular n'a pas la scène ouverte, ou n'est pas lancé, l'enregistrement est fait quand même : la scène lira le fichier à sa prochaine ouverture, et sera modifiée (●). Sans réponse au bout de 2 s, faustcode le dit : « Enregistré dans Ma scène, qui n'est pas ouverte dans faustmodular ».
8. Avec des erreurs de compilation, rien n'est écrit (voir Enregistrer et compiler).

## Ce qui change de l'autre côté

- **Rechargements.** L'origine est un chemin de fichier : recharger faustcode ou faustmodular ne défait rien. Il n'y a ni fenêtre à retrouver, ni identifiant de page.
- **La ressource change dans faustmodular** (annulation, *Mettre à jour*, fichier déposé sur une instance) : faustmodular réécrit le fichier et sonne `resource-changed`. faustcode recharge le document s'il n'est pas modifié ; sinon, le bandeau *Recharger* ou *Garder la mienne* (le prochain Enregistrer écrase, après confirmation).
- **La ressource est renommée** (`resource-renamed`) : l'origine du document suit.
- **La ressource est retirée de la scène** (`resource-removed`), ou la scène est mise à la corbeille : le document devient **sans origine**, et un bandeau propose *Enregistrer sous…*.

## Enregistrer sous… ▸ faustmodular

*Enregistrer sous… ▸ faustmodular* choisit une scène et écrit un nouveau fichier `resources/<Nom>.dsp`, de nom libre, puis sonne `resource-added` avec `place`. Si la scène est ouverte, faustmodular adopte la ressource et en pose une instance au centre de la vue ; sinon, il l'adoptera à la prochaine ouverture. Un **nouveau document** naît, dont l'origine est ce fichier (D2) ; l'original reste tel quel. Le bouton **faustmodular** de l'en-tête fait la même chose dans la scène ouverte de faustmodular (la dernière qui a sonné), et revient à Enregistrer pour un document dont l'origine est déjà une ressource.

## La même origine

Le système de fichiers, les verrous et le canal ne sont partagés que par des pages de **même origine**. C'est le cas en production (`orlarey.github.io/faustcode/` et `orlarey.github.io/faustmodular/`). En développement, le serveur de faustmodular sert faustcode sous `/faustcode/`. Ailleurs, le volume faustmodular est absent de la boîte *Ouvrir*, et le bouton faustmodular est grisé, avec la raison en infobulle.

# Les surfaces

## Le menu Fichier

```
File ▾
 New                         Cmd/Ctrl-N
 Open…                       Cmd/Ctrl-O      la boîte Ouvrir : les volumes
 Open recent ▸                               les 8 derniers documents
 ──────────
 Save                        Cmd/Ctrl-S
 Save as…                    Shift-Cmd/Ctrl-S  une origine : Bibliothèque, Disque, faustmodular
 Revert to saved
 Rename…
 Move to trash                               Bibliothèque seulement ; corbeille restaurable
 ──────────
 Stores…                                     suivre, lire et écrire (inchangé)
```

## La boîte Ouvrir

Une seule boîte, en deux niveaux : les volumes, puis leur contenu.

- **Bibliothèque** : la liste des documents, avec la recherche et le tri par date ; et la **Corbeille** (restaurer, vider).
- **Disque** : les dossiers montés, **Monter un dossier…**, et **Ouvrir un fichier de l'appareil…** (disponible partout, avec `<input type=file>` hors de Chromium).
- **Magasins** : un dossier par magasin suivi, puis ses modules, avec la recherche (la liste actuelle de *Open from a store*).
- **faustmodular** : les scènes (sans celles de la corbeille), puis leurs ressources.

## L'en-tête

```
[File ▾]   VCO.dsp ●  — faustmodular ▸ Ma scène ▸ VCO    …   [Export] [faustmodular]  MCP
```

Le nom du document, le point ●, puis l'origine en clair. Un clic sur l'origine ouvre la boîte *Ouvrir* à cet endroit. Les flèches ◀ ▶ disparaissent.

# Les bibliothèques `.lib`

`import("foo.lib")` dans un document se résout dans cet ordre :

1. le dossier du document, s'il est sur un disque monté ;
2. la Bibliothèque : le document `foo.lib`, dans son contenu **enregistré** ;
3. les bibliothèques de Faust (`stdfaust.lib`…).

Enregistrer un `.lib` recompile le document ouvert s'il l'importe.

# Export, liens, onglets, MCP

**Export.** Il agit, comme aujourd'hui, sur le **contenu enregistré** du document ouvert, et signale les modifications non enregistrées. Rien d'autre ne change.

**Liens.** `?code=` ouvre un document de la Bibliothèque. Si un document de même nom a déjà ce contenu, c'est lui qui s'ouvre ; sinon un nouveau document est créé, avec un suffixe de nom si besoin. `?file=` et `?store=` ouvrent un module comme la boîte Ouvrir. Les paramètres sont retirés de l'adresse après le chargement, comme aujourd'hui.

**Onglets.** Un document peut être ouvert dans plusieurs onglets, qui se préviennent par `BroadcastChannel` :
- un Enregistrer dans un onglet recharge le document dans les autres, s'il n'y est pas modifié ;
- s'il y est modifié, un bandeau propose *Recharger* ou *Garder la mienne*.

La reprise d'onglet (`spec_reuse_tab.md`) reste inchangée.

**MCP.** Les outils de session sont remplacés par des outils de document, et `tools.json` change de version :

| Avant | Après |
| :-- | :-- |
| `submit(code, filename)` | `submit(code, filename?)` : écrit la copie de travail du document ouvert (ou, avec `filename`, du document de ce nom de la Bibliothèque, créé si besoin), puis Enregistre ; renvoie les erreurs et l'identifiant du document |
| `get_session`, `get_state` | `get_document`, `get_state` : identifiant, nom, origine, modifié, erreurs |
| `list_sessions` | `list_documents` : les documents de la Bibliothèque |
| `set_session(sha1)` | `open_document(id ou nom)` |
| `delete_session` | `trash_document` |
| `get_errors(sha1)` | `get_errors()` : celles du document ouvert |
| `prev_session`, `next_session`, `get_session_order`, `set_session_order` | supprimés |

Le pont Go déjà installé chez un utilisateur embarque l'ancien `tools.json`. La page répond donc encore aux anciens noms pendant une version, sur les documents : `set_session` ouvre le document dont le contenu a ce SHA-1, `list_sessions` liste les documents. Elle annonce dans `get_onboarding_guide` qu'il faut mettre à jour le pont.

# Le stockage et la migration

```tree "OPFS de faustcode, version 0.26"
/
  documents/<id>/meta.json     nom, origine ou provenance, dates, empreinte du contenu enregistré
  documents/<id>/saved.dsp     le contenu enregistré (Bibliothèque ; ou dernier contenu lu de l'origine)
  documents/<id>/working.dsp   la copie de travail, si elle diffère
  trash/<id>/…                 la corbeille
  cache/<empreinte>/…          les compilations (diagrammes) : jetable
  preferences.json             inchangé
  legacy/                      sessions/ et files.json d'avant 0.26, déplacés, jamais lus
  faustmodular/…               les scènes de faustmodular (même origine) : faustcode n'y lit et n'y écrit que les ressources
```

- Pour une origine Disque ou faustmodular, `saved.dsp` est le dernier contenu lu de l'origine, et `meta.json` garde son empreinte. Ils servent à afficher le document et à l'écriture conditionnelle (D6) ; l'origine reste la référence.
- **Migration** (au premier démarrage de 0.26, idempotente) :
  - chaque fichier de `files.json` devient un document de la Bibliothèque. Son contenu enregistré est sa version courante, sa copie de travail son brouillon. Sa provenance de magasin et son *handle* de disque sont gardés, ce dernier devenant son origine Disque ;
  - les sessions orphelines regroupées par nom suivent la même règle ;
  - le document ouvert est celui du fichier ouvert ;
  - `sessions/` et `files.json` sont **déplacés** dans `legacy/`, pas supprimés. Les anciennes versions n'y sont plus accessibles depuis l'interface. Une version ultérieure pourra proposer de vider `legacy/`.

# Ce qui disparaît

- Les sessions, leurs SHA-1 comme identité, le score d'usage, l'ordre chronologique ou d'usage.
- Les versions et ◀ ▶.
- Les brouillons rattachés à un SHA-1 (`drafts.js`), remplacés par la copie de travail.
- Le lien par fenêtres avec faustmodular : `playground-link.js`, `?link=modular`, les messages `faustcode-link-*`, `LinkTable` et le suivi des sessions liées. Une ressource de scène est une origine comme une autre.
- *Open from a store* et *All files…* comme entrées de menu, absorbés par *Open…*.
- *Install ▸ Add to faustmodular*, remplacé par *Save as… ▸ faustmodular*.
- `spec_playground_link.md`, remplacé par cette spécification et par `SCENE-RESOURCES-SPEC.md` de faustmodular.

# Hors périmètre

- Les dossiers dans la Bibliothèque.
- Enregistrer en place dans un magasin (commit à chaque Enregistrer). Publier reste un geste distinct.
- Le lien avec un faustmodular d'une autre origine.
- Un historique des versions dans faustcode.
- L'édition simultanée d'un même module depuis deux fenêtres faustcode.

# Décisions à valider

Celles de cette spécification ont été prises le 16 novembre 2026 (Décisions prises). Restent celles de `SCENE-RESOURCES-SPEC.md` de faustmodular, qui concernent les ressources elles-mêmes : nom de groupe, ressource sans instance, réutilisation, fichier déposé, même origine obligatoire, format 5.

# Critères d'acceptation

Les scénarios sont vérifiés de bout en bout avec les deux applications servies en local (Playwright, Chromium), sauf les sélecteurs de fichiers natifs, qui ne s'automatisent pas et sont vérifiés à la main.

**Documents**

- [ ] Nouveau, trois frappes, rechargement : le document revient avec sa copie de travail et ●.
- [ ] Enregistrer un code avec erreurs dans la Bibliothèque : écrit, erreurs à leur ligne, la vue Run joue encore l'ancienne version.
- [ ] *Save as…* dans la Bibliothèque : un nouveau document ; l'original est propre et inchangé.
- [x] *Revert to saved* rend le contenu enregistré et efface ●.
- [ ] Un `.lib` enregistré est utilisé par un `.dsp` qui l'importe ; sa copie de travail non enregistrée ne l'est pas.
- [ ] Le même `?code=` ouvert deux fois n'ouvre qu'un document.
- [ ] Deux onglets : Enregistrer dans l'un recharge l'autre ; avec des modifications dans l'autre, le bandeau apparaît.

**faustmodular** (avec faustcode servi sous `/faustcode/` du serveur de faustmodular ; les scénarios de `SCENE-RESOURCES-SPEC.md`)

- [x] Crayon : faustcode s'ouvre sur le code de la ressource, dans la vue dsp, sans ENTER, l'origine affichée ; un second clic ramène au même document.
- [ ] Cmd/Ctrl-S qui compile : toutes les instances sont mises à jour en place, valeurs, connexions et modulations gardées ; « VCO mis à jour (2 instances) ».
- [ ] Cmd/Ctrl-S avec erreurs : rien n'est écrit, ● reste, les instances jouent l'ancienne version.
- [ ] faustcode rechargé, puis faustmodular rechargé : Cmd/Ctrl-S met encore la ressource à jour, sans recliquer sur le crayon.
- [ ] Scène fermée dans faustmodular : Cmd/Ctrl-S écrit le fichier et le dit ; la scène s'ouvre ensuite avec le nouveau code.
- [ ] Annulation dans faustmodular : le document non modifié est rechargé ; modifié, le bandeau ; *Écraser* n'écrase qu'après confirmation.
- [ ] Écriture concurrente : le fichier a changé depuis la lecture, faustcode n'écrit pas et propose *Recharger* ou *Écraser*.
- [ ] Ressource renommée : l'origine suit. Ressource retirée : le bandeau sans origine.
- [ ] *Save as… ▸ faustmodular* : une ressource et une instance dans la scène ouverte, un nouveau document lié ; l'original est inchangé.
- [x] La boîte *Ouvrir* ▸ faustmodular liste les scènes et leurs ressources.

**Disque, magasins, MCP, migration**

- [ ] (À la main, Chromium) Ouvrir un fichier du disque, Enregistrer, le fichier est réécrit ; après un rechargement, la permission est redemandée.
- [x] Monter un dossier, ouvrir un `.dsp` qui importe un `.lib` du même dossier : il compile ; un changement externe est rechargé, ou le bandeau (vérifié avec un dossier du stockage privé, qui a la même interface ; le sélecteur natif, à la main).
- [ ] Ouvrir un module d'un magasin : un document avec sa provenance ; le rouvrir ne crée rien ; Publish inchangé.
- [ ] MCP : `submit` puis `get_document` ; un ancien `set_session(sha1)` ouvre le bon document.
- [ ] Migration d'une OPFS de 0.25 : chaque fichier devient un document, avec son contenu courant et son brouillon ; `legacy/` contient les anciennes données ; un second démarrage ne fait rien.

# Plan de réalisation

Une seule livraison, construite dans cet ordre, chaque étape testée avant la suivante :

1. **Le modèle pur** (`documents.js`) : documents, origines, copie de travail, noms uniques, corbeille, avec ses tests `node --test`.
2. **Le stockage** (`document-store.js`) sur OPFS, et la **migration**, testée sur une copie de l'OPFS de 0.25.
3. **L'éditeur et la compilation** : la copie de travail gardée, Enregistrer, la vue Run sur la dernière compilation réussie, le cache. Les sessions sont retirées de `app.js`, `handlers.js`, `api-shim.js`, `io-session.js`, `editor-sync.js`, `floating-editor.js` et `lib-inject.js`.
4. **Les surfaces** : le menu, la boîte Ouvrir, l'en-tête, les bandeaux.
5. **Les volumes** : Disque (fichier, dossier monté, changement externe) et Magasins (provenance, Publish).
6. **Le volume faustmodular** : la lecture des scènes et des ressources, l'écriture conditionnelle sous verrou, la sonnette ; `playground-link.js` retiré. Côté faustmodular, `SCENE-RESOURCES-SPEC.md`, livrée en même temps ; les tests de bout en bout des deux applications, servies par la même origine.
7. **MCP** : `tools.json`, la page et la compatibilité des anciens noms.
8. **La documentation** : README, `spec_playground_link.md` et `spec_files_store.md` marqués comme remplacés, CHANGELOG.
