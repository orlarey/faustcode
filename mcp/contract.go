// Package main — faustcode-mcp.
//
// contract.go : load and validate tools.json, the single source of truth
// describing the operations exposed by the faustcode webapp. The file is
// embedded at build time AND optionally overridden by --contract for dev.
package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
)

//go:embed tools.json
var embeddedToolsJSON []byte

// LoadEmbeddedContract parses the tools.json that was compiled into the
// binary at build time. Returns an error only if the embedded blob fails
// validation — that would be a build-time mistake, not a runtime one.
func LoadEmbeddedContract() (*ToolsContract, error) {
	return parseContract("<embedded>", embeddedToolsJSON)
}

// ToolDef mirrors one entry of tools.json. Schemas are kept as raw bytes so
// they can be passed verbatim to the MCP SDK without going through Go types.
type ToolDef struct {
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Stability    string          `json:"stability,omitempty"`
	Deprecated   bool            `json:"deprecated,omitempty"`
	InputSchema  json.RawMessage `json:"inputSchema"`
	OutputSchema json.RawMessage `json:"outputSchema"`
}

// ToolsContract is the top-level shape of tools.json.
type ToolsContract struct {
	ContractVersion string                     `json:"contractVersion"`
	Defs            map[string]json.RawMessage `json:"$defs,omitempty"`
	Tools           []ToolDef                  `json:"tools"`
}

// LoadContract parses a tools.json file from disk.
func LoadContract(path string) (*ToolsContract, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return parseContract(path, data)
}

// parseContract is the shared body of LoadContract and LoadEmbeddedContract.
func parseContract(source string, data []byte) (*ToolsContract, error) {
	var c ToolsContract
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", source, err)
	}
	if c.ContractVersion == "" {
		return nil, fmt.Errorf("%s: missing contractVersion", source)
	}
	if len(c.Tools) == 0 {
		return nil, fmt.Errorf("%s: empty tools list", source)
	}
	seen := make(map[string]bool, len(c.Tools))
	for i, t := range c.Tools {
		if t.Name == "" {
			return nil, fmt.Errorf("%s: tool #%d has empty name", source, i)
		}
		if seen[t.Name] {
			return nil, fmt.Errorf("%s: duplicate tool name %q", source, t.Name)
		}
		seen[t.Name] = true
		if len(t.InputSchema) == 0 {
			return nil, fmt.Errorf("%s: tool %q has empty inputSchema", source, t.Name)
		}
	}
	return &c, nil
}
