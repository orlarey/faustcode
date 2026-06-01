# ONBOARDING-GUIDE

How to drive faustcode from an AI client over MCP. This document is
served by the `get_onboarding_guide` tool and is addressed to you,
the AI agent.

---

## Who this guide is for

You are an MCP client (Claude Desktop, Claude Code, or any other)
connected to the `faustcode-mcp` bridge. You are driving a faustcode
session running in the user's browser. The formal contract for the
tools lives in `tools.json` (field `contractVersion`) and reaches you
via the standard `tools/list` call at session start — that contract
is the authoritative source for every input and output schema.

---

## Fundamental constraint: you are deaf

You have **no access whatsoever to the audio** rendered by faustcode:

- The MCP `AudioContent` channel is not hydrated by current clients.
- The audio played in real time inside the user's browser is not
  routed back to you either.

Your main feedback channel is therefore `render_audio detail=metrics`,
which returns a vector of descriptors (see `$defs/AudioMetricsV2` in
the contract). You reason about those numbers, dimension by
dimension, the way a sound engineer reads a spectrum analyser and a
VU meter — not the way a listener hears a sound.

---

## The flagship scenario: reproducing a sound provided by the user

The user gives you a target audio recording (foghorn, bell, voice,
instrument, …) and asks you to reproduce it in Faust. Follow this
sequence:

| #  | Step                                                                  | MCP tools                       |
| :-: | :------------------------------------------------------------------- | :------------------------------ |
| 1  | Receive the target WAV and the user's intent (outside faustcode)      | —                               |
| 2  | Submit a **first DSP hypothesis** — minimal but compiling             | `submit`                        |
| 3  | **Discover the UI paths** of the current patch                        | `get_run_ui`                    |
| 4  | Render the sound and collect descriptors `vₙ`                         | `render_audio detail=metrics`   |
| 5  | Compare `vₙ` against the target, dimension by dimension               | (reasoning)                     |
| 6  | Edit the code targeting the most-deviating dimension and resubmit     | `submit`                        |
| 7  | Loop 3 → 6 until the descriptors are close enough                     | —                               |
| 8  | **Start the patch in real time** to signal the end of iteration       | `run_audio` (start)             |
| 9  | The user listens, gives you verbal feedback, you loop back to 3       | —                               |

A few unwritten rules:

- **Step 3 is not optional.** You cannot guess UI paths from the
  source code or from the filename. Patches are compiled under the
  canonical name `dsp`, so a `button("blast")` becomes `/dsp/blast` —
  but that convention may evolve; `get_run_ui` is the authoritative
  source.
- **At step 6, change one dimension at a time.** If the centroid is
  too high, adjust the lowpass before touching the envelope.
  Iterating one dimension per cycle gives you a clean progress (or
  regression) signal.
- **Keep a mental log of past `vₙ`.** It lets you detect a regression
  — a descriptor that gets worse after an edit that was meant to
  improve it.

---

## Why step 8 (real-time playback) is mandatory

Without it, the user has no way to know you are done iterating: all
they see is a stream of `submit` / `render_audio` calls with no
indication that it is now their turn to judge. Starting the patch in
real time via `run_audio` hands the floor back to them and lets them
listen.

It is the human who closes the final loop — you only optimised
numbers.

---

## When to ask the user to upload the rendered WAV

If you are torn between two versions, or you suspect a descriptor is
not telling the whole story, you can:

1. Call `render_audio detail=wav` ; you receive a path to a `.wav`
   file on the user's disk (typically under `/tmp/faustcode-renders/`).
2. Ask the user to **upload** that file into the conversation —
   depending on your multimodal capabilities, you can then analyse it
   yourself in addition to the descriptors.

This is a fallback, not the main loop.

---

## Common anti-patterns

- **Skipping `get_run_ui`** before `set_run_param`, or before filling
  `paramSetup` in `render_audio` — you will invent paths that do not
  exist and receive `op_unknown`.
- **Stopping at step 7** without starting real-time playback — the
  user will not know you are done.
- **Believing you can hear the sound** — you never do; every decision
  must be grounded in descriptors or in verbal user feedback.
- **Editing several dimensions at once** between renders — you lose
  the trace of what improved what.
- **Resubmitting the same code under a different filename** hoping
  for a different result — the sha1 (and therefore the rendered
  audio) is determined by the code content.

---

## Going further

- Exact descriptor schema: `$defs/AudioMetricsV2` in the contract.
- Compact spectrum format: `$defs/SpectrumSummaryV1` in the contract.
- Full list of tools and their parameters: served by `tools/list` at
  MCP session start.
