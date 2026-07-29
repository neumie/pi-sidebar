import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
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

describe("createSidebarSurface", () => {
	it("reserves only right-dock columns and mounts one non-capturing overlay", () => {
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
		assert.equal(right.presentation, "dock");
		surface.dispose();
		assert.deepEqual(tui.render(120), ["main:120"]);
		assert.equal(tui.hideCount, 1);
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

	it("keeps right overlay hidden while the editor widget owns narrow presentation", () => {
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
		assert.equal(visible(tui, 120, 40), true);
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
