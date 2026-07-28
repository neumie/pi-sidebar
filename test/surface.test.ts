import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { createSidebarSurface, type SidebarSurfaceComponent } from "../src/surface.ts";

class FakeTui {
	readonly terminal = { columns: 120, rows: 30 };
	readonly widths: number[] = [];
	readonly overlays: OverlayOptions[] = [];
	hideCount = 0;
	renders = 0;

	render(width: number): string[] {
		this.widths.push(width);
		return [`main:${width}`];
	}
	showOverlay(_component: Component, options?: OverlayOptions) {
		this.overlays.push(options ?? {});
		return {
			hide: () => { this.hideCount += 1; },
			setHidden() {}, isHidden: () => false, focus() {}, unfocus() {}, isFocused: () => false,
		};
	}
	requestRender(): void { this.renders += 1; }
}

function fakeComponent(): SidebarSurfaceComponent & { presentation?: string } {
	return {
		presentation: undefined,
		setPresentation(presentation) { this.presentation = presentation; },
		render: () => [],
		invalidate() {},
	};
}

const options = { mode: "auto" as const, width: 42, gutter: 1, minMainWidth: 64 };

describe("createSidebarSurface", () => {
	it("reserves columns in auto mode and mounts a non-capturing overlay", () => {
		const tui = new FakeTui();
		const component = fakeComponent();
		const surface = createSidebarSurface(tui as unknown as TUI, component, options);
		assert.equal(surface.backend(), "dock");
		assert.deepEqual(tui.render(120), ["main:77"]);
		assert.equal(tui.overlays[0]?.nonCapturing, true);
		assert.equal(tui.overlays[0]?.anchor, "top-right");
		assert.equal(tui.overlays[0]?.width, 42);
		assert.equal(tui.overlays[0]?.maxHeight, "100%");
		assert.equal(tui.overlays[0]?.margin, 0);
		assert.equal(component.presentation, "dock");

		surface.dispose();
		assert.deepEqual(tui.render(120), ["main:120"]);
		assert.equal(tui.hideCount, 1);
	});

	it("uses overlay fallback when another extension already owns render", () => {
		const tui = new FakeTui();
		const original = tui.render.bind(tui);
		tui.render = (width) => original(width);
		const surface = createSidebarSurface(tui as unknown as TUI, fakeComponent(), options);
		assert.equal(surface.backend(), "overlay");
		assert.deepEqual(tui.render(120), ["main:120"]);
		surface.dispose();
	});

	it("leaves a later render wrapper installed and makes its own wrapper inert", () => {
		const tui = new FakeTui();
		const surface = createSidebarSurface(tui as unknown as TUI, fakeComponent(), { ...options, mode: "dock" });
		const sidebarWrapper = tui.render;
		const later = (width: number) => sidebarWrapper.call(tui, width);
		tui.render = later;
		surface.dispose();
		assert.equal(tui.render, later);
		assert.deepEqual(tui.render(120), ["main:120"]);
	});

	it("reserves only at or above the exact responsive threshold", () => {
		const tui = new FakeTui();
		const surface = createSidebarSurface(tui as unknown as TUI, fakeComponent(), options);
		assert.deepEqual(tui.render(107), ["main:64"]);
		assert.deepEqual(tui.render(106), ["main:106"]);
		surface.dispose();
	});
});
