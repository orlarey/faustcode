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
    orbit-style knob layout on the right, polyphony / MIDI / download
    selectors, and an oscilloscope + spectrum analyser at the bottom
  - **signals** / **tasks** — DOT representations of the compiled graphs
- **✎** in the header toggles a floating CodeMirror overlay : drag the
  title bar to move, drag the bottom-right corner to resize, position and
  size persist across reloads. The overlay mirrors the dsp-view editor
  keystroke by keystroke (and vice-versa) when both are visible, so you
  can iterate on the code while watching the Run view update underneath
  at every `Cmd/Ctrl-S`.
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

The webapp recognises two query strings :

- `?mcp=ws://127.0.0.1:7777/ws` — auto-connect to the bridge without
  needing the user to click Connect. Handy for automated browsers,
  embedded contexts or persistent setups.
- `?token=<shared-secret>` — sent in the `WsReady.token` field of the
  handshake (SC-4). The bridge must have been launched with the same
  `--token` flag, otherwise the connection is rejected.

## What's inside

```
webapp/        the browser app (HTML, ES modules, CodeMirror 6 bundle,
               Faust UI vendor, libfaust-wasm runtime)
mcp/           the Go MCP bridge ; speaks MCP over stdio, brokers
               tool calls to the browser tab over WebSocket
tools.json     the shared contract (34 tools, JSON Schemas inlined per
               tool so MCP clients can validate without resolving $defs)
SPECIFICATION.md     architecture and protocol document
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
