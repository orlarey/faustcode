// mcp_server.go : declare one MCP tool per tools.json entry, route each
// invocation through the bridge to the connected browser tab.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// MCPServer wraps the SDK Server with our wiring.
//
// Tools are NOT registered at construction. They appear only after the
// webapp tab connects (RegisterTools), and disappear when it
// disconnects (UnregisterTools). The Go SDK emits
// `notifications/tools/list_changed` on every AddTool / RemoveTools
// call to every live session, so connected MCP clients (Claude Desktop,
// Claude Code, …) refetch the tool list and only see the 34 faustcode
// tools when they are actually usable. This avoids surfacing tools that
// would immediately fail with "tab not connected".
type MCPServer struct {
	server         *mcp.Server
	bridge         *Bridge
	contract       *ToolsContract
	validator      *SchemaValidator
	requestTimeout time.Duration
	log            *slog.Logger

	mu              sync.Mutex
	toolsRegistered bool
}

// NewMCPServer builds the SDK server, declares one tool per contract entry,
// and returns the wrapper ready to be Run() against the stdio transport.
func NewMCPServer(contract *ToolsContract, bridge *Bridge, log *slog.Logger, requestTimeout time.Duration) (*MCPServer, error) {
	impl := &mcp.Implementation{
		Name:    "faustcode-mcp",
		Title:   "faustcode-mcp",
		Version: contract.ContractVersion,
	}
	srv := mcp.NewServer(impl, nil)
	validator, err := NewSchemaValidator(contract)
	if err != nil {
		return nil, fmt.Errorf("compile schemas: %w", err)
	}
	m := &MCPServer{
		server:         srv,
		bridge:         bridge,
		contract:       contract,
		validator:      validator,
		requestTimeout: requestTimeout,
		log:            log,
	}
	log.Info("schemas compiled", "tools", len(contract.Tools))
	log.Info("tools NOT yet registered — waiting for webapp tab to connect")
	return m, nil
}

// RegisterTools advertises all contract tools to MCP clients. The Go
// SDK's AddTool fires `notifications/tools/list_changed` on every live
// session, so connected MCP clients refetch and the tools become
// visible. Called by the WS server when the webapp tab connects.
// Idempotent.
func (m *MCPServer) RegisterTools() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.toolsRegistered {
		return
	}
	for i := range m.contract.Tools {
		def := m.contract.Tools[i] // capture by value for the handler closure
		tool := &mcp.Tool{
			Name:         def.Name,
			Description:  def.Description,
			InputSchema:  def.InputSchema,
			OutputSchema: def.OutputSchema,
			Meta:         buildToolMeta(def),
		}
		m.server.AddTool(tool, m.makeHandler(def.Name))
	}
	m.toolsRegistered = true
	m.log.Info("mcp tools registered (tab connected)", "count", len(m.contract.Tools))
}

// UnregisterTools hides every contract tool from MCP clients. Called by
// the WS server when the webapp tab disconnects. Idempotent.
func (m *MCPServer) UnregisterTools() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.toolsRegistered {
		return
	}
	names := make([]string, len(m.contract.Tools))
	for i := range m.contract.Tools {
		names[i] = m.contract.Tools[i].Name
	}
	m.server.RemoveTools(names...)
	m.toolsRegistered = false
	m.log.Info("mcp tools unregistered (tab disconnected)", "count", len(names))
}

// makeHandler returns a ToolHandler that dispatches `op` through the bridge.
func (m *MCPServer) makeHandler(op string) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id := uuid.NewString()
		ch, err := m.bridge.register(id)
		if err != nil {
			if errors.Is(err, errNoWebapp) {
				return mcpToolError(ErrCodeNoWebapp, "faustcode tab not connected"), nil
			}
			return nil, err
		}
		defer m.bridge.unregister(id)

		args := req.Params.Arguments
		if len(args) == 0 {
			args = json.RawMessage(`{}`)
		}
		// Defence-in-depth : validate args against the contract input
		// schema before paying the WS round-trip. The MCP SDK already
		// validates against the same schema (since AddTool was called
		// with it), so this guards against future code paths that
		// might skip the SDK's check ; cheap to keep.
		if err := m.validator.ValidateInput(op, args); err != nil {
			m.log.Warn("input schema validation failed", "op", op, "err", err)
			return mcpToolError(ErrCodeBadResponse, err.Error()), nil
		}
		if err := m.bridge.Send(WsReq{Kind: KindReq, ID: id, Op: op, Args: args}); err != nil {
			return mcpToolError(ErrCodeNoWebapp, err.Error()), nil
		}

		select {
		case resp := <-ch:
			if !resp.OK {
				if resp.Error != nil {
					return mcpToolError(resp.Error.Code, resp.Error.Message), nil
				}
				return mcpToolError(ErrCodeBadResponse, "unsuccessful response without error payload"), nil
			}
			// Validate the webapp's result against the contract
			// outputSchema. A mismatch turns into a clean MCP error
			// instead of a malformed payload leaking to the client.
			if err := m.validator.ValidateOutput(op, resp.Result); err != nil {
				m.log.Warn("output schema validation failed", "op", op, "err", err)
				return mcpToolError(ErrCodeBadResponse, err.Error()), nil
			}
			return mcpToolSuccess(resp.Result), nil

		case <-time.After(m.requestTimeout):
			return mcpToolError(ErrCodeTimeout, fmt.Sprintf("no response within %s", m.requestTimeout)), nil

		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Run starts the MCP server on stdio and blocks until the client disconnects.
func (m *MCPServer) Run(ctx context.Context) error {
	transport := &mcp.StdioTransport{}
	return m.server.Run(ctx, transport)
}

// mcpToolSuccess packs the webapp's JSON result into a CallToolResult.
// We populate StructuredContent (visible to LLMs as parsed JSON) AND a text
// fallback (visible to clients that don't render structured content yet).
func mcpToolSuccess(result json.RawMessage) *mcp.CallToolResult {
	var structured any
	if len(result) > 0 {
		_ = json.Unmarshal(result, &structured)
	}
	text := string(result)
	if text == "" {
		text = "{}"
	}
	return &mcp.CallToolResult{
		Content:           []mcp.Content{&mcp.TextContent{Text: text}},
		StructuredContent: structured,
	}
}

// buildToolMeta surfaces tools.json's per-tool annotations (stability /
// deprecated) inside Tool.Meta. The MCP spec leaves Meta open for any
// extension key, so capable clients (or our own webapp tooling) can pick
// these up to render badges or filter the list.
func buildToolMeta(def ToolDef) mcp.Meta {
	if def.Stability == "" && !def.Deprecated {
		return nil
	}
	meta := mcp.Meta{}
	if def.Stability != "" {
		meta["faustcode.stability"] = def.Stability
	}
	if def.Deprecated {
		meta["faustcode.deprecated"] = true
	}
	return meta
}

// mcpToolError builds a CallToolResult with IsError=true and a machine-
// readable error code in the structured content.
func mcpToolError(code, message string) *mcp.CallToolResult {
	body := map[string]any{"code": code, "message": message}
	raw, _ := json.Marshal(body)
	return &mcp.CallToolResult{
		Content:           []mcp.Content{&mcp.TextContent{Text: string(raw)}},
		StructuredContent: body,
		IsError:           true,
	}
}
