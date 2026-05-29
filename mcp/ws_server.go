// ws_server.go : WebSocket endpoint that the browser tab opens to talk
// to faustcode-mcp. Only one active connection is accepted at a time
// (PR-5). All routing/correlation lives in Bridge.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WSConfig groups the server-side tuning knobs. Defaults match the
// invariants laid out in SPECIFICATION-STANDALONE.md §Protocole.
type WSConfig struct {
	Addr              string        // e.g. "127.0.0.1:7777"
	HeartbeatInterval time.Duration // default 30s
	HeartbeatTimeout  time.Duration // default 10s
	WriteTimeout      time.Duration // default 5s
	MCPVersion        string        // sent in WsHello.mcpVersion
	ContractVersion   string        // sent in WsHello.contractVersion
	RequiredToken     string        // if non-empty, the webapp must send the same string in WsReady.token (SC-4)

	// OnTabConnected is invoked right after the WS handshake completes
	// (NW-2). The MCP server uses this to register its tools so
	// connected MCP clients see them appear via
	// notifications/tools/list_changed.
	OnTabConnected func()
	// OnTabDisconnected is invoked when the WS connection closes for
	// any reason. The MCP server uses this to remove its tools so
	// clients stop seeing tools that would immediately fail.
	OnTabDisconnected func()
}

// WSServer wraps the http.Server + the gorilla upgrader.
type WSServer struct {
	cfg    WSConfig
	bridge *Bridge
	log    *slog.Logger
	srv    *http.Server

	connMu sync.Mutex
	conn   *websocket.Conn
}

// NewWSServer wires up the WS endpoint.
func NewWSServer(cfg WSConfig, bridge *Bridge, log *slog.Logger) *WSServer {
	if cfg.HeartbeatInterval == 0 {
		cfg.HeartbeatInterval = 30 * time.Second
	}
	if cfg.HeartbeatTimeout == 0 {
		cfg.HeartbeatTimeout = 10 * time.Second
	}
	if cfg.WriteTimeout == 0 {
		cfg.WriteTimeout = 5 * time.Second
	}
	s := &WSServer{cfg: cfg, bridge: bridge, log: log}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})
	s.srv = &http.Server{
		Addr:    cfg.Addr,
		Handler: mux,
	}
	return s
}

// Start runs the WS server in the foreground until ctx is cancelled.
func (s *WSServer) Start(ctx context.Context) error {
	go func() {
		<-ctx.Done()
		_ = s.srv.Shutdown(context.Background())
	}()
	s.log.Info("ws server listening", "addr", s.cfg.Addr)
	if err := s.srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

var upgrader = websocket.Upgrader{
	// Bridge listens only on loopback (SC-1), so origin checks are
	// unnecessary — and they would break ?mcp=ws://localhost activation
	// from a remote-served webapp. The threat model assumes the local
	// process owner is trusted.
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (s *WSServer) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.log.Warn("ws upgrade failed", "err", err)
		return
	}

	// Replace any existing connection (PR-5). Before tearing the old
	// one down, send a close frame with our custom code 4001 and reason
	// "superseded-by-new-tab" so the losing client knows it was kicked
	// on purpose and can stop its automatic reconnect (otherwise the
	// two tabs ping-pong forever).
	s.connMu.Lock()
	if old := s.conn; old != nil {
		s.log.Info("ws: replacing previous connection")
		closeMsg := websocket.FormatCloseMessage(WSCloseSupersededByNewTab, "superseded-by-new-tab")
		_ = old.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(s.cfg.WriteTimeout))
		_ = old.Close()
	}
	s.conn = conn
	s.connMu.Unlock()

	// Attach the write callback to the bridge.
	s.bridge.AttachSender(func(msg any) error {
		raw, err := json.Marshal(msg)
		if err != nil {
			return err
		}
		s.connMu.Lock()
		c := s.conn
		s.connMu.Unlock()
		if c == nil {
			return errNoWebapp
		}
		_ = c.SetWriteDeadline(time.Now().Add(s.cfg.WriteTimeout))
		return c.WriteMessage(websocket.TextMessage, raw)
	})
	// Tracks whether the handshake completed so OnTabConnected was
	// fired ; gates the matching OnTabDisconnected in the defer.
	tabReady := false
	defer func() {
		s.connMu.Lock()
		if s.conn == conn {
			s.conn = nil
		}
		s.connMu.Unlock()
		s.bridge.AttachSender(nil) // flush inflight + clear sender
		if tabReady && s.cfg.OnTabDisconnected != nil {
			s.cfg.OnTabDisconnected()
		}
		_ = conn.Close()
		s.log.Info("ws closed")
	}()

	// Send hello (NW-1).
	hello := WsHello{
		Kind:            KindHello,
		MCPVersion:      s.cfg.MCPVersion,
		ContractVersion: s.cfg.ContractVersion,
	}
	if err := s.bridge.MarshalSend(hello); err != nil {
		s.log.Warn("ws hello failed", "err", err)
		return
	}

	// Heartbeat loop in its own goroutine.
	pingDone := make(chan struct{})
	go s.heartbeat(conn, pingDone)
	defer close(pingDone)

	// Read loop.
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			s.log.Info("ws read ended", "err", err)
			return
		}
		var env WsEnvelope
		if err := json.Unmarshal(raw, &env); err != nil {
			s.log.Warn("ws bad envelope", "err", err)
			continue
		}
		switch env.Kind {
		case KindReady:
			var ready WsReady
			if err := json.Unmarshal(raw, &ready); err != nil {
				s.log.Warn("ws bad ready", "err", err)
				continue
			}
			// SC-4 : if a shared token is configured, the webapp must
			// supply the matching value in WsReady.token. A mismatch
			// closes the connection — assume a hostile local process
			// has tried to impersonate the legitimate webapp.
			if s.cfg.RequiredToken != "" {
				if ready.Token != s.cfg.RequiredToken {
					s.log.Error("ws token mismatch — closing")
					_ = s.bridge.MarshalSend(WsResp{
						Kind: KindResp,
						ID:   "handshake",
						OK:   false,
						Error: &WsErrorPayload{
							Code:    ErrCodeContractMismatch,
							Message: "shared token mismatch",
						},
					})
					return
				}
				s.log.Info("ws token accepted")
			}
			// Apply NW-3..NW-5 : compare contract versions, hard reject
			// on a major mismatch.
			switch CompareContractVersions(ready.ContractVersion, s.cfg.ContractVersion) {
			case ContractUnparsable:
				s.log.Warn("contractVersion unparsable — proceeding leniently",
					"webapp", ready.ContractVersion,
					"mcp", s.cfg.ContractVersion)
			case ContractMajorMismatch:
				// NW-3 : hard reject. Tell the webapp why, then close.
				s.log.Error("contract major mismatch — closing WS",
					"webapp", ready.ContractVersion,
					"mcp", s.cfg.ContractVersion)
				_ = s.bridge.MarshalSend(WsResp{
					Kind: KindResp,
					ID:   "handshake",
					OK:   false,
					Error: &WsErrorPayload{
						Code: ErrCodeContractMismatch,
						Message: "contract major mismatch (webapp=" +
							ready.ContractVersion + ", mcp=" + s.cfg.ContractVersion + ")",
					},
				})
				return // defer will close conn + flush inflight
			case ContractMinorMismatch:
				// NW-4 / NW-5 : compatible major but minor diverges.
				s.log.Warn("contract minor mismatch — proceeding",
					"webapp", ready.ContractVersion,
					"mcp", s.cfg.ContractVersion)
			case ContractOK:
				s.log.Info("ws ready",
					"webappVersion", ready.WebappVersion,
					"contractVersion", ready.ContractVersion)
			}
			// Handshake fully accepted (NW-2 + contract check passed).
			// Tell the MCP server it can publish its tools — the SDK
			// auto-emits tools/list_changed so connected clients refetch.
			if !tabReady {
				tabReady = true
				if s.cfg.OnTabConnected != nil {
					s.cfg.OnTabConnected()
				}
			}
		case KindResp:
			var resp WsResp
			if err := json.Unmarshal(raw, &resp); err != nil {
				s.log.Warn("ws bad resp", "err", err)
				continue
			}
			s.bridge.DispatchResp(resp)
		case KindPong:
			// handled by heartbeat goroutine via the read pong handler;
			// we still accept explicit pong messages for symmetry.
		default:
			s.log.Debug("ws unknown kind", "kind", env.Kind)
		}
	}
}

func (s *WSServer) heartbeat(conn *websocket.Conn, done <-chan struct{}) {
	t := time.NewTicker(s.cfg.HeartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case now := <-t.C:
			ping := WsPingPong{Kind: KindPing, At: now.UnixMilli()}
			raw, _ := json.Marshal(ping)
			s.connMu.Lock()
			c := s.conn
			s.connMu.Unlock()
			if c != conn {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(s.cfg.WriteTimeout))
			if err := conn.WriteMessage(websocket.TextMessage, raw); err != nil {
				s.log.Warn("ws heartbeat write failed", "err", err)
				_ = conn.Close()
				return
			}
		}
	}
}
