package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadEmbeddedContract(t *testing.T) {
	c, err := LoadEmbeddedContract()
	if err != nil {
		t.Fatalf("LoadEmbeddedContract: %v", err)
	}
	if c.ContractVersion == "" {
		t.Errorf("embedded contractVersion is empty")
	}
	if got := len(c.Tools); got != 34 {
		t.Errorf("embedded contract has %d tools, expected 34 (sync issue with ../tools.json?)", got)
	}
	// Spot-check a few tool names from each category.
	want := []string{
		"submit", "get_state", "set_view", "get_run_ui", "get_spectrum",
		"trigger_button", "midi_note_pulse", "search_faust_lib",
	}
	have := make(map[string]bool, len(c.Tools))
	for _, t := range c.Tools {
		have[t.Name] = true
	}
	for _, name := range want {
		if !have[name] {
			t.Errorf("expected tool %q missing from embedded contract", name)
		}
	}
}

func TestLoadContract_File(t *testing.T) {
	c, err := LoadContract("tools.json")
	if err != nil {
		t.Fatalf("LoadContract(tools.json): %v", err)
	}
	if c.ContractVersion == "" {
		t.Errorf("contractVersion is empty")
	}
}

func TestLoadContract_Errors(t *testing.T) {
	type tc struct {
		name    string
		body    string
		wantSub string
	}
	cases := []tc{
		{"missing version", `{"tools":[{"name":"x","inputSchema":{}}]}`, "missing contractVersion"},
		{"empty tools", `{"contractVersion":"1.0.0","tools":[]}`, "empty tools list"},
		{"empty name", `{"contractVersion":"1.0.0","tools":[{"name":"","inputSchema":{}}]}`, "empty name"},
		{"duplicate name", `{"contractVersion":"1.0.0","tools":[{"name":"a","inputSchema":{}},{"name":"a","inputSchema":{}}]}`, "duplicate"},
		{"empty inputSchema", `{"contractVersion":"1.0.0","tools":[{"name":"a"}]}`, "empty inputSchema"},
		{"invalid json", `not json`, "parse"},
	}

	dir := t.TempDir()
	for _, c := range cases {
		path := filepath.Join(dir, c.name+".json")
		if err := os.WriteFile(path, []byte(c.body), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
		_, err := LoadContract(path)
		if err == nil {
			t.Errorf("case %q: expected error, got nil", c.name)
			continue
		}
		if !strings.Contains(err.Error(), c.wantSub) {
			t.Errorf("case %q: error %q does not contain %q", c.name, err.Error(), c.wantSub)
		}
	}
}

func TestLoadContract_NonexistentFile(t *testing.T) {
	_, err := LoadContract(filepath.Join(t.TempDir(), "missing.json"))
	if err == nil {
		t.Fatalf("expected error for missing file")
	}
	if !strings.Contains(err.Error(), "read") {
		t.Errorf("expected 'read' in error, got: %v", err)
	}
}
