# faustcode

A browser-native workbench for the [Faust](https://faust.grame.fr) DSP
language. Edit Faust source with live syntax highlighting, compile in
the page via `libfaust-wasm`, watch the run-time UI, oscilloscope and
spectrum analyser update at every save, and optionally drive the
workflow from an MCP client (Claude Desktop, Claude Code, …) through
a small local Go bridge.

No backend. No Docker. The webapp runs entirely client-side ; only the
optional MCP bridge runs locally on your machine.

## Try it

The latest build is live at **<https://orlarey.github.io/faustcode/>**.

For local development :

```sh
./scripts/serve.py            # serves the repo on http://localhost:8080
# then open http://localhost:8080/webapp/
```

The dev server sends `Cache-Control: no-store` on every response so you
don't have to fight Chrome's ES module cache while iterating.

## Quick tour

- Drop a `.dsp` file anywhere on the page, or paste Faust code into the
  empty-state pane.
- The header dropdown switches between five views :
  - **dsp** — live CodeMirror editor (syntax-highlighted Faust, `Cmd/Ctrl-S`
    to compile, click a line number to select that whole line, drag across
    line numbers for multi-line selections)
  - **svg** — block diagram, clickable from the outer `process` down to
    every nested expression
  - **run** — audio engine with the classic Faust UI on the left, an
    orbit-style knob layout on the right, polyphony / MIDI selectors,
    Rec, and an oscilloscope + spectrum analyser at the bottom

  (The **signals** and **tasks** views, DOT graphs of the compiled program,
  were removed in 0.14.0: of little use to most users, and libfaust 2.88 to
  2.90 cannot draw the signals graph of recursive programs.)
- **✎** in the header toggles a floating CodeMirror overlay : drag the
  title bar to move, drag the bottom-right corner to resize, position and
  size persist across reloads. The overlay mirrors the dsp-view editor
  keystroke by keystroke (and vice-versa) when both are visible, so you
  can iterate on the code while watching the Run view update underneath
  at every `Cmd/Ctrl-S`.
- **Files** (0.16.0, `spec_files_store.md`) : the **File** menu has New
  file, Open… (`Cmd/Ctrl-O`), All files… (search, trash), the recent
  files, Save (`Cmd/Ctrl-S`), Save as… (`Shift-Cmd/Ctrl-S`), Rename… and
  Move to trash. A file is a name and its versions : each save adds one,
  the header shows `Wahoo.dsp ● · v3/5` (● : unsaved changes) and ◀ ▶
  step through the versions. In Chromium, a file opened from the disk is
  written back there by Save. Submitting a code under the name of a file
  (drop, MCP `submit`) makes a new version of it.
- **Stores** (0.17.0, `spec_files_store.md`) : GitHub repositories of
  Faust modules and scenes, the same as in faustmodular (same browser,
  same list : a store followed in one is followed in the other). File ▸
  Stores… follows one ; File ▸ Open from a store lists its modules, and
  one opens as a file linked to the store. A link opens any `.dsp` of
  GitHub : `?file=<its address on GitHub>` (or `?store=owner/repo&file=
  <path>&ref=<commit>`) ; `?store=owner/repo` shows the modules of a
  store. Share offers the link of the store (short, at the commit read)
  for a module unchanged since it was opened.
- **Publishing** (0.18.0) : a click on the *read* badge of a store (File ▸
  Stores…) asks for a token of GitHub (fine-grained, this repository only,
  Contents read and write), checked before it is kept ; faustmodular uses
  it too. Share ▸ Publish publishes the current version of the open
  file as a module of the store, in one commit, the index made again : a
  new module, or a new version of the module it was opened from. It warns
  when someone else published since, offers another name when the path
  holds another module, and refuses a code that does not compile, a
  `.lib`, or a code that imports a `.lib` of faustcode. The link to share
  it, at the commit published, is copied. `⇡` in the header : the file
  changed since the store.
- **Share** (0.22.0, `spec_partage.md`) : everything that leaves faustcode
  goes through the **Share** button, by destination, for the saved version
  of the open file (unsaved changes are said, not shared), at the voices
  chosen once in the head of the panel :
  - **Audience** : a link and its QR code (Projection, Copy link), to play
    the module or to edit its code ; the link of the store for a module
    published and unchanged. *Play* opens `play.html` (0.23.0), never the
    editor : it builds the app of the module on the phone (libfaust, a few
    seconds the first time), installs it at `apps/<name>/` and opens it,
    ready to install ; the same code at the same voices opens at once the
    second time (the fingerprint in its manifest). Old `?code=…&view=run`
    links still open the run view ;
  - **Apps** : install as an app on this computer ; open in faustmodular
    (the faustmodular button of the header does it too) ;
  - **Files** : `.dsp`, the diagrams, the math documentation, the PWA ;
  - **Publish** : to a store, the module ; or **as an app** (0.24.0) :
    the PWA compiled at the voices of the panel, committed with a
    `.nojekyll` to `apps/<name>/` of the store, and served by GitHub Pages
    at `https://<owner>.github.io/<store>/apps/<name>/`. Enable GitHub
    Pages on the store once (Settings ▸ Pages ▸ Deploy from a branch ▸
    `main` ▸ `/ (root)` ; the repository public) ; faustcode waits for
    the deployment (30 s to 1 min) by reading the fingerprint of the
    manifest served, then Audience offers this short link : its QR code
    opens the app at once, without faustcode. The index of the store
    ignores `apps/`. Installed apps update after being closed and opened
    again (the service worker of faustwasm does not `skipWaiting`).

  File only writes : new, open, save, versions, stores to open from. A
  `.lib`, or a code that does not compile, greys what does not apply, and
  says why.
- **Math documentation** (0.19.0) : Share ▸ Files ▸ `<name>-mdoc.zip`
  (English, Français, Deutsch or Italiano) downloads what
  `faust -mdoc -mdlang <lang>` makes for the saved version : `tex/<name>.tex` (the equations of the signals, the controls,
  the block diagram, the listings), `svg/`, `src/` (the sources, the
  libraries and the `.lib` files of faustcode included). The documentator
  of the libfaust of the page does it ; `webapp/mathdoc.js` gives it its
  files (`webapp/vendor/faust-mathdoc/`), escapes the texts Faust copies
  raw into the LaTeX (labels, units, metadata : a `&` stops pdflatex, a
  `%` drops the end of the line, a `_` prints a dot), gives every
  character beyond ASCII to `listings` (which stops on the `π`, `μ`, `≤`
  of the comments of the libraries) and to `inputenc` (accents, Greek,
  mathematics ; emoji and the like are printed as `[U+1F3B5]`), and adds
  a PNG at 300 dpi of each diagram the document includes, so `cd tex && pdflatex -output-directory=../pdf <name>.tex`
  (twice) makes the PDF ; `README.txt` in the archive tells the rest.
  Write `<mdoc>…</mdoc>` in the code (not in a comment) to write the
  document yourself, with `<equation>`, `<diagram>`, `<metadata>`,
  `<notice/>` and `<listing/>` ; without it, Faust makes a default one.
  The document lists the program and the `.lib` files of faustcode, not
  the libraries of Faust (140 pages for `stdfaust.lib` ; they stay in
  `src/`) : `<listing dependencies="true"/>` in a `<mdoc>` lists them too.
- **PWA** (0.20.0) : Share ▸ Files ▸ `<name>-pwa.zip`, what
  `faust2wasm -pwa` of faustwasm makes, in the page : the saved version,
  compiled as the run view compiles it (mono, or poly at the voices of the
  panel, with the `effect` of the code), and the templates of faustwasm
  0.20.1 (`webapp/vendor/faust-pwa/`). Serve the folder by HTTP
  (`python3 -m http.server`) ; in HTTPS it installs and runs offline.
  Share ▸ Files ▸ `<name>-svg.zip` : every diagram.
- **Apps** (0.21.0) : Share ▸ Apps ▸ Install installs the program at
  once, at the voices of the panel, as an app of faustcode's origin, at
  `apps/<name>/` : its window opens with an Install button (Chrome, Edge ;
  Safari : File ▸ Add to Dock, Share ▸ Add to Home Screen). The files live
  in the cache `faustcode-apps`, served by `webapp/apps/sw.js` (scope
  `apps/` only : faustcode's own pages do not go through it), so the app
  runs offline ; installing the same name again updates it. Clearing the
  data of the site removes the apps.
- Sessions hydrate from the browser's Origin Private File System on
  every load, so closing the tab doesn't lose your patches.

## Drive faustcode from an MCP client

The contract exposes **34 tools** (cf. `tools.json`) covering session
management, audio transport, run-parameter manipulation, MIDI events,
spectrum / audio-quality capture, error retrieval and Faust library
documentation lookup. A local Go bridge (`faustcode-mcp`) speaks MCP
over stdio and brokers every tool call to the browser tab over
`ws://127.0.0.1:7777/ws`.

### 1. Install the bridge

Download the prebuilt binary for your platform from
**<https://github.com/orlarey/faustcode/releases/latest>** —
`darwin-arm64`, `darwin-amd64`, `linux-amd64`, `linux-arm64` or
`windows-amd64.exe`. The webapp's "Setup MCP" panel (open it from the
**MCP** pill in the header) detects your platform and offers the
matching link.

On macOS the binary is unsigned ; strip Gatekeeper's quarantine flag
after the first download :

```sh
chmod +x ./faustcode-mcp-darwin-arm64
xattr -d com.apple.quarantine ./faustcode-mcp-darwin-arm64
mv ./faustcode-mcp-darwin-arm64 ~/bin/faustcode-mcp    # or anywhere on PATH
```

(On Linux, `chmod +x` is enough. On Windows, double-click — Defender
SmartScreen will flag the unsigned `.exe` once ; click "More info → Run
anyway".)

### 2. Tell your MCP client about it

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`)
or any MCP-aware tool that consumes the standard config :

```json
{
  "mcpServers": {
    "faustcode": {
      "command": "/Users/<you>/bin/faustcode-mcp"
    }
  }
}
```

**Claude Code** (one-liner) :

```sh
claude mcp add faustcode /Users/<you>/bin/faustcode-mcp
claude mcp list      # verify it shows ✓ Connected
```

### 3. Open the webapp

Make sure <https://orlarey.github.io/faustcode/> is open in a browser
tab while you talk to your MCP client. The bridge needs a webapp tab on
the other end to actually execute tool calls — without it, calls return
a friendly `no_webapp` error that tells the assistant what to do.

Only **one** tab can hold the bridge at a time. A second tab opening
sends the first one a `4001 superseded-by-new-tab` close code ; the MCP
pill of the displaced tab goes red and stops reconnecting until you
click **Connect** in the side drawer to take the seat back.

### URL parameters

The webapp recognises these query strings :

- `?mcp=ws://127.0.0.1:7777/ws` — auto-connect to the bridge without
  needing the user to click Connect. Handy for automated browsers,
  embedded contexts or persistent setups.
- `?token=<shared-secret>` — sent in the `WsReady.token` field of the
  handshake (SC-4). The bridge must have been launched with the same
  `--token` flag, otherwise the connection is rejected.
- `?code=…&name=…&view=…&poly=…` — open a shared DSP (cf.
  `spec_share_url.md`).
- `?link=modular` — this window edits the modules of the
  [faustmodular](https://github.com/orlarey/faustmodular) (formerly FaustPlayground)
  page that opened it (see below).
- `?faustmodular=<url>` — the faustmodular that the faustmodular button
  opens (default `https://orlarey.github.io/faustmodular/` ; a local one,
  tests).

## Edit faustmodular modules

The pencil of a faustmodular module opens faustcode in a window
reused for all the modules (`?link=modular`). The module's code
becomes a session, shown in the dsp view once ENTER is clicked. Each
save of that session that compiles (`Cmd/Ctrl-S` in the dsp view or the
floating editor, or an MCP `submit` while it is active) is sent back to
the playground, which recompiles the module in place : the sound goes
on, the slider values and the connections are kept. A code with errors
stays in faustcode, with its errors ; the module keeps playing its last
valid version.

The other way, the **faustmodular** button of the header opens the
session in faustmodular, as a module of its open document : faustmodular
is opened if needed (`?link=faustcode`, a window reused), or the
faustmodular that opened faustcode is used. The session is then linked
to the module : each save that compiles updates it, as above, and the
button sends the new code of a linked session to its module instead of
adding another one.

The two pages talk with `postMessage` (they may have different
origins) ; faustcode only accepts messages from the faustmodular window
(the one that opened it, or the one it opened), and faustmodular only
takes code from the official faustcode, or a local one. Protocol and
behaviour : `spec_playground_link.md` and `webapp/playground-link.js`.

## What's inside

```
webapp/        the browser app (HTML, ES modules, CodeMirror 6 bundle,
               Faust UI vendor, libfaust-wasm runtime)
mcp/           the Go MCP bridge ; speaks MCP over stdio, brokers
               tool calls to the browser tab over WebSocket
tools.json     the shared contract (34 tools, JSON Schemas inlined per
               tool so MCP clients can validate without resolving $defs)
SPECIFICATION.md     architecture and protocol document
webapp/vendor/fauststore/   the library of the stores, a copy built by
                     faustmodular (scripts/update-fauststore.sh)
spec_files_store.md  files, File menu and stores
scripts/serve.py     a no-cache dev server
.github/workflows/   Pages publish + cross-build releases
```

### High-level architecture

```
┌─────────────────────────┐    stdio JSON-RPC    ┌─────────────────┐
│ MCP client              │ ◄───────────────────►│ faustcode-mcp   │
│ (Claude Desktop, …)     │                      │ (Go bridge)     │
└─────────────────────────┘                      └────────┬────────┘
                                                          │ WS 7777
                                                          ▼
                                              ┌──────────────────────┐
                                              │ browser tab          │
                                              │ (faustcode webapp)   │
                                              │                      │
                                              │ • libfaust-wasm      │
                                              │ • WebAudio engine    │
                                              │ • spectrum / OPFS    │
                                              └──────────────────────┘
```

The webapp is just static files served from GitHub Pages (or the local
dev server). All compilation and audio happen in-page via WebAssembly.
The bridge is the only host-side process and only listens on `127.0.0.1`.

## Building from source

### MCP bridge

```sh
cd mcp
make build           # outputs ./faustcode-mcp
make test            # vet + go test ./...
make probe           # round-trip MCP↔bridge↔fake-webapp e2e check
```

Cross-platform release builds are produced by the `release.yml`
workflow on every `v*.*.*` tag and uploaded to GitHub Releases ; the
webapp's "Setup MCP" panel always points to `releases/latest` so users
get the newest binary regardless of how often you cut tags.

### CodeMirror bundle

```sh
./webapp/vendor/codemirror/build-cm6.sh
```

Runs `npx esbuild` inside a transient build directory ; no
`node_modules` is committed. The resulting `cm6.js` (~290 KB) lives
in `webapp/vendor/codemirror/`.

### Faust compiler and libraries

faustcode and faustmodular embed the **same** libfaust and Faust libraries (`stdfaust.lib`...): a module
edited here must compile and sound the same there. Both use `@grame/faustwasm` 0.20.1 (libfaust 2.90.19),
copied here from the npm package:

```sh
npm pack @grame/faustwasm@0.20.1 && tar xzf grame-faustwasm-0.20.1.tgz
cp package/dist/esm/index.js webapp/faustwasm/index.js
cp package/dist/esm/index.js webapp/vendor/faustwasm/index.js
cp package/libfaust-wasm/libfaust-wasm.{js,data,wasm} webapp/libfaust-wasm/
node scripts/build-doc-index.mjs
```

The last command rebuilds `webapp/faust-doc-index.json`, the documentation of the libraries used by the
completion and the library tools (`search_faust_lib`, `get_faust_symbol`, `list_faust_module`...), from
the `.lib` files of the embedded libfaust; `webapp/doc-index.test.mjs` fails when it is out of date
(`node scripts/build-doc-index.mjs --check` tells the same).

Update both applications together. When faustcode is opened by faustmodular, its ready message carries
its version of libfaust, and faustmodular warns if it differs from its own. (Known issue of libfaust
2.88.0 to 2.90.19, reproduced with `process = _ : + ~ *(0.5);`: `-sg` fails on an assertion in
`sigtyperules.cpp:209` for any recursive program. faustcode no longer uses `-sg`.)

## Troubleshooting

- **macOS : `killed: 9`** — Gatekeeper rejected the binary, usually
  because `com.apple.quarantine` is still attached. Re-run
  `xattr -d com.apple.quarantine ./faustcode-mcp-darwin-arm64`.
- **macOS : binary works once, then `killed: 9` after replacing the
  file in place** — AMFI caches the code signature per path. Either
  `mv newfile oldpath` or `rm oldpath && cp newfile oldpath` to force
  a new inode.
- **MCP pill keeps cycling between green and red** — two tabs are
  fighting for the bridge. Close the spare ones, then click **Connect**
  in the drawer.
- **MCP pill stays grey ("idle") with the webapp open** — the auto-
  connect only fires when `?mcp=…` is in the URL or a saved WS URL
  exists in OPFS. Click **MCP** → **Connect** once.
- **Audio is locked** — visit the **run** view once and click anywhere
  in it. WebAudio refuses to start without a user gesture per tab.

## Licence

MIT (see `LICENSE`).
