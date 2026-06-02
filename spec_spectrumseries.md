# Ajout de `render_audio detail=spectrumSeries` à faustcode

**Destinataire :** Claude Code.
**But :** donner à l'IA cliente un feedback d'**évolution spectrale** (trajectoire
de spectres datés), pour qu'elle compare elle-même le rendu de son DSP à la
description du son de référence qu'elle porte déjà — **sans jamais récupérer le
WAV**. Pas de comparaison ni de scoring côté faustcode : faustcode *produit* la
trajectoire, l'IA *compare*.
**Origine :** session expérimentale (corne de brume), validée par tests ABX à
l'oreille et par un banc d'essai sur signal synthétique de vérité connue.

---

## 1. Ce qui existe déjà

- `$defs/SpectrumSeries` = `[{ tMs, summary: SpectrumSummary }]` — **le type de
  retour existe déjà** mais n'est produit par aucun mode de `render_audio`.
- `$defs/SpectrumSummary` (`spectrum_summary_v1`) = un spectre compact :
  `bandsDbQ[]`, `peaks[{hz,dbQ,q}]`, `features{...}`, `frame{floorDb,...}`,
  `audioQuality`, `delta`.
- `render_audio.detail` ∈ `{light, metrics, wav}`. `light` produit déjà **un**
  `SpectrumSummary` (tap unique vers 80 % du rendu).

**L'ajout est donc minimal :** un nouveau `detail=spectrumSeries` qui produit
plusieurs `SpectrumSummary` datés au lieu d'un seul. La brique « un spectre »
est là ; il manque la **dimension temporelle** + deux corrections de contenu (§3).

---

## 2. Nouveau mode `detail=spectrumSeries`

Ajouter la valeur `spectrumSeries` à l'enum `detail` de `render_audio`. Retour :
un `SpectrumSeries` (type déjà défini). Sémantique : analyser tout le buffer
rendu en trames, puis **n'émettre que les spectres aux instants où le contenu
spectral change** (échantillonnage adaptatif, §4) — pas une grille régulière.

Cohérent avec le découpage en phases déjà documenté (attack/sustain/release) :
la série couvre tout le rendu ; sa densité de points sera spontanément forte
dans l'attaque et faible dans le sustain stable.

---

## 3. Contenu d'un `SpectrumSummary` : deux corrections

### 3.1 `bandsDbQ` doit porter le BRUIT seul, pas le spectre total

C'est le point clé pour la **lisibilité par l'IA**. Si `bandsDbQ` mélange
partiels et bruit, l'IA ne peut pas distinguer « harmonique trop faible » de
« bruit de bande trop fort » — or ce sont deux corrections Faust opposées.

Convention à garantir :
- `peaks[]` = les **partiels** (raies tonales), `dbQ` relatif au plus fort.
- `bandsDbQ[]` = le **bruit résiduel** par bande (ce qui reste hors des raies).

8 bandes ERB de 50 à 8000 Hz (4 suffisent perceptivement ; 8 par sécurité, pour
garder de la finesse sur les instants bruités type attaque).

### 3.2 CORRECTIF de l'estimation du bruit / `interHarmonicFloorDb`

**Bug mesuré.** L'actuel `interHarmonicFloorDb` échantillonne le niveau dans
`k·f0 + 30..50 Hz`. Une fenêtre fixe après chaque harmonique capte les **pieds
de lobes** des partiels forts (énergie tonale, pas du bruit) et **surestime
massivement** le bruit dans les bandes contenant des partiels forts (le grave).

**Preuve sur signal connu** (à intégrer comme test de non-régression) :
f0 = 130.8 Hz, 5 partiels à 0/−6/−12/−18/−24 dB, + bruit blanc à −40 dB RMS sous
le fondamental. Vérité-terrain du bruit par bande ERB (dB rel f0) :
`-62.1, -60.3, -58.5, -56.6, -54.8, -52.9, -51.1, -49.3`.
Estimateur fautif (résiduel global / fenêtre fixe) → écart à la vérité :
`+32.7, +24.6, +12.0, -0.1, -1.4, -0.4, -1.2, +0.8`. **Jusqu'à +33 dB** dans le
grave (là où sont les partiels forts), correct ailleurs.

**Correction** — bruit d'une bande = densité spectrale moyenne des bins **hors
raies**, extrapolée à la largeur de bande. Règles (spectre `X`, fréquences `fr`,
`Wsum = Σ hann`) :

```
gardeBande     := 0.3 · f0           # PROPORTIONNEL à f0 (≈40 Hz à f0=131 ; PAS fixe)
horm(f)        := ∃ k : |f − k·f0| < gardeBande
free(b)        := { i : fr[i] ∈ bande_b ∧ ¬horm(fr[i]) }
densité(b)     := mean_{i ∈ free(b)} |X[i]|²
bruit_rms(b)   := sqrt( 2 · densité(b) · |bande_b| ) / Wsum
```

Écart après correction : `+7.3, +3.8, +0.7, +2.1, +1.3, +2.8, +1.7, +3.1`. De
**+33 dB à +1–3 dB** sur la majorité des bandes. Biais résiduel des 2 bandes
graves (+4–7 dB) : intrinsèque (à f0=131 Hz, peu de bins libres entre H1/H2/H3
après garde-bande) ; petit, sur des bandes déjà à −60 dB, sans impact perceptif
notable — à documenter comme limite connue.

**Impact :** `interHarmonicFloorDb` et `hnrDb` héritent de la correction (un HNR
calculé sur un bruit surestimé est trop bas). Le garde-bande doit devenir
**proportionnel à f0** partout où l'on sépare harmonique / non-harmonique.

### 3.3 Extraction des partiels — par soustraction, pas par mise à zéro

Pour `peaks[]`, extraire chaque partiel par **projection aux moindres carrés**
(cos/sin à chaque f_k, soustraction de la reconstruction), jamais en mettant à
zéro des bins autour de la raie. Validé sur signal connu : les 5 partiels
ressortent à ±0.3 dB, sans biais sur l'aigu. Seuil de conservation :
**−40 dB** (rel. au plus fort) sous 3 kHz, **−50 dB** au-dessus — garde les
harmoniques aigus réels (brillance), jette les pseudo-partiels (bruit de mesure).

---

## 4. Échantillonnage temporel adaptatif de la série

La signature « synthétique » est **temporelle** (spectre figé). La série ne doit
donc pas être à pas régulier : émettre un spectre quand le contenu **change**.

```
profil(trame) := bandsDbQ + peaks rebinned en 8 ERB, normalisé au max, clampé [−45,0] dB
émettre trame 0 ; ref := profil(0)
pour i suivant :  si RMS(profil(i) − ref) > SEUIL : émettre i ; ref := profil(i)
émettre la dernière trame
SEUIL := 3 dB
```

Émergent (souhaitable) : ~10–20 ms entre points dans l'attaque, 0.5–1 s dans le
sustain stable. Ordre de grandeur : un son de 22 s → ~90 points. Le `tMs` de
chaque point est déjà prévu par `SpectrumSeries`.

Paramètres exposables (avec ces défauts) : fenêtre d'analyse `N` (déf. 8192 @
48 kHz pour un son lent — voir limite ci-dessous), `SEUIL` de variation (déf. 3 dB),
nombre de bandes (déf. 8).

**Limite connue — l'attaque.** Une cascade harmonique (aigus en retard, étalés
sur ~500 ms) est sous-résolue par une fenêtre de 170 ms. Évolution possible :
analyse multi-résolution (fenêtre longue pour partiels, courte pour
l'enveloppe/bruit). Non bloquant : sustain et corps sont fidèles.

---

## 5. Critère de validation : la trajectoire rend le WAV inutile

Le but est que Claude Desktop n'ait **plus jamais** besoin de
`render_audio detail=wav` (dont le fichier, écrit sur l'hôte de Claude Code,
n'est de toute façon pas lisible par Claude Desktop sans upload manuel — friction
majeure documentée dans DEBUG.md).

**Test de suffisance** (hérité de la session) : à partir de la seule
`SpectrumSeries`, on doit pouvoir resynthétiser un son perceptivement proche.
Si oui, la trajectoire contient l'information pertinente. Deux métriques de
contrôle, orthogonales, résument les écueils :
- **HNR** (énergie ±15 Hz des k·f0 / hors raies) : trop bas ⇒ trop de bruit
  (souffle). Cible : proche de la source.
- **Contraste pic/creux HF** (3.7–6 kHz) : trop bas ⇒ aigus « bruitisés »
  (ternissure).
Une bonne reproduction a les deux hauts. (Détecteurs de régression, pas cible
ultime : l'oreille humaine reste juge — la plus fidèle spectralement n'est pas
toujours la préférée.)

Tests recommandés : (1) unitaire sur le signal connu du §3.2 ; (2) bout-en-bout
(série → resynthèse → ré-analyse, partiels et bruit préservés) ; (3) une session
Claude Desktop qui reproduit un son en ne lisant **que** des `spectrumSeries`,
zéro WAV déposé.

---

## 6. Patch du ONBOARDING-GUIDE (face « consommateur »)

À insérer dans `ONBOARDING-GUIDE.md`. L'IA cliente doit apprendre à **exprimer
sa référence dans le même format** puis à comparer, sans audio.

> ### Comparing without the audio: `detail=spectrumSeries`
>
> You cannot hear the render — but you do not need the WAV. Beyond the phased
> `metrics`, `render_audio detail=spectrumSeries` returns a **time series of
> spectra** (`[{tMs, summary}]`): the spectral *trajectory* of the render.
>
> **Encode your target the same way.** From the reference sound, write it as a
> trajectory in the *same vocabulary*: an ADSR envelope plus a handful of dated
> spectra (attack, body, sustain, tail), each = partials (`peaks`, dB) + noise
> (`bandsDbQ`, 8 ERB bands). This is your target, directly comparable to what
> faustcode returns.
>
> **Compare trajectory vs target on three independent axes:**
>
> | Axis | Read | If render deviates |
> | :--- | :--- | :--- |
> | **Partials** (`peaks`) | harmonic dB shape | highs too low → *dull*: lift upper harmonics (waveshaping, bright-component mix), don't touch noise. Too high → *harsh*. |
> | **Noise** (`bandsDbQ`, noise-only) | per-band noise level | bands too high → *breathy/hissy*: lower the noise layer in those bands. Near-silent + `hnrDb` very high → *sterile*: add broadband noise (acoustic floor ≈ −80…−40 dB). |
> | **Trajectory** (across `tMs`, `*Std`) | how the spectrum moves | `centroidHzStd ≈ 0` in sustain while the target moves → *frozen*: add motion (slow detune, micro-vibrato, per-partial AM). Highs arriving all at once at onset → *plastered attack*: stagger per-rank rise times (harmonic cascade). |
>
> **Hard-won invariants** (each validated by blind A/B):
> - Noise is constitutive, not decoration — a partials-only render sounds wrong;
>   a very high `hnrDb` is a red flag, not a win.
> - A tonal partial below ~5 kHz must stay a partial — folding it into a noise
>   band sounds *dull and veiled* even at −35/−45 dB.
> - Faint high harmonics matter collectively (brilliance); dropping them dulls,
>   smoothing them into a spectral envelope fails (the high tail is *formantic*,
>   not a slope).
> - Separate partials from noise by subtraction, never by zeroing FFT bins.
> - Two orthogonal tells: low HNR = too much noise (hiss); low HF peak/valley
>   contrast = bruitised highs (dullness). Good renders score high on both.
>
> **Loop:** read trajectory → find the largest deviation on ONE axis → change
> ONE Faust parameter in ONE phase → re-render → re-compare. The WAV fallback
> (`detail=wav` + manual upload) becomes unnecessary once you drive on the
> trajectory.

---

## 7. Récapitulatif d'implémentation

1. **`detail=spectrumSeries`** dans `render_audio` → retourne `SpectrumSeries`.
2. Dans chaque `SpectrumSummary` : `peaks` = partiels (moindres carrés, seuil
   −40/−50 dB) ; `bandsDbQ` = **bruit seul**, 8 ERB.
3. **Corriger l'estimateur de bruit** (§3.2) — densité hors-raies, garde-bande
   `0.3·f0` ; propage à `interHarmonicFloorDb` et `hnrDb`. Test de non-régression
   = le signal synthétique du §3.2.
4. **Échantillonnage adaptatif** (§4), seuil 3 dB, défauts exposés.
5. **Patch ONBOARDING-GUIDE** (§6).
6. Objectif de succès : une session Claude Desktop reproduit un son en ne lisant
   que des `spectrumSeries`, sans aucun WAV.
