import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as PiTui from "@earendil-works/pi-tui";
import { CURSOR_MARKER, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, OverlayOptions, Terminal, TUI } from "@earendil-works/pi-tui";
import {
	createSidebarSurface,
	type SidebarSurfaceComponent,
} from "../src/surface.ts";

class FakeTui {
	readonly terminal = { columns: 120, rows: 30 };
	readonly widths: number[] = [];
	readonly overlays: Array<{ component: Component; options: OverlayOptions }> =
		[];
	hideCount = 0;
	renders = 0;
	failOverlay = false;
	rootFactory: ((width: number) => string[]) | undefined;
	render(width: number): string[] {
		this.widths.push(width);
		return this.rootFactory?.(width) ?? [`main:${width}`];
	}
	showOverlay(component: Component, options?: OverlayOptions) {
		if (this.failOverlay) throw new Error("overlay mount failed");
		this.overlays.push({ component, options: options ?? {} });
		return {
			hide: () => {
				this.hideCount += 1;
			},
			setHidden() {},
			isHidden: () => false,
			focus() {},
			unfocus() {},
			isFocused: () => false,
		};
	}
	requestRender(): void {
		this.renders += 1;
	}
}

const options = {
	mode: "auto" as const,
	width: 42,
	gutter: 1,
	minMainWidth: 64,
	narrowPosition: "bottom" as const,
	narrowRows: 7,
	minNarrowWidth: 32,
	minNarrowHeight: 32,
};
function component(): SidebarSurfaceComponent & { presentation?: string } {
	return {
		presentation: undefined,
		setPresentation(presentation) {
			this.presentation = presentation;
		},
		render: () => [],
		invalidate() {},
	};
}
function visible(tui: FakeTui, width: number, height: number): boolean {
	return tui.overlays[0]?.options.visible?.(width, height) ?? true;
}

function hostTerminal(rows = 30): Terminal {
	return {
		columns: 120,
		rows,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		async drainInput() {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
	};
}

describe("createSidebarSurface", () => {
	it("reserves and restores the real Pi TUI render seam", () => {
		const exports = PiTui as unknown as Record<string, unknown>;
		const HostTui = (exports.TuiMainScreen ?? exports.TUI) as new (terminal: Terminal) => TUI;
		assert.equal(typeof HostTui, "function");

		const tui = new HostTui(hostTerminal());
		const widths: number[] = [];
		tui.addChild({
			render(width) {
				widths.push(width);
				return [`main:${width}`];
			},
			invalidate() {},
		});

		const surface = createSidebarSurface(tui, { right: component() }, options);
		assert.equal(surface.backend(), "dock");
		assert.deepEqual(tui.render(120), ["main:77"]);
		assert.deepEqual(widths, [77]);

		surface.dispose();
		assert.equal(Object.hasOwn(tui, "render"), false);
		assert.deepEqual(tui.render(120), ["main:120"]);
	});

	it("scrolls the dock out in a real Pi alternate-screen host when available", () => {
		type ScrollableTui = TUI & { scrollBy(lines: number): void };
		type AltScreenConstructor = new (terminal: Terminal) => ScrollableTui;
		const HostTui = (PiTui as unknown as { TuiAltScreen?: AltScreenConstructor })
			.TuiAltScreen;
		if (!HostTui) return;

		const tui = new HostTui(hostTerminal(3));
		tui.addChild({
			render: (width) => Array.from({ length: 6 }, (_, index) => `history:${index}:${width}`),
			invalidate() {},
		});
		const right = component();
		right.render = () => ["rail:0", "rail:1", "rail:2"];
		const surface = createSidebarSurface(tui, { right }, options);
		const internals = tui as unknown as { doRender(): void; previousScreen: string[] };
		tui.start();
		internals.doRender();
		assert.equal(internals.previousScreen.some((line) => line.includes("rail:")), true);

		tui.scrollBy(-3);
		internals.doRender();
		assert.equal(internals.previousScreen.some((line) => line.includes("rail:")), false);
		surface.dispose();
		tui.stop();
	});

	it("reserves right-dock columns and keeps a non-capturing fallback overlay", () => {
		const tui = new FakeTui();
		const right = component();
		const surface = createSidebarSurface(
			tui as unknown as TUI,
			{ right },
			options,
		);
		assert.equal(surface.backend(), "dock");
		assert.deepEqual(tui.render(120), ["main:77"]);
		assert.equal(tui.overlays.length, 1);
		assert.equal(tui.overlays[0]?.options.anchor, "top-right");
		assert.equal(tui.overlays[0]?.options.nonCapturing, true);
		assert.equal(visible(tui, 120, 30), false);
		assert.equal(right.presentation, "dock");
		surface.dispose();
		assert.deepEqual(tui.render(120), ["main:120"]);
		assert.equal(tui.hideCount, 1);
	});

	it("composes the dock into trailing document rows so it follows history scrolling", () => {
		const tui = new FakeTui();
		tui.terminal.rows = 3;
		tui.rootFactory = (width) =>
			Array.from({ length: 6 }, (_, index) => `history:${index}:${width}`);
		const right = component();
		right.render = () => ["rail:0", "rail:1", "rail:2"];
		const surface = createSidebarSurface(
			tui as unknown as TUI,
			{ right },
			options,
		);

		const lines = tui.render(120);
		assert.deepEqual(lines.slice(0, 3), ["history:0:77", "history:1:77", "history:2:77"]);
		for (let row = 3; row < 6; row += 1) {
			assert.equal(visibleWidth(lines[row] ?? ""), 120);
			assert.equal(
				sliceByColumn(lines[row] ?? "", 78, 6, true).endsWith(`rail:${row - 3}`),
				true,
			);
		}
		assert.equal(visible(tui, 120, 3), false);
		surface.dispose();
	});

	it("preserves styled wide text, cursor markers, and image protocol rows", () => {
		const tui = new FakeTui();
		tui.terminal.rows = 2;
		const imageLine = "\x1b_Ga=T,f=100;payload\x1b\\";
		tui.rootFactory = () => [`\x1b[31m界base\x1b[0m${CURSOR_MARKER}`, imageLine];
		const right = component();
		right.render = () => ["\x1b]8;;https://example.com\x07界rail\x1b]8;;\x07", "rail:1"];
		const surface = createSidebarSurface(tui as unknown as TUI, { right }, options);

		const lines = tui.render(120);
		assert.equal(visibleWidth(lines[0] ?? ""), 120);
		assert.equal(lines[0]?.includes(CURSOR_MARKER), true);
		assert.equal(lines[0]?.includes("https://example.com"), true);
		assert.equal(sliceByColumn(lines[0] ?? "", 78, 6, true).includes("界rail"), true);
		assert.equal(lines[1], imageLine);
		surface.dispose();
	});

	it("pads short documents to the live viewport and recomposes after height changes", () => {
		const tui = new FakeTui();
		tui.terminal.rows = 2;
		tui.rootFactory = () => [`main${CURSOR_MARKER}`];
		const right = component();
		right.render = () => ["rail:0", "rail:1", "rail:2", "rail:3"];
		const surface = createSidebarSurface(tui as unknown as TUI, { right }, options);

		const short = tui.render(120);
		assert.equal(short.length, 2);
		assert.equal(short[0]?.includes(CURSOR_MARKER), true);
		assert.ok(short.every((line) => visibleWidth(line) === 120));
		tui.terminal.rows = 4;
		const resized = tui.render(120);
		assert.equal(resized.length, 4);
		assert.equal(resized[0]?.includes(CURSOR_MARKER), true);
		assert.ok(resized.every((line) => visibleWidth(line) === 120));
		surface.dispose();
	});

	it("never alters oversized ordinary or transient slash roots in narrow mode", () => {
		const tui = new FakeTui();
		tui.terminal.columns = 80;
		tui.terminal.rows = 40;
		let slash = false;
		tui.rootFactory = () =>
			Array.from(
				{ length: slash ? 63 : 80 },
				(_, index) => `${slash ? "slash" : "root"}:${index}`,
			);
		const surface = createSidebarSurface(
			tui as unknown as TUI,
			{ right: component() },
			options,
		);
		const ordinary = tui.rootFactory(80);
		assert.deepEqual(tui.render(80), ordinary);
		assert.equal(surface.backend(), "bottom");
		slash = true;
		const transient = tui.rootFactory(80);
		assert.deepEqual(tui.render(80), transient);
		assert.equal(visible(tui, 80, 40), false);
		surface.dispose();
	});

	it("keeps the fallback overlay hidden in narrow and dock presentations", () => {
		const tui = new FakeTui();
		tui.terminal.columns = 80;
		tui.terminal.rows = 40;
		const surface = createSidebarSurface(
			tui as unknown as TUI,
			{ right: component() },
			options,
		);
		assert.equal(surface.backend(), "bottom");
		assert.equal(visible(tui, 80, 40), false);
		tui.terminal.columns = 120;
		assert.equal(surface.backend(), "dock");
		assert.equal(visible(tui, 120, 40), false);
		surface.dispose();
	});

	it("uses a wide overlay when another extension owns render", () => {
		const tui = new FakeTui();
		const original = tui.render.bind(tui);
		tui.render = (width) => original(width);
		const surface = createSidebarSurface(
			tui as unknown as TUI,
			{ right: component() },
			options,
		);
		assert.equal(surface.backend(), "overlay");
		assert.deepEqual(tui.render(120), ["main:120"]);
		assert.equal(visible(tui, 120, 30), true);
		surface.dispose();
	});

	it("keeps the auto narrow widget backend with foreign render ownership but hides forced overlay", () => {
		const autoTui = new FakeTui();
		autoTui.terminal.columns = 80;
		autoTui.terminal.rows = 40;
		const original = autoTui.render.bind(autoTui);
		autoTui.render = (width) => original(width);
		const auto = createSidebarSurface(autoTui as unknown as TUI, { right: component() }, options);
		assert.equal(auto.backend(), "bottom");
		assert.equal(visible(autoTui, 80, 40), false);
		auto.dispose();

		const forcedTui = new FakeTui();
		forcedTui.terminal.columns = 80;
		forcedTui.terminal.rows = 40;
		const forced = createSidebarSurface(
			forcedTui as unknown as TUI,
			{ right: component() },
			{ ...options, mode: "overlay" },
		);
		assert.equal(forced.backend(), "hidden");
		assert.equal(visible(forcedTui, 80, 40), false);
		assert.deepEqual(forcedTui.render(80), ["main:80"]);
		forced.dispose();
	});

	it("switches exactly at the right-dock threshold", () => {
		const tui = new FakeTui();
		tui.terminal.rows = 40;
		const surface = createSidebarSurface(tui as unknown as TUI, { right: component() }, options);
		tui.terminal.columns = 106;
		assert.equal(surface.backend(), "bottom");
		assert.deepEqual(tui.render(106), ["main:106"]);
		tui.terminal.columns = 107;
		assert.equal(surface.backend(), "dock");
		assert.deepEqual(tui.render(107), ["main:64"]);
		surface.dispose();
	});

	it("falls back to a wide overlay after dock render failure", () => {
		const tui = new FakeTui();
		const warnings: string[] = [];
		tui.rootFactory = (width) => {
			if (width === 77) throw new Error("dock failed");
			return [`main:${width}`];
		};
		const surface = createSidebarSurface(
			tui as unknown as TUI,
			{ right: component() },
			{ ...options, onWarning: (message) => warnings.push(message) },
		);
		assert.deepEqual(tui.render(120), ["main:120"]);
		assert.equal(surface.backend(), "overlay");
		assert.equal(visible(tui, 120, 30), true);
		assert.deepEqual(warnings, ["Adaptive sidebar dock reservation disabled after a render failure: dock failed"]);
		surface.dispose();
	});

	it("falls back to the wide overlay when dock component rendering fails", () => {
		const tui = new FakeTui();
		const warnings: string[] = [];
		const right = component();
		right.render = () => {
			if (right.presentation === "dock") throw new Error("sidebar failed");
			return ["fallback"];
		};
		const surface = createSidebarSurface(
			tui as unknown as TUI,
			{ right },
			{ ...options, onWarning: (message) => warnings.push(message) },
		);
		assert.deepEqual(tui.render(120), ["main:120"]);
		assert.equal(surface.backend(), "overlay");
		assert.equal(visible(tui, 120, 30), true);
		assert.deepEqual(warnings, ["Adaptive sidebar dock reservation disabled after a render failure: sidebar failed"]);
		surface.dispose();
	});

	it("restores its wrapper when overlay mount fails", () => {
		const tui = new FakeTui();
		tui.failOverlay = true;
		assert.throws(
			() => createSidebarSurface(tui as unknown as TUI, { right: component() }, options),
			/overlay mount failed/,
		);
		assert.equal(Object.hasOwn(tui, "render"), false);
		assert.deepEqual(tui.render(120), ["main:120"]);
	});

	it("leaves a later render wrapper installed during disposal", () => {
		const tui = new FakeTui();
		const surface = createSidebarSurface(tui as unknown as TUI, { right: component() }, options);
		const later = (_width: number) => ["later"];
		tui.render = later;
		surface.dispose();
		assert.equal(tui.render, later);
		assert.deepEqual(tui.render(120), ["later"]);
	});
});
