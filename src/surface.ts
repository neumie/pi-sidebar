import type {
	Component,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@earendil-works/pi-tui";
import type { NarrowSidebarPosition, SidebarPresentation } from "./render.ts";

export type SidebarLayoutMode = "auto" | "dock" | "overlay";
export type SidebarSurfaceBackend =
	| SidebarPresentation
	| NarrowSidebarPosition
	| "hidden";

export interface SidebarSurfaceComponent extends Component {
	setPresentation?(presentation: SidebarPresentation): void;
}

/** Narrow components live in controller-owned widgets/footer slots, never root overlays. */
export interface SidebarSurfaceComponents {
	right: SidebarSurfaceComponent;
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
	onBackendChange?(backend: SidebarSurfaceBackend): void;
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

/**
 * Owns the right rail only. The controller mounts narrow shelves through Pi's
 * documented widgets or a compatible footer's bounded post-footer slot.
 */
export function createSidebarSurface(
	tui: TUI,
	components: SidebarSurfaceComponents,
	options: SidebarSurfaceOptions,
): SidebarSurface {
	const hadOwnRender = Object.hasOwn(tui, "render");
	const ownRenderDescriptor = Object.getOwnPropertyDescriptor(tui, "render");
	const previousRender = tui.render;
	let disposed = false;
	let warned = false;
	let reservationActive =
		options.mode === "dock" || (options.mode === "auto" && !hadOwnRender);
	let wrappedRender: RenderFunction | undefined;
	let rightOverlayHandle: OverlayHandle | undefined;
	let lastBackend: SidebarSurfaceBackend | undefined;

	const warnOnce = (message: string) => {
		if (warned) return;
		warned = true;
		try {
			options.onWarning?.(message);
		} catch {
			/* diagnostics never render-fail */
		}
	};
	const layoutAt = (
		terminalWidth: number,
		terminalHeight: number,
	): SidebarSurfaceBackend => {
		const width = normalizedSize(terminalWidth);
		const height = normalizedSize(terminalHeight);
		const wide = width >= options.minMainWidth + options.gutter + options.width;
		let backend: SidebarSurfaceBackend = "hidden";
		if (!disposed) {
			if (wide) backend = reservationActive ? "dock" : "overlay";
			else if (options.mode !== "overlay" && width >= options.minNarrowWidth && height >= options.minNarrowHeight) {
				backend = options.narrowPosition;
			}
		}
		if (backend !== lastBackend) {
			lastBackend = backend;
			try {
				options.onBackendChange?.(backend);
			} catch {
				/* transition observers cannot break layout selection */
			}
		}
		return backend;
	};
	const syncRightPresentation = (layout: SidebarSurfaceBackend) => {
		components.right.setPresentation?.(layout === "dock" ? "dock" : "overlay");
	};

	if (reservationActive) {
		wrappedRender = function (this: TUI, terminalWidth: number): string[] {
			const layout = layoutAt(terminalWidth, tui.terminal.rows);
			syncRightPresentation(layout);
			if (disposed || layout !== "dock")
				return previousRender.call(this, terminalWidth);
			try {
				return previousRender.call(
					this,
					Math.max(1, terminalWidth - options.width - options.gutter),
				);
			} catch (error) {
				reservationActive = false;
				syncRightPresentation(layoutAt(terminalWidth, tui.terminal.rows));
				const message = error instanceof Error ? error.message : String(error);
				warnOnce(
					`Adaptive sidebar dock reservation disabled after a render failure: ${message}`,
				);
				queueMicrotask(() => tui.requestRender());
				return previousRender.call(this, terminalWidth);
			}
		};
		tui.render = wrappedRender;
	}

	function restoreRender(): void {
		if (!wrappedRender || tui.render !== wrappedRender) return;
		if (hadOwnRender && ownRenderDescriptor)
			Object.defineProperty(tui, "render", ownRenderDescriptor);
		else Reflect.deleteProperty(tui, "render");
	}

	const rightOverlayOptions: OverlayOptions = {
		anchor: "top-right",
		width: options.width,
		maxHeight: "100%",
		margin: 0,
		nonCapturing: true,
		visible: (width, height) => {
			const layout = layoutAt(width, height);
			syncRightPresentation(layout);
			return layout === "dock" || layout === "overlay";
		},
	};
	try {
		rightOverlayHandle = tui.showOverlay(components.right, rightOverlayOptions);
	} catch (error) {
		restoreRender();
		throw error;
	}

	const currentBackend = () =>
		layoutAt(tui.terminal.columns, tui.terminal.rows);
	syncRightPresentation(currentBackend());
	return {
		backend: currentBackend,
		requestRender: () => tui.requestRender(),
		dispose() {
			if (disposed) return;
			disposed = true;
			rightOverlayHandle?.hide();
			rightOverlayHandle = undefined;
			restoreRender();
			tui.requestRender();
		},
	};
}
