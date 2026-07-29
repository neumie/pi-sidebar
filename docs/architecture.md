# Architecture

## Goal

`pi-sidebar` is one layout owner with many read-only panel providers. The public interface stays small while the unsupported Pi 0.82.x compatibility work remains local to one adapter.

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
  ├─ top: visible-row replacement + full-width top overlay
  ├─ bottom: appended-row reservation + full-width bottom overlay
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

The renderer is a flat, unlabeled activity rail: every emitted row has one host-owned dim-gray left divider, two columns of content inset, and one trailing padding column. Panel bodies add two more columns of indentation, so a configured width `W` yields provider body width `W - 6`. That small terminal-specific sub-inset distinguishes live values from section labels while the rail remains the single structural edge. Whitespace separates visible sections; no top, right, bottom, or horizontal-rule chrome is emitted. The empty state names the state and directs the user to start a subagent or background job.

### Configurable narrow shelf

When the right rail does not fit and the terminal is at least 32 columns by 32 rows, the wrapper reserves eight full-width rows using the configured narrow position.

- `top` computes the current viewport start and replaces its first eight root rows with width-matched blanks. Root length and lower-row positions stay unchanged.
- `bottom` appends eight blank rows after Pi's root. The viewport advances by eight, moving Pi's editor and footer upward while preserving their order and placing the shelf physically below the footer.

Transient or foreign roots shorter than the viewport are left untouched because their row roles are unknowable. Exact non-capturing overlays at `top-left` and `bottom-left` are independently mounted but mutually gated; only the configured, successfully reserved position renders in a frame.

The shared narrow renderer uses seven content rows and one full-width dim-gray divider: below content in `top`, above content in `bottom`. It always stacks visible panels in one column using the shelf's full usable width. Each panel receives at most two summary body rows.

### Overlay fallback

`auto` mode checks whether `render` is already an own property on the TUI instance. That indicates another extension may already wrap layout. Instead of stacking unsupported wrappers, the host uses a normal right overlay on wide terminals and leaves Pi at full width. It deliberately hides on narrow terminals: an unreserved top or bottom overlay would cover Pi content.

Terminals that fit neither the right rail nor the minimum narrow geometry hide the activity surface.

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
17. Top reservation may replace only the first visible viewport rows; bottom reservation may only append bounded blank rows after Pi's root.
18. Never show a narrow overlay unless the same frame successfully reserved its rows; preserve short root frames unchanged rather than guessing which rows belong to the editor or footer.
19. Keep right, top, and bottom overlays non-capturing, mutually exclusive, and owned through their exact handles.
20. Render integration health only from explicit actionable evidence; healthy, inactive, lazy, cached, malformed, and unknown states consume no panel rows.

## Integration contracts

### pi-subagents

- discovery: `subagents:rpc:v1:ready`
- request: `subagents:rpc:v1:request`
- reply: `subagents:rpc:v1:reply:<requestId>`
- refresh signals: `subagent:async-started`, `subagent:async-complete`, `subagent:foreground-complete`, `subagent:control-event`
- reconciliation: bounded `status` polling after successful `ping`

The v1 status contract currently returns display text plus generic tool details. The adapter consumes that public text conservatively and treats unknown formatting as bounded lines.

### pi-background-jobs

- refresh and initial snapshot: `background-jobs:changed`
- stable fields: `runningCount`, `terminalRecentCount`, optional `oldestStart`, and optional primary job metadata

The event intentionally omits full job output and paths. The sidebar does not bypass that privacy boundary.

### LSP health through pi-footer

Pi 0.82.1 exposes its read-only extension-status map only to custom footer factories. `pi-footer` therefore publishes a temporary capability rather than pushing snapshots from its render path:

- request: `pi-footer:status-source:v1:request` with `{ version: 1, sessionId }`
- ready/replay: `pi-footer:status-source:v1:ready` with `{ version: 1, sessionId, token, readStatuses }`
- lifecycle: the getter returns a fresh bounded copy and becomes empty after footer disposal or session replacement

The adapter accepts only the current session's source and pulls it during normal sidebar renders. It recognizes only the exact `pi-lens-lsp` `LSP Failed:` state already selected by Pi Lens's tested sibling/fallback policy. The sidebar never reads mutable footer state and still never owns the footer.

### MCP health

The MCP adapter consumes Pi's documented `tool_result` lifecycle and structured results from the generic `mcp` tool. A full `mode: "status"` result authoritatively replaces MCP issues; only `needs-auth` and `failed` are degraded. Recognized reactive failures are limited to authentication, connect/backoff, unavailable-server, and initialization failures emitted by that tool. Successful `mcp` connect/call results clear the corresponding issue. Direct and unrelated application tools are deliberately ignored even if they reuse the same detail field names; lazy, cached, ordinary disconnected, aborted, input-validation, and application-tool failures are also hidden.

This is deliberately reactive: `pi-mcp-adapter` has no documented push health event. The adapter neither polls private state nor deep-imports the peer.

## Future native Pi API

When Pi exposes native side- or top-panel reservation APIs, add a native surface adapter and prefer it through feature detection. Do not change the panel contract, provider protocol, renderers, or integration adapters.
