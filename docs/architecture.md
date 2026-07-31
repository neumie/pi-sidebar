# Architecture

## Goal

`pi-sidebar` is one layout owner with many read-only panel providers. The public interface stays small while the unsupported Pi 0.83.x compatibility work remains local to one adapter.

```text
registerSidebarPanel()
        │
        ▼
versioned event protocol
        │
        ▼
session controller ──► bounded panel renderer
        │
        ▼
sidebar surface
  ├─ dock: render-width reservation + right overlay
  ├─ top: documented above-editor widget shelf
  ├─ bottom: pi-footer trailing slot with below-editor fallback
  └─ overlay: supported wide fallback without reservation
```

## Public seam

A provider knows four facts: stable identity, title/order, session connection lifecycle, and synchronous rendering. It does not know how the host obtains the TUI, reserves width, mounts overlays, handles reload, or chooses a future native API.

Registration uses versioned `pi.events` messages rather than a public mutable global. Providers announce immediately and again whenever a host emits readiness. Each registration has an opaque token; replacement is atomic by panel id and stale unregister messages are ignored.

A private `Symbol.for` slot elects one host instance during reload. It does not carry panel state or form part of the provider interface.

## Layout adapters

### Dock

The dock adapter captures the active `tui.render` function and replaces it with a wrapper that passes `terminalWidth - sidebarWidth - gutter` to the captured renderer. Pi therefore wraps its normal transcript, editor, widgets, and custom footer at the reduced width.

The sidebar itself is one `TUI.showOverlay()` component anchored at top-right with `nonCapturing: true`. TUI overlay compositing still uses the physical terminal width, so it paints into the columns withheld from the main renderer.

The renderer is a flat, unlabeled activity rail: every emitted row has one host-owned dim-gray left divider and one content inset, with no reserved trailing padding. Panel bodies add one more column of indentation, so a configured width `W` yields provider body width `W - 3`. This compact hierarchy distinguishes live values from section labels while returning three columns to provider content. The divider itself is sufficient separation, so the default dock gutter is zero. Whitespace separates visible sections; no top, right, bottom, or horizontal-rule chrome is emitted. The empty state names the state and directs the user to start a subagent or background job.

### Configurable narrow shelf

When the right rail does not fit and the terminal is at least 32 columns by 32 rows, the controller mounts the seven-row shelf without claiming root lines. `top` uses Pi's documented `aboveEditor` widget placement. `bottom` requests `pi-footer`'s versioned, session-scoped post-footer capability and registers the same bounded renderer there, producing editor → footer → shelf. If that capability is missing, incompatible, replaced, or inactive, the existing documented `belowEditor` widget immediately resumes as the safe fallback.

The adaptive widget returns no rows while a live post-footer handle owns bottom placement or when the rail fits, and is remounted when the configured position changes. Capability and registration handles are exact-session and generation-safe. Replacement is atomic: a failed capability leaves the current live handle untouched; a successful replacement is installed before the prior handle is disposed. Session/widget teardown disposes the active handle. Neither path appends, deletes, overwrites, or inspects root/editor lines, so transient slash roots remain entirely Pi-owned.

The shared narrow renderer uses six content rows and one full-width dim-gray divider: below content in `top`, above content in `bottom`. It always stacks visible panels in one column using the shelf's full usable width. Panels may opt out of their narrow title only when their body is self-identifying; the built-in activity adapters use an accent `◆` for agents and a success `▸` for background jobs. The reclaimed heading row and inset return directly to that provider. A panel may use up to five body rows; actual returned rows determine what remains for later panels, and panel detail takes precedence over an inter-panel spacer.

### Overlay fallback

`auto` mode checks whether `render` is already an own property on the TUI instance. That indicates another extension may already wrap layout. Instead of stacking unsupported wrappers, the host uses a normal right overlay on wide terminals and leaves Pi at full width. On narrow terminals, the documented editor widget remains safe and available because it does not depend on render ownership. Forced `overlay` mode is wide-only and hides the narrow widget.

Terminals that fit neither the right rail nor the minimum narrow geometry hide the activity surface. Explicit `/sidebar off` does the same. While hidden, the controller gathers optional synchronous `hiddenStatus()` values, sanitizes and bounds each one, and writes their aggregate through Pi's documented `ctx.ui.setStatus()` seam. This keeps the footer generic: the sidebar and its adapters retain all activity ownership, and only private-ID-free counts such as `◆ 2 agents · ▸ 3 jobs` reach the right-side footer status area. Visible dock, overlay, and narrow backends clear that status.

## Invariants

1. Never call `ctx.ui.setFooter()`.
2. Never capture editor focus or terminal input.
3. Always call Pi's previous renderer; sidebar failure cannot blank the main UI.
4. Restore the previous renderer only when this host still owns the slot.
5. If a later extension wraps this host, disposal makes the retained wrapper inert.
6. Hide rather than reserve width below the responsive threshold.
7. Dispose the exact overlay handle, not the topmost overlay.
8. Keep provider rendering synchronous, width-bounded, and error-isolated.
9. Abort and dispose every panel connection on reload/session shutdown.
10. Ignore late async connection completions from stale session generations.
11. Let missing optional integrations produce no panel rather than warnings.
12. Keep data adapters on documented event/RPC contracts; do not deep-import peer internals.
13. Emit one host-owned structural edge: left for the right rail, below a top shelf, or above a bottom shelf; never surround a surface with a frame.
14. Keep every emitted row exactly the configured visible width and never exceed the current terminal height.
15. Give providers only their usable body width and remaining body-row budget; hidden panels consume no heading or spacing.
16. Select `dock`, configured `top`/`bottom`, `overlay`, or `hidden` from current terminal dimensions on every render; resizing requires no remount.
17. Narrow shelves use documented editor widgets or the versioned `pi-footer` post-footer capability and never mutate or inspect root lines.
18. Render exactly one narrow-bottom copy: prefer a live post-footer handle, otherwise use the `belowEditor` fallback; top remains `aboveEditor`.
19. Keep the right overlay non-capturing and owned through its exact handle.
20. Publish bounded, private-ID-free panel summaries through Pi's footer-status seam only while the sidebar backend is hidden; clear them on every visible backend and session teardown.
21. Render integration health only from explicit actionable evidence; healthy, inactive, lazy, cached, malformed, and unknown states consume no panel rows.
22. Render config freshness only from bounded v1 `update` snapshots; current, attention-only, error, and age-held states consume no panel rows.

## Integration contracts

### pi-subagents-goal

- request/replay: `@neumie/pi-subagents-goal:v1:status-request` with exact `sessionId`;
- state: `@neumie/pi-subagents-goal:v1:status` with provider ID and monotonic sequence;
- display fields: objective, phase, timestamps, aggregates, at most 128 recent work labels plus omitted count, optional limits/usage, continuation/review state, and generic reason.

The adapter validates the complete v1 display DTO, rejects foreign sessions, stale sequences, malformed counters and cross-field inconsistencies, and sanitizes every rendered line through the host. It never receives session files, owner/item IDs, acknowledgement/review tokens, digests, raw faults, or child output. Completed/cancelled goals consume no rows.

### pi-subagents

- discovery: `subagents:rpc:v1:ready`
- request: `subagents:rpc:v1:request`
- reply: `subagents:rpc:v1:reply:<requestId>`
- refresh signals: `subagent:async-started`, `subagent:async-complete`, `subagent:foreground-complete`, `subagent:control-event`
- reconciliation: bounded `status` polling after successful `ping`

When `ping.capabilities.fleetStatus` is `{ version: 1 }`, the v1 status reply additionally exposes a bounded, current-session `fleet` DTO with opaque reconciliation keys, resolved agent roles, elapsed timestamps, model/effort, split token usage, caller-facing goals, and total/omitted counts. The adapter prefers that structured capability and never displays its opaque keys. A bounded overflow row right-aligns `/subagents-fleet` when the usable width permits, linking to the peer's inspection-only fleet surface without exposing identifiers. Older peers fall back only to an ID-safe active-run count; human child-detail text is never rendered.

### pi-background-jobs

- refresh and initial snapshot: `background-jobs:changed`
- stable aggregate fields: `runningCount`, `terminalRecentCount`, optional `oldestStart`, and optional primary job metadata
- optional structured fields from `pi-background-jobs` 0.3.0+: newest-first `running` summaries (maximum 16) and exact `runningOmitted`

Each structured summary carries only an optional bounded display label and `startedAt`; it intentionally has no command, path, or private job id. The adapter validates aggregate/list consistency, fills the body-row budget with jobs, and reserves an overflow row only when jobs are actually hidden. That overflow row right-aligns the `/jobs` manager hint when the usable body width can hold both summary and hint; otherwise the summary wins. Older aggregate-only payloads remain valid. The event intentionally omits full job output and paths, and the sidebar does not bypass that privacy boundary.

### Config status

- discovery: `@neumie/config-status:v1:ready`
- request: `@neumie/config-status:v1:request`
- snapshot: `@neumie/config-status:v1:snapshot`
- display fields: checked timestamp, at most 64 actionable update names/kinds/versions/summaries, and an omitted count capped at 10,000

The adapter requests once per connection; successful `/config-status` runs publish through the same snapshot event. It validates the complete bounded payload, rejects controls and malformed versions/counts, and renders only immediately eligible `update` entries. It does not poll, inspect `pi-config` internals, or display current, dirty/attention-only, failed-verification, or age-held entries. A missing provider leaves the panel absent.

### LSP health through pi-footer

Pi 0.83.0 exposes its read-only extension-status map only to custom footer factories. `pi-footer` therefore publishes a temporary capability rather than pushing snapshots from its render path:

- request: `pi-footer:status-source:v1:request` with `{ version: 1, sessionId }`
- ready/replay: `pi-footer:status-source:v1:ready` with `{ version: 1, sessionId, token, readStatuses }`
- lifecycle: the getter returns a fresh bounded copy and becomes empty after footer disposal or session replacement

The adapter accepts only the current session's source and pulls it during normal sidebar renders. It recognizes only the exact `pi-lens-lsp` `LSP Failed:` state already selected by Pi Lens's tested sibling/fallback policy. The sidebar never reads mutable footer state and still never owns the footer.

### MCP health

The MCP adapter consumes Pi's documented `tool_result` lifecycle and structured results from the generic `mcp` tool. A full `mode: "status"` result authoritatively replaces MCP issues; only `needs-auth` and `failed` are degraded. Recognized reactive failures are limited to authentication, connect/backoff, unavailable-server, and initialization failures emitted by that tool. Successful `mcp` connect/call results clear the corresponding issue. Direct and unrelated application tools are deliberately ignored even if they reuse the same detail field names; lazy, cached, ordinary disconnected, aborted, input-validation, and application-tool failures are also hidden.

This is deliberately reactive: `pi-mcp-adapter` has no documented push health event. The adapter neither polls private state nor deep-imports the peer.

## pi-footer post-footer composition

Pi 0.83.0 hardcodes `belowEditor` widgets before its footer and offers no `belowFooter` placement. `pi-footer` 0.4.0 therefore exposes `pi-footer:post-footer:v1:request` / `ready`. The ready payload carries an exact-session registration function; the sidebar contributes only its synchronous bounded renderer and keeps ownership of all activity state. The footer validates and caps lines, isolates failures, and returns a handle whose `isActive()` state controls the ordinary widget fallback. Replayed capabilities replace handles atomically, and stale handles cannot suppress a replacement session's widget.

## Future native Pi API

When Pi exposes native side-, top-, or below-footer reservation APIs, add a native surface adapter and prefer it through feature detection. Do not change the panel contract, provider protocol, renderers, or integration adapters.
