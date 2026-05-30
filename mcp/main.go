// faustcode-mcp — local binary that bridges an MCP client (over stdio) to
// the faustcode webapp running in a browser tab (over WebSocket).
//
// See SPECIFICATION-STANDALONE.md for the full design.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// MCPVersion is the version of the binary itself (independent of the
// contract version embedded in tools.json). It is sent in the WS hello
// so the webapp can detect a mismatch.
const MCPVersion = "0.1.0-dev"

func main() {
	var (
		contractPath   = flag.String("contract", "", "path to tools.json (default: use the file embedded at build time)")
		wsAddr         = flag.String("ws-addr", "127.0.0.1:7777", "WebSocket listen address (loopback only — see SC-1)")
		requestTimeout = flag.Duration("request-timeout", 60*time.Second, "default per-call timeout (PR-8)")
		token          = flag.String("token", "", "optional shared token the webapp must echo in its ready frame (SC-4)")
		debug          = flag.Bool("debug", false, "enable debug-level logging on stderr")
	)
	flag.Parse()

	// MCP uses stdio for its protocol → all logs MUST go to stderr.
	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	var (
		contract *ToolsContract
		source   string
		err      error
	)
	if *contractPath != "" {
		contract, err = LoadContract(*contractPath)
		source = *contractPath
	} else {
		contract, err = LoadEmbeddedContract()
		source = "<embedded>"
	}
	if err != nil {
		log.Error("failed to load contract", "err", err)
		os.Exit(1)
	}
	log.Info("contract loaded",
		"source", source,
		"contractVersion", contract.ContractVersion,
		"tools", len(contract.Tools))

	// Prepare the render_audio sink (creates dir, prunes stale WAVs).
	if err := setupRenderDir(); err != nil {
		log.Warn("render dir setup failed", "err", err, "dir", renderDir())
	} else {
		log.Info("render dir ready", "dir", renderDir())
	}

	bridge := NewBridge()

	mcpSrv, err := NewMCPServer(contract, bridge, log, *requestTimeout)
	if err != nil {
		log.Error("failed to build MCP server", "err", err)
		os.Exit(1)
	}

	wsSrv := NewWSServer(WSConfig{
		Addr:            *wsAddr,
		MCPVersion:      MCPVersion,
		ContractVersion: contract.ContractVersion,
		RequiredToken:   *token,
	}, bridge, log)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// WS in background.
	wsErr := make(chan error, 1)
	go func() {
		wsErr <- wsSrv.Start(ctx)
	}()

	// MCP in foreground — blocks until the stdio peer closes.
	log.Info("mcp server starting on stdio", "mcpVersion", MCPVersion)
	if err := mcpSrv.Run(ctx); err != nil {
		log.Error("mcp server exited with error", "err", err)
		_, _ = fmt.Fprintln(os.Stderr, err)
	}
	cancel()
	if err := <-wsErr; err != nil {
		log.Error("ws server exited with error", "err", err)
	}
	log.Info("faustcode-mcp shutting down")
}
