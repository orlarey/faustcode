// render_writer.go — sink for the render_audio tool's WAV payload.
//
// The webapp ships the rendered Float32 WAV bytes base64-encoded inside
// the WS resp.result under the `_wav_payload_base64` field. We pull that
// out, write the bytes to disk under TempDir/faustcode-renders/, and
// rewrite the result so the MCP client sees only the file path. The
// base64 never leaves the binary process.

package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	renderDirName = "faustcode-renders"
	// Files older than this at startup are pruned. Re-render the same
	// fingerprint and the file reappears ; we do not need long-term
	// persistence.
	renderTTL = 1 * time.Hour
	// Hard cap for the inlineAudio path : refuse to ship more than this
	// many WAV bytes through the MCP Content stream. 2 MB lets a 10 s
	// stereo @ 48 kHz Float32 (~3.8 MB) be refused with a clean error
	// instead of flooding the wire.
	maxInlineAudioBytes = 2 * 1024 * 1024
)

// renderDir returns the directory we write rendered WAV files to.
// Created lazily on first use ; cleaned at server startup.
func renderDir() string {
	return filepath.Join(os.TempDir(), renderDirName)
}

// setupRenderDir creates the render directory if missing and prunes any
// .wav file older than renderTTL. Errors are logged and swallowed —
// startup must not be blocked by a broken /tmp.
func setupRenderDir() error {
	dir := renderDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("render dir mkdir: %w", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil // best-effort prune
	}
	cutoff := time.Now().Add(-renderTTL)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".wav") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
	return nil
}

// processRenderAudio detects the underscore-prefixed wav payload in a
// render_audio response, writes the audio to disk, and returns the
// rewritten JSON (with `path` replacing the payload fields) plus the
// raw WAV bytes — the caller may attach those bytes as a standard MCP
// AudioContent block when the client asked for inlineAudio.
//
// Inputs without a `_wav_payload_base64` field (e.g. detail="light")
// pass through unchanged ; bytes return value is nil.
func processRenderAudio(result json.RawMessage) (json.RawMessage, []byte, error) {
	if len(result) == 0 {
		return result, nil, nil
	}
	var asMap map[string]json.RawMessage
	if err := json.Unmarshal(result, &asMap); err != nil {
		// Not an object → can't carry a payload, pass through.
		return result, nil, nil
	}
	payloadRaw, hasPayload := asMap["_wav_payload_base64"]
	if !hasPayload {
		return result, nil, nil
	}
	var payloadB64 string
	if err := json.Unmarshal(payloadRaw, &payloadB64); err != nil {
		return nil, nil, fmt.Errorf("render_audio: _wav_payload_base64 is not a string: %w", err)
	}
	bytes, err := base64.StdEncoding.DecodeString(payloadB64)
	if err != nil {
		return nil, nil, fmt.Errorf("render_audio: base64 decode failed: %w", err)
	}

	hintRaw, ok := asMap["_wav_filename_hint"]
	if !ok {
		return nil, nil, errors.New("render_audio: missing _wav_filename_hint")
	}
	var hint string
	if err := json.Unmarshal(hintRaw, &hint); err != nil {
		return nil, nil, fmt.Errorf("render_audio: _wav_filename_hint not a string: %w", err)
	}
	hint = sanitizeFilename(hint)
	if hint == "" {
		return nil, nil, errors.New("render_audio: empty filename hint after sanitization")
	}

	if err := os.MkdirAll(renderDir(), 0o755); err != nil {
		return nil, nil, fmt.Errorf("render_audio: mkdir: %w", err)
	}
	path := filepath.Join(renderDir(), hint)
	if err := os.WriteFile(path, bytes, 0o644); err != nil {
		return nil, nil, fmt.Errorf("render_audio: write file: %w", err)
	}

	// Build the rewritten result : strip the underscore-prefixed fields,
	// inject `path`. We keep the original key order best-effort by
	// rebuilding through json.RawMessage rather than re-marshalling
	// asMap (which would lose order on most maps).
	delete(asMap, "_wav_payload_base64")
	delete(asMap, "_wav_filename_hint")
	pathRaw, _ := json.Marshal(path)
	asMap["path"] = pathRaw
	rewritten, err := json.Marshal(asMap)
	if err != nil {
		return nil, nil, fmt.Errorf("render_audio: rewrite marshal: %w", err)
	}
	return rewritten, bytes, nil
}

// argsBoolField reads a boolean named `field` from the caller-supplied
// arguments. Returns the default value (false) when the field is absent
// or unparseable ; tool-level validation already caught explicit type
// errors earlier in the pipeline.
func argsBoolField(args json.RawMessage, field string) bool {
	if len(args) == 0 {
		return false
	}
	var asMap map[string]json.RawMessage
	if err := json.Unmarshal(args, &asMap); err != nil {
		return false
	}
	raw, ok := asMap[field]
	if !ok {
		return false
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err != nil {
		return false
	}
	return b
}

// sanitizeFilename strips path traversal and anything that's not a-z 0-9
// dot dash underscore. Keeps the basename only. Defence in depth — the
// webapp builds the hint from a SHA-1 prefix and a fingerprint so it
// shouldn't contain dodgy characters, but we don't trust an untrusted
// browser tab implicitly.
func sanitizeFilename(name string) string {
	name = filepath.Base(name)
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			b.WriteRune(r)
		}
	}
	out := b.String()
	if !strings.HasSuffix(out, ".wav") {
		out += ".wav"
	}
	return out
}
