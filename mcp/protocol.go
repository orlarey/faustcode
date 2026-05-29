// protocol.go : wire types for the WebSocket channel between faustcode-mcp
// and the browser tab. See SPECIFICATION-STANDALONE.md §Protocole de
// communication for the contract.
package main

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

// Message kinds exchanged on the WebSocket.
const (
	KindReq   = "req"
	KindResp  = "resp"
	KindPing  = "ping"
	KindPong  = "pong"
	KindHello = "hello"
	KindReady = "ready"
)

// WsReq is sent from faustcode-mcp to the webapp to invoke a tool.
type WsReq struct {
	Kind string          `json:"kind"` // "req"
	ID   string          `json:"id"`
	Op   string          `json:"op"`             // = ToolDef.Name
	Args json.RawMessage `json:"args,omitempty"` // validated against ToolDef.InputSchema
}

// WsResp is the reply from the webapp. Exactly one of (Result, Error) is set.
type WsResp struct {
	Kind   string          `json:"kind"` // "resp"
	ID     string          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *WsErrorPayload `json:"error,omitempty"`
}

// WsErrorPayload follows the structure laid out in §Protocole > PR-6..PR-8.
type WsErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// WsHello is sent by faustcode-mcp immediately after WS accept (NW-1).
type WsHello struct {
	Kind            string `json:"kind"`
	MCPVersion      string `json:"mcpVersion"`
	ContractVersion string `json:"contractVersion"`
}

// WsReady is the webapp's handshake reply (NW-2).
type WsReady struct {
	Kind            string `json:"kind"`
	WebappVersion   string `json:"webappVersion"`
	ContractVersion string `json:"contractVersion"`
	Token           string `json:"token,omitempty"` // optional shared token (SC-4)
}

// WsPingPong : trivial keepalive.
type WsPingPong struct {
	Kind string `json:"kind"`
	At   int64  `json:"at"` // unix milliseconds
}

// WsEnvelope is used to peek at the `kind` field before deserializing the
// full message into the right concrete type.
type WsEnvelope struct {
	Kind string `json:"kind"`
}

// Stable error codes returned to MCP clients when something goes wrong on the
// bridge side rather than from the tool itself.
const (
	ErrCodeNoWebapp           = "no_webapp"
	ErrCodeWebappDisconnected = "webapp_disconnected"
	ErrCodeTimeout            = "timeout"
	ErrCodeOpUnknown          = "op_unknown"
	ErrCodeBadResponse        = "bad_response"
	ErrCodeContractMismatch   = "contract_mismatch"
)

// SemVer is the minimal SemVer triplet we need for the NW-1..NW-5 handshake.
// Only the integer major / minor / patch are tracked; pre-release tags
// (e.g. "1.2.3-rc1") are tolerated but ignored beyond the patch component.
type SemVer struct {
	Major, Minor, Patch int
}

// ParseSemVer reads "MAJOR.MINOR.PATCH[-tag]" into a SemVer.
// Returns an error if the leading three numeric parts are not present.
func ParseSemVer(s string) (SemVer, error) {
	// Strip an optional "-tag" or "+build" suffix.
	for _, sep := range []string{"-", "+"} {
		if i := strings.Index(s, sep); i >= 0 {
			s = s[:i]
		}
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return SemVer{}, errVersionFormat
	}
	nums := [3]int{}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return SemVer{}, errVersionFormat
		}
		nums[i] = n
	}
	return SemVer{Major: nums[0], Minor: nums[1], Patch: nums[2]}, nil
}

var errVersionFormat = errors.New("version must be MAJOR.MINOR.PATCH")

// ContractCompat encodes the result of comparing two contract version
// strings against the NW-3..NW-5 ladder of SPECIFICATION-STANDALONE.md.
type ContractCompat int

const (
	ContractOK            ContractCompat = iota // versions match exactly
	ContractMinorMismatch                       // same major, different minor (NW-4 / NW-5)
	ContractMajorMismatch                       // different major (NW-3, hard reject)
	ContractUnparsable                          // at least one side is not SemVer
)

// CompareContractVersions parses both sides and returns the
// compatibility verdict. Used by ws_server.go to decide whether to
// accept a handshake.
func CompareContractVersions(webapp, mcp string) ContractCompat {
	wv, errW := ParseSemVer(webapp)
	mv, errM := ParseSemVer(mcp)
	if errW != nil || errM != nil {
		return ContractUnparsable
	}
	if wv.Major != mv.Major {
		return ContractMajorMismatch
	}
	if wv.Minor != mv.Minor {
		return ContractMinorMismatch
	}
	return ContractOK
}
