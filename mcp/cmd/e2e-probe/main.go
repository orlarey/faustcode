// e2e-probe — end-to-end smoke test of the full faustcode-mcp pipeline.
//
// Architecture under test:
//
//	[this probe (MCP client)] --stdio--> [faustcode-mcp] <--WS-- [this probe (fake webapp)]
//
// The probe plays both roles in the same process :
//
//   - as an MCP client, it spawns faustcode-mcp through the SDK's
//     CommandTransport, lists the tools (expect 34), then calls one
//     simple tool ("get_state") ;
//
//   - as a fake webapp, it opens a WebSocket connection to
//     ws://127.0.0.1:7777/ws, does the hello/ready handshake, then
//     replies to every WsReq with a synthetic WsResp.
//
// On success, the probe prints a green verdict and exits with code 0.
// On failure, it prints the offending step and exits with code 1.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeContractVersion must match the value in tools.json for the
// handshake (NW-1..NW-5) to succeed quietly.
const fakeContractVersion = "0.1.0"

// All WS-side types are duplicated here on purpose : the probe lives
// in cmd/e2e-probe so it can pretend to be a fully separate program.
type wsEnvelope struct {
	Kind string `json:"kind"`
}
type wsHello struct {
	Kind            string `json:"kind"`
	MCPVersion      string `json:"mcpVersion"`
	ContractVersion string `json:"contractVersion"`
}
type wsReady struct {
	Kind            string `json:"kind"`
	WebappVersion   string `json:"webappVersion"`
	ContractVersion string `json:"contractVersion"`
}
type wsReq struct {
	Kind string          `json:"kind"`
	ID   string          `json:"id"`
	Op   string          `json:"op"`
	Args json.RawMessage `json:"args"`
}
type wsResp struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  any    `json:"error,omitempty"`
}
type wsPingPong struct {
	Kind string `json:"kind"`
	At   int64  `json:"at"`
}

func main() {
	var (
		binPath  = flag.String("bin", "./faustcode-mcp", "path to the faustcode-mcp binary to spawn")
		wsURL    = flag.String("ws", "ws://127.0.0.1:7777/ws", "WS URL exposed by faustcode-mcp")
		external = flag.Bool("external-webapp", false,
			"do NOT start the built-in fake webapp ; expect an external webapp (e.g. a browser tab) to be connected before invoking tools")
		op = flag.String("op", "get_state", "tool to call once the webapp is ready")
	)
	flag.Parse()

	abs, err := filepath.Abs(*binPath)
	if err != nil {
		fail("resolve bin path: %v", err)
	}
	if _, err := os.Stat(abs); err != nil {
		fail("bin not found at %s — build it first with `go build -o faustcode-mcp .`", abs)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// 1. Start the fake webapp side first (skipped when --external-webapp).
	//    It loops, retrying the WS connection until faustcode-mcp's WS
	//    server is up (the probe starts the subprocess in step 2).
	var (
		webappDone  chan error
		webappReady chan struct{}
	)
	if !*external {
		webappDone = make(chan error, 1)
		webappReady = make(chan struct{})
		go func() {
			webappDone <- runFakeWebapp(ctx, *wsURL, webappReady)
		}()
	} else {
		log.Printf("[probe] --external-webapp : will wait %s for an outside webapp to connect", 15*time.Second)
	}

	// 2. Spawn faustcode-mcp via CommandTransport, set up the MCP client.
	log.Printf("[probe] spawning %s", abs)
	cmd := exec.Command(abs, "--debug")
	cmd.Stderr = os.Stderr
	transport := &mcp.CommandTransport{Command: cmd}

	// Faustcode-mcp registers its tools dynamically — they appear only
	// after the WS handshake completes. The server fires
	// notifications/tools/list_changed, which we wait for here before
	// calling ListTools to avoid the race between the probe sending
	// Ready and the server's OnTabConnected hook adding the tools.
	toolsChanged := make(chan struct{}, 1)
	client := mcp.NewClient(&mcp.Implementation{
		Name:    "faustcode-mcp-e2e-probe",
		Version: "0.0.1",
	}, &mcp.ClientOptions{
		ToolListChangedHandler: func(_ context.Context, _ *mcp.ToolListChangedRequest) {
			select {
			case toolsChanged <- struct{}{}:
			default:
			}
		},
	})

	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		fail("mcp connect: %v", err)
	}
	defer session.Close()

	// 3. Wait for the WS side to be ready (handshake done) before calling.
	if !*external {
		select {
		case <-webappReady:
			log.Printf("[probe] fake webapp ready")
		case <-time.After(10 * time.Second):
			fail("fake webapp never reached ready state")
		}
		// Wait for the binary to fire tools/list_changed once the WS
		// handshake makes it through (server-side OnTabConnected).
		select {
		case <-toolsChanged:
			log.Printf("[probe] tools/list_changed received")
		case <-time.After(5 * time.Second):
			fail("tools/list_changed never received")
		}
	} else {
		// External webapp : give it ample time to connect. The first
		// CallTool will surface no_webapp if nobody is on the line, which
		// is a clearer signal than a timeout here.
		const waitForExternal = 10 * time.Second
		log.Printf("[probe] waiting %s for an external webapp to connect…", waitForExternal)
		time.Sleep(waitForExternal)
		log.Printf("[probe] proceeding")
	}

	// 4. List tools.
	listResult, err := session.ListTools(ctx, nil)
	if err != nil {
		fail("ListTools: %v", err)
	}
	const expectedTools = 34
	log.Printf("[probe] ListTools : got %d tools", len(listResult.Tools))
	if len(listResult.Tools) != expectedTools {
		fail("expected %d tools, got %d", expectedTools, len(listResult.Tools))
	}

	// 5. Call the chosen tool.
	args := argsForOp(*op)
	log.Printf("[probe] CallTool %s args=%s", *op, mustJSON(args))
	callResult, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      *op,
		Arguments: args,
	})
	if err != nil {
		fail("CallTool %s: %v", *op, err)
	}
	body, _ := json.Marshal(callResult.StructuredContent)
	log.Printf("[probe] CallTool %s result : isError=%v structured=%s",
		*op, callResult.IsError, string(body))

	if !*external {
		// 5bis. Sanity assertion only meaningful against the deterministic
		// fake-webapp.
		if callResult.IsError {
			fail("CallTool %s returned IsError=true : %+v", *op, callResult.Content)
		}
		if *op == "get_state" {
			wantSha1 := "0000000000000000000000000000000000000001"
			var got struct {
				Sha1     string `json:"sha1"`
				Filename string `json:"filename"`
				View     string `json:"view"`
			}
			if err := json.Unmarshal(body, &got); err != nil {
				fail("decode structured result: %v", err)
			}
			if got.Sha1 != wantSha1 || got.Filename != "fake.dsp" || got.View != "dsp" {
				fail("unexpected get_state payload: %+v", got)
			}
		}
	}

	// 6. Done.
	_ = session.Close()
	cancel()
	if webappDone != nil {
		if err := <-webappDone; err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("[probe] fake webapp ended with: %v", err)
		}
	}
	if *external {
		fmt.Println("\n\x1b[32m✓ round-trip OK\x1b[0m  MCP-client ↔ faustcode-mcp ↔ external webapp")
	} else {
		fmt.Println("\n\x1b[32m✓ round-trip OK\x1b[0m  MCP-client ↔ faustcode-mcp ↔ fake-webapp")
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "\x1b[31m✗ \x1b[0m"+format+"\n", args...)
	os.Exit(1)
}

// argsForOp builds canonical arguments for the few tools the probe can
// invoke meaningfully. For everything else we send {}, which will either
// satisfy a no-args handler or trigger a clear validation error from the
// webapp side — both cases are diagnostic.
func argsForOp(op string) map[string]any {
	switch op {
	case "submit":
		return map[string]any{
			// Simple stereo oscillator — identical to the F1/F2a sample DSP.
			"code":     "import(\"stdfaust.lib\");\nprocess = os.osc(440) * 0.3 <: _, _;\n",
			"filename": "e2e-probe.dsp",
		}
	case "get_errors":
		return map[string]any{
			"sha1": "0000000000000000000000000000000000000001",
		}
	case "search_faust_lib":
		return map[string]any{"query": "lowpass", "limit": 5}
	case "get_faust_symbol":
		return map[string]any{"symbol": "fi.lowpass"}
	case "list_faust_module":
		return map[string]any{"module": "filters", "limit": 3}
	case "get_faust_examples":
		return map[string]any{"symbolOrModule": "fi.lowpass", "limit": 2}
	case "explain_faust_symbol_for_goal":
		return map[string]any{"symbol": "fi.lowpass", "goal": "tame the harshness of a square wave"}
	case "run_audio":
		return map[string]any{"state": "on"}
	case "set_run_param":
		return map[string]any{"path": "/session/freq", "value": 880}
	case "trigger_button":
		return map[string]any{"path": "/session/gate", "holdMs": 50}
	case "set_polyphony":
		return map[string]any{"voices": 0}
	case "midi_note_on":
		return map[string]any{"note": 60, "velocity": 0.8}
	case "midi_note_off":
		return map[string]any{"note": 60}
	case "midi_note_pulse":
		return map[string]any{"note": 60, "velocity": 0.8, "holdMs": 100}
	default:
		return map[string]any{}
	}
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("<marshal err %v>", err)
	}
	return string(b)
}

// runFakeWebapp dials the WS server (retrying for ~5s while faustcode-mcp
// starts up), then handles hello/ready handshake and replies to WsReq.
func runFakeWebapp(ctx context.Context, url string, ready chan<- struct{}) error {
	// Retry the dial — the MCP subprocess takes a moment to start.
	var conn *websocket.Conn
	deadline := time.Now().Add(8 * time.Second)
	for {
		if time.Now().After(deadline) {
			return fmt.Errorf("dial %s: gave up", url)
		}
		c, _, err := websocket.DefaultDialer.DialContext(ctx, url, nil)
		if err == nil {
			conn = c
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(150 * time.Millisecond):
		}
	}
	defer conn.Close()
	log.Printf("[fake-webapp] connected to %s", url)

	readyOnce := sync.Once{}
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("ws read: %w", err)
		}
		var env wsEnvelope
		if err := json.Unmarshal(raw, &env); err != nil {
			log.Printf("[fake-webapp] bad envelope: %v", err)
			continue
		}

		switch env.Kind {
		case "hello":
			var h wsHello
			_ = json.Unmarshal(raw, &h)
			log.Printf("[fake-webapp] got hello : mcpVersion=%s contractVersion=%s",
				h.MCPVersion, h.ContractVersion)
			r := wsReady{
				Kind:            "ready",
				WebappVersion:   "0.0.1-fake",
				ContractVersion: fakeContractVersion,
			}
			if err := writeJSON(conn, r); err != nil {
				return err
			}
			readyOnce.Do(func() { close(ready) })

		case "ping":
			var p wsPingPong
			_ = json.Unmarshal(raw, &p)
			_ = writeJSON(conn, wsPingPong{Kind: "pong", At: p.At})

		case "req":
			var rq wsReq
			if err := json.Unmarshal(raw, &rq); err != nil {
				log.Printf("[fake-webapp] bad req: %v", err)
				continue
			}
			log.Printf("[fake-webapp] req id=%s op=%s args=%s",
				rq.ID, rq.Op, string(rq.Args))
			resp := buildSyntheticResponse(rq)
			if err := writeJSON(conn, resp); err != nil {
				return err
			}

		default:
			log.Printf("[fake-webapp] unknown kind: %s", env.Kind)
		}
	}
}

func writeJSON(conn *websocket.Conn, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, raw)
}

// buildSyntheticResponse fabricates a deterministic result depending on op.
// For the smoke test we only cover one tool (get_state); any other tool
// gets a generic { "echo": "<op>" } response that still validates the
// round-trip without claiming any specific shape.
func buildSyntheticResponse(req wsReq) wsResp {
	switch req.Op {
	case "get_state":
		return wsResp{
			Kind: "resp",
			ID:   req.ID,
			OK:   true,
			Result: map[string]any{
				"sha1":     "0000000000000000000000000000000000000001",
				"filename": "fake.dsp",
				"view":     "dsp",
			},
		}
	default:
		return wsResp{
			Kind:   "resp",
			ID:     req.ID,
			OK:     true,
			Result: map[string]any{"echo": req.Op},
		}
	}
}
