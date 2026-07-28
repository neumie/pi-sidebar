import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { SidebarPresentation } from "./render.ts";

export type SidebarLayoutMode = "auto" | "dock" | "overlay";

export interface SidebarSurfaceComponent extends Component {
	setPresentation?(presentation: SidebarPresentation): void;
}

export interface SidebarSurfaceOptions {
	mode: SidebarLayoutMode;
	width: number;
	gutter: number;
	minMainWidth: number;
	onWarning?(message: string): void;
}

export interface SidebarSurface {
	backend(): SidebarPresentation;
	requestRender(): void;
	dispose(): void;
}

type RenderFunction = TUI["render"];

export function createSidebarSurface(
	tui: TUI,
	component: SidebarSurfaceComponent,
	options: SidebarSurfaceOptions,
): SidebarSurface {
	const hadOwnRender = Object.prototype.hasOwnProperty.call(tui, "render");
	const ownRenderDescriptor = Object.getOwnPropertyDescriptor(tui, "render");
	const previousRender = tui.render;
	let disposed = false;
	let warned = false;
	let dockActive = options.mode === "dock" || (options.mode === "auto" && !hadOwnRender);
	let wrappedRender: RenderFunction | undefined;
	let overlayHandle: OverlayHandle | undefined;

	const warnOnce = (message: string) => {
		if (warned) return;
		warned = true;
		try {
			options.onWarning?.(message);
		} catch {
			// Diagnostics must never become a render failure path.
		}
	};
	const visibleAt = (terminalWidth: number) =>
		!disposed && terminalWidth >= options.minMainWidth + options.gutter + options.width;
	const syncPresentation = () => component.setPresentation?.(dockActive ? "dock" : "overlay");

	if (dockActive) {
		wrappedRender = function (this: TUI, terminalWidth: number): string[] {
			if (disposed || !dockActive || !visibleAt(terminalWidth) || terminalWidth <= 0) {
				return previousRender.call(this, terminalWidth);
			}
			syncPresentation();
			try {
				return previousRender.call(this, Math.max(1, terminalWidth - options.width - options.gutter));
			} catch (error) {
				dockActive = false;
				syncPresentation();
				const message = error instanceof Error ? error.message : String(error);
				warnOnce(`Docked sidebar disabled after a render failure: ${message}`);
				queueMicrotask(() => tui.requestRender());
				return previousRender.call(this, terminalWidth);
			}
		};
		tui.render = wrappedRender;
	}

	syncPresentation();
	const overlayOptions: OverlayOptions = {
		anchor: "top-right",
		width: options.width,
		maxHeight: "100%",
		margin: 0,
		nonCapturing: true,
		visible: (terminalWidth) => visibleAt(terminalWidth),
	};
	try {
		overlayHandle = tui.showOverlay(component, overlayOptions);
	} catch (error) {
		if (wrappedRender && tui.render === wrappedRender) restoreRender();
		throw error;
	}

	function restoreRender(): void {
		if (!wrappedRender || tui.render !== wrappedRender) return;
		if (hadOwnRender && ownRenderDescriptor) {
			Object.defineProperty(tui, "render", ownRenderDescriptor);
		} else {
			Reflect.deleteProperty(tui, "render");
		}
	}

	return {
		backend: () => dockActive ? "dock" : "overlay",
		requestRender: () => tui.requestRender(),
		dispose() {
			if (disposed) return;
			disposed = true;
			overlayHandle?.hide();
			overlayHandle = undefined;
			restoreRender();
			tui.requestRender();
		},
	};
}
