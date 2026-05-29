// schema_validator.go — defence-in-depth JSON Schema validation of
// every WsReq.args sent to the webapp AND every WsResp.result received
// from it. Catches drift between tools.json and the actual handlers
// before the malformed payload propagates to the MCP client.
//
// Implementation uses github.com/santhosh-tekuri/jsonschema/v5 with
// JSON Schema draft 2020-12. Per-tool schemas are wrapped with the
// contract-level $defs so $ref="#/$defs/X" resolves naturally.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

// SchemaValidator holds one compiled input + output schema per tool.
type SchemaValidator struct {
	inputs  map[string]*jsonschema.Schema
	outputs map[string]*jsonschema.Schema
}

// NewSchemaValidator compiles every tool's input and output schema.
// A nil contract or absence of schemas yields a validator that lets
// everything through (no-op).
func NewSchemaValidator(contract *ToolsContract) (*SchemaValidator, error) {
	v := &SchemaValidator{
		inputs:  make(map[string]*jsonschema.Schema),
		outputs: make(map[string]*jsonschema.Schema),
	}
	if contract == nil {
		return v, nil
	}
	defs := contract.Defs

	for _, tool := range contract.Tools {
		if len(tool.InputSchema) > 0 {
			s, err := compileWithDefs(tool.Name+".input", tool.InputSchema, defs)
			if err != nil {
				return nil, fmt.Errorf("compile inputSchema for %q: %w", tool.Name, err)
			}
			v.inputs[tool.Name] = s
		}
		if len(tool.OutputSchema) > 0 {
			s, err := compileWithDefs(tool.Name+".output", tool.OutputSchema, defs)
			if err != nil {
				return nil, fmt.Errorf("compile outputSchema for %q: %w", tool.Name, err)
			}
			v.outputs[tool.Name] = s
		}
	}
	return v, nil
}

// ValidateInput checks args against the tool's input schema. Returns
// nil if validation succeeds, an error describing the mismatch
// otherwise. Tools without a registered schema pass through.
func (v *SchemaValidator) ValidateInput(toolName string, args json.RawMessage) error {
	if v == nil {
		return nil
	}
	schema, ok := v.inputs[toolName]
	if !ok || schema == nil {
		return nil
	}
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	var v2 any
	if err := json.Unmarshal(args, &v2); err != nil {
		return fmt.Errorf("args is not JSON: %w", err)
	}
	if err := schema.Validate(v2); err != nil {
		return fmt.Errorf("args does not match inputSchema of %q: %w", toolName, err)
	}
	return nil
}

// ValidateOutput checks result against the tool's output schema.
func (v *SchemaValidator) ValidateOutput(toolName string, result json.RawMessage) error {
	if v == nil {
		return nil
	}
	schema, ok := v.outputs[toolName]
	if !ok || schema == nil {
		return nil
	}
	if len(result) == 0 {
		result = json.RawMessage(`null`)
	}
	var v2 any
	if err := json.Unmarshal(result, &v2); err != nil {
		return fmt.Errorf("result is not JSON: %w", err)
	}
	if err := schema.Validate(v2); err != nil {
		return fmt.Errorf("result does not match outputSchema of %q: %w", toolName, err)
	}
	return nil
}

// compileWithDefs wraps a per-tool schema with the contract-level
// $defs so internal $refs resolve. The wrapped document is registered
// in a fresh compiler instance (one compiler per schema keeps things
// hermetic ; the contract is small).
func compileWithDefs(name string, raw json.RawMessage, defs map[string]json.RawMessage) (*jsonschema.Schema, error) {
	doc, err := wrapWithDefs(raw, defs)
	if err != nil {
		return nil, err
	}
	c := jsonschema.NewCompiler()
	c.Draft = jsonschema.Draft2020
	if err := c.AddResource(name, bytes.NewReader(doc)); err != nil {
		return nil, err
	}
	return c.Compile(name)
}

func wrapWithDefs(raw json.RawMessage, defs map[string]json.RawMessage) ([]byte, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	// Don't overwrite an existing $defs the tool author wrote on purpose.
	if _, has := m["$defs"]; !has && len(defs) > 0 {
		out := make(map[string]any, len(defs))
		for k, v := range defs {
			var d any
			if err := json.Unmarshal(v, &d); err != nil {
				return nil, fmt.Errorf("$defs.%s: %w", k, err)
			}
			out[k] = d
		}
		m["$defs"] = out
	}
	return json.Marshal(m)
}
