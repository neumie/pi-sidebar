import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";
import { SidebarController } from "../src/controller.ts";
import { SIDEBAR_REGISTER_EVENT } from "../src/protocol.ts";

class EventBus {
	private listeners = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, listener: (payload: unknown) => void): () => void {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return () => listeners.delete(listener);
	}
	emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
	}
}

class FakeTui {
	readonly terminal = { columns: 120, rows: 14 };
	overlay?: { component: Component; options?: OverlayOptions };
	hidden = false;
	requests = 0;
	render(width: number): string[] { return [`main:${width}`]; }
	showOverlay(component: Component, options?: OverlayOptions) {
		this.overlay = { component, options };
		return {
			hide: () => { this.hidden = true; },
			setHidden() {}, isHidden: () => false, focus() {}, unfocus() {}, isFocused: () => false,
		};
	}
	requestRender(): void { this.requests += 1; }
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function harness() {
	const events = new EventBus();
	const lifecycle = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const tui = new FakeTui();
	let widget: (Component & { dispose?(): void }) | undefined;
	const notifications: string[] = [];
	let footerWrites = 0;
	const ui = {
		setWidget(_key: string, content: unknown) {
			widget?.dispose?.();
			widget = typeof content === "function"
				? (content as (tui: TUI, theme: Theme) => Component)(tui as unknown as TUI, theme)
				: undefined;
		},
		notify(message: string) { notifications.push(message); },
		setFooter() { footerWrites += 1; },
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui,
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
	const pi = {
		events,
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		},
		registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	return {
		pi, events, tui, ctx, commands, notifications,
		footerWrites: () => footerWrites,
		start: () => lifecycle.get("session_start")?.forEach((handler) => handler({ reason: "startup" }, ctx)),
		shutdown: () => lifecycle.get("session_shutdown")?.forEach((handler) => handler({ reason: "quit" }, ctx)),
	};
}

describe("SidebarController", () => {
	it("connects panels, mounts a dock without footer ownership, and disposes cleanly", async () => {
		const h = harness();
		let connected = 0;
		let disconnected = 0;
		new SidebarController(h.pi).register();
		h.events.emit(SIDEBAR_REGISTER_EVENT, {
			version: 1,
			token: "panel-token",
			panel: {
				id: "example.activity",
				title: "Activity",
				connect: () => { connected += 1; return () => { disconnected += 1; }; },
				render: () => ["active"],
			},
		});

		h.start();
		await Promise.resolve();
		assert.equal(connected, 1);
		assert.equal(h.tui.overlay?.options?.nonCapturing, true);
		assert.deepEqual(h.tui.render(120), ["main:77"]);
		const sidebarLines = h.tui.overlay?.component.render(42) ?? [];
		assert.equal(sidebarLines.length, 14);
		assert.ok(sidebarLines.every((line) => visibleWidth(line) === 42));
		assert.ok(sidebarLines.every((line) => line.startsWith("│")));
		assert.doesNotMatch(sidebarLines.join("\n"), /[╭╮╰╯─]/);
		assert.match(sidebarLines.join("\n"), /Activity/);
		assert.match(sidebarLines.join("\n"), /active/);
		assert.equal(h.footerWrites(), 0);

		h.shutdown();
		assert.equal(disconnected, 1);
		assert.equal(h.tui.hidden, true);
		assert.deepEqual(h.tui.render(120), ["main:120"]);
	});

	it("rejects partially parsed width arguments", async () => {
		const h = harness();
		new SidebarController(h.pi).register();
		h.start();
		const command = h.commands.get("sidebar");
		assert.ok(command);
		await command.handler("width 42junk", h.ctx);
		await command.handler("width 42 extra", h.ctx);
		assert.equal(h.notifications.filter((message) => /Usage|integer/.test(message)).length, 2);
		h.shutdown();
	});
});
