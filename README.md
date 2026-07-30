# pi-sidebar

A docked, extensible activity sidebar for [Pi](https://pi.dev), rendered as a flat Helm-inspired activity rail.

```text
Wide terminal
Pi transcript and tools                         │
                                                │ Subagents
                                                │  ◆ reviewer · 18s
                                                │
Pi editor and session footer                    │ Background jobs
                                                │  ▸ Typecheck · 7s
                                                │  ▸ Test suite · 4s

Narrow + tall terminal (default: bottom)
Pi conversation

› editor
Pi session footer
────────────────────────────────────────────────────
 ◆ reviewer · 18s
 ▸ Typecheck · 7s

Hidden surface
Pi session footer                 ◆ 2 agents · ▸ 3 jobs
```

## Features

- Reserves a right-hand column so Pi's transcript, editor, widgets, and footer reflow instead of rendering underneath it.
- Minimal chrome: one quiet structural divider—left for the right rail, above a bottom shelf, or below a top shelf—plus whitespace hierarchy and accent reserved for live activity.
- Does not replace the footer; with [`pi-footer`](https://github.com/neumie/pi-footer) 0.4.0 or newer, the narrow-bottom shelf composes after the footer. When no sidebar surface fits or `/sidebar off` is active, bounded agent/job counts move into Pi's ordinary right-side footer status area.
- Zero-config [`pi-subagents`](https://github.com/neumie/pi-subagents) panel through its versioned in-process RPC and lifecycle events.
- Zero-config [`pi-background-jobs`](https://github.com/neumie/pi-background-jobs) panel that fills available rows from a bounded, private-ID-free activity snapshot.
- Degraded-only Integrations panel for actionable LSP failures and observed MCP authentication/connectivity failures; healthy, inactive, cached, and lazily disconnected integrations stay hidden.
- One layout owner for multiple independently installed panel providers.
- Non-capturing UI: normal keyboard input stays with Pi's editor.
- Adaptive responsive layout: scrollback-following right rail on wide terminals; configurable bottom dock or top shelf on narrow but very tall terminals; hidden when neither fits.
- Safe viewport-fixed overlay fallback when another extension already wraps Pi's root renderer.
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
| `PI_SIDEBAR_GUTTER` | `0` | Optional blank columns between Pi and the sidebar. |
| `PI_SIDEBAR_MIN_MAIN_WIDTH` | `64` | Minimum columns preserved beside the right rail. |
| `PI_SIDEBAR_NARROW_POSITION` | `bottom` | `bottom` after a compatible footer, or `top` above the editor. |
| `PI_SIDEBAR_NARROW_ROWS` | `7` | Rows rendered by the narrow shelf. |
| `PI_SIDEBAR_NARROW_MIN_WIDTH` | `32` | Minimum terminal width for narrow mode. |
| `PI_SIDEBAR_NARROW_MIN_HEIGHT` | `32` | Minimum terminal height for narrow mode. |

The former `PI_SIDEBAR_TOP_*` geometry variables remain accepted as fallback aliases when their corresponding remaining `PI_SIDEBAR_NARROW_*` variable is unset.

In `auto` and `dock` modes, the right rail wins whenever the terminal can fit the configured main width, gutter, and sidebar width. Otherwise a terminal at least 32 columns wide and 32 rows tall gets a seven-row, single-column narrow shelf. The built-in activity panels omit redundant narrow headings and identify themselves with distinct markers: `◆` agents and `▸` background jobs. `narrow bottom` registers a bounded post-footer renderer when `pi-footer` 0.4.0 or newer is present, producing editor → footer → shelf; with Pi's built-in footer or an older custom footer it safely falls back to the documented `belowEditor` widget. `narrow top` always uses the documented `aboveEditor` widget. Smaller terminals hide the activity surface and expose only private-ID-free activity counts through Pi's public footer-status seam.

The configured right-rail width includes the divider and compact internal hierarchy. Right-rail providers receive `configured width - 3` body columns: one divider, one heading inset, and one additional body indent, with no reserved trailing column. Narrow-shelf providers receive the shelf's full usable width. Provider height always excludes host-owned headings and section spacing.

## Built-in integrations

### pi-subagents

The adapter listens for `subagents:rpc:v1:ready`, sends versioned `ping` and `status` requests, and uses async lifecycle events for immediate refresh. It polls only after the RPC is available. Missing or incompatible subagent installations simply hide the panel.

Foreground `subagent` tool calls are shown immediately from Pi's public tool lifecycle. When the peer advertises `fleetStatus` v1, each active child shows its role and elapsed time, footer-style model/effort and `↑input ↓output` usage, plus its caller-facing goal. The bounded RPC snapshot carries an omitted count so narrow surfaces can report hidden children without exposing run IDs. Overflow rows right-align `/subagents-fleet` when it fits, opening the package's live inspection-only fleet even when its native FleetView widget is disabled. Older peers degrade to an ID-free active count; no private modules are imported.

### pi-background-jobs

The adapter consumes the stable `background-jobs:changed` payload. With `pi-background-jobs` 0.3.0 or newer, it renders the newest bounded running-job summaries into every available panel row and emits `+N more` only for real overflow; that row right-aligns `/jobs` when it fits so the complete manager is one command away. Recent terminal jobs use a spare row or share the overflow summary. Older producers degrade to the aggregate primary/count view. Commands, output, paths, and private job ids are never rendered; `/jobs` remains the detailed manager.

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
    hiddenStatus: () => active > 0 ? `◇ ${active} deployment${active === 1 ? "" : "s"}` : undefined,

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
- Set `showTitleInNarrow: false` only when the panel body has a stable visual identity of its own.
- `hiddenStatus()` is optional, synchronous, bounded by the host, and must expose only aggregate, private-ID-free text. It appears in Pi's right-side footer status area only while the sidebar surface is hidden.
- `render()` is synchronous and returns bounded terminal lines.
- `render({ width, height, surface })` receives only the usable panel-body area after host chrome; `surface` is `right` or `narrow`. A title-free narrow panel receives the reclaimed title row and inset.
- Returning no lines hides the panel section.
- `connect()` owns subscriptions or timers and returns their disposer.
- The host clips every line and isolates render/connect failures by panel, including malformed or hostile output values.
- Registration replays after host readiness, so package load order does not matter.
- A stale disposer cannot remove a newer registration with the same id.

## Compatibility

Pi 0.82.1 does not expose a native column-reserving side-panel API. In `auto` mode this package uses the least invasive working technique found in current community packages:

1. capture Pi's public `TUI` through a zero-height widget factory;
2. wrap `tui.render(width)` so the normal UI receives the remaining main width;
3. compose the rail into the document's trailing viewport rows—using Pi's public `compositeTuiLine()` when safe and an ANSI/image/cursor-aware compatibility path on Pi 0.82 and cursor-bearing rows—so terminal or alternate-screen history scrolling moves it naturally;
4. keep one exact, non-capturing right overlay hidden for compatibility fallback;
5. restore the renderer with compare-and-swap teardown.

The renderer wrapper is version-sensitive. If another extension already owns an instance-level renderer wrapper, `auto` mode falls back to a normal viewport-fixed wide overlay rather than stacking layout patches; narrow mode remains available because it does not need render ownership. Forced `overlay` mode is wide-only and hides the narrow shelf. Narrow mode never appends, deletes, overwrites, or inspects Pi root lines: it uses documented editor widgets plus the optional versioned `pi-footer` post-footer capability. This keeps slash completion and other transient editor UI entirely Pi-owned. If Pi later adds a native side-panel or below-footer API, only the private surface adapter needs to change; panel providers and integrations stay unchanged.

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
