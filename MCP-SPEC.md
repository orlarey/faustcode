# MCP-SPEC.md — alignement actions utilisateur ↔ outils MCP

Audit de couverture : pour chaque action qu'un humain peut faire dans la
webapp faustcode, quel outil MCP permet à une IA de produire le même
effet ?

Snapshot pris le **2026-05-30** (révisé le **2026-05-31** : ajout puis
retrait de `inlineAudio`, puis `detail: "metrics"` livré en 0.5.0 sous la
forme `audio_metrics_v1`, et restructuré en `audio_metrics_v2` en 0.6.0
pour capturer l'évolution temporelle — segmentation attack/sustain/release
auto-détectée via la courbe RMS, métriques différenciées par phase),
contrat `tools.json` version **0.6.0** (37 outils). À refaire si on
ajoute des outils ou si la webapp gagne / perd des surfaces.

Légende : **✓** couvert, **◐** partiellement couvert (effet équivalent
mais sémantique différente), **✗** absent (souvent volontaire), **n/a**
cosmétique / non pertinent côté IA.

---

## A. Header global (visible quelle que soit la view)

| Action humaine | Tool MCP | État |
|---|---|---|
| Choisir une session dans le picker (par sha/nom) | `set_session` | ✓ |
| Lister les sessions disponibles | `list_sessions` (renvoie aussi `order`) | ✓ |
| Lire les métadonnées d'une session | `get_session` | ✓ |
| Bouton ◀ (session précédente) | `prev_session` (display-order : step toward bottom) | ✓ |
| Bouton ▶ (session suivante) | `next_session` (display-order : step toward top) | ✓ |
| Basculer ordre chronologique ↔ usage (indicateur ⏱/★) | `set_session_order` + `get_session_order` (état partagé via bascule pollState) | ✓ |
| Bouton ↻ refresh session (reload depuis OPFS) | — | ✗ équivalent : re-`submit` du même code |
| Bouton ✎ "edit session" (ouvre éditeur flottant) | — | ✗ UI-only |
| Bouton 🗑 delete session | `delete_session` | ✓ |
| Bouton Archive DSP | — | ✗ hors scope |
| Sélecteur de View | `set_view` | ✓ |
| Lire le state global (sha + view courants) | `get_state` | ✓ |
| Ouvrir le panneau MCP drawer | — | n/a |

## B. View DSP (éditeur code)

| Action humaine | Tool MCP | État |
|---|---|---|
| Lire le code DSP courant | `get_view_content` (view=dsp) | ✓ |
| Remplacer le code DSP | `submit` | ✓ |
| Lire les erreurs de compilation | `get_errors` | ✓ |
| Taper/éditer caractère par caractère dans CodeMirror | — | ✗ (résultat final via `submit`) |
| Sauvegarder via Cmd+S | — | ◐ couvert par `submit` |
| Drag-and-drop d'un .dsp | — | ✗ (résultat via `submit`) |

## C. View Diagrams (SVG)

| Action humaine | Tool MCP | État |
|---|---|---|
| Voir le SVG `process.svg` du DSP courant | `get_view_content` (view=svg) | ✓ |
| Naviguer vers un sous-diagramme (clic sur une boîte) | — | ✗ |
| Télécharger le SVG | — | ✗ |

## D. View Run (surface la plus riche)

### D.1 Transport audio + mode

| Action humaine | Tool MCP | État |
|---|---|---|
| Bouton Audio On/Off | `run_audio` (state: on/off/toggle) | ✓ |
| Alias legacy start/stop/toggle | `run_transport` | ✓ |
| Sélecteur Mode (Mono / 1, 2, 4, 8, 16, 32, 64 voix) | `set_polyphony` | ✓ |
| Lire la polyphonie courante | `get_polyphony` | ✓ |
| Sélecteur MIDI source (Virtual / device externe) | — | ✗ |

### D.2 Faust UI (Regular UI + Orbit UI)

| Action humaine | Tool MCP | État |
|---|---|---|
| Lire la structure UI Faust | `get_run_ui` | ✓ |
| Lire les valeurs des paramètres | `get_run_params` | ✓ |
| Bouger un slider | `set_run_param` | ✓ (validé 2026-05-30) |
| Cliquer un bouton (presser/relâcher) | `trigger_button` | ✓ |
| Bouger + capturer le spectre | `set_run_param_and_get_spectrum` | ✓ |
| Presser bouton + capturer | `trigger_button_and_get_spectrum` | ✓ |
| Drag dans l'Orbit UI (2D dual-param) | — | ◐ `set_run_param` × 2 |
| Random (bouton casino) | — | ✗ |
| Recall un preset nommé | — | ✗ |
| Zoom UI / Orbit | — | n/a |

### D.3 Oscilloscope

| Action humaine | Tool MCP | État |
|---|---|---|
| Lire le spectre live (tap sur l'AnalyserNode du run audio) | `get_spectrum` | ✓ |
| Rendu offline déterministe (script de gate, sampleRate configurable, sortie WAV Float32, spectre ou analyse riche) | `render_audio` (`detail: light \| metrics \| wav`) | ✓ |
| Changer view (Waveform/Spectrum), scale, trigger, slope, threshold, holdoff | — | ✗ UI-only |

### D.4 MIDI

| Action humaine | Tool MCP | État |
|---|---|---|
| Cliquer une note du clavier virtuel | `midi_note_on` / `midi_note_off` | ✓ |
| Note pulse (on → hold → off) | `midi_note_pulse` | ✓ |
| Variantes avec capture spectre | `midi_note_*_and_get_spectrum` | ✓ |
| Sélectionner un device MIDI externe | — | ✗ |
| Connecter clavier ordinateur (touches AZERTY) | — | ✗ (couvert par `midi_note_*`) |

### D.5 Download

| Action humaine | Tool MCP | État |
|---|---|---|
| Bouton Download (PWA .tar.gz) | — | ✗ hors scope |

## E. Views Tasks / Signals

| Action humaine | Tool MCP | État |
|---|---|---|
| Voir le graphe DOT rendu | `get_view_content` (view=tasks ou signals) | ✓ |
| Split view / zoom du graphe | — | n/a UI |
| Télécharger le .dot | — | ✗ |

## F. Documentation Faust (pas de surface UI dédiée — pure côté IA)

| Action équivalente | Tool MCP | État |
|---|---|---|
| Chercher un symbole dans stdfaust.lib | `search_faust_lib` | ✓ |
| Récupérer la doc d'un symbole | `get_faust_symbol` | ✓ |
| Lister les symboles d'un module | `list_faust_module` | ✓ |
| Récupérer des exemples Faust | `get_faust_examples` | ✓ |
| Expliquer un symbole pour un objectif | `explain_faust_symbol_for_goal` | ✓ |
| Guide d'onboarding | `get_onboarding_guide` | ✓ |

---

## Synthèse

| Catégorie | Couverture |
|---|---|
| Lecture d'état (sessions, views, params, UI, spectre, errors) | très complète |
| Écriture audio runtime (params, transport, MIDI, polyphonie) | très complète |
| Documentation Faust | très complète |
| Gestion sessions (suppression, ordre, navigation par usage) | très complète depuis la passe du 2026-05-30 |
| Réglages oscilloscope | absents (UI-only, cohérent) — pour les mesures fines : `render_audio` |
| Mesure audio offline déterministe / export WAV | très complète via `render_audio` (Phase 1 livrée 2026-05-30) |
| Sélection device MIDI externe | absent (peu critique : l'IA pilote via `midi_note_*`) |
| Random / Presets | absents |
| Download PWA / .dot / SVG | absents (hors scope) |

## Trous qui mériteraient un outil MCP

| Manque | Justification |
|---|---|
| `recall_preset(name)` | si le DSP a des presets, l'IA devrait pouvoir les essayer ; couplage avec `vendor/faust-orbit-ui/` |
| `refresh_session(sha1)` | équivalent du bouton ↻ — en standalone redondant avec un re-`submit`, à ressortir si on rebranche du live |

## Notes sémantiques

- **`usage_score`** : compteur cumulatif persisté, incrémenté de 1 par "événement d'usage"
  (sélection, re-sélection, tick d'engagement audio toutes les 5 s).
  Debounce 700 ms par sha1. Persisté dans `metadata.json` côté OPFS. Sémantique alignée
  avec la version Docker (`dist/sessions.js: markSessionUsed`).
- **`prev_session` / `next_session`** : traversent désormais les sessions dans la
  **display order** (= ce que voit l'humain) gouvernée par `get_session_order()`.
  En `chronological` : `prev` = plus ancien, `next` = plus récent (puis empty au-dessus du plus récent).
  En `usage` : `prev` = score plus bas, `next` = score plus haut.
- **Bascule UI ↔ MCP** : `sessionOrder` est partagé via le même pattern que
  `activeSha1`/`activeView` (api-shim + `/api/state` + `pollState` à 1.5 s). Un changement
  côté MCP se reflète dans l'indicateur `⏱`/`★` en ≤ 1.5 s, et inversement.
- **`render_audio`** : rendu **offline** déterministe via `OfflineAudioContext`. N'a pas
  besoin que la Run view soit montée — compile le DSP de la session active à neuf, applique
  `paramSetup`, scripte des événements de paramètres dans le temps (granularité = un
  render quantum, ~2.7 ms @ 48 kHz), retourne soit un `spectrum_summary_v1` (`detail: light`),
  soit un fichier WAV Float32 IEEE_FLOAT écrit sur disque (`detail: wav`). Le WAV transite
  base64 dans le canal WS webapp↔binaire ; le binaire le décode, l'écrit sous
  `$TMPDIR/faustcode-renders/<sha8>-<paramfp>.wav`, et substitue par un champ `path`
  dans la réponse MCP — la base64 n'est **jamais** dans le contexte de l'IA. Fichiers
  > 1 h supprimés au prochain démarrage du binaire. Le contenu est `librosa.load(path,
  sr=None)`-compatible et bit-stable (les rendus avec les mêmes args produisent le même
  fingerprint et le même fichier).
- **Convention des événements à `atMs === 0`** : un event de script à `atMs=0` est appliqué
  pendant `paramSetup` (avant `startRendering`) — il sert à exprimer l'état initial dans
  `script` pour la symétrie avec les events suivants. **Pour qu'une transition de bouton soit
  détectable par un DSP à déclenchement (front montant)**, schedulez la transition à
  `atMs > 0` (e.g. `atMs: 10`) avec le bouton initial à `0` dans `paramSetup`.
- **`render_audio: detail = "metrics"`** : retourne un `audio_metrics_v2` (0.6.0,
  remplace `audio_metrics_v1` de 0.5.0 — pas de rétro-compat, le v1 n'a vécu que 2 h).
  Le rendu est segmenté en **phases d'enveloppe** détectées par la courbe RMS :
  attack (10 % → 90 % du pic RMS), sustain (frames toujours au-dessus de 50 % du pic ;
  englobe le decay vers un sustainLevel ADSR), release (sustain → 10 % du pic).
  Sortie en 4 blocs :
  - **`envelope`** : `attackMs`, `peakDbFS`, `sustainStartMs`, `sustainEndMs`,
    `releaseMs`, `decaySlopeDbPerS` (régression linéaire en dB sur la release).
  - **`attack`** (FFT 512, ~21 ms @ 24 kHz) : `centroidHz`, `rolloff95Hz`, `flatness`,
    `spectralFluxDb` (distance L2 magnitude entre frames successives — élevé pour les
    attaques claquées, faible pour les attaques feutrées). Pas de f0/harmonics : trop
    court pour être fiable.
  - **`sustain`** (pipeline complet, n_fft=2048 STFT center=True comme librosa) :
    `f0Hz` avec correction sous-harmonique (DSP où H2 ou H3 dominent H1, brass/horn),
    `harmonicsDb[N]`, `hnrDb`, `roughnessDb` par bandes (5-20/20-50/50-100/100-200 Hz),
    `features` (`centroidHz`, `rolloff95Hz`, `flatness`) — bit-comparables avec
    `librosa.feature.spectral_*`. Cross-validé sur un signal 220+440+660 Hz :
    f0/harmonics/HNR/centroid/rolloff/flatness identiques à `horn_metrics.py`.
  - **`release`** : même shape que `attack`.

  **Signaux stationnaires** (pas de gate) : `attackMs`≈0, `releaseMs`≈0, sustain
  englobe tout le rendu. Les blocs attack/release sont émis avec `durationMs: 0`,
  pas d'erreur.

  **`metricsOptions`** expose les knobs : `fmin` / `fmax` (défaut 50-2000 Hz pour
  couvrir la majorité des sons musicaux ; passer `fmax: 400` pour mimer le défaut
  klaxon de `horn_metrics.py`), `nHarm`, `plateauCapS`, `roughnessBands`.
- **`render_audio` et l'accessibilité du `path`** : le fichier WAV est écrit sur le
  filesystem de l'**hôte du binaire** (`$TMPDIR/faustcode-renders/`). Pour **Claude Code**
  (modèle et binaire sur le même hôte), `librosa.load(path)` marche directement. Pour
  **Claude Desktop** (outils du modèle dans un container Anthropic disjoint de l'hôte),
  le `path` n'est pas atteignable depuis le sandbox et il faut que l'utilisateur upload
  manuellement le fichier dans la conversation (drag-and-drop) pour qu'il apparaisse
  sous `/mnt/user-data/uploads/`. La piste `AudioContent`/`EmbeddedResource` MCP standard
  a été tentée en 0.4.0 puis retirée en 0.4.1 : ces blocs ne sont pas hydratés par
  Claude Desktop (cf. `DEBUG.md` §8 pour les références doc Anthropic + ticket GitHub).
  La vraie fermeture de boucle pour Claude Desktop demande un pont côté infrastructure
  Anthropic, hors périmètre faustcode.

## Conventions

- "UI-only" : l'action concerne l'affichage / l'ergonomie côté humain ; un agent
  n'en a pas besoin pour atteindre le même but musical.
- "Hors scope" : exclusion délibérée du périmètre faustcode (cf. README, parties
  héritées du Docker faustservice qui ne s'appliquent plus).
- "Couvert par X" : l'effet musical / observable est identique, même si le
  geste humain et l'appel d'outil diffèrent.

## À refaire / maintenir

- À chaque ajout d'un tool MCP : compléter la colonne correspondante.
- À chaque ajout d'un contrôle UI dans la webapp : ajouter la ligne ici.
- Si un test révèle qu'une case marquée ✓ ne marche pas dans la pratique,
  rebasculer à ◐ ou ✗ et expliquer pourquoi.
