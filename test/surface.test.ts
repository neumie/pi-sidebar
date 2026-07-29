import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import {
	createSidebarSurface,
	type SidebarSurfaceComponent,
	type SidebarSurfaceComponents,
} from "../src/surface.ts";

class FakeTui {
	readonly terminal = { columns: 120, rows: 30 };
	readonly widths: number[] = [];
	readonly overlays: Array<{ component: Component; options: OverlayOptions }> = [];
	hideCount = 0;
	renders = 0;
	overlayCalls = 0;
	failOverlayAt: number | undefined;
	rootFactory: ((width: number) => string[]) | undefined;

	render(width: number): string[] {
		this.widths.push(width);
		return this.rootFactory?.(width) ?? [`main:${width}`];
	}
	showOverlay(component: Component, options?: OverlayOptions) {
		this.overlayCalls += 1;
		if (this.overlayCalls === this.failOverlayAt) throw new Error("overlay mount failed");
		this.overlays.push({ component, options: options ?? {} });
		return {
			hide: () => { this.hideCount += 1; },
			setHidden() {}, isHidden: () => false, focus() {}, unfocus() {}, isFocused: () => false,
		};
	}
	requestRender(): void { this.renders += 1; }
}

function fakeComponents(): SidebarSurfaceComponents & { right: SidebarSurfaceComponent & { presentation?: string } } {
	return {
		right: {
			presentation: undefined,
			setPresentation(presentation) { this.presentation = presentation; },
			render: () => [],
			invalidate() {},
		},
		top: { render: () => [], invalidate() {} },
		bottom: { render: () => [], invalidate() {} },
	};
}

const options = {
	mode: "auto" as const,
	width: 42,
	gutter: 1,
	minMainWidth: 64,
	narrowPosition: "bottom" as const,
	narrowRows: 8,
	minNarrowWidth: 32,
	minNarrowHeight: 32,
};

function visible(overlay: { options: OverlayOptions } | undefined, width: number, height: number): boolean {
	return overlay?.options.visible?.(width, height) ?? true;
}

describe("createSidebarSurface", () => {
	it("reserves columns in wide auto mode and mounts three non-capturing overlays", () => {
		const tui = new FakeTui();
		const components = fakeComponents();
		const surface = createSidebarSurface(tui as unknown as TUI, components, options);
		assert.equal(surface.backend(), "dock");
		assert.deepEqual(tui.render(120), ["main:77"]);
		assert.equal(tui.overlays.length, 3);
		assert.equal(tui.overlays[0]?.options.nonCapturing, true);
		assert.equal(tui.overlays[0]?.options.anchor, "top-right");
		assert.equal(tui.overlays[0]?.options.width, 42);
		assert.equal(tui.overlays[0]?.options.maxHeight, "100%");
		assert.equal(tui.overlays[1]?.options.nonCapturing, true);
		assert.equal(tui.overlays[1]?.options.anchor, "top-left");
		assert.equal(tui.overlays[1]?.options.width, "100%");
		assert.equal(tui.overlays[1]?.options.maxHeight, 8);
		assert.equal(tui.overlays[2]?.options.nonCapturing, true);
		assert.equal(tui.overlays[2]?.options.anchor, "bottom-left");
		assert.equal(tui.overlays[2]?.options.width, "100%");
		assert.equal(tui.overlays[2]?.options.maxHeight, 8);
		assert.equal(visible(tui.overlays[0], 120, 30), true);
		assert.equal(visible(tui.overlays[1], 120, 30), false);
		assert.equal(visible(tui.overlays[2], 120, 30), false);
		assert.equal(components.right.presentation, "dock");

		surface.dispose();
		assert.deepEqual(tui.render(120), ["main:120"]);
		assert.equal(tui.hideCount, 3);
	});

	it("reserves bottom rows after the footer by default", () => {
		const tui = new FakeTui();
		tui.terminal.columns = 80;
		tui.terminal.rows = 40;
		tui.rootFactory = (width) => Array.from(
			{ length: 50 },
			(_, index) => index === 49 ? "footer" : `root:${index}:${width}`,
		);
		const surface = createSidebarSurface(tui as unknown as TUI, fakeComponents(), options);
		const rendered = tui.render(80);
		assert.equal(surface.backend(), "bottom");
		assert.equal(rendered.length, 58);
		assert.equal(rendered[49], "footer");
		assert.ok(rendered.slice(50).every((line) => line === " ".repeat(80)));
		const viewport = rendered.slice(-40);
		assert.equal(viewport[31], "footer");
		assert.ok(viewport.slice(32).every((line) => line === " ".repeat(80)));
		assert.equal(visible(tui.overlays[0], 80, 40), false);
		assert.equal(visible(tui.overlays[1], 80, 40), false);
		assert.equal(visible(tui.overlays[2], 80, 40), true);
		surface.dispose();
	});

	it("supports the legacy top shelf as a configured narrow position", () => {
		const tui = new FakeTui();
		tui.terminal.columns = 80;
		tui.terminal.rows = 40;
		tui.rootFactory = (width) => Array.from(
			{ length: 50 },
			(_, index) => index === 49 ? "footer" : `root:${index}:${width}`,
		);
		const surface = createSidebarSurface(
			tui as unknown as TUI,
			fakeComponents(),
			{ ...options, narrowPosition: "top" },
		);
		const rendered = tui.render(80);
		assert.equal(surface.backend(), "top");
		assert.equal(rendered.length, 50);
		assert.equal(rendered[9], "root:9:80");
		assert.ok(rendered.slice(10, 18).every((line) => line === " ".repeat(80)));
		assert.equal(rendered[18], "root:18:80");
		assert.equal(rendered[49], "footer");
		assert.equal(visible(tui.overlays[1], 80, 40), true);
		assert.equal(visible(tui.overlays[2], 80, 40), false);
		surface.dispose();
	});

	it("keeps a short root intact and skips both unsafe narrow overlays for that frame", () => {
		const tui = new FakeTui();
		tui.terminal.columns = 80;
		tui.terminal.rows = 40;
		tui.rootFactory = () => ["editor", "footer"];
		const surface = createSidebarSurface(tui as unknown as TUI, fakeComponents(), options);
		assert.deepEqual(tui.render(80), ["editor", "footer"]);
		assert.equal(visible(tui.overlays[1], 80, 40), false);
		assert.equal(visible(tui.overlays[2], 80, 40), false);
		assert.equal(surface.backend(), "bottom");
		surface.dispose();
	});

	it("activates the configured narrow mode only for very tall terminals of usable width", () => {
		const tui = new FakeTui();
		tui.terminal.columns = 80;
		tui.terminal.rows = 31;
		tui.rootFactory = (width) => Array.from({ length: 40 }, (_, index) => `root:${index}:${width}`);
		const surface = createSidebarSurface(tui as unknown as TUI, fakeComponents(), options);
		assert.equal(surface.backend(), "hidden");
		assert.deepEqual(tui.render(80), tui.rootFactory(80));

		tui.terminal.rows = 32;
		tui.render(80);
		assert.equal(surface.backend(), "bottom");
		assert.equal(visible(tui.overlays[2], 80, 32), true);

		tui.terminal.columns = 31;
		tui.render(31);
		assert.equal(surface.backend(), "hidden");
		assert.equal(visible(tui.overlays[2], 31, 40), false);
		surface.dispose();
	});

	it("uses wide overlay fallback when another extension already owns render", () => {
		const tui = new FakeTui();
		const original = tui.render.bind(tui);
		tui.render = (width) => original(width);
		const surface = createSidebarSurface(tui as unknown as TUI, fakeComponents(), options);
		assert.equal(surface.backend(), "overlay");
		assert.deepEqual(tui.render(120), ["main:120"]);
		assert.equal(visible(tui.overlays[0], 120, 30), true);
		tui.terminal.columns = 80;
		tui.terminal.rows = 40;
		assert.equal(surface.backend(), "hidden");
		assert.equal(visible(tui.overlays[1], 80, 40), false);
		assert.equal(visible(tui.overlays[2], 80, 40), false);
		surface.dispose();
	});

	it("never uses an unreserved narrow mode when overlay mode is forced", () => {
		const tui = new FakeTui();
		tui.terminal.columns = 80;
		tui.terminal.rows = 40;
		const surface = createSidebarSurface(
			tui as unknown as TUI,
			fakeComponents(),
			{ ...options, mode: "overlay" },
		);
		assert.equal(surface.backend(), "hidden");
		assert.deepEqual(tui.render(80), ["main:80"]);
		assert.equal(visible(tui.overlays[1], 80, 40), false);
		assert.equal(visible(tui.overlays[2], 80, 40), false);
		surface.dispose();
	});

	it("falls back to a wide overlay after a dock render failure", () => {
		const tui = new FakeTui();
		const warnings: string[] = [];
		tui.rootFactory = (width) => {
			if (width === 77) throw new Error("narrow render failed");
			return [`main:${width}`];
		};
		const surface = createSidebarSurface(
			tui as unknown as TUI,
			fakeComponents(),
			{ ...options, onWarning: (message) => warnings.push(message) },
		);
		assert.deepEqual(tui.render(120), ["main:120"]);
		assert.equal(surface.backend(), "overlay");
		assert.equal(visible(tui.overlays[0], 120, 30), true);
		assert.equal(visible(tui.overlays[1], 120, 30), false);
		assert.equal(visible(tui.overlays[2], 120, 30), false);
		assert.deepEqual(warnings, ["Adaptive sidebar reservation disabled after a render failure: narrow render failed"]);
		surface.dispose();
	});

	it("rolls back mounted overlays and the render wrapper when the third mount fails", () => {
		const tui = new FakeTui();
		tui.failOverlayAt = 3;
		assert.throws(
			() => createSidebarSurface(tui as unknown as TUI, fakeComponents(), options),
			/overlay mount failed/,
		);
		assert.equal(tui.hideCount, 2);
		assert.equal(Object.prototype.hasOwnProperty.call(tui, "render"), false);
		assert.deepEqual(tui.render(120), ["main:120"]);
	});

	it("leaves a later render wrapper installed and makes its own wrapper inert", () => {
		const tui = new FakeTui();
		const surface = createSidebarSurface(
			tui as unknown as TUI,
			fakeComponents(),
			{ ...options, mode: "dock" },
		);
		const sidebarWrapper = tui.render;
		const later = (width: number) => sidebarWrapper.call(tui, width);
		tui.render = later;
		surface.dispose();
		assert.equal(tui.render, later);
		assert.deepEqual(tui.render(120), ["main:120"]);
	});

	it("switches exactly at the right-dock width threshold", () => {
		const tui = new FakeTui();
		tui.terminal.rows = 30;
		const surface = createSidebarSurface(tui as unknown as TUI, fakeComponents(), options);
		assert.deepEqual(tui.render(107), ["main:64"]);
		assert.deepEqual(tui.render(106), ["main:106"]);
		surface.dispose();
	});
});
