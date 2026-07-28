# pi-sidebar

A docked, extensible activity sidebar for [Pi](https://pi.dev).

```text
┌──────────────────────── Pi ────────────────────────┬──── PI SIDEBAR ────┐
│ conversation, tools, editor, and session footer   │ Subagents          │
│ reflow into the remaining width                   │ ● reviewer · 18s   │
│                                                   │                    │
│                                                   │ Background jobs    │
│                                                   │ ● Typecheck · 7s   │
└───────────────────────────────────────────────────┴────────────────────┘
```

## Features

- Reserves a right-hand column so Pi's transcript, editor, widgets, and footer reflow instead of rendering underneath it.
- Does not replace the footer, so it composes with [`pi-footer`](https://github.com/neumie/pi-footer).
- Zero-config [`pi-subagents`](https://github.com/neumie/pi-subagents) panel through its versioned in-process RPC and lifecycle events.
- Zero-config [`pi-background-jobs`](https://github.com/neumie/pi-background-jobs) panel through its stable `background-jobs:changed` event.
- One layout owner for multiple independently installed panel providers.
- Non-capturing UI: normal keyboard input stays with Pi's editor.
- Responsive hiding on narrow terminals.
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
/sidebar mode auto               dock when safe, otherwise overlay
/sidebar mode dock               force docked width reservation
/sidebar mode overlay            use only Pi's supported overlay behavior
```

Runtime command changes are session-scoped. Environment defaults:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_SIDEBAR_ENABLED` | `1` | Set to `0` to start hidden. |
| `PI_SIDEBAR_MODE` | `auto` | `auto`, `dock`, or `overlay`. |
| `PI_SIDEBAR_WIDTH` | `42` | Sidebar columns. |
| `PI_SIDEBAR_GUTTER` | `1` | Blank columns between Pi and the sidebar. |
| `PI_SIDEBAR_MIN_MAIN_WIDTH` | `64` | Minimum columns preserved for Pi. |

The sidebar hides when the terminal cannot fit the configured main width, gutter, and sidebar width.

## Built-in integrations

### pi-subagents

The adapter listens for `subagents:rpc:v1:ready`, sends versioned `ping` and `status` requests, and uses async lifecycle events for immediate refresh. It polls only after the RPC is available. Missing or incompatible subagent installations simply hide the panel.

Foreground `subagent` tool calls are shown immediately from Pi's public tool lifecycle. Async status is rendered from the public RPC response; no private modules are imported.

### pi-background-jobs

The adapter consumes the stable `background-jobs:changed` payload. The current producer contract exposes aggregate counts and one primary job, so the panel shows the primary label, elapsed time, running count, and recent count—not a complete job list. `/jobs` remains the detailed manager.

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
- `render()` is synchronous and returns bounded terminal lines.
- Returning no lines hides the panel section.
- `connect()` owns subscriptions or timers and returns their disposer.
- The host clips every line and isolates render/connect failures by panel.
- Registration replays after host readiness, so package load order does not matter.
- A stale disposer cannot remove a newer registration with the same id.

## Compatibility

Pi 0.82.1 does not expose a native column-reserving side-panel API. In `auto` mode this package uses the least invasive working technique found in current community packages:

1. capture Pi's public `TUI` through a zero-height widget factory;
2. wrap `tui.render(width)` so the normal UI receives the remaining main width;
3. mount one exact, non-capturing right overlay in the reserved columns;
4. restore the renderer with compare-and-swap teardown.

The renderer wrapper is version-sensitive. If another extension already owns an instance-level renderer wrapper, `auto` mode falls back to a normal overlay rather than stacking layout patches. If Pi later adds a native side-panel API, only the private surface adapter needs to change; panel providers and integrations stay unchanged.

See [`docs/architecture.md`](docs/architecture.md) for invariants and trade-offs.

## Development

```bash
npm install --ignore-scripts
npm run check
```

Requires Node.js 22.19 or newer. Pi loads the TypeScript extension directly; there is no build step.

## Acknowledgements

The compatibility approach was informed by the Pi sidebar ecosystem, especially the public-overlay design in [`jrimmer/pi-sidebar`](https://github.com/jrimmer/pi-sidebar), the renderer-width approach in [`pi-atelier`](https://github.com/michaelmjhhhh/pi-atelier), and the shared-card registry in [`Catdaemon/pi-extensions`](https://github.com/Catdaemon/pi-extensions).

## License

[MIT](LICENSE)
