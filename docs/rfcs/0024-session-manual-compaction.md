---
id: 0024
title: Session V2 Manual Compaction Compatibility
status: accepted
authors:
  - hammershock
created: 2026-09-25
updated: 2026-09-25
implemented-by: []
depends-on:
  - 0003
  - 0006
---

# RFC-0024: Session V2 manual compaction compatibility

## Motivation

The legacy `session.summarize` endpoint and TUI `/compact` action still exist after Session V2 became the default prompt backend. They currently write a V1 compaction part and call the V1 loop. A V2-backed Session therefore fails or gains an incompatible second transcript. The V2 history code already supports durable compaction checkpoints, but its explicit `SessionV2.compact` operation is unavailable. This RFC defines the missing manual operation before implementation issue #623 changes those paths.

## Contract

1. `session.summarize` keeps its request (`providerID`, `modelID`, optional `auto`) and Boolean success response. V1-backed Sessions keep their existing flow. V2-backed Sessions use only the canonical V2 transcript and compaction events. The TUI action keeps the `/compact` and `/summarize` names and passes its selected model through the existing request. The V2 `POST /api/session/:id/compact` endpoint calls the same domain operation, using the Session's effective selected model when no explicit model is supplied.
2. Manual compaction is a Session-scoped execution operation, serialized with the process-local V2 drain. It does not cancel an active provider turn or Task. If one is active, the request fails as busy before starting a provider call. An accepted prompt may remain in the durable inbox; the checkpoint covers only the visible history at the operation's start. A later wake observes the completed checkpoint before continuing. The operation does not promote pending prompts or start an unrelated provider turn.
3. The explicitly requested model is used only for the summarizing provider call. It does not switch the Session's persistent model or Agent. Without an explicit model, resolve the effective model from the current Session selection. The selected Agent remains Session state; its policy and Location govern access, but manual compaction does not run its tools or system prompt. This matches V2 automatic compaction's summarizer request shape.
4. Manual compaction uses the same structured summary, recent-context representation, Skill snapshot retention, and Context Epoch reset semantics as automatic compaction. The durable `Compaction.Started` and `Compaction.Ended` events have `reason: "manual"`. Only a completed `Ended` event changes model-visible history. A short Session still produces a checkpoint by summarizing its visible conversation; a Session with no visible content returns a clear no-content error.
5. A failed provider call, empty summary, interruption, or invalid model leaves the prior history boundary active. The legacy endpoint returns a non-success HTTP response rather than `true`; the V2 endpoint reports a typed operation error. A retry may start a new attempt after a failure. The attempt's durable start event is diagnostic and never interpreted as a completed checkpoint.
6. Exactly one summarizer request is made per accepted attempt. The operation does not issue a follow-up provider turn. If a caller has a pending prompt, its normal wake handles the continuation. The TUI surfaces an error from the existing action instead of silently clearing the dialog on failure.

## Authority and persistence

The operation uses the Session's Location and existing provider credentials. It changes only Session-owned durable history through a completed checkpoint; it does not update project instructions, environment configuration, persistent Agent/model defaults, or other Sessions. The summary and Skill snapshots are replayable and syncable through the existing V2 event path. No local paths or credentials are added to the checkpoint beyond data already admitted into the Session.

## Acceptance

- V1 and V2 requests through the same legacy endpoint retain the documented shape, and V2 leaves V1 message/part tables untouched.
- A completed manual checkpoint replays with the same recent context and Skill snapshots on a fresh process; a failed or interrupted attempt leaves the previous context usable.
- Explicit model choice affects the summarizer request only. Busy execution and empty history have precise errors and no provider or checkpoint side effects.
- The exact clean Mac candidate runs TUI `/compact` and the HTTP endpoint on both backends. Remote Location behavior is exercised where selected by the testing workflow.

## Implementation boundary

Issue #623 owns the domain operation, legacy adapter, tests, and generated artifacts if its public API changes. The accepted contract authorizes implementation after issue #623 meets the Ready criteria.
