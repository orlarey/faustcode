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
- **L'origine faustmodular** — le crayon, l'envoi vers faustmodular, le protocole 2.
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
3. **Migration** : chaque fichier actuel devient un document de la Bibliothèque.
4. **Tout d'un coup** : le noyau, le disque, les magasins et faustmodular, dans une seule version (faustcode 1.0.0).

# Le modèle

## Vocabulaire

Document
: L'unité éditée : un `.dsp` ou un `.lib`. Il a un **identifiant** stable (uuid), un **nom**, un **contenu enregistré** et une **copie de travail**. Le point ● de l'en-tête signale une copie de travail différente du contenu enregistré.

Origine
: Le lieu **unique** auquel un document appartient. *Enregistrer* y écrit, et nulle part ailleurs. Une origine est un couple (volume, emplacement) : `Bibliothèque ▸ Wahoo.dsp`, `Disque ▸ ~/faust/echo.dsp`, `faustmodular ▸ Ma scène ▸ Echo`.

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

# Enregistrer et compiler

- **La copie de travail** est ce que montre l'éditeur, dans la vue dsp ou l'éditeur flottant ; les deux sont synchronisés. Elle est gardée automatiquement (D3) et retrouvée au rechargement, avec ●.
- **Enregistrer** (Cmd/Ctrl-S) compile la copie de travail, puis l'écrit dans l'origine :
  - **Bibliothèque, Disque** : le contenu est écrit **même avec des erreurs**, car un éditeur enregistre ce qu'on tape. Les erreurs sont affichées à leur ligne.
  - **faustmodular** : le contenu n'est envoyé au module que s'il compile. Avec des erreurs, rien n'est envoyé, le document reste modifié (●) et le module continue de jouer sa dernière version.
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

Le module d'une scène de faustmodular est une origine (section suivante). On n'y entre pas par la boîte *Ouvrir*, mais par le crayon du module, ou par *Enregistrer sous… ▸ faustmodular*.

# L'origine faustmodular

## Le crayon

1. Un clic sur le crayon d'un module ouvre faustcode dans la fenêtre `faustcode-modular`, ou la retrouve si elle existe. Il la met au premier plan sans la recharger : faustmodular la retrouve par son nom, `window.open("", "faustcode-modular")`, avant d'en ouvrir une nouvelle.
2. faustcode ouvre le document dont l'origine est ce module, ou le crée s'il n'existe pas. Le document s'affiche **directement dans la vue dsp**, sans ENTER : ENTER ne sert qu'à débloquer le son.
3. Un second clic sur le crayon du même module ramène à ce document : il n'y a pas de doublon.
4. L'en-tête montre l'origine : `Echo.dsp — faustmodular ▸ Ma scène ▸ Echo`.
5. Si le navigateur bloque la fenêtre, faustmodular le dit. Sans réponse au bout de 30 s, il le dit aussi.

## Enregistrer

6. Cmd/Ctrl-S compile. Si le code compile, il est envoyé au module, qui le recompile en place : le son continue, et les valeurs des sliders, les connexions et les modulations sont gardées. faustcode affiche « Echo mis à jour » quand faustmodular confirme.
7. Avec des erreurs, rien n'est envoyé (voir Enregistrer et compiler).
8. Si faustmodular refuse (module supprimé, plus de 32 canaux…), la raison s'affiche et le document reste modifié.

## L'identité de l'origine

L'origine est le triplet **(document de faustmodular, module, nom)** : l'identifiant du document de faustmodular, stable, et l'identifiant du module dans ce document, stable lui aussi (`keepIds`). Les identifiants tirés au hasard par page du protocole 1 disparaissent : ils empêchaient le lien de survivre à un rechargement.

- **faustcode rechargé** : le document et sa copie de travail sont dans la Bibliothèque. faustcode se réannonce à sa fenêtre ouvreuse, qui survit au rechargement, et le lien reprend.
- **faustmodular rechargé** : faustcode garde son document. Au prochain Enregistrer, faustmodular retrouve le module par (document, module) s'il a ce document ouvert. Sinon il répond que le document n'est pas ouvert, et le document de faustcode reste modifié.
- **Module supprimé** : faustmodular prévient faustcode, et le document devient **sans origine** : un bandeau propose *Enregistrer sous…*. Annuler la suppression dans faustmodular rétablit l'origine.
- **Code changé dans faustmodular** (annulation, dépôt d'un code sur le module, code d'un autre crayon) : faustmodular envoie le nouveau code. Si le document n'est pas modifié, il est rechargé. S'il l'est, un bandeau propose *Recharger* ou *Garder la mienne* (le prochain Enregistrer écrase le module).

## Envoyer vers faustmodular

*Enregistrer sous… ▸ faustmodular* et le bouton **faustmodular** de l'en-tête remplacent l'actuel *Install ▸ Add to faustmodular*. Ils ajoutent le contenu comme module de la scène ouverte, et créent un **nouveau document** dont l'origine est ce module, conformément à D2. Le document d'origine, dans la Bibliothèque ou sur le disque, reste tel quel. Un nouveau clic sur le bouton depuis un document d'origine faustmodular revient à Enregistrer.

## Protocole 2

Les deux applications passent ensemble au protocole 2. `faustcode-link-*` garde ses noms, et `protocol: 2` les distingue. Un message de protocole 1 est refusé, avec un message qui demande de mettre à jour l'autre application.

| Sens | `type` | Champs | Rôle |
| :-- | :-- | :-- | :-- |
| faustcode → faustmodular | `ready` | `libfaust` | prêt ; au chargement et après un rechargement |
| faustmodular → faustcode | `edit` | `origin`, `code` | ouvrir le document de ce module (crayon) |
| faustcode → faustmodular | `save` | `origin`, `code`, `request` | enregistrer ce code dans le module |
| faustmodular → faustcode | `saved` | `request`, `ok`, `error?` | appliqué, ou pourquoi non |
| faustmodular → faustcode | `changed` | `origin`, `code` | le code du module a changé dans faustmodular |
| faustmodular → faustcode | `removed` | `origin` | le module a été supprimé |
| faustmodular → faustcode | `restored` | `origin`, `code` | sa suppression a été annulée |
| faustcode → faustmodular | `add` | `name`, `code`, `request` | ajouter ce code comme module de la scène ouverte |
| faustmodular → faustcode | `added` | `request`, `ok`, `origin?`, `error?` | ajouté (son origine), ou pourquoi non |
| faustmodular → faustcode | `hello` | `libfaust` | ouvert par faustcode (`?link=faustcode`), prêt |

`origin` vaut `{ document, documentName, module, moduleName }`. `code` est le code de l'utilisateur, sans l'enveloppe du module (`model/ModuleCode`). Les règles d'origine des messages du protocole 1 sont inchangées : chaque application n'accepte que la fenêtre de l'autre, à l'origine de son URL, et `?faustcode=` ou `?faustmodular=` ne sont acceptés que vers localhost.

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

## L'en-tête

```
[File ▾]   Echo.dsp ●  — faustmodular ▸ Ma scène ▸ Echo    …   [Export] [faustmodular]  MCP
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

```tree "OPFS de faustcode, version 1.0"
/
  documents/<id>/meta.json     nom, origine ou provenance, dates, empreinte du contenu enregistré
  documents/<id>/saved.dsp     le contenu enregistré (Bibliothèque ; ou dernier contenu connu de l'origine)
  documents/<id>/working.dsp   la copie de travail, si elle diffère
  trash/<id>/…                 la corbeille
  cache/<empreinte>/…          les compilations (diagrammes) : jetable
  preferences.json             inchangé
  legacy/                      sessions/ et files.json d'avant 1.0, déplacés, jamais lus
```

- Pour une origine Disque ou faustmodular, `saved.dsp` est le dernier contenu connu de l'origine. Il sert à afficher le document et à détecter un changement externe ; l'origine reste la référence.
- **Migration** (au premier démarrage de 1.0, idempotente) :
  - chaque fichier de `files.json` devient un document de la Bibliothèque. Son contenu enregistré est sa version courante, sa copie de travail son brouillon. Sa provenance de magasin et son *handle* de disque sont gardés, ce dernier devenant son origine Disque ;
  - les sessions orphelines regroupées par nom suivent la même règle ;
  - le document ouvert est celui du fichier ouvert ;
  - `sessions/` et `files.json` sont **déplacés** dans `legacy/`, pas supprimés. Les anciennes versions n'y sont plus accessibles depuis l'interface. Une version ultérieure pourra proposer de vider `legacy/`.

# Ce qui disparaît

- Les sessions, leurs SHA-1 comme identité, le score d'usage, l'ordre chronologique ou d'usage.
- Les versions et ◀ ▶.
- Les brouillons rattachés à un SHA-1 (`drafts.js`), remplacés par la copie de travail.
- `LinkTable` et le suivi des sessions liées (`playground-link.js`), remplacés par l'origine.
- *Open from a store* et *All files…* comme entrées de menu, absorbés par *Open…*.
- *Install ▸ Add to faustmodular*, remplacé par *Save as… ▸ faustmodular*.

# Hors périmètre

- Les dossiers dans la Bibliothèque.
- Enregistrer en place dans un magasin (commit à chaque Enregistrer). Publier reste un geste distinct.
- Lister les modules de faustmodular dans la boîte Ouvrir. Le crayon suffit.
- Un historique des versions dans faustcode.
- L'édition simultanée d'un même module depuis deux fenêtres faustcode.

# Décisions à valider

1. **Enregistrer écrit même avec des erreurs** dans la Bibliothèque et sur le disque, mais pas dans faustmodular.
2. **Les magasins sont un volume en lecture**, et publier reste dans Export : un module ouvert devient un document de la Bibliothèque, avec une provenance.
3. **L'origine faustmodular est (document, module)**, stable à travers les rechargements, ce qui impose le protocole 2 aux deux applications à la fois.
4. **Le code changé dans faustmodular revient dans faustcode** (`changed`), avec le bandeau en cas de conflit.
5. **Les anciennes versions sont mises de côté (`legacy/`)**, pas migrées.
6. **MCP** : de nouveaux outils de document, et les anciens noms gardés une version pour les ponts déjà installés.
7. **La version 1.0.0** de faustcode, pour marquer le changement de modèle.

# Critères d'acceptation

Les scénarios sont vérifiés de bout en bout avec les deux applications servies en local (Playwright, Chromium), sauf les sélecteurs de fichiers natifs, qui ne s'automatisent pas et sont vérifiés à la main.

**Documents**

- [ ] Nouveau, trois frappes, rechargement : le document revient avec sa copie de travail et ●.
- [ ] Enregistrer un code avec erreurs dans la Bibliothèque : écrit, erreurs à leur ligne, la vue Run joue encore l'ancienne version.
- [ ] *Save as…* dans la Bibliothèque : un nouveau document ; l'original est propre et inchangé.
- [ ] *Revert to saved* rend le contenu enregistré et efface ●.
- [ ] Un `.lib` enregistré est utilisé par un `.dsp` qui l'importe ; sa copie de travail non enregistrée ne l'est pas.
- [ ] Le même `?code=` ouvert deux fois n'ouvre qu'un document.
- [ ] Deux onglets : Enregistrer dans l'un recharge l'autre ; avec des modifications dans l'autre, le bandeau apparaît.

**faustmodular** (les scénarios A à F)

- [ ] Crayon : faustcode s'ouvre sur le code du module, dans la vue dsp, sans ENTER, l'origine affichée.
- [ ] Cmd/Ctrl-S qui compile : le module est mis à jour en place, sliders, connexions et modulations gardés ; « Echo mis à jour ».
- [ ] Trois enregistrements successifs mettent à jour le même module.
- [ ] Cmd/Ctrl-S avec erreurs : rien n'est envoyé, ● reste, le module joue l'ancienne version.
- [ ] Deux modules, deux crayons : deux documents, chacun met à jour son module. Un second clic sur le crayon ramène au même document.
- [ ] faustcode rechargé, puis Cmd/Ctrl-S : le module est mis à jour.
- [ ] faustmodular rechargé, puis Cmd/Ctrl-S dans faustcode : le module est mis à jour.
- [ ] Module supprimé : le bandeau sans origine ; Cmd/Ctrl-S le dit ; annuler la suppression rétablit le lien.
- [ ] Code du module changé par une annulation dans faustmodular : le document non modifié est rechargé ; modifié, le bandeau.
- [ ] *Save as… ▸ faustmodular* : un module ajouté, un nouveau document lié ; Cmd/Ctrl-S le met à jour ; l'original est inchangé.
- [ ] Un message de protocole 1 est refusé avec un message clair.

**Disque, magasins, MCP, migration**

- [ ] (À la main, Chromium) Ouvrir un fichier du disque, Enregistrer, le fichier est réécrit ; après un rechargement, la permission est redemandée.
- [ ] (À la main) Monter un dossier, ouvrir un `.dsp` qui importe un `.lib` du même dossier : il compile.
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
6. **faustmodular, protocole 2**, des deux côtés : `playground-link.js` réécrit, `src/FaustcodeLink.ts` de faustmodular, avec les tests de bout en bout des deux applications.
7. **MCP** : `tools.json`, la page et la compatibilité des anciens noms.
8. **La documentation** : README, `spec_playground_link.md` et `spec_files_store.md` marqués comme remplacés, CHANGELOG.
