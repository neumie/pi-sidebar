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
  ├─ dock: render-width reservation + non-capturing overlay
  └─ overlay: supported fallback without width reservation
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

### Overlay fallback

`auto` mode checks whether `render` is already an own property on the TUI instance. That indicates another extension may already wrap layout. Instead of stacking unsupported wrappers, the host uses a normal right overlay and leaves Pi at full width.

Narrow terminals hide both presentations rather than leave an unusably small editor.

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
13. Emit exactly one host-owned left divider on every sidebar row and no surrounding frame.
14. Keep every emitted row exactly the configured visible width and never exceed the current terminal height.
15. Give providers only their usable body width and remaining body-row budget; hidden panels consume no heading or spacing.

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

## Future native Pi API

When Pi exposes a column-reserving side-panel API, add a native surface adapter and prefer it through feature detection. Do not change the panel contract, provider protocol, renderer, or integration adapters.
