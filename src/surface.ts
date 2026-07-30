import * as PiTui from "@earendil-works/pi-tui";
import { CURSOR_MARKER, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
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

interface LineCompositionOptions {
	baseLine: string;
	overlayLine: string;
	startCol: number;
	overlayWidth: number;
	totalWidth: number;
}

type NativeLineComposer = (...args: [
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
]) => string;

const nativeLineComposer = (PiTui as unknown as { compositeTuiLine?: NativeLineComposer })
	.compositeTuiLine;
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

function isImageProtocolLine(line: string): boolean {
	return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

function compatibilityLineComposer(options: LineCompositionOptions): string {
	if (isImageProtocolLine(options.baseLine)) return options.baseLine;
	const base = sliceByColumn(options.baseLine, 0, options.startCol, true);
	const overlay = sliceByColumn(options.overlayLine, 0, options.overlayWidth, true);
	const beforePad = Math.max(0, options.startCol - visibleWidth(base));
	const overlayPad = Math.max(0, options.overlayWidth - visibleWidth(overlay));
	const result = `${base}${" ".repeat(beforePad)}${SEGMENT_RESET}${overlay}${" ".repeat(overlayPad)}${SEGMENT_RESET}`;
	return visibleWidth(result) <= options.totalWidth
		? result
		: sliceByColumn(result, 0, options.totalWidth, true);
}

function composeLine(options: LineCompositionOptions): string {
	if (!nativeLineComposer || options.baseLine.includes(CURSOR_MARKER)) {
		return compatibilityLineComposer(options);
	}
	return nativeLineComposer(
		options.baseLine,
		options.overlayLine,
		options.startCol,
		options.overlayWidth,
		options.totalWidth,
	);
}

interface DockCompositionOptions {
	terminalWidth: number;
	terminalHeight: number;
	mainWidth: number;
	sidebarWidth: number;
	gutter: number;
}

function composeDockIntoDocument(
	mainLines: string[],
	right: SidebarSurfaceComponent,
	options: DockCompositionOptions,
): string[] {
	const height = normalizedSize(options.terminalHeight);
	if (height === 0) return mainLines;
	const sidebarLines = right.render(options.sidebarWidth).slice(0, height);
	if (sidebarLines.length === 0) return mainLines;

	const result = [...mainLines];
	while (result.length < height) result.push("");
	const viewportStart = Math.max(0, result.length - height);
	const sidebarColumn = options.mainWidth + options.gutter;
	for (let row = 0; row < sidebarLines.length; row += 1) {
		const index = viewportStart + row;
		result[index] = composeLine({
			baseLine: result[index] ?? "",
			overlayLine: sidebarLines[row] ?? "",
			startCol: sidebarColumn,
			overlayWidth: options.sidebarWidth,
			totalWidth: options.terminalWidth,
		});
	}
	return result;
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
			const terminalHeight = tui.terminal.rows;
			const layout = layoutAt(terminalWidth, terminalHeight);
			syncRightPresentation(layout);
			if (disposed || layout !== "dock")
				return previousRender.call(this, terminalWidth);
			try {
				const mainWidth = Math.max(1, terminalWidth - options.width - options.gutter);
				const mainLines = previousRender.call(this, mainWidth);
				return composeDockIntoDocument(mainLines, components.right, {
					terminalWidth,
					terminalHeight,
					mainWidth,
					sidebarWidth: options.width,
					gutter: options.gutter,
				});
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
			return layout === "overlay";
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
