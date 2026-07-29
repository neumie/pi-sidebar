import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { SidebarPresentation } from "./render.ts";

export type SidebarLayoutMode = "auto" | "dock" | "overlay";
export type SidebarSurfaceBackend = SidebarPresentation | "top" | "hidden";

export interface SidebarSurfaceComponent extends Component {
	setPresentation?(presentation: SidebarPresentation): void;
}

export interface SidebarSurfaceComponents {
	right: SidebarSurfaceComponent;
	top: Component;
}

export interface SidebarSurfaceOptions {
	mode: SidebarLayoutMode;
	width: number;
	gutter: number;
	minMainWidth: number;
	topRows: number;
	minTopWidth: number;
	minTopHeight: number;
	onWarning?(message: string): void;
}

export interface SidebarSurface {
	backend(): SidebarSurfaceBackend;
	requestRender(): void;
	dispose(): void;
}

type RenderFunction = TUI["render"];

function normalizedSize(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function createSidebarSurface(
	tui: TUI,
	components: SidebarSurfaceComponents,
	options: SidebarSurfaceOptions,
): SidebarSurface {
	const hadOwnRender = Object.prototype.hasOwnProperty.call(tui, "render");
	const ownRenderDescriptor = Object.getOwnPropertyDescriptor(tui, "render");
	const previousRender = tui.render;
	let disposed = false;
	let warned = false;
	let reservationActive = options.mode === "dock" || (options.mode === "auto" && !hadOwnRender);
	let topFrameReserved = false;
	let wrappedRender: RenderFunction | undefined;
	let rightOverlayHandle: OverlayHandle | undefined;
	let topOverlayHandle: OverlayHandle | undefined;

	const warnOnce = (message: string) => {
		if (warned) return;
		warned = true;
		try {
			options.onWarning?.(message);
		} catch {
			// Diagnostics must never become a render failure path.
		}
	};
	const layoutAt = (terminalWidth: number, terminalHeight: number): SidebarSurfaceBackend => {
		if (disposed) return "hidden";
		const width = normalizedSize(terminalWidth);
		const height = normalizedSize(terminalHeight);
		const wide = width >= options.minMainWidth + options.gutter + options.width;
		if (!reservationActive) return wide ? "overlay" : "hidden";
		if (wide) return "dock";
		if (width >= options.minTopWidth && height >= options.minTopHeight) return "top";
		return "hidden";
	};
	const syncRightPresentation = (layout: SidebarSurfaceBackend) => {
		components.right.setPresentation?.(layout === "dock" ? "dock" : "overlay");
	};
	const reserveTopRows = (
		lines: string[],
		terminalWidth: number,
		terminalHeight: number,
	): { lines: string[]; reserved: boolean } => {
		const width = normalizedSize(terminalWidth);
		const height = normalizedSize(terminalHeight);
		const rows = Math.min(normalizedSize(options.topRows), height);
		// Pi's normal root fills the viewport. If a transient or foreign root does not,
		// there is no safe way to identify editor/footer rows: keep it intact and skip
		// the shelf for this frame instead of covering or repositioning content.
		if (rows === 0 || lines.length < height) return { lines, reserved: false };
		const result = [...lines];
		const viewportStart = Math.max(0, result.length - height);
		for (let index = 0; index < rows; index += 1) {
			result[viewportStart + index] = " ".repeat(width);
		}
		return { lines: result, reserved: true };
	};

	if (reservationActive) {
		wrappedRender = function (this: TUI, terminalWidth: number): string[] {
			const terminalHeight = tui.terminal.rows;
			const layout = layoutAt(terminalWidth, terminalHeight);
			syncRightPresentation(layout);
			topFrameReserved = false;
			if (disposed || terminalWidth <= 0 || (layout !== "dock" && layout !== "top")) {
				return previousRender.call(this, terminalWidth);
			}
			try {
				if (layout === "dock") {
					return previousRender.call(
						this,
						Math.max(1, terminalWidth - options.width - options.gutter),
					);
				}
				const rendered = previousRender.call(this, terminalWidth);
				const reservation = reserveTopRows(rendered, terminalWidth, terminalHeight);
				topFrameReserved = reservation.reserved;
				return reservation.lines;
			} catch (error) {
				reservationActive = false;
				topFrameReserved = false;
				syncRightPresentation(layoutAt(terminalWidth, terminalHeight));
				const message = error instanceof Error ? error.message : String(error);
				warnOnce(`Adaptive sidebar reservation disabled after a render failure: ${message}`);
				queueMicrotask(() => tui.requestRender());
				return previousRender.call(this, terminalWidth);
			}
		};
		tui.render = wrappedRender;
	}

	function restoreRender(): void {
		if (!wrappedRender || tui.render !== wrappedRender) return;
		if (hadOwnRender && ownRenderDescriptor) {
			Object.defineProperty(tui, "render", ownRenderDescriptor);
		} else {
			Reflect.deleteProperty(tui, "render");
		}
	}

	const rightOverlayOptions: OverlayOptions = {
		anchor: "top-right",
		width: options.width,
		maxHeight: "100%",
		margin: 0,
		nonCapturing: true,
		visible: (terminalWidth, terminalHeight) => {
			const layout = layoutAt(terminalWidth, terminalHeight);
			syncRightPresentation(layout);
			return layout === "dock" || layout === "overlay";
		},
	};
	const topOverlayOptions: OverlayOptions = {
		anchor: "top-left",
		width: "100%",
		maxHeight: options.topRows,
		margin: 0,
		nonCapturing: true,
		visible: (terminalWidth, terminalHeight) =>
			layoutAt(terminalWidth, terminalHeight) === "top" && topFrameReserved,
	};
	try {
		rightOverlayHandle = tui.showOverlay(components.right, rightOverlayOptions);
		topOverlayHandle = tui.showOverlay(components.top, topOverlayOptions);
	} catch (error) {
		rightOverlayHandle?.hide();
		topOverlayHandle?.hide();
		rightOverlayHandle = undefined;
		topOverlayHandle = undefined;
		restoreRender();
		throw error;
	}

	const currentBackend = () => layoutAt(tui.terminal.columns, tui.terminal.rows);
	syncRightPresentation(currentBackend());

	return {
		backend: currentBackend,
		requestRender: () => tui.requestRender(),
		dispose() {
			if (disposed) return;
			disposed = true;
			topFrameReserved = false;
			rightOverlayHandle?.hide();
			topOverlayHandle?.hide();
			rightOverlayHandle = undefined;
			topOverlayHandle = undefined;
			restoreRender();
			tui.requestRender();
		},
	};
}
