import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	visibleWidth,
	type Component,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import type { SidebarPanelConnection } from "../src/api.ts";
import { SidebarController } from "../src/controller.ts";
import { POST_FOOTER_SLOT_READY_EVENT } from "../src/post-footer.ts";
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

class FakeClock {
	private nextId = 0;
	private readonly tasks = new Map<
		number,
		{ callback: () => void; delayMs: number }
	>();

	readonly scheduleClock = (callback: () => void, delayMs: number): number => {
		const id = ++this.nextId;
		this.tasks.set(id, { callback, delayMs });
		return id;
	};

	readonly cancelClock = (handle: unknown): void => {
		if (typeof handle === "number") this.tasks.delete(handle);
	};

	pending(): number {
		return this.tasks.size;
	}

	delays(): number[] {
		return [...this.tasks.values()].map((task) => task.delayMs);
	}

	runNext(): void {
		const next = this.tasks.entries().next().value as
			| [number, { callback: () => void; delayMs: number }]
			| undefined;
		if (!next) return;
		this.tasks.delete(next[0]);
		next[1].callback();
	}
}

class FakeTui {
	readonly terminal = { columns: 120, rows: 14 };
	readonly overlays: Array<{ component: Component; options?: OverlayOptions }> =
		[];
	hideCount = 0;
	requests = 0;
	render(width: number): string[] {
		if (this.terminal.rows < 32) return [`main:${width}`];
		return Array.from(
			{ length: this.terminal.rows },
			(_, index) => `main:${index}:${width}`,
		);
	}
	showOverlay(component: Component, options?: OverlayOptions) {
		this.overlays.push({ component, options });
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
		this.requests += 1;
	}
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function harness() {
	const events = new EventBus();
	const lifecycle = new Map<
		string,
		Array<(event: unknown, ctx: ExtensionContext) => void>
	>();
	const commands = new Map<
		string,
		{ handler(args: string, ctx: ExtensionContext): Promise<void> }
	>();
	const tui = new FakeTui();
	const widgets = new Map<string, Component & { dispose?(): void }>();
	const widgetPlacements = new Map<string, string>();
	const notifications: string[] = [];
	const statuses = new Map<string, string>();
	const statusWrites: Array<{ key: string; value?: string }> = [];
	let footerWrites = 0;
	let headerWrites = 0;
	const ui = {
		setWidget(key: string, content: unknown, options?: { placement?: string }) {
			widgets.get(key)?.dispose?.();
			if (typeof content === "function") {
				widgets.set(
					key,
					(content as (tui: TUI, theme: Theme) => Component)(
						tui as unknown as TUI,
						theme,
					),
				);
				widgetPlacements.set(key, options?.placement ?? "aboveEditor");
			} else {
				widgets.delete(key);
				widgetPlacements.delete(key);
			}
		},
		notify(message: string) {
			notifications.push(message);
		},
		setStatus(key: string, value: string | undefined) {
			statusWrites.push({ key, value });
			if (value === undefined) statuses.delete(key);
			else statuses.set(key, value);
		},
		setFooter() {
			footerWrites += 1;
		},
		setHeader() {
			headerWrites += 1;
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui,
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
	const pi = {
		events,
		on(
			event: string,
			handler: (event: unknown, ctx: ExtensionContext) => void,
		) {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		},
		registerCommand(
			name: string,
			command: { handler(args: string, ctx: ExtensionContext): Promise<void> },
		) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		events,
		tui,
		ctx,
		commands,
		widget: (key: string) => widgets.get(key),
		widgetPlacement: (key: string) => widgetPlacements.get(key),
		notifications,
		status: (key: string) => statuses.get(key),
		statusWrites,
		footerWrites: () => footerWrites,
		headerWrites: () => headerWrites,
		start: () =>
			lifecycle
				.get("session_start")
				?.forEach((handler) => handler({ reason: "startup" }, ctx)),
		shutdown: () =>
			lifecycle
				.get("session_shutdown")
				?.forEach((handler) => handler({ reason: "quit" }, ctx)),
	};
}

describe("SidebarController", () => {
	it("runs one shared clock only while a visible panel requests it", async () => {
		const h = harness();
		const clock = new FakeClock();
		let refreshInterval: number | undefined;
		let invalidatePanel: () => void = () => undefined;
		new SidebarController(h.pi, {
			scheduleClock: clock.scheduleClock,
			cancelClock: clock.cancelClock,
		}).register();
		h.events.emit(SIDEBAR_REGISTER_EVENT, {
			version: 1,
			token: "clock-panel-token",
			panel: {
				id: "example.clock",
				title: "Clock",
				connect: (context: SidebarPanelConnection) => {
					invalidatePanel = context.invalidate;
				},
				refreshIntervalMs: () => refreshInterval,
				render: () => ["elapsed"],
			},
		});

		h.start();
		await Promise.resolve();
		assert.equal(clock.pending(), 0);

		refreshInterval = 1_000;
		invalidatePanel();
		await Promise.resolve();
		assert.deepEqual(clock.delays(), [1_000]);

		h.tui.terminal.columns = 80;
		h.tui.terminal.rows = 14;
		h.tui.render(80);
		await Promise.resolve();
		assert.equal(clock.pending(), 0);

		h.tui.terminal.rows = 40;
		h.tui.render(80);
		await Promise.resolve();
		assert.deepEqual(clock.delays(), [1_000]);

		const before = h.tui.requests;
		clock.runNext();
		await Promise.resolve();
		assert.ok(h.tui.requests > before);
		assert.deepEqual(clock.delays(), [1_000]);

		refreshInterval = undefined;
		invalidatePanel();
		await Promise.resolve();
		assert.equal(clock.pending(), 0);
		h.shutdown();
		assert.equal(clock.pending(), 0);
	});

	it("mounts right and configurable narrow docks without footer ownership", async () => {
		const h = harness();
		let connected = 0;
		let disconnected = 0;
		let hiddenStatus = "◆ 2 agents · ▸ 3 jobs";
		let hiddenStatusReads = 0;
		let invalidatePanel: () => void = () => undefined;
		new SidebarController(h.pi).register();
		h.events.emit(SIDEBAR_REGISTER_EVENT, {
			version: 1,
			token: "panel-token",
			panel: {
				id: "example.activity",
				title: "Example panel",
				connect: (context: SidebarPanelConnection) => {
					connected += 1;
					invalidatePanel = context.invalidate;
					return () => {
						disconnected += 1;
					};
				},
				render: () => ["active"],
				hiddenStatus: () => {
					hiddenStatusReads += 1;
					return hiddenStatus;
				},
			},
		});

		h.start();
		await Promise.resolve();
		assert.equal(connected, 1);
		assert.equal(h.tui.overlays.length, 1);
		assert.equal(h.tui.overlays[0]?.options?.nonCapturing, true);
		assert.deepEqual(h.tui.render(120), ["main:78"]);
		const narrowWidget = h.widget("@neumie/pi-sidebar:narrow");
		assert.ok(narrowWidget);
		assert.equal(h.widgetPlacement("@neumie/pi-sidebar:narrow"), "belowEditor");
		assert.deepEqual(narrowWidget.render(78), []);
		const sidebarLines = h.tui.overlays[0]?.component.render(42) ?? [];
		assert.equal(sidebarLines.length, 14);
		assert.ok(sidebarLines.every((line) => visibleWidth(line) === 42));
		assert.ok(sidebarLines.every((line) => line.startsWith("│")));
		assert.doesNotMatch(sidebarLines.join("\n"), /[╭╮╰╯─]/);
		assert.match(sidebarLines.join("\n"), /Example panel/);
		assert.match(sidebarLines.join("\n"), /active/);
		assert.doesNotMatch(sidebarLines.join("\n"), /│ {2}Activity/);
		assert.equal(h.status("@neumie/pi-sidebar:activity"), undefined);
		assert.equal(hiddenStatusReads, 0);
		assert.equal(h.footerWrites(), 0);
		assert.equal(h.headerWrites(), 0);

		h.tui.terminal.columns = 80;
		h.tui.terminal.rows = 40;
		const narrowRoot = h.tui.render(80);
		assert.equal(narrowRoot.length, 40);
		assert.deepEqual(
			narrowRoot,
			Array.from({ length: 40 }, (_, index) => `main:${index}:80`),
		);
		assert.equal(h.tui.overlays[0]?.options?.visible?.(80, 40), false);
		const bottomLines = narrowWidget.render(80);
		assert.equal(h.status("@neumie/pi-sidebar:activity"), undefined);
		assert.equal(hiddenStatusReads, 0);
		assert.equal(bottomLines.length, 7);
		assert.equal(bottomLines[0], "─".repeat(80));
		assert.match(bottomLines.join("\n"), /Example panel.*active/s);
		const command = h.commands.get("sidebar");
		assert.ok(command);
		await command.handler("status", h.ctx);
		assert.match(
			h.notifications.at(-1) ?? "",
			/backend bottom.*narrow bottom\/7 rows/,
		);

		await command.handler("narrow top", h.ctx);
		const topRoot = h.tui.render(80);
		assert.deepEqual(
			topRoot,
			Array.from({ length: 40 }, (_, index) => `main:${index}:80`),
		);
		assert.equal(h.tui.overlays.at(-1)?.options?.visible?.(80, 40), false);
		assert.equal(h.widgetPlacement("@neumie/pi-sidebar:narrow"), "aboveEditor");
		const topWidget = h.widget("@neumie/pi-sidebar:narrow");
		assert.ok(topWidget);
		const topLines = topWidget.render(80);
		assert.equal(topLines.length, 7);
		assert.equal(topLines.at(-1), "─".repeat(80));
		assert.match(topLines.join("\n"), /Example panel.*active/s);
		assert.match(
			h.notifications.at(-1) ?? "",
			/backend top.*narrow top\/7 rows/,
		);

		await command.handler("mode overlay", h.ctx);
		const forcedOverlayWidget = h.widget("@neumie/pi-sidebar:narrow");
		assert.ok(forcedOverlayWidget);
		assert.deepEqual(forcedOverlayWidget.render(80), []);
		assert.match(h.notifications.at(-1) ?? "", /mode overlay.*backend hidden/);
		assert.equal(
			h.status("@neumie/pi-sidebar:activity"),
			"◆ 2 agents · ▸ 3 jobs",
		);
		assert.ok(hiddenStatusReads >= 1);

		await command.handler("off", h.ctx);
		assert.equal(
			h.status("@neumie/pi-sidebar:activity"),
			"◆ 2 agents · ▸ 3 jobs",
		);
		hiddenStatus = "◆ 1 agent";
		invalidatePanel();
		await Promise.resolve();
		assert.equal(h.status("@neumie/pi-sidebar:activity"), "◆ 1 agent");
		h.shutdown();
		assert.equal(h.status("@neumie/pi-sidebar:activity"), undefined);
		assert.equal(disconnected, 1);
		assert.equal(h.tui.hideCount, 3);
		h.tui.terminal.rows = 14;
		assert.deepEqual(h.tui.render(120), ["main:120"]);
	});

	it("moves hidden activity status immediately across resize backends", async () => {
		const h = harness();
		new SidebarController(h.pi).register();
		h.events.emit(SIDEBAR_REGISTER_EVENT, {
			version: 1,
			token: "summary-panel-token",
			panel: {
				id: "example.summary",
				title: "Summary",
				hiddenStatus: () => "◆ 1 agent · ▸ 2 jobs",
				render: () => ["active"],
			},
		});
		h.start();
		await Promise.resolve();
		assert.equal(h.status("@neumie/pi-sidebar:activity"), undefined);

		h.tui.terminal.columns = 80;
		h.tui.terminal.rows = 14;
		h.tui.render(80);
		await Promise.resolve();
		assert.equal(
			h.status("@neumie/pi-sidebar:activity"),
			"◆ 1 agent · ▸ 2 jobs",
		);

		h.tui.terminal.rows = 40;
		h.tui.render(80);
		await Promise.resolve();
		assert.equal(h.status("@neumie/pi-sidebar:activity"), undefined);
		h.shutdown();
	});

	it("moves narrow bottom below a compatible footer and keeps the widget fallback", async () => {
		const h = harness();
		h.tui.terminal.columns = 80;
		h.tui.terminal.rows = 40;
		new SidebarController(h.pi).register();
		h.events.emit(SIDEBAR_REGISTER_EVENT, {
			version: 1,
			token: "panel-token",
			panel: {
				id: "example.activity",
				title: "Example panel",
				render: () => ["active"],
			},
		});
		h.start();
		const narrowWidget = h.widget("@neumie/pi-sidebar:narrow");
		assert.ok(narrowWidget);
		assert.equal(narrowWidget.render(80).length, 7);

		let registeredSlot:
			| { render(width: number): readonly string[] }
			| undefined;
		let slotActive = false;
		h.events.emit(POST_FOOTER_SLOT_READY_EVENT, {
			version: 1,
			sessionId: "wrong-session",
			token: "foreign-footer-capability",
			register() {
				throw new Error("foreign capability must not be called");
			},
		});
		assert.equal(registeredSlot, undefined);
		h.events.emit(POST_FOOTER_SLOT_READY_EVENT, {
			version: 1,
			sessionId: "session-1",
			token: "footer-capability",
			register(slot: { render(width: number): readonly string[] }) {
				registeredSlot = slot;
				slotActive = true;
				return {
					isActive: () => slotActive,
					dispose: () => { slotActive = false; },
				};
			},
		});
		await Promise.resolve();
		const activeSlot = registeredSlot as
			| { render(width: number): readonly string[] }
			| undefined;
		assert.ok(activeSlot);
		assert.deepEqual(narrowWidget.render(80), []);
		const footerShelf = activeSlot.render(80);
		assert.equal(footerShelf.length, 7);
		assert.equal(footerShelf[0], "─".repeat(80));
		assert.match(footerShelf.join("\n"), /Example panel.*active/s);

		h.events.emit(POST_FOOTER_SLOT_READY_EVENT, {
			version: 1,
			sessionId: "session-1",
			token: "failed-footer-capability",
			register() { return undefined; },
		});
		assert.equal(slotActive, true);
		assert.deepEqual(narrowWidget.render(80), []);

		slotActive = false;
		assert.equal(narrowWidget.render(80).length, 7);
		let replacementActive = false;
		h.events.emit(POST_FOOTER_SLOT_READY_EVENT, {
			version: 1,
			sessionId: "session-1",
			token: "replacement-footer-capability",
			register(slot: { render(width: number): readonly string[] }) {
				registeredSlot = slot;
				replacementActive = true;
				return {
					isActive: () => replacementActive,
					dispose: () => { replacementActive = false; },
				};
			},
		});
		assert.deepEqual(narrowWidget.render(80), []);
		const command = h.commands.get("sidebar");
		assert.ok(command);
		await command.handler("narrow top", h.ctx);
		assert.equal(slotActive, false);
		assert.equal(replacementActive, false);
		assert.equal(
			h.widgetPlacement("@neumie/pi-sidebar:narrow"),
			"aboveEditor",
		);
		assert.equal(h.widget("@neumie/pi-sidebar:narrow")?.render(80).length, 7);

		h.shutdown();
		assert.equal(slotActive, false);
	});

	it("uses responsive width by default and keeps explicit widths fixed", async () => {
		const h = harness();
		new SidebarController(h.pi).register();
		h.start();
		const command = h.commands.get("sidebar");
		assert.ok(command);
		h.tui.terminal.columns = 256;

		let overlay = h.tui.overlays.at(-1)?.options;
		assert.equal(overlay?.visible?.(256, 40), true);
		assert.equal(overlay?.width, 58);
		assert.deepEqual(h.tui.render(256), ["main:198"]);

		await command.handler("width 50", h.ctx);
		overlay = h.tui.overlays.at(-1)?.options;
		assert.equal(overlay?.visible?.(256, 40), true);
		assert.equal(overlay?.width, 50);
		assert.deepEqual(h.tui.render(256), ["main:206"]);
		assert.match(h.notifications.at(-1) ?? "", /width 50/);

		await command.handler("width auto", h.ctx);
		overlay = h.tui.overlays.at(-1)?.options;
		assert.equal(overlay?.visible?.(256, 40), true);
		assert.equal(overlay?.width, 58);
		assert.deepEqual(h.tui.render(256), ["main:198"]);
		assert.match(h.notifications.at(-1) ?? "", /width auto 42–58/);
		h.shutdown();
	});

	it("treats the startup width environment variable as a fixed override", () => {
		const previous = process.env.PI_SIDEBAR_WIDTH;
		process.env.PI_SIDEBAR_WIDTH = "48";
		try {
			const h = harness();
			new SidebarController(h.pi).register();
			h.start();
			h.tui.terminal.columns = 256;
			const overlay = h.tui.overlays.at(-1)?.options;
			assert.equal(overlay?.visible?.(256, 40), true);
			assert.equal(overlay?.width, 48);
			assert.deepEqual(h.tui.render(256), ["main:208"]);
			h.shutdown();
		} finally {
			if (previous === undefined) delete process.env.PI_SIDEBAR_WIDTH;
			else process.env.PI_SIDEBAR_WIDTH = previous;
		}
	});

	it("rejects malformed width and narrow arguments", async () => {
		const h = harness();
		new SidebarController(h.pi).register();
		h.start();
		const command = h.commands.get("sidebar");
		assert.ok(command);
		await command.handler("width 42junk", h.ctx);
		await command.handler("width 42 extra", h.ctx);
		await command.handler("narrow middle", h.ctx);
		assert.equal(
			h.notifications.filter((message) =>
				/Usage|integer|top or bottom/.test(message),
			).length,
			3,
		);
		h.shutdown();
	});
});
