# pi-sidebar

A docked, extensible activity sidebar for [Pi](https://pi.dev), rendered as a flat Helm-inspired activity rail.

```text
Wide terminal
Pi transcript and tools                         │
                                                │  Subagents
                                                │    ● reviewer · 18s
                                                │
Pi editor and session footer                    │  Background jobs
                                                │    ● Typecheck · 7s

Narrow + tall terminal (default: bottom)
Pi conversation

› editor
Pi session footer
────────────────────────────────────────────────────
  Subagents                         Background jobs
    ● reviewer · 18s                  ● Typecheck · 7s
```

## Features

- Reserves a right-hand column so Pi's transcript, editor, widgets, and footer reflow instead of rendering underneath it.
- Minimal chrome: one quiet structural divider—left for the right rail, above a bottom shelf, or below a top shelf—plus whitespace hierarchy and accent reserved for live activity.
- Does not replace the footer; with [`pi-footer`](https://github.com/neumie/pi-footer) 0.4.0 or newer, the narrow-bottom shelf composes after the footer.
- Zero-config [`pi-subagents`](https://github.com/neumie/pi-subagents) panel through its versioned in-process RPC and lifecycle events.
- Zero-config [`pi-background-jobs`](https://github.com/neumie/pi-background-jobs) panel through its stable `background-jobs:changed` event.
- Degraded-only Integrations panel for actionable LSP failures and observed MCP authentication/connectivity failures; healthy, inactive, cached, and lazily disconnected integrations stay hidden.
- One layout owner for multiple independently installed panel providers.
- Non-capturing UI: normal keyboard input stays with Pi's editor.
- Adaptive responsive layout: right rail on wide terminals; configurable bottom dock or top shelf on narrow but very tall terminals; hidden when neither fits.
- Safe overlay fallback when another extension already wraps Pi's root renderer.
- Reload-safe, token-safe panel registration.

## Install

```bash
pi install git:github.com/neumie/pi-sidebar
```

Then restart Pi or run `/reload`.

For local development:

```bash
pi install /absolute/path/to/pi-sidebar
```

Pi packages execute with your full system permissions. Review extension source before installing.

## Commands

```text
/sidebar                         toggle visibility
/sidebar on | off                explicitly show or hide
/sidebar status                  report mode, backend, width, and panel count
/sidebar width 42                set runtime width (24–80 columns)
/sidebar mode auto               choose a safe responsive layout
/sidebar mode dock               reserve the right rail when it fits
/sidebar mode overlay            use Pi's supported wide overlay behavior
/sidebar narrow bottom           place narrow mode after a compatible footer (default)
/sidebar narrow top              place narrow mode above the editor
```

Runtime command changes are session-scoped. Environment defaults:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_SIDEBAR_ENABLED` | `1` | Set to `0` to start hidden. |
| `PI_SIDEBAR_MODE` | `auto` | `auto`, `dock`, or `overlay`. |
| `PI_SIDEBAR_WIDTH` | `42` | Sidebar columns. |
| `PI_SIDEBAR_GUTTER` | `1` | Blank columns between Pi and the sidebar. |
| `PI_SIDEBAR_MIN_MAIN_WIDTH` | `64` | Minimum columns preserved beside the right rail. |
| `PI_SIDEBAR_NARROW_POSITION` | `bottom` | `bottom` after a compatible footer, or `top` above the editor. |
| `PI_SIDEBAR_NARROW_ROWS` | `7` | Rows rendered by the narrow shelf. |
| `PI_SIDEBAR_NARROW_MIN_WIDTH` | `32` | Minimum terminal width for narrow mode. |
| `PI_SIDEBAR_NARROW_MIN_HEIGHT` | `32` | Minimum terminal height for narrow mode. |

The former `PI_SIDEBAR_TOP_*` geometry variables remain accepted as fallback aliases when their corresponding remaining `PI_SIDEBAR_NARROW_*` variable is unset.

In `auto` and `dock` modes, the right rail wins whenever the terminal can fit the configured main width, gutter, and sidebar width. Otherwise a terminal at least 32 columns wide and 32 rows tall gets a seven-row, single-column narrow shelf. `narrow bottom` registers a bounded post-footer renderer when `pi-footer` 0.4.0 or newer is present, producing editor → footer → shelf; with Pi's built-in footer or an older custom footer it safely falls back to the documented `belowEditor` widget. `narrow top` always uses the documented `aboveEditor` widget. Smaller terminals hide the activity surface.

The configured right-rail width includes the divider and internal padding. Right-rail providers receive `configured width - 6` body columns; narrow-shelf providers receive the shelf's full usable width. Provider height always excludes host-owned headings and section spacing.

## Built-in integrations

### pi-subagents

The adapter listens for `subagents:rpc:v1:ready`, sends versioned `ping` and `status` requests, and uses async lifecycle events for immediate refresh. It polls only after the RPC is available. Missing or incompatible subagent installations simply hide the panel.

Foreground `subagent` tool calls are shown immediately from Pi's public tool lifecycle. When the peer advertises `fleetStatus` v1, each active child shows its role and elapsed time, footer-style model/effort and `↑input ↓output` usage, plus its caller-facing goal. The bounded RPC snapshot carries an omitted count so narrow surfaces can report hidden children without exposing run IDs. Older peers degrade to an ID-free active count; no private modules are imported.

### pi-background-jobs

The adapter consumes the stable `background-jobs:changed` payload. The current producer contract exposes aggregate counts and one primary job, so the panel shows the primary label, elapsed time, running count, and recent count—not a complete job list. `/jobs` remains the detailed manager.

### Degraded integrations

The `Integrations` section is absent unless action is required:

- **LSP:** with `pi-footer` 0.3.0 or newer installed, the sidebar reads Pi Lens's existing `pi-lens-lsp` status through the footer's versioned, session-scoped status-source capability. Only `LSP Failed:` is shown; active, inactive, missing, and malformed statuses are hidden.
- **MCP:** the adapter observes Pi's public `tool_result` lifecycle for the generic `mcp` tool. Structured status snapshots show only `needs-auth` and recent `failed` servers. Reactive `auth_required`, connection failure/backoff, unavailable-server, and initialization failures are shown until an authoritative healthy snapshot or a successful `mcp` operation confirms recovery.

Normal MCP lazy states (`cached` and `not connected`), aborted calls, invalid input, and application-level MCP tool errors are not integration degradation. MCP health is reactive because `pi-mcp-adapter` currently publishes no push health event; run `mcp({})` for an authoritative refresh.

## Add a panel

Install the package as a dependency, then register one read-only panel from your extension:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSidebarPanel } from "@neumie/pi-sidebar";

export default function deployments(pi: ExtensionAPI): void {
  let active = 0;

  registerSidebarPanel(pi, {
    id: "acme.deployments",
    title: "Deployments",
    order: 300,

    connect({ invalidate, signal }) {
      const unsubscribe = pi.events.on("acme:deployments-changed", (payload) => {
        if (payload && typeof payload === "object" && "active" in payload) {
          active = Number((payload as { active: unknown }).active) || 0;
          invalidate();
        }
      });
      signal.addEventListener("abort", unsubscribe, { once: true });
      return unsubscribe;
    },

    render({ theme }) {
      return active > 0
        ? [theme.fg("accent", `● ${active} active`)]
        : [];
    },
  });
}
```

Panel rules:

- `id` is globally unique and stable.
- `title` is short and sentence case; the host preserves provider wording rather than rewriting it.
- `render()` is synchronous and returns bounded terminal lines.
- `render({ width, height, surface })` receives only the usable panel-body area, after the host divider, padding, title, and section spacing; `surface` is `right` or `narrow`.
- Returning no lines hides the panel section.
- `connect()` owns subscriptions or timers and returns their disposer.
- The host clips every line and isolates render/connect failures by panel, including malformed or hostile output values.
- Registration replays after host readiness, so package load order does not matter.
- A stale disposer cannot remove a newer registration with the same id.

## Compatibility

Pi 0.82.1 does not expose a native column-reserving side-panel API. In `auto` mode this package uses the least invasive working technique found in current community packages:

1. capture Pi's public `TUI` through a zero-height widget factory;
2. wrap `tui.render(width)` so the normal UI receives the remaining main width;
3. mount one exact, non-capturing right overlay in the reserved columns;
4. restore the renderer with compare-and-swap teardown.

The renderer wrapper is version-sensitive. If another extension already owns an instance-level renderer wrapper, `auto` mode falls back to a normal wide overlay rather than stacking layout patches; narrow mode remains available because it does not need render ownership. Forced `overlay` mode is wide-only and hides the narrow shelf. Narrow mode never appends, deletes, overwrites, or inspects Pi root lines: it uses documented editor widgets plus the optional versioned `pi-footer` post-footer capability. This keeps slash completion and other transient editor UI entirely Pi-owned. If Pi later adds a native side-panel or below-footer API, only the private surface adapter needs to change; panel providers and integrations stay unchanged.

See [`docs/architecture.md`](docs/architecture.md) for invariants and trade-offs.

## Development

```bash
npm install --ignore-scripts
npm run check
```

Requires Node.js 22.19 or newer. Pi loads the TypeScript extension directly; there is no build step.

## Acknowledgements

The compatibility approach was informed by the Pi sidebar ecosystem, especially the public-overlay design in [`jrimmer/pi-sidebar`](https://github.com/jrimmer/pi-sidebar), the renderer-width approach in [`pi-atelier`](https://github.com/michaelmjhhhh/pi-atelier), and the shared-card registry in [`Catdaemon/pi-extensions`](https://github.com/Catdaemon/pi-extensions). The flat visual hierarchy follows the design principles used by Neumie's Helm project: spacing and typography instead of in-flow cards.

## License

[MIT](LICENSE)
