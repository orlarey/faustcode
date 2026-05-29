// bridge.go : in-memory registry of pending tool invocations.
//
// The bridge is the rendezvous point between the MCP server (which calls
// Invoke from a goroutine handling an MCP tool call) and the WebSocket
// server (which sends WsReq to the webapp and routes the matching WsResp
// back to the caller).
//
// Invariants (cf. SPECIFICATION-STANDALONE.md §Protocole > PR-1..PR-5):
//   - Exactly one response (or one error) per invocation.
//   - Correlation by ID, no ordering assumption.
//   - On WS disconnect, every inflight call receives ErrCodeWebappDisconnected.
package main

import (
	"encoding/json"
	"errors"
	"sync"
)

// pendingCall is the slot held while waiting for a WsResp.
type pendingCall struct {
	ch chan WsResp // buffered(1) — never block the WS reader
}

// Bridge couples MCP-side invocations with WS-side responses.
type Bridge struct {
	mu       sync.Mutex
	inflight map[string]*pendingCall
	send     func(msg any) error // injected at WS connect time; returns error if no WS connected
}

// NewBridge constructs a bridge with no active WS connection.
func NewBridge() *Bridge {
	return &Bridge{
		inflight: make(map[string]*pendingCall),
	}
}

// AttachSender plugs the WS write callback. Pass nil on disconnect to flush
// the inflight registry (every pending call receives a disconnected error).
func (b *Bridge) AttachSender(send func(msg any) error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if send == nil {
		// Disconnect path : drain pending calls with a clear error.
		for id, p := range b.inflight {
			p.ch <- WsResp{
				Kind: KindResp,
				ID:   id,
				OK:   false,
				Error: &WsErrorPayload{
					Code: ErrCodeWebappDisconnected,
					Message: "faustcode tab disconnected mid-call. " +
						"Please open https://orlarey.github.io/faustcode/ in a browser and retry.",
				},
			}
		}
		b.inflight = make(map[string]*pendingCall)
	}
	b.send = send
}

// register reserves a slot for the given id and returns the channel to wait on.
// Returns nil and an error if there is no active WS sender.
func (b *Bridge) register(id string) (chan WsResp, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.send == nil {
		return nil, errNoWebapp
	}
	p := &pendingCall{ch: make(chan WsResp, 1)}
	b.inflight[id] = p
	return p.ch, nil
}

// unregister removes a pending call (used both after success and on timeout).
func (b *Bridge) unregister(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.inflight, id)
}

// DispatchResp is called by the WS reader on every incoming "resp" message.
// It looks up the matching pending call and delivers the response.
func (b *Bridge) DispatchResp(resp WsResp) {
	b.mu.Lock()
	p, ok := b.inflight[resp.ID]
	b.mu.Unlock()
	if !ok {
		// Late or duplicate response — drop silently. Could be logged.
		return
	}
	// Non-blocking send into a buffered(1) channel.
	select {
	case p.ch <- resp:
	default:
	}
}

// Send forwards an arbitrary outgoing message (hello, req, ping) to the WS.
// Returns errNoWebapp if there is no active connection.
func (b *Bridge) Send(msg any) error {
	b.mu.Lock()
	send := b.send
	b.mu.Unlock()
	if send == nil {
		return errNoWebapp
	}
	return send(msg)
}

var errNoWebapp = errors.New("no webapp connected")

// MarshalSend is a small helper: marshal `msg` to JSON and forward via Send.
// It is here mostly to keep the WS server code thin.
func (b *Bridge) MarshalSend(msg any) error {
	_, err := json.Marshal(msg) // sanity check at the call site
	if err != nil {
		return err
	}
	return b.Send(msg)
}
