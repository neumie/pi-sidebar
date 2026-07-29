import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { assertSidebarPanel } from "./api.ts";
import {
	SIDEBAR_PROTOCOL_VERSION,
	SIDEBAR_READY_EVENT,
	SIDEBAR_REGISTER_EVENT,
	SIDEBAR_UNREGISTER_EVENT,
	isRegisterEnvelope,
	isUnregisterEnvelope,
	type SidebarRegisterEnvelope,
} from "./protocol.ts";
import {
	NarrowSidebarComponent,
	SidebarComponent,
	type NarrowSidebarPosition,
} from "./render.ts";
import {
	createSidebarSurface,
	type SidebarLayoutMode,
	type SidebarSurface,
} from "./surface.ts";

const WIDGET_KEY = "@neumie/pi-sidebar:bootstrap";
const HOST_SLOT = Symbol.for("@neumie/pi-sidebar:host:v1");

type HostSlot = { id: string; dispose(): void };
type HostGlobal = typeof globalThis & { [HOST_SLOT]?: HostSlot };

type Registration = SidebarRegisterEnvelope & {
	connectionAbort?: AbortController;
	connectionDispose?: () => void;
};

interface SessionRuntime {
	generation: number;
	ctx: ExtensionContext;
	surface?: SidebarSurface;
	components?: [SidebarComponent, NarrowSidebarComponent, NarrowSidebarComponent];
	tick?: ReturnType<typeof setInterval>;
}

interface SidebarSettings {
	enabled: boolean;
	mode: SidebarLayoutMode;
	width: number;
	gutter: number;
	minMainWidth: number;
	narrowPosition: NarrowSidebarPosition;
	narrowRows: number;
	minNarrowWidth: number;
	minNarrowHeight: number;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function aliasedIntegerEnv(
	name: string,
	legacyName: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	return process.env[name] === undefined
		? integerEnv(legacyName, fallback, minimum, maximum)
		: integerEnv(name, fallback, minimum, maximum);
}

function initialSettings(): SidebarSettings {
	const rawMode = process.env.PI_SIDEBAR_MODE;
	const mode: SidebarLayoutMode = rawMode === "dock" || rawMode === "overlay" ? rawMode : "auto";
	const narrowPosition: NarrowSidebarPosition = process.env.PI_SIDEBAR_NARROW_POSITION === "top"
		? "top"
		: "bottom";
	const narrowRows = aliasedIntegerEnv("PI_SIDEBAR_NARROW_ROWS", "PI_SIDEBAR_TOP_ROWS", 7, 4, 16);
	return {
		enabled: process.env.PI_SIDEBAR_ENABLED !== "0",
		mode,
		width: integerEnv("PI_SIDEBAR_WIDTH", 42, 24, 80),
		gutter: integerEnv("PI_SIDEBAR_GUTTER", 1, 0, 4),
		minMainWidth: integerEnv("PI_SIDEBAR_MIN_MAIN_WIDTH", 64, 40, 160),
		narrowPosition,
		narrowRows,
		minNarrowWidth: aliasedIntegerEnv(
			"PI_SIDEBAR_NARROW_MIN_WIDTH",
			"PI_SIDEBAR_TOP_MIN_WIDTH",
			32,
			24,
			120,
		),
		minNarrowHeight: aliasedIntegerEnv(
			"PI_SIDEBAR_NARROW_MIN_HEIGHT",
			"PI_SIDEBAR_TOP_MIN_HEIGHT",
			32,
			narrowRows + 8,
			160,
		),
	};
}

class BootstrapComponent implements Component {
	private disposed = false;

	constructor(private readonly onDispose: () => void) {}
	render(): string[] { return []; }
	invalidate(): void {}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.onDispose();
	}
}

export class SidebarController {
	private readonly hostId = randomUUID();
	private readonly settings = initialSettings();
	private readonly registrations = new Map<string, Registration>();
	private readonly protocolUnsubscribes: Array<() => void> = [];
	private session: SessionRuntime | undefined;
	private generation = 0;
	private renderQueued = false;
	private disposed = false;

	constructor(private readonly pi: ExtensionAPI) {}

	register(): void {
		const globals = globalThis as HostGlobal;
		globals[HOST_SLOT]?.dispose();
		globals[HOST_SLOT] = { id: this.hostId, dispose: () => this.dispose() };

		this.protocolUnsubscribes.push(
			this.pi.events.on(SIDEBAR_REGISTER_EVENT, (payload) => this.registerPanel(payload)),
			this.pi.events.on(SIDEBAR_UNREGISTER_EVENT, (payload) => this.unregisterPanel(payload)),
		);
		this.pi.on("session_start", (_event, ctx) => this.startSession(ctx));
		this.pi.on("session_shutdown", () => this.dispose());
		this.registerCommand();
	}

	private registerCommand(): void {
		this.pi.registerCommand("sidebar", {
			description: "Toggle or configure the Pi activity sidebar",
			handler: async (args, ctx) => {
				const parts = args.trim() ? args.trim().split(/\s+/) : [];
				const action = parts[0] ?? "toggle";
				const value = parts[1];
				if (action === "toggle" && parts.length <= 1) this.settings.enabled = !this.settings.enabled;
				else if (action === "on" && parts.length === 1) this.settings.enabled = true;
				else if (action === "off" && parts.length === 1) this.settings.enabled = false;
				else if (action === "status" && parts.length === 1) {
					ctx.ui.notify(this.statusLine(), "info");
					return;
				} else if (action === "width" && parts.length === 2) {
					const width = /^\d+$/.test(value ?? "") ? Number(value) : Number.NaN;
					if (!Number.isInteger(width) || width < 24 || width > 80) {
						ctx.ui.notify("Sidebar width must be an integer from 24 to 80.", "warning");
						return;
					}
					this.settings.width = width;
				} else if (action === "mode" && parts.length === 2) {
					if (value !== "auto" && value !== "dock" && value !== "overlay") {
						ctx.ui.notify("Sidebar mode must be auto, dock, or overlay.", "warning");
						return;
					}
					this.settings.mode = value;
				} else if (action === "narrow" && parts.length === 2) {
					if (value !== "top" && value !== "bottom") {
						ctx.ui.notify("Sidebar narrow position must be top or bottom.", "warning");
						return;
					}
					this.settings.narrowPosition = value;
				} else {
					ctx.ui.notify("Usage: /sidebar [on|off|toggle|status|width 24-80|mode auto|dock|overlay|narrow top|bottom]", "warning");
					return;
				}
				this.remount();
				ctx.ui.notify(this.statusLine(), "info");
			},
		});
	}

	private statusLine(): string {
		const backend = this.session?.surface?.backend() ?? (this.settings.enabled ? "not mounted" : "hidden");
		return `Sidebar ${this.settings.enabled ? "on" : "off"} · mode ${this.settings.mode} · backend ${backend} · width ${this.settings.width} · narrow ${this.settings.narrowPosition}/${this.settings.narrowRows} rows · ${this.registrations.size} panels`;
	}

	private startSession(ctx: ExtensionContext): void {
		if (this.disposed || ctx.mode !== "tui") return;
		this.stopSession();
		const runtime: SessionRuntime = { generation: ++this.generation, ctx };
		this.session = runtime;
		for (const registration of this.registrations.values()) this.connectPanel(registration, runtime);
		if (this.settings.enabled) this.mount(runtime);
		runtime.tick = setInterval(() => this.requestRender(), 1_000);
		runtime.tick.unref?.();
		this.pi.events.emit(SIDEBAR_READY_EVENT, {
			version: SIDEBAR_PROTOCOL_VERSION,
			hostId: this.hostId,
			sessionId: ctx.sessionManager.getSessionId(),
		});
	}

	private mount(runtime: SessionRuntime): void {
		if (!this.isCurrent(runtime)) return;
		runtime.ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			if (!this.isCurrent(runtime)) return new BootstrapComponent(() => undefined);
			const getPanels = () => [...this.registrations.values()].map((entry) => entry.panel);
			const rightComponent = new SidebarComponent({
				theme: theme as Theme,
				getPanels,
				getTerminalHeight: () => tui.terminal.rows,
				getPresentation: () => "overlay",
			});
			const narrowOptions = {
				theme: theme as Theme,
				getPanels,
				getTerminalHeight: () => tui.terminal.rows,
				getRows: () => this.settings.narrowRows,
			};
			const topComponent = new NarrowSidebarComponent({
				...narrowOptions,
				getPosition: () => "top",
			});
			const bottomComponent = new NarrowSidebarComponent({
				...narrowOptions,
				getPosition: () => "bottom",
			});
			runtime.components = [rightComponent, topComponent, bottomComponent];
			try {
				runtime.surface = createSidebarSurface(
					tui as TUI,
					{ right: rightComponent, top: topComponent, bottom: bottomComponent },
					{
						mode: this.settings.mode,
						width: this.settings.width,
						gutter: this.settings.gutter,
						minMainWidth: this.settings.minMainWidth,
						narrowPosition: this.settings.narrowPosition,
						narrowRows: this.settings.narrowRows,
						minNarrowWidth: this.settings.minNarrowWidth,
						minNarrowHeight: this.settings.minNarrowHeight,
						onWarning: (message) => runtime.ctx.ui.notify(message, "warning"),
					},
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				runtime.ctx.ui.notify(`Sidebar unavailable: ${message}`, "warning");
			}
			return new BootstrapComponent(() => {
				if (!this.isCurrent(runtime)) return;
				runtime.surface?.dispose();
				runtime.surface = undefined;
				runtime.components = undefined;
			});
		}, { placement: "belowEditor" });
	}

	private remount(): void {
		const runtime = this.session;
		if (!runtime) return;
		try {
			runtime.ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// A replacement session can stale the old UI context during teardown.
		}
		runtime.surface?.dispose();
		runtime.surface = undefined;
		runtime.components = undefined;
		if (this.settings.enabled) this.mount(runtime);
	}

	private registerPanel(payload: unknown): void {
		if (this.disposed || !isRegisterEnvelope(payload)) return;
		try {
			assertSidebarPanel(payload.panel);
		} catch (error) {
			this.report(`Rejected sidebar panel: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const current = this.registrations.get(payload.panel.id);
		if (current?.token === payload.token) return;
		if (current) this.disconnectPanel(current);
		const registration: Registration = { ...payload };
		this.registrations.set(payload.panel.id, registration);
		if (this.session) this.connectPanel(registration, this.session);
		this.requestRender();
	}

	private unregisterPanel(payload: unknown): void {
		if (!isUnregisterEnvelope(payload)) return;
		const current = this.registrations.get(payload.panelId);
		if (!current || current.token !== payload.token) return;
		this.disconnectPanel(current);
		this.registrations.delete(payload.panelId);
		this.requestRender();
	}

	private connectPanel(registration: Registration, runtime: SessionRuntime): void {
		this.disconnectPanel(registration);
		if (!registration.panel.connect || !this.isCurrent(runtime)) return;
		const controller = new AbortController();
		registration.connectionAbort = controller;
		const invalidate = () => {
			if (this.isCurrent(runtime) && !controller.signal.aborted) this.requestRender();
		};
		try {
			const connected = registration.panel.connect({
				pi: this.pi,
				session: runtime.ctx,
				signal: controller.signal,
				invalidate,
			});
			void Promise.resolve(connected).then((dispose) => {
				if (typeof dispose !== "function") return;
				if (!this.isCurrent(runtime) || controller.signal.aborted) dispose();
				else registration.connectionDispose = dispose;
			}).catch((error) => this.report(`Panel ${registration.panel.id} failed to connect: ${String(error)}`));
		} catch (error) {
			this.report(`Panel ${registration.panel.id} failed to connect: ${String(error)}`);
		}
	}

	private disconnectPanel(registration: Registration): void {
		registration.connectionAbort?.abort();
		registration.connectionAbort = undefined;
		try {
			registration.connectionDispose?.();
		} catch (error) {
			this.report(`Panel ${registration.panel.id} failed to disconnect: ${String(error)}`);
		}
		registration.connectionDispose = undefined;
	}

	private requestRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		queueMicrotask(() => {
			this.renderQueued = false;
			for (const component of this.session?.components ?? []) component.invalidate();
			this.session?.surface?.requestRender();
		});
	}

	private stopSession(): void {
		const runtime = this.session;
		if (!runtime) return;
		this.session = undefined;
		if (runtime.tick) clearInterval(runtime.tick);
		for (const registration of this.registrations.values()) this.disconnectPanel(registration);
		try {
			runtime.ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// Best effort for stale replacement-session contexts.
		}
		runtime.surface?.dispose();
	}

	private dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopSession();
		for (const unsubscribe of this.protocolUnsubscribes.splice(0)) unsubscribe();
		for (const registration of this.registrations.values()) this.disconnectPanel(registration);
		this.registrations.clear();
		const globals = globalThis as HostGlobal;
		if (globals[HOST_SLOT]?.id === this.hostId) delete globals[HOST_SLOT];
	}

	private report(message: string): void {
		if (this.session) this.session.ctx.ui.notify(message, "warning");
		else console.error(message);
	}

	private isCurrent(runtime: SessionRuntime): boolean {
		return !this.disposed && this.session === runtime && runtime.generation === this.generation;
	}
}
