# DEBUG.md — pièges opérationnels et notes d'itération

Ce fichier regroupe les choses qu'on ne devine pas en lisant le code mais qui
font perdre du temps en debug, surtout quand on pilote faustcode via MCP +
Playwright, ou qu'on reproduit une session utilisateur côté local.

---

## 1. Permissions navigateur natives (MIDI, audio)

La Run view appelle `ensureMidiAccess()` (`webapp/views/run.js`) dès qu'elle
est montée. Sur un Chrome neuf, ça déclenche le **dialog natif** "Contrôler
et reprogrammer vos appareils MIDI bloqués ou autorisés" — qui vit en dehors
du DOM.

Conséquences :

- Playwright (Skill MCP) script à l'intérieur de la page → ne voit pas le
  dialog → `browser_handle_dialog` retourne `no modal state present`.
- Seul un humain (ou une option de lancement du contexte) peut le fermer.
- Une fois la permission accordée ou refusée pour l'origine, Chrome
  mémorise et ne redemande plus.

**Workaround propre** : lancer Playwright avec `context.grantPermissions(
['midi', 'midi-sysex'])` au boot. Mais c'est une option de **lancement du
contexte**, donc inaccessible mid-session via les outils Playwright-MCP. Si
on configure un launcher dédié, l'ajouter là.

Même histoire pour la microphone, le geolocation, etc. — anticiper avant de
les utiliser dans la webapp.

### Audio context : user-gesture obligatoire

Le navigateur bloque `AudioContext.resume()` tant qu'aucun **geste
utilisateur** n'a été enregistré dans l'onglet. En Playwright, un
`document.body.click()` suffit à débloquer le geste — penser à le faire
**avant** tout `run_audio:on`, sinon `startAudio` jette "Audio start blocked
by browser policy".

---

## 2. WebSocket : un seul onglet à la fois

`faustcode-mcp` n'autorise qu'**un** client WS à la fois (PR-5). Quand un
nouvel onglet se connecte, l'ancien reçoit le close-code privé **4001
("superseded-by-new-tab")** et le client cesse de retry (`ws-client.js`).

Conséquences pratiques :

- Si Yann a déjà faustcode ouvert dans Chrome et qu'on lance un Playwright
  sur la même URL, le tab Chrome de Yann perd la session WS sans warning
  visible. Toujours lui demander de fermer son onglet avant un test
  autonome.
- Inversement, si Yann ouvre un nouvel onglet faustcode pendant que
  Playwright tourne, c'est Playwright qui se fait virer.

---

## 3. Architecture audio : un seul runtime (depuis le fix du 2026-05-30)

Avant le fix : deux runtimes parallèles, `webapp/audio-engine.js` (piloté par
MCP) et `webapp/views/run.js` (piloté par l'humain). Symptômes : Claude
"réussissait" `set_run_param` mais le slider visible ne bougeait pas, le
spectre captuté par MCP n'avait aucun rapport avec ce que l'utilisateur
entendait.

Après le fix : `audio-engine.js` est supprimé. Les handlers MCP délèguent
à une surface `mcp*` exportée par `views/run.js`. Conséquence :

- Les handlers audio (`set_run_param`, `get_spectrum`, `run_audio`, MIDI,
  trigger_button…) **exigent que la Run view soit montée**.
- L'auto-`set_view:run` est branché dans `ensureRunViewMounted()`
  (`handlers.js`). Mais voir §4 : la propagation passe par `pollState`.

---

## 4. Pourquoi `set_view` MCP peut prendre ~1.5 s à monter la Run view

La séquence réelle après `set_view("run")` côté MCP :

1. `handlers.js` → `shimSetActiveView('run')` met à jour `sessions.js` et
   bump `updatedAt` côté `api-shim.js`.
2. `app.js` poll `/api/state` **toutes les 1500 ms** (`setInterval(pollState,
   1500)`).
3. `pollState` détecte le changement, appelle `switchView('run',
   {source:'remote'})`, qui monte la Run view → `views/run.js`'s `render()`
   s'exécute → `dspNode` et `faustUIInstance` sont créés.

Tant que le `render()` n'a pas tourné, `mcpIsMounted()` reste false. C'est
pour ça que `ensureRunViewMounted()` poll jusqu'à 3.5 s.

**Piège associé** : `handlers.js` doit utiliser `shimSetActiveSha` et
`shimSetActiveView` (depuis `api-shim.js`) au lieu de `setActiveSha1` et
`setActiveView` (de `sessions.js`). Les premières bumpent `updatedAt`, les
secondes non — et sans bump, `pollState` ignore. Bug subtil qui se traduit
par "app.js ne voit jamais ma session". Vérifié 2026-05-30.

### `localViewStickyUntil`

`app.js` maintient une fenêtre de 8 s pendant laquelle les changements de
view **locaux** (déclenchés par `switchView(..., {source: 'local'})`) sont
authoritatifs et écrasent ce que retourne `/api/state`. Si on enchaîne
showcase → `switchView('dsp')` local → MCP `set_view('run')`, la run view
peut ne pas monter avant que ces 8 s soient écoulées. Souvent invisible en
pratique (au boot, Yann clique ENTER, qui dispose du showcase et laisse le
sticky expirer).

---

## 5. Local dev

```sh
python3 scripts/serve.py 8090
# puis ouvrir http://localhost:8090/webapp/?mcp=ws://localhost:7777/ws
```

- Le suffixe `?mcp=ws://localhost:7777/ws` est ce qui déclenche
  l'auto-connect WS (cf. `boot.js`). Sans lui, la page boote mais ne dial
  jamais le WS et les tools MCP renvoient `no_webapp`.
- `contract.js` essaie `./tools.json` puis `../tools.json` — en local le
  premier 404 et c'est le second qui sert. C'est normal de voir un 404
  `tools.json` dans la console au boot local.
- Le bouton **ENTER** de l'audio-gate :
  1. déclenche le user-gesture (résout l'autoplay browser policy),
  2. dispose le showcase preview,
  3. `loadEmptySession({resetView:true})` → état vide, prêt pour un
     `submit` MCP.
  Sauter cette étape laisse le state coincé en showcase et `pollState`
  n'embraye jamais correctement sur les `submit` MCP qui suivent.

---

## 6. Logs côté MCP (binaire Go)

`faustcode-mcp` log sur stderr. Pour voir ce qu'il valide / refuse :

```sh
~/bin/faustcode-mcp 2>&1 | tee /tmp/faustcode-mcp.log
```

Les warnings d'intérêt :
- `input schema validation failed` — les `args` envoyés à un tool ne
  matchent pas son `inputSchema` du contrat.
- `output schema validation failed` — la webapp a répondu hors schema.
  Symptôme courant : un handler a oublié un champ requis du `outputSchema`.

---

## 7. Vérifier l'état réel depuis Playwright

Patterns utiles à garder sous la main :

```js
// Vue MCP + sessions + active sha/view
const sess = await import('./sessions.js');
const app  = await import('./app/state.js');
console.log({
  activeSha1: sess.getActiveSha1(),
  activeView: sess.getActiveView(),
  appCurrentSha: app.state.currentSha,
  appCurrentView: app.state.currentView,
  sessions: sess.listSessions().map(s => s.sha1.slice(0,8)),
});

// État du runtime Run view (la nouvelle vérité unique pour l'audio)
const run = await import('./views/run.js');
console.log({
  mounted: run.mcpIsMounted(),
  audio:   run.mcpIsAudioRunning(),
  params:  run.mcpGetParams(),
});

// Spectre actuel
const sp = run.mcpGetLatestSpectrum();
console.log({ centroid: sp.features.centroidHz, peak: sp.peaks[0] });
```

Ces appels sont disponibles dès que `import('./views/run.js')` a été fait
une fois dans la page — pas besoin de WS pour interroger.
