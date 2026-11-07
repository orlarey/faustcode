---
title: Fichiers et magasins dans faustcode
subtitle: Un menu Fichier, des fichiers versionnés, et les magasins de faustmodular
author: Yann Orlarey
organization: EMERAUDE (GRAME/INRIA/INSA)
date: 7 novembre 2026
document-style: note-a4
language: fr
---

::: toc+
- **Objet** — ce qui manque à faustcode, ce que la fonction apporte.
- **Ce qui existe** — les sessions de faustcode, les documents et les magasins de faustmodular.
- **La thèse** — un fichier est un nom et une suite de versions ; les sessions ne changent pas.
- **Le fichier** — contenu, identité, versions, brouillon, provenance.
- **Le stockage** — disposition dans OPFS, fichiers du disque, migration des sessions.
- **Les surfaces** — menu Fichier, en-tête, navigation.
- **Les magasins** — suivre, lire et écrire, état partagé avec faustmodular.
- **Ouvrir depuis un magasin** — la liste des modules, la provenance.
- **Publier** — un module, une nouvelle version, les cas de conflit.
- **Les liens** — `?file=`, `?store=…&file=…`, et le bouton Share.
- **Le code commun** — la bibliothèque `fauststore`, partagée avec faustmodular.
- **MCP** — ce qui change pour le contrat, ce qui viendra plus tard.
- **Hors périmètre**, **Décisions à valider**, **Phases**, **Critères d'acceptation**.
:::

# Objet

faustcode garde tout ce qu'on lui soumet, mais il n'a pas de **fichiers** : chaque enregistrement crée une session nouvelle, identifiée par l'empreinte de son code, et la liste des sessions mêle toutes les versions de tous les programmes. On ne peut pas dire « mon fichier `Wahoo.dsp` », ni l'enregistrer sur le disque là d'où on l'a ouvert, ni le retrouver par son nom.

faustmodular a désormais un menu Fichier d'application de bureau (documents enregistrés automatiquement, fichiers du disque, scènes récentes) et des **magasins** : des dépôts GitHub où l'on publie des modules et des scènes (`Documentation/STORE-SPEC.md` de faustmodular). Depuis la 3.49.0, publier une scène publie aussi ses modules, comme fichiers `.dsp` ordinaires : faustcode doit pouvoir les ouvrir, les modifier et en publier de nouvelles versions.

Cette spécification donne à faustcode :

1. des **fichiers** : un nom, des versions, un menu Fichier, l'enregistrement sur le disque ;
2. la **lecture des magasins** : les mêmes magasins suivis que faustmodular, ouvrir un module, les liens ;
3. la **publication** : publier un fichier comme module d'un magasin, ou en publier une nouvelle version.

Chaque partie est utile seule, et livrée dans cet ordre (\ref{sec:phases}).

# Ce qui existe

**Les sessions de faustcode** (`webapp/sessions.js`, `opfs-store.js`). Une session est identifiée par le SHA-1 de son code et ne change jamais (INV-3 de `SPECIFICATION.md`). Elle porte un nom de fichier (`filename`), ses erreurs, ses diagrammes, ses dates et un score d'usage. Soumettre deux fois le même code redonne la même session ; soumettre un code modifié sous le même nom crée une session de plus. Les brouillons non soumis sont gardés par session (`drafts.js`, `localStorage`). L'en-tête montre la session active, ◀ ▶ parcourent toutes les sessions, et un clic sur le nom ouvre la liste avec une recherche.

Un fichier `.lib` est une session à part : soumettre un `.lib` supprime les sessions `.lib` de même nom, car `import("foo.lib")` se résout par le nom.

**Les documents de faustmodular** (`Documentation/DOCUMENT-SPEC.md`). Un document a un identifiant stable et un nom ; il référence des codes par leur SHA-1 ; il est enregistré automatiquement ; le menu Fichier est celui d'une application de bureau (Ouvrir, Enregistrer, Enregistrer sous…, récents). Avec l'API File System Access (Chromium), le fichier du disque ouvert ou enregistré est retenu (son *handle*, dans IndexedDB) et Enregistrer le réécrit.

**Les magasins de faustmodular** (`src/store/`). Un magasin est un dépôt GitHub (`fauststore.json`, `index.json`, `modules/<Nom>/<Nom>.dsp`, `scenes/<Nom>/<Nom>.jfaust`). On le lit sans compte. On y écrit avec un jeton personnel limité au dépôt, un jeton par magasin, et chaque publication fait un seul commit. Les magasins suivis et les jetons sont gardés dans le `localStorage` de l'origine `orlarey.github.io`, **que faustcode partage**.

# La thèse

> Un **fichier** est un nom et une suite chronologique de **versions** ; chaque version est une session. Les sessions ne changent pas : le fichier est une couche au-dessus.

- **Rien ne casse.** Les sessions restent immuables et identifiées par le SHA-1 de leur code ; le contrat MCP (`tools.json`) ne change pas ; les liens `?code=` et le lien avec faustmodular (`?link=modular`) fonctionnent comme avant.
- **Ce que l'utilisateur voit change.** L'en-tête montre un fichier et sa version, ◀ ▶ parcourent les versions de ce fichier, la liste montre les fichiers.
- **Le modèle est celui des magasins.** Un module d'un magasin est un nom, un chemin et des versions identifiées par l'empreinte de leur code : un fichier de faustcode s'y publie sans traduction.

# Le fichier

## Contenu

```json "Un fichier dans files.json"
{
  "id": "0b6f2c4e-…",
  "name": "Wahoo.dsp",
  "versions": ["a1b2…", "c3d4…", "e5f6…"],
  "created": 1762500000000,
  "modified": 1762510000000,
  "store": { "store": "orlarey/faust-store", "path": "modules/Wahoo/Wahoo.dsp",
             "commit": "ab66723…", "code": "e5f6…" },
  "trashed": null
}
```

| Champ | Sens |
| :-- | :-- |
| `id` | identifiant opaque (uuid), stable ; le nom peut changer |
| `name` | nom du fichier, `.dsp` ou `.lib` ; unique parmi les fichiers |
| `versions` | les SHA-1 des sessions enregistrées, de la plus ancienne à la plus récente ; la dernière est la **version courante** |
| `created`, `modified` | création, dernier enregistrement (ms) |
| `store` | absent, ou le lien avec un magasin : le module ouvert depuis ce magasin, ou publié dans ce magasin, à ce commit, avec ce code (son SHA-1, \ref{sec:identite}) |
| `trashed` | dans la corbeille depuis (ms), ou `null` |

Le fichier retenu sur le disque (son *handle*) n'est pas dans `files.json` : il est dans IndexedDB, par l'identifiant du fichier (\ref{sec:disque}).

## Les versions

- **Enregistrer** (Cmd/Ctrl-S, dans la vue dsp ou l'éditeur flottant) soumet le code comme aujourd'hui. La session obtenue devient la version courante : son SHA-1 est ajouté à la fin de `versions`, sauf s'il est déjà la version courante.
- **Une version avec erreurs** suit la règle actuelle (`persistOnSuccessOnly`) : elle ne devient une version que si sa session est gardée. Sinon le code reste dans le brouillon et les erreurs s'affichent.
- **Revenir à une ancienne version.** On affiche une ancienne version (◀ ▶), puis on l'enregistre : son SHA-1 est ajouté de nouveau à la fin de `versions`. L'historique est une suite d'enregistrements, sans branches. Rien n'est jamais perdu.
- **Le brouillon** reste celui d'aujourd'hui : il est attaché au SHA-1 de la version affichée. Un point (●) à côté du nom signale un brouillon différent de cette version.

## Identité

- **Les noms sont uniques.** En cas de collision, on ajoute `-2`, `-3`… avant l'extension (`Wahoo-2.dsp`), comme pour les chemins libres d'un magasin.
- **Même nom, même fichier.** Soumettre un code sous un nom de fichier existant en fait une nouvelle version de ce fichier. C'est le cas d'un dépôt de fichier `.dsp` sur la page, de *Ouvrir…* ou d'un `submit` MCP. C'est déjà le comportement des sessions : les soumissions d'un même `.dsp` s'accumulent.
- **Un fichier `.lib`** garde ses versions comme un `.dsp`. Seule sa version courante est donnée au compilateur. Cela remplace la règle actuelle, qui supprimait les anciennes sessions `.lib` de même nom.
- **Une session peut appartenir à plusieurs fichiers**, par exemple après *Enregistrer sous…* sans modification. Elle est gardée tant qu'un fichier la référence, corbeille comprise (\ref{sec:collecte}).

# Le stockage

## Disposition

```tree "OPFS de faustcode"
/
  sessions/<sha1>/…      inchangé : les versions
  files.json             les fichiers, et le fichier ouvert (open) (nouveau)
  preferences.json       inchangé
  faustmodular/…         les documents de faustmodular (même origine, non lus ici)
```

`files.json` est écrit après la session qu'il référence, jamais avant. Les écritures sont sérialisées, comme celles de `index.json` dans faustmodular.

## Fichiers du disque \label{sec:disque}

- **Avec l'API File System Access** (Chromium) :
  - *Ouvrir…* lit un fichier `.dsp` ou `.lib` et retient son *handle*, dans IndexedDB `faustcode-files`, par l'identifiant du fichier ;
  - *Enregistrer* réécrit ce fichier sur le disque, avec ou sans erreurs, car un éditeur enregistre ce qu'on tape. Le navigateur redemande la permission d'écrire après un rechargement ;
  - *Enregistrer sous…* choisit un autre fichier du disque et crée un nouveau fichier de faustcode, à la version courante.
- **Sans elle** (Firefox, Safari) : *Ouvrir…* lit un fichier choisi, et *Enregistrer sous…* demande un nom, télécharge le fichier sous ce nom et crée le nouveau fichier de faustcode. *Enregistrer* garde la version dans faustcode seulement.
- **Déposer un fichier** sur la page revient à *Ouvrir…*, sans *handle*.

## Migration des sessions \label{sec:migration}

Les sessions dont le code contient un `\r` sont d'abord réécrites sous le SHA-1 de leur code normalisé (\ref{sec:identite}) ; si cette session existe déjà, elles s'y confondent. Puis, au premier démarrage avec les fichiers, les sessions sont **groupées par nom de fichier** : chaque nom devient un fichier, dont les versions sont ses sessions triées par date de création. C'est ce que les sessions représentaient déjà. Le fichier ouvert est celui de la session active. Deux programmes sans rapport qui portaient le même nom (`shared.dsp`, ouvert par deux liens différents) deviennent deux versions d'un même fichier : *Renommer* ou *Enregistrer sous…* les séparent. La règle s'applique à chaque démarrage, et non une seule fois : une session qui n'appartient à aucun fichier (écrite par une ancienne version de faustcode dans un autre onglet, par exemple) rejoint le fichier de son nom, ou en crée un. Une fois les sessions adoptées, il n'en reste plus d'orphelines : la règle ne fait plus rien.

## Collecte \label{sec:collecte}

Une session est gardée tant qu'un fichier la référence, corbeille comprise. Vider la corbeille supprime les fichiers qu'elle contient et les sessions que plus rien ne référence. Rien d'autre ne supprime de session, ni un `submit` de `.lib`, ni l'ancien bouton de suppression.

# Les surfaces

## Le menu Fichier

Un bouton **Fichier ▾** prend la place du bouton **+**, à gauche de l'en-tête :

```
Fichier ▾
 Nouveau fichier
 Ouvrir…                         Cmd/Ctrl-O      un fichier du disque
 Tous les fichiers…                              la liste, la recherche, la corbeille
 Fichiers récents                                les 8 derniers, dans le menu
 Ouvrir depuis un magasin ▸                      un sous-menu par magasin suivi (phase 2)
 ──────────────
 Enregistrer                     Cmd/Ctrl-S
 Enregistrer sous…               Maj-Cmd/Ctrl-S
 Renommer…
 Supprimer                                       vers la corbeille
 ──────────────
 Publier dans un magasin…                        (phase 3)
 Magasins…                                       suivre, lire et écrire (phase 2)
```

- **Nouveau fichier** crée `untitled.dsp` (unique), avec un `process = _;` minimal, et l'ouvre dans la vue dsp.
- **Tous les fichiers…** est la liste actuelle des sessions, devenue liste des fichiers : recherche par nom, tri chronologique ou par usage, et une section **Corbeille** (restaurer, vider).
- **Publier dans un magasin…** suit la règle de faustmodular. Il est grisé sans magasin en écriture, direct avec un seul, et propose un sous-menu avec plusieurs.
- Le bouton de suppression quitte l'en-tête pour le menu (*Supprimer*, vers la corbeille), et le bouton **Archive** est retiré : il ne fonctionnait plus depuis la version sans Docker (sa route renvoyait une erreur). L'en-tête gagne la place que demande la mise en page étroite (`spec_share_url.md`).

## L'en-tête

```
[Fichier ▾]  ◀  Wahoo.dsp ● · v3/5  ▶   …   [Share] [faustmodular]  MCP
```

- Le nom du fichier ouvert, le point de brouillon, et la version affichée parmi les versions du fichier. Un clic sur le nom ouvre *Tous les fichiers…*.
- **◀ ▶ parcourent les versions du fichier**, et non plus toutes les sessions. À la version courante, ▶ est grisé.
- Un fichier lié à un magasin montre son magasin en infobulle, et une pastille ⇡ quand sa version courante diffère du code publié.

# Les magasins

## Suivre, lire, écrire

*Magasins…* ouvre un panneau qui reprend la famille *Magasins* de la bibliothèque de faustmodular :

- **Suivre un magasin** : `propriétaire/dépôt`, ou son adresse sur GitHub.
- **La liste des magasins suivis**, chacun avec son indicateur : *lecture*, *écriture* ou ⚠. Un clic sur l'indicateur ouvre le même menu que dans faustmodular : *Écrire dans ce magasin…* (le jeton, vérifié avant d'être gardé), ou *Changer le jeton…* et *Repasser en lecture seule* ; *Relire* ; *Ouvrir sur GitHub* ; *Ne plus suivre*.
- **La boîte du jeton** : son lien vers la page de GitHub qui crée un jeton (*fine-grained*, ce seul dépôt, *Contents : read and write*), ses messages d'erreur et le rappel qu'un magasin public est public.

## L'état partagé avec faustmodular \label{sec:partage}

faustcode et faustmodular sont servis par la même origine (`orlarey.github.io`) : ils partagent le `localStorage`. **Un magasin suivi, ou un jeton donné, dans l'un est connu de l'autre.** Les deux clés deviennent un contrat entre les deux applications, et gardent leur nom pour ne pas casser la version déployée de faustmodular :

| Clé | Valeur |
| :-- | :-- |
| `faustmodular:stores` | tableau JSON des magasins suivis, `"propriétaire/dépôt"` |
| `faustmodular:store-tokens` | objet JSON `"propriétaire/dépôt"` → jeton |

- Chaque application relit ces clés au démarrage et sur l'événement `storage`, émis quand un autre onglet les modifie. faustmodular l'ajoute dans la même livraison.
- Un champ inconnu de ces valeurs est conservé tel quel ; une valeur illisible est traitée comme vide, sans être réécrite.
- En développement local, les deux applications ont des origines différentes et ne partagent rien : c'est voulu.

# Ouvrir depuis un magasin

- **Ouvrir depuis un magasin ▸** propose un sous-menu par magasin suivi. Chacun ouvre la liste des modules de ce magasin, avec la recherche de la liste des fichiers : le nom du module, sa description (`declare description`) et sa date de publication.
- **Ouvrir un module** lit son code et l'ouvre comme fichier `<Nom>.dsp`, lié au magasin : le champ `store` reçoit le magasin, le chemin, le commit lu et le code.
  - Si un fichier est déjà lié à ce chemin de ce magasin avec ce code, ce fichier s'ouvre : rouvrir ne crée pas de doublon.
  - Sinon, c'est un nouveau fichier. Son nom reçoit un suffixe s'il est pris, et le fichier existant n'est jamais modifié.
- **Les scènes** d'un magasin ne s'ouvrent pas dans faustcode. Leurs modules, eux, sont des fichiers du magasin depuis faustmodular 3.49.0.

# Publier

*Publier dans un magasin…* publie la version courante du fichier ouvert, comme module : `modules/<Nom>/<Nom>.dsp`, où `<Nom>` est le nom du fichier sans `.dsp`. Une boîte de dialogue montre le magasin, le chemin et ce qui va se passer :

| Situation | Proposé |
| :-- | :-- |
| Le chemin est libre | *Publier* |
| Le chemin existe, et le code du magasin est celui que le fichier y a lu ou publié (`store.code`) | *Publier une nouvelle version* |
| Le code du magasin a changé depuis (quelqu'un d'autre a publié) | avertissement : *Publier quand même* (une nouvelle version : la sienne reste dans l'historique) ou *Annuler* |
| Le chemin existe, et le fichier n'est pas lié à ce magasin | choix : *Nouvelle version* de ce module, ou *Sous un autre nom* (`<Nom>-2`), ou *Annuler* |
| Le code est déjà la dernière version du magasin | rien à publier : le lien est copié |
| Le code est une ancienne version du magasin | avertissement : republier ramènerait le module en arrière |

- **Ce qui ne se publie pas** :
  - un code avec des erreurs de compilation ;
  - un fichier `.lib`, car les magasins n'ont pas encore de bibliothèques ;
  - un code qui importe un `.lib` de faustcode, puisque le module ne compilerait pas ailleurs. Le message nomme ces bibliothèques.
- **Un commit par publication**, l'index refait, comme dans faustmodular. Le message du commit est `Publish the module <Nom> (faustcode)` ou `Publish a new version of the module <Nom> (faustcode)`.
- **Après la publication** : le champ `store` du fichier reçoit le commit et le code publiés, le magasin est relu (à jour, avec le jeton), et le lien de partage, au commit publié, est copié (\ref{sec:liens}).
- **Les métadonnées** viennent des `declare` du code (`name`, `description`, `author`…). Les compléter au moment de publier est reporté, comme dans faustmodular.

# Les liens \label{sec:liens}

| Lien | Effet |
| :-- | :-- |
| `?file=https://github.com/<o>/<r>/blob/<ref>/<chemin>` | ouvre ce `.dsp` (ou `.lib`) de GitHub ; l'adresse brute `raw.githubusercontent.com/…` est acceptée, encodée ou non |
| `?store=<o>/<r>&file=<chemin>[&ref=<ref>]` | la même chose, avec une branche qui contient `/` |
| `?store=<o>/<r>` | suit ce magasin et ouvre la liste de ses modules |

- C'est la forme de `?scene=` dans faustmodular, et la même fonction d'analyse (`parseFileUrl`, \ref{sec:commun}).
- **N'importe quel dépôt public** : un `.dsp` de GitHub s'ouvre même si son dépôt n'est pas un magasin. Le fichier n'est alors lié à aucun magasin.
- `view` et `poly` s'y ajoutent comme pour `?code=`. Tous ces paramètres sont retirés de l'adresse après le chargement (`history.replaceState`), en gardant `mcp` et `token`.
- **Rouvrir le même lien** ne crée ni session ni fichier en double.

**Le bouton Share** propose, pour un fichier dont la version courante est le code publié dans un magasin, le **lien du magasin** au commit publié (environ 120 caractères, quelle que soit la taille du code). Son QR code se lit de loin même pour un long programme. Le lien `?code=`, autonome, reste proposé, et c'est le seul quand le fichier n'est pas publié.

# Le code commun \label{sec:commun}

Les deux applications doivent lire et écrire les magasins **exactement de la même façon** : même index, mêmes empreintes, même vérification des jetons, même commit. Le code ne doit donc pas être réécrit en JavaScript dans faustcode.

- **La bibliothèque `fauststore`.** Ce sont les modules sans interface de `src/store/` de faustmodular :
  - analyse des adresses et des chemins ;
  - index et empreintes git ;
  - lecture et publication par l'API de GitHub ;
  - magasins suivis et jetons ;
  - plan de publication d'une scène.

  faustmodular la construit en un module ES autonome, sans dépendance (`npm run build:fauststore` → `lib/fauststore.js` et `fauststore.d.ts`), avec sa propre version (`FAUSTSTORE_VERSION`, qui commence à 1.0.0).
- **faustcode en garde une copie** dans `webapp/vendor/fauststore/` (comme faustwasm et faust-ui). Le script `scripts/update-fauststore.sh <faustmodular>` la met à jour. La copie rend faustcode indépendant des déploiements de faustmodular, et le laisse fonctionner hors ligne.
- **Les interfaces restent propres à chaque application** : menus, boîtes de dialogue, textes. Les comportements et les messages suivent ceux de faustmodular.
- **Tests** : faustmodular teste la bibliothèque sur sa source (avec son GitHub en mémoire). faustcode vérifie sa copie par `node --test` : analyse des liens, index, publication sur un faux GitHub.
- **Plus tard**, si faustdaw en a besoin aussi : un dépôt `orlarey/fauststore` et un paquet npm.

## Identité des codes \label{sec:identite}

**Le source est normalisé dès son entrée dans faustcode** : `\r\n` puis `\r` seul deviennent `\n`, la règle de faustmodular (`normalizeText`). La session est donc identifiée par le SHA-1 du texte normalisé, en UTF-8, comme un code de faustmodular et d'un magasin : une seule identité pour les trois.

- **Pourquoi c'est sans effet sur le programme.** Pour le lexer de Faust (`compiler/parser/faustlexer.l`), `\r` (`\x0d`) est un blanc (`[ \t\x0a\x0d]+`), termine un commentaire `//` (`"//"[^\x0a\x0d]*`), et se traite comme `\n` dans un commentaire `/* */`. Seule une chaîne écrite sur plusieurs lignes (`"\""[^\"]*"\""`, un `declare` par exemple) contient ses `\r` : son texte passe de `\r\n` à `\n`, ce qui est souhaitable.
- **Convertir, pas supprimer.** Un `\r` seul (fichier d'un ancien Mac) est une fin de ligne : le supprimer collerait les lignes, et un commentaire `//` avalerait la ligne suivante.
- **Où.** À chaque entrée d'un code : `submit` (MCP et Cmd/Ctrl-S), fichier déposé ou ouvert, collage, liens `?code=` et `?file=`, magasin, message de faustmodular. Le contrat MCP ne définit pas le calcul du SHA-1 : il ne change pas. L'éditeur ne produit pas de `\r` (CodeMirror sépare les lignes par `\n`).
- **Les sessions existantes** qui contiennent un `\r` sont réécrites sous le SHA-1 de leur code normalisé à la migration (\ref{sec:migration}). Les autres gardent leur SHA-1, qui est déjà le bon.
- **Enregistrer sur le disque** écrit le texte normalisé : un fichier en fins de ligne Windows est réécrit en `\n`, ce que tous les éditeurs lisent.

# MCP

- **Le contrat ne change pas** dans les phases 1 à 3. `submit` attache sa session à un fichier :
  1. le fichier ouvert, s'il porte ce nom ;
  2. sinon le fichier de ce nom ;
  3. sinon un nouveau fichier.

  `set_session` ouvre le fichier qui contient cette session (le plus récemment modifié s'il y en a plusieurs), à cette version. `list_sessions` liste toujours les sessions.
- **Plus tard** : `list_files`, `list_store_modules`, `open_store_module` (en lecture). **Publier n'est jamais fait par un outil MCP sans une confirmation dans la page** : c'est un geste public, fait avec le jeton de l'utilisateur.

# Hors périmètre

- Les scènes dans faustcode, et les projets de plusieurs fichiers (`.dsp` et ses `.lib` publiés ensemble).
- Les bibliothèques dans les magasins (`libraries/`, phase 6 de STORE-SPEC.md).
- Retirer un module d'un magasin.
- Compléter les métadonnées au moment de publier.
- Contribuer au magasin d'un autre (*fork* et *pull request*).
- Un magasin de codes commun dans OPFS avec faustmodular (`DOCUMENT-SPEC.md`, « Le partage ») : les empreintes le rendent possible, mais il n'est pas nécessaire ici.

# Décisions à valider \label{sec:decisions}

1. **Les fichiers sont une couche au-dessus des sessions** : un nom et une suite de versions, sans changement des sessions ni du contrat MCP.
2. **◀ ▶ parcourent les versions du fichier ouvert**, et la liste montre les fichiers (et non plus toutes les sessions).
3. **Même nom, même fichier**, pour un dépôt sur la page, *Ouvrir…* ou `submit` ; et les sessions existantes sont groupées par nom à la migration.
4. **Un `.lib` garde ses versions**, et seule la version courante compile ; aucune session n'est supprimée hors de la corbeille.
5. **Enregistrer écrit aussi sur le disque** quand le fichier y est retenu (Chromium), même avec des erreurs.
6. **Les clés `faustmodular:stores` et `faustmodular:store-tokens`** deviennent un contrat entre les deux applications, sous ces noms.
7. **La bibliothèque `fauststore`**, construite par faustmodular et copiée dans faustcode, plutôt qu'importée à l'exécution depuis faustmodular.
8. **Share préfère le lien du magasin** pour un fichier publié et inchangé.
9. **Le source est normalisé à l'entrée** (`\r\n` et `\r` → `\n`) : une session, un code de faustmodular et un code de magasin ont la même empreinte.

# Phases \label{sec:phases}

::: note [État]
Phase 1 livrée dans faustcode 0.16.0 :
- `webapp/file-index.js` est le modèle, pur et testé (`file-index.test.mjs`) ;
- `webapp/files.js` le garde dans `files.json`, avec le fichier ouvert, et prévient les autres onglets ;
- `webapp/disk-files.js` retient les fichiers du disque ;
- le source est normalisé à l'entrée, par l'interface comme par MCP ;
- les sessions sont adoptées par nom, et celles qui contiennent un `\r` sont réécrites sous leur empreinte normalisée ;
- les `.lib` gardent leurs versions, et seule la version courante compile ;
- l'interface comprend le menu *File*, l'en-tête (`Wahoo.dsp ● · v3/5`), ◀ ▶ sur les versions, et *All files…* avec la recherche et la corbeille.

Les textes de l'interface sont en anglais, comme le reste de faustcode : *New file*, *Open…*, *Save*, *Save as…*, *Rename…*, *Move to trash*.

Phase 2 livrée dans faustcode 0.17.0, avec faustmodular 3.50.0 :
- **La bibliothèque.** `fauststore` 1.0.0 vient de `src/store/fauststore.ts` de faustmodular. `npm run build:fauststore` la construit, et `scripts/update-fauststore.sh` la copie dans `webapp/vendor/fauststore/`. Elle n'a pas de fichier `.d.ts`, puisque faustcode est en JavaScript.
- **L'interface** (`webapp/stores-ui.js`) :
  - *Stores…* : suivre un magasin, son indicateur (*read*, *write* si faustmodular y a mis un jeton, ⚠), *Read again*, *Open on GitHub*, *Unfollow* ;
  - *Open from a store* dans le menu *File* : la liste des modules, avec la recherche ;
  - un module ouvert devient un fichier lié au magasin. Le commit lu est demandé à l'API en un seul appel, après l'ouverture.
- **Les liens** `?file=` et `?store=` :
  - un `.dsp` d'un dépôt qui n'est pas un magasin s'ouvre sans lien de magasin ;
  - le lien du magasin dans *Share*.
- **Le suivi entre onglets.** L'événement `storage` est suivi dans les deux applications.
- **Dans faustmodular**, *Open in faustcode* au menu d'un module d'un magasin, qui ouvre faustcode avec `?file=`.
:::

1. **Fichiers** (faustcode 0.16.0) :
   - `files.json` et la migration ;
   - le menu Fichier, l'en-tête et ◀ ▶ sur les versions ;
   - les fichiers du disque, la corbeille ;
   - `submit` attaché aux fichiers.
2. **Lire les magasins** (faustcode 0.17.0, faustmodular 3.50.0) :
   - la bibliothèque `fauststore` 1.0 ;
   - le panneau *Magasins…* et la lecture des clés partagées, avec l'événement `storage` dans les deux applications ;
   - *Ouvrir depuis un magasin ▸*, les liens `?file=` et `?store=` ;
   - le lien du magasin dans Share ;
   - dans faustmodular, *Ouvrir dans faustcode* au menu d'un module d'un magasin.
3. **Publier** (faustcode 0.18.0) :
   - les jetons ;
   - *Publier dans un magasin…* et ses cas ;
   - le lien copié et la pastille ⇡.

# Critères d'acceptation

**Phase 1**

- [ ] Après la migration, chaque nom de session existant est un fichier dont les versions sont ses sessions, dans l'ordre ; la session active est ouverte.
- [ ] Trois Cmd/Ctrl-S avec trois codes différents donnent `v3/3` ; ◀ affiche `v2/3` ; Cmd/Ctrl-S sur `v2` donne `v4/4`, de même code que `v2`.
- [ ] Sur Chromium, un fichier ouvert par *Ouvrir…* est réécrit sur le disque par Cmd/Ctrl-S, y compris après un rechargement (le navigateur redemande la permission).
- [ ] Sur Firefox, *Enregistrer sous…* télécharge le fichier.
- [ ] Deux versions d'un `.lib` : un `.dsp` qui l'importe compile avec la version courante.
- [ ] Un `submit` MCP sous le nom du fichier ouvert en ajoute une version ; sous un nom nouveau, crée un fichier ; `list_sessions` est inchangé.
- [ ] Un fichier `.dsp` en fins de ligne Windows (`\r\n`) et le même en `\n` donnent la même session ; une session existante avec des `\r` est réécrite sous l'empreinte normalisée à la migration.
- [ ] Supprimer un fichier puis vider la corbeille supprime ses sessions qui n'appartiennent à aucun autre fichier, et seulement celles-là.

**Phase 2**

- [ ] Un magasin suivi dans faustmodular apparaît dans faustcode, dans un autre onglet ouvert, sans rechargement ; et réciproquement.
- [ ] Ouvrir `Drone` depuis `orlarey/faust-store` crée `Drone.dsp`, lié au magasin ; le rouvrir ne crée rien.
- [ ] `?file=https://github.com/orlarey/faust-store/blob/<commit>/modules/Drone/Drone.dsp&view=run` ouvre Drone en vue Run, et l'adresse est nettoyée.
- [ ] `?file=` vers un `.dsp` d'un dépôt qui n'est pas un magasin l'ouvre, sans lien de magasin.
- [ ] Share sur un module publié et inchangé propose le lien du magasin, plus court que le lien `?code=`.

**Phase 3**

- [ ] Publier un nouveau fichier crée `modules/<Nom>/<Nom>.dsp` en un commit, l'index à jour, le lien copié ; faustmodular le voit dans la bibliothèque après *Relire*.
- [ ] Modifier puis republier fait une nouvelle version : l'index garde l'ancienne avec son commit.
- [ ] Si quelqu'un a publié entre-temps une autre version, l'avertissement s'affiche avant toute écriture.
- [ ] Un code avec erreurs, un `.lib`, ou un code qui importe un `.lib` de faustcode ne se publie pas, avec un message qui dit pourquoi.
- [ ] Un jeton refusé ou expiré donne le même message que dans faustmodular.
