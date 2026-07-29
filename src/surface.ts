import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { NarrowSidebarPosition, SidebarPresentation } from "./render.ts";

export type SidebarLayoutMode = "auto" | "dock" | "overlay";
export type SidebarSurfaceBackend = SidebarPresentation | NarrowSidebarPosition | "hidden";

export interface SidebarSurfaceComponent extends Component {
	setPresentation?(presentation: SidebarPresentation): void;
}

export interface SidebarSurfaceComponents {
	right: SidebarSurfaceComponent;
	top: Component;
	bottom: Component;
}

export interface SidebarSurfaceOptions {
	mode: SidebarLayoutMode;
	width: number;
	gutter: number;
	minMainWidth: number;
	narrowPosition: NarrowSidebarPosition;
	narrowRows: number;
	minNarrowWidth: number;
	minNarrowHeight: number;
	onWarning?(message: string): void;
}

export interface SidebarSurface {
	backend(): SidebarSurfaceBackend;
	requestRender(): void;
	dispose(): void;
}

type RenderFunction = TUI["render"];
type Reservation = { lines: string[]; reserved: boolean };

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
	let bottomFrameReserved = false;
	let wrappedRender: RenderFunction | undefined;
	let rightOverlayHandle: OverlayHandle | undefined;
	let topOverlayHandle: OverlayHandle | undefined;
	let bottomOverlayHandle: OverlayHandle | undefined;

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
		if (width >= options.minNarrowWidth && height >= options.minNarrowHeight) {
			return options.narrowPosition;
		}
		return "hidden";
	};
	const syncRightPresentation = (layout: SidebarSurfaceBackend) => {
		components.right.setPresentation?.(layout === "dock" ? "dock" : "overlay");
	};
	const reservationGeometry = (terminalWidth: number, terminalHeight: number) => ({
		width: normalizedSize(terminalWidth),
		height: normalizedSize(terminalHeight),
		rows: Math.min(normalizedSize(options.narrowRows), normalizedSize(terminalHeight)),
	});
	const reserveTopRows = (
		lines: string[],
		terminalWidth: number,
		terminalHeight: number,
	): Reservation => {
		const { width, height, rows } = reservationGeometry(terminalWidth, terminalHeight);
		// Pi's normal root fills the viewport. If a transient or foreign root does not,
		// row roles are unknowable: keep it intact and skip the shelf for this frame.
		if (rows === 0 || lines.length < height) return { lines, reserved: false };
		const result = [...lines];
		const viewportStart = Math.max(0, result.length - height);
		for (let index = 0; index < rows; index += 1) {
			result[viewportStart + index] = " ".repeat(width);
		}
		return { lines: result, reserved: true };
	};
	const reserveBottomRows = (
		lines: string[],
		terminalWidth: number,
		terminalHeight: number,
	): Reservation => {
		const { width, height, rows } = reservationGeometry(terminalWidth, terminalHeight);
		if (rows === 0 || lines.length < height) return { lines, reserved: false };
		return {
			lines: [...lines, ...Array.from({ length: rows }, () => " ".repeat(width))],
			reserved: true,
		};
	};

	if (reservationActive) {
		wrappedRender = function (this: TUI, terminalWidth: number): string[] {
			const terminalHeight = tui.terminal.rows;
			const layout = layoutAt(terminalWidth, terminalHeight);
			syncRightPresentation(layout);
			topFrameReserved = false;
			bottomFrameReserved = false;
			if (
				disposed
				|| terminalWidth <= 0
				|| (layout !== "dock" && layout !== "top" && layout !== "bottom")
			) {
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
				const reservation = layout === "top"
					? reserveTopRows(rendered, terminalWidth, terminalHeight)
					: reserveBottomRows(rendered, terminalWidth, terminalHeight);
				topFrameReserved = layout === "top" && reservation.reserved;
				bottomFrameReserved = layout === "bottom" && reservation.reserved;
				return reservation.lines;
			} catch (error) {
				reservationActive = false;
				topFrameReserved = false;
				bottomFrameReserved = false;
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
		maxHeight: options.narrowRows,
		margin: 0,
		nonCapturing: true,
		visible: (terminalWidth, terminalHeight) =>
			layoutAt(terminalWidth, terminalHeight) === "top" && topFrameReserved,
	};
	const bottomOverlayOptions: OverlayOptions = {
		anchor: "bottom-left",
		width: "100%",
		maxHeight: options.narrowRows,
		margin: 0,
		nonCapturing: true,
		visible: (terminalWidth, terminalHeight) =>
			layoutAt(terminalWidth, terminalHeight) === "bottom" && bottomFrameReserved,
	};
	try {
		rightOverlayHandle = tui.showOverlay(components.right, rightOverlayOptions);
		topOverlayHandle = tui.showOverlay(components.top, topOverlayOptions);
		bottomOverlayHandle = tui.showOverlay(components.bottom, bottomOverlayOptions);
	} catch (error) {
		rightOverlayHandle?.hide();
		topOverlayHandle?.hide();
		bottomOverlayHandle?.hide();
		rightOverlayHandle = undefined;
		topOverlayHandle = undefined;
		bottomOverlayHandle = undefined;
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
			bottomFrameReserved = false;
			rightOverlayHandle?.hide();
			topOverlayHandle?.hide();
			bottomOverlayHandle?.hide();
			rightOverlayHandle = undefined;
			topOverlayHandle = undefined;
			bottomOverlayHandle = undefined;
			restoreRender();
			tui.requestRender();
		},
	};
}
