# faustcode

A browser-native workbench for the [Faust](https://faust.grame.fr) DSP
language. Edit Faust source with live syntax highlighting, compile in
the page via `libfaust-wasm`, watch the run-time UI, oscilloscope and
spectrum analyser update at every save, and optionally drive the
workflow from an MCP client (Claude Desktop, …) through a small
local Go bridge.

No backend. No Docker. The webapp runs entirely client-side ; only the
optional MCP bridge runs locally on your machine.

## Try it

A public deployment lives at GitHub Pages (TODO once the page is
published). For local development :

```sh
./scripts/serve.py            # serves the repo on http://localhost:8080
# then open http://localhost:8080/webapp/
```

## What's inside

```
webapp/        the browser app (HTML, modules, CodeMirror bundle,
               Faust UI vendor, libfaust-wasm runtime)
mcp/           the Go MCP bridge ; speaks MCP over stdio, brokers
               tool calls to the browser tab over WebSocket
tools.json     the shared contract (34 tools : submit, set_session,
               run_audio, get_spectrum, set_run_param, …)
SPECIFICATION.md     the architecture document
scripts/serve.py     a no-cache dev server
```

## Key features

- **Live CodeMirror editor** : Faust syntax highlighting (`faust-lang.js`),
  oneDark theme, history, bracket matching, line-number gutter
  click/drag to select whole lines.
- **Floating overlay editor** : opens above any view (Run, SVG, Signals,
  Tasks, C++) via the ✎ icon ; drag the title bar to move, drag the
  bottom-right corner to resize. Position and size persist.
- **Live mirror sync** : when multiple editors are visible (the DSP view
  + the floating overlay), every keystroke mirrors live ; submitting
  from any of them creates a new session and clears dirty everywhere.
- **OPFS persistence** : sessions hydrate from `Origin Private File
  System` across page reloads.
- **MCP pill** : single button in the header reflects MCP state via
  colour (grey idle, amber connecting/reconnecting, green connected,
  red error). Pulses on every incoming request. Clicking it opens a
  side drawer with Connect / Disconnect, WS URL override, the
  4-step Setup MCP onboarding and the activity log.
- **Run view** : Faust UI in classic split + OrbitUI knobs, polyphony
  switching, MIDI input picker, oscilloscope with waveform / spectrum
  views (trigger, slope, threshold, holdoff).

## MCP bridge

The browser cannot expose a stdio server. To drive faustcode from
Claude Desktop (or any MCP client), download the local Go bridge
binary from the project's Releases and point your client at it :

```json
{
  "mcpServers": {
    "faustcode": {
      "command": "/path/to/faustcode-mcp"
    }
  }
}
```

The webapp auto-connects to the bridge on `ws://localhost:7777/ws`
and re-establishes the connection on every reload. From there the
MCP client can drive every tool exposed by `tools.json` —
`submit`, `set_session`, `run_audio`, `set_run_param`,
`get_spectrum`, `midi_note_pulse`, and so on.

The full handshake (NW-1..NW-5) and the per-tool semantics are
described in `SPECIFICATION.md`.

## Building the bridge

```sh
cd mcp
make build         # outputs ./faustcode-mcp
```

Cross-platform release builds are produced via `make release` and
uploaded to GitHub Releases ; the webapp's "Setup MCP" panel offers
direct download links for the visitor's detected platform.

## Rebuilding the CodeMirror bundle

```sh
./webapp/vendor/codemirror/build-cm6.sh
```

Runs `npx esbuild` inside a transient build directory, no
`node_modules` is committed.

## Licence

MIT (see `LICENSE`).
