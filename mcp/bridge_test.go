package main

import (
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

// captureSender returns a Bridge sender that records every outgoing message
// in a slice (under a mutex). Useful to assert that the bridge forwards what
// we expect to the WS connection.
func captureSender() (func(any) error, func() []any) {
	var (
		mu   sync.Mutex
		msgs []any
	)
	send := func(m any) error {
		mu.Lock()
		defer mu.Unlock()
		msgs = append(msgs, m)
		return nil
	}
	read := func() []any {
		mu.Lock()
		defer mu.Unlock()
		out := make([]any, len(msgs))
		copy(out, msgs)
		return out
	}
	return send, read
}

func TestBridge_SendWithoutWebappFails(t *testing.T) {
	b := NewBridge()
	if err := b.Send(WsHello{Kind: "hello"}); err == nil {
		t.Fatalf("Send without attached sender should return errNoWebapp, got nil")
	}
}

func TestBridge_AttachThenSend(t *testing.T) {
	b := NewBridge()
	send, read := captureSender()
	b.AttachSender(send)

	if err := b.Send(WsPingPong{Kind: "ping", At: 42}); err != nil {
		t.Fatalf("Send after AttachSender: %v", err)
	}
	if msgs := read(); len(msgs) != 1 {
		t.Fatalf("want 1 captured msg, got %d", len(msgs))
	}
}

func TestBridge_RegisterDispatchUnregister(t *testing.T) {
	b := NewBridge()
	send, _ := captureSender()
	b.AttachSender(send)

	ch, err := b.register("req-1")
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	go b.DispatchResp(WsResp{Kind: KindResp, ID: "req-1", OK: true, Result: json.RawMessage(`{"x":1}`)})

	got := <-ch
	if !got.OK {
		t.Fatalf("expected OK, got %+v", got)
	}
	if got.ID != "req-1" {
		t.Errorf("wrong id: got %q", got.ID)
	}
	b.unregister("req-1")

	// Dispatching again must not panic, just silently drop.
	b.DispatchResp(WsResp{Kind: KindResp, ID: "req-1", OK: true})
}

func TestBridge_DispatchUnknownIDIsDropped(t *testing.T) {
	b := NewBridge()
	send, _ := captureSender()
	b.AttachSender(send)
	// Should be a no-op, no panic.
	b.DispatchResp(WsResp{Kind: KindResp, ID: "ghost", OK: true})
}

func TestBridge_DisconnectFlushesInflight(t *testing.T) {
	b := NewBridge()
	send, _ := captureSender()
	b.AttachSender(send)

	var (
		ids = []string{"a", "b", "c"}
		chs = make([]chan WsResp, len(ids))
	)
	for i, id := range ids {
		ch, err := b.register(id)
		if err != nil {
			t.Fatalf("register %s: %v", id, err)
		}
		chs[i] = ch
	}

	// AttachSender(nil) simulates the WS reader exiting.
	b.AttachSender(nil)

	for i, ch := range chs {
		select {
		case resp := <-ch:
			if resp.OK {
				t.Errorf("id %s: expected error response, got OK", ids[i])
			}
			if resp.Error == nil || resp.Error.Code != ErrCodeWebappDisconnected {
				t.Errorf("id %s: expected code %q, got %+v", ids[i], ErrCodeWebappDisconnected, resp.Error)
			}
		default:
			t.Errorf("id %s: no response delivered on disconnect", ids[i])
		}
	}

	// Subsequent Send must fail.
	if err := b.Send(WsPingPong{Kind: "ping"}); err == nil {
		t.Fatalf("Send after disconnect should fail")
	}
}

func TestBridge_RegisterAfterDisconnectFails(t *testing.T) {
	b := NewBridge()
	send, _ := captureSender()
	b.AttachSender(send)
	b.AttachSender(nil)

	if _, err := b.register("x"); err == nil {
		t.Fatalf("register after disconnect should fail")
	}
}

func TestBridge_ConcurrentDispatch(t *testing.T) {
	b := NewBridge()
	send, _ := captureSender()
	b.AttachSender(send)

	const n = 100
	var wg sync.WaitGroup
	var oks int64
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			id := makeID(i)
			ch, err := b.register(id)
			if err != nil {
				t.Errorf("register: %v", err)
				return
			}
			go b.DispatchResp(WsResp{Kind: KindResp, ID: id, OK: true})
			resp := <-ch
			if resp.OK && resp.ID == id {
				atomic.AddInt64(&oks, 1)
			}
			b.unregister(id)
		}(i)
	}
	wg.Wait()
	if oks != n {
		t.Errorf("expected %d successful dispatches, got %d", n, oks)
	}
}

func makeID(i int) string {
	return fmt.Sprintf("req-%d", i)
}
