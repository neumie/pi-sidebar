import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
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
	POST_FOOTER_SLOT_READY_EVENT,
	POST_FOOTER_SLOT_REQUEST_EVENT,
	parsePostFooterSlotReady,
	type PostFooterSlotHandle,
} from "./post-footer.ts";
import {
	NarrowSidebarComponent,
	SidebarComponent,
	sanitizeSidebarLine,
	type NarrowSidebarPosition,
} from "./render.ts";
import {
	DEFAULT_SIDEBAR_WIDTH,
	MAX_RESPONSIVE_SIDEBAR_WIDTH,
	responsiveSidebarWidth,
} from "./sidebar-width.ts";
import {
	createSidebarSurface,
	type SidebarLayoutMode,
	type SidebarSurface,
} from "./surface.ts";

const WIDGET_KEY = "@neumie/pi-sidebar:bootstrap";
const NARROW_WIDGET_KEY = "@neumie/pi-sidebar:narrow";
const ACTIVITY_STATUS_KEY = "@neumie/pi-sidebar:activity";
const MAX_ACTIVITY_STATUS_PARTS = 8;
const MAX_ACTIVITY_STATUS_PART_WIDTH = 48;
const MAX_ACTIVITY_STATUS_WIDTH = 160;
const SGR = /\x1b\[[0-9:;]*m/g;
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
	components?: Component[];
	narrowComponent?: AdaptiveNarrowSidebarComponent;
	postFooterToken?: string;
	postFooterHandle?: PostFooterSlotHandle;
	activityStatus?: string;
	activityStatusInitialized?: boolean;
	tick?: ReturnType<typeof setInterval>;
}

interface SidebarSettings {
	enabled: boolean;
	mode: SidebarLayoutMode;
	width: number;
	responsiveWidth: boolean;
	gutter: number;
	minMainWidth: number;
	narrowPosition: NarrowSidebarPosition;
	narrowRows: number;
	minNarrowWidth: number;
	minNarrowHeight: number;
}

function integerEnv(
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed)
		? Math.min(maximum, Math.max(minimum, parsed))
		: fallback;
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
	const mode: SidebarLayoutMode =
		rawMode === "dock" || rawMode === "overlay" ? rawMode : "auto";
	const narrowPosition: NarrowSidebarPosition =
		process.env.PI_SIDEBAR_NARROW_POSITION === "top" ? "top" : "bottom";
	const narrowRows = aliasedIntegerEnv(
		"PI_SIDEBAR_NARROW_ROWS",
		"PI_SIDEBAR_TOP_ROWS",
		7,
		4,
		16,
	);
	return {
		enabled: process.env.PI_SIDEBAR_ENABLED !== "0",
		mode,
		width: integerEnv("PI_SIDEBAR_WIDTH", DEFAULT_SIDEBAR_WIDTH, 24, 80),
		responsiveWidth: process.env.PI_SIDEBAR_WIDTH === undefined,
		gutter: integerEnv("PI_SIDEBAR_GUTTER", 0, 0, 4),
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

function sidebarWidthAt(settings: SidebarSettings, terminalWidth: number): number {
	return settings.responsiveWidth
		? responsiveSidebarWidth(terminalWidth)
		: settings.width;
}

class AdaptiveNarrowSidebarComponent implements Component {
	constructor(
		private readonly narrow: NarrowSidebarComponent,
		private readonly tui: TUI,
		private readonly settings: SidebarSettings,
		private readonly isPostFooterActive: () => boolean,
	) {}
	invalidate(): void {
		this.narrow.invalidate();
	}
	private renderNarrow(width: number): string[] {
		const wide =
			this.tui.terminal.columns >=
			this.settings.minMainWidth + this.settings.gutter +
				sidebarWidthAt(this.settings, this.tui.terminal.columns);
		if (
			this.settings.mode === "overlay" ||
			wide ||
			width < this.settings.minNarrowWidth ||
			this.tui.terminal.rows < this.settings.minNarrowHeight
		)
			return [];
		return this.narrow.render(width).slice(0, this.settings.narrowRows);
	}
	render(width: number): string[] {
		if (
			this.settings.narrowPosition === "bottom" &&
			this.isPostFooterActive()
		) return [];
		return this.renderNarrow(width);
	}
	renderPostFooter(width: number): string[] {
		return this.settings.narrowPosition === "bottom"
			? this.renderNarrow(width)
			: [];
	}
}

class BootstrapComponent implements Component {
	private disposed = false;

	constructor(private readonly onDispose: () => void) {}
	render(): string[] {
		return [];
	}
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
			this.pi.events.on(SIDEBAR_REGISTER_EVENT, (payload) =>
				this.registerPanel(payload),
			),
			this.pi.events.on(SIDEBAR_UNREGISTER_EVENT, (payload) =>
				this.unregisterPanel(payload),
			),
			this.pi.events.on(POST_FOOTER_SLOT_READY_EVENT, (payload) =>
				this.registerPostFooterSlot(payload),
			),
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
				if (action === "toggle" && parts.length <= 1)
					this.settings.enabled = !this.settings.enabled;
				else if (action === "on" && parts.length === 1)
					this.settings.enabled = true;
				else if (action === "off" && parts.length === 1)
					this.settings.enabled = false;
				else if (action === "status" && parts.length === 1) {
					ctx.ui.notify(this.statusLine(), "info");
					return;
				} else if (action === "width" && parts.length === 2) {
					if (value === "auto") {
						this.settings.width = DEFAULT_SIDEBAR_WIDTH;
						this.settings.responsiveWidth = true;
					} else {
						const width = /^\d+$/.test(value ?? "") ? Number(value) : Number.NaN;
						if (!Number.isInteger(width) || width < 24 || width > 80) {
							ctx.ui.notify(
								"Sidebar width must be auto or an integer from 24 to 80.",
								"warning",
							);
							return;
						}
						this.settings.width = width;
						this.settings.responsiveWidth = false;
					}
				} else if (action === "mode" && parts.length === 2) {
					if (value !== "auto" && value !== "dock" && value !== "overlay") {
						ctx.ui.notify(
							"Sidebar mode must be auto, dock, or overlay.",
							"warning",
						);
						return;
					}
					this.settings.mode = value;
				} else if (action === "narrow" && parts.length === 2) {
					if (value !== "top" && value !== "bottom") {
						ctx.ui.notify(
							"Sidebar narrow position must be top or bottom.",
							"warning",
						);
						return;
					}
					this.settings.narrowPosition = value;
				} else {
					ctx.ui.notify(
						"Usage: /sidebar [on|off|toggle|status|width auto|24-80|mode auto|dock|overlay|narrow top|bottom]",
						"warning",
					);
					return;
				}
				this.remount();
				ctx.ui.notify(this.statusLine(), "info");
			},
		});
	}

	private statusLine(): string {
		const backend =
			this.session?.surface?.backend() ??
			(this.settings.enabled ? "not mounted" : "hidden");
		const width = this.settings.responsiveWidth
			? `auto ${DEFAULT_SIDEBAR_WIDTH}–${MAX_RESPONSIVE_SIDEBAR_WIDTH}`
			: String(this.settings.width);
		return `Sidebar ${this.settings.enabled ? "on" : "off"} · mode ${this.settings.mode} · backend ${backend} · width ${width} · narrow ${this.settings.narrowPosition}/${this.settings.narrowRows} rows · ${this.registrations.size} panels`;
	}

	private startSession(ctx: ExtensionContext): void {
		if (this.disposed || ctx.mode !== "tui") return;
		this.stopSession();
		const runtime: SessionRuntime = { generation: ++this.generation, ctx };
		this.session = runtime;
		for (const registration of this.registrations.values())
			this.connectPanel(registration, runtime);
		if (this.settings.enabled) this.mount(runtime);
		this.syncActivityStatus(runtime);
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
		const placement =
			this.settings.narrowPosition === "bottom" ? "belowEditor" : "aboveEditor";
		runtime.ctx.ui.setWidget(
			NARROW_WIDGET_KEY,
			(tui, theme) => {
				const narrow = new NarrowSidebarComponent({
					theme: theme as Theme,
					getPanels: () =>
						[...this.registrations.values()].map((entry) => entry.panel),
					getTerminalHeight: () => tui.terminal.rows,
					getRows: () => this.settings.narrowRows,
					getPosition: () => this.settings.narrowPosition,
				});
				const component = new AdaptiveNarrowSidebarComponent(
					narrow,
					tui as TUI,
					this.settings,
					() => this.postFooterActive(runtime),
				);
				runtime.narrowComponent = component;
				runtime.components = [...(runtime.components ?? []), component];
				return component;
			},
			{ placement },
		);
		runtime.ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				if (!this.isCurrent(runtime))
					return new BootstrapComponent(() => undefined);
				const getPanels = () =>
					[...this.registrations.values()].map((entry) => entry.panel);
				const rightComponent = new SidebarComponent({
					theme: theme as Theme,
					getPanels,
					getTerminalHeight: () => tui.terminal.rows,
					getPresentation: () => "overlay",
				});
				runtime.components = [...(runtime.components ?? []), rightComponent];
				try {
					runtime.surface = createSidebarSurface(
						tui as TUI,
						{ right: rightComponent },
						{
							mode: this.settings.mode,
							width: this.settings.width,
							resolveWidth: this.settings.responsiveWidth
								? responsiveSidebarWidth
								: undefined,
							gutter: this.settings.gutter,
							minMainWidth: this.settings.minMainWidth,
							narrowPosition: this.settings.narrowPosition,
							narrowRows: this.settings.narrowRows,
							minNarrowWidth: this.settings.minNarrowWidth,
							minNarrowHeight: this.settings.minNarrowHeight,
							onBackendChange: () => this.requestRender(),
							onWarning: (message) => runtime.ctx.ui.notify(message, "warning"),
						},
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					runtime.ctx.ui.notify(`Sidebar unavailable: ${message}`, "warning");
				}
				return new BootstrapComponent(() => {
					if (!this.isCurrent(runtime)) return;
					this.disposePostFooterSlot(runtime);
					try {
						runtime.ctx.ui.setWidget(NARROW_WIDGET_KEY, undefined);
					} catch {
						/* stale teardown */
					}
					runtime.surface?.dispose();
					runtime.surface = undefined;
					runtime.components = undefined;
				});
			},
			{ placement: "belowEditor" },
		);
		this.requestPostFooterSlot(runtime);
	}

	private remount(): void {
		const runtime = this.session;
		if (!runtime) return;
		this.disposePostFooterSlot(runtime);
		try {
			runtime.ctx.ui.setWidget(WIDGET_KEY, undefined);
			runtime.ctx.ui.setWidget(NARROW_WIDGET_KEY, undefined);
		} catch {
			// A replacement session can stale the old UI context during teardown.
		}
		runtime.surface?.dispose();
		runtime.surface = undefined;
		runtime.components = undefined;
		runtime.narrowComponent = undefined;
		if (this.settings.enabled) this.mount(runtime);
		this.syncActivityStatus(runtime);
	}

	private requestPostFooterSlot(runtime: SessionRuntime): void {
		if (!this.isCurrent(runtime) || this.settings.narrowPosition !== "bottom")
			return;
		this.pi.events.emit(POST_FOOTER_SLOT_REQUEST_EVENT, {
			version: 1,
			sessionId: runtime.ctx.sessionManager.getSessionId(),
		});
	}

	private registerPostFooterSlot(payload: unknown): void {
		const source = parsePostFooterSlotReady(payload);
		const runtime = this.session;
		if (!source || !runtime || !this.isCurrent(runtime)) return;
		if (source.sessionId !== runtime.ctx.sessionManager.getSessionId()) return;
		if (this.settings.narrowPosition !== "bottom") return;
		if (
			runtime.postFooterToken === source.token &&
			this.postFooterActive(runtime)
		) return;
		const previousHandle = runtime.postFooterHandle;
		const handle = source.register({
			id: "neumie.sidebar.narrow",
			token: `${this.hostId}:${runtime.generation}`,
			order: 100,
			maxRows: this.settings.narrowRows,
			render: (width) =>
				this.isCurrent(runtime)
					? runtime.narrowComponent?.renderPostFooter(width) ?? []
					: [],
		});
		if (!handle?.isActive()) {
			handle?.dispose();
			return;
		}
		runtime.postFooterToken = source.token;
		runtime.postFooterHandle = handle;
		if (previousHandle !== handle) previousHandle?.dispose();
		this.requestRender();
	}

	private postFooterActive(runtime: SessionRuntime): boolean {
		if (!this.isCurrent(runtime)) return false;
		try {
			return runtime.postFooterHandle?.isActive() === true;
		} catch {
			return false;
		}
	}

	private disposePostFooterSlot(runtime: SessionRuntime): void {
		runtime.postFooterHandle?.dispose();
		runtime.postFooterHandle = undefined;
		runtime.postFooterToken = undefined;
	}

	private registerPanel(payload: unknown): void {
		if (this.disposed || !isRegisterEnvelope(payload)) return;
		try {
			assertSidebarPanel(payload.panel);
		} catch (error) {
			this.report(
				`Rejected sidebar panel: ${error instanceof Error ? error.message : String(error)}`,
			);
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

	private connectPanel(
		registration: Registration,
		runtime: SessionRuntime,
	): void {
		this.disconnectPanel(registration);
		if (!registration.panel.connect || !this.isCurrent(runtime)) return;
		const controller = new AbortController();
		registration.connectionAbort = controller;
		const invalidate = () => {
			if (this.isCurrent(runtime) && !controller.signal.aborted)
				this.requestRender();
		};
		try {
			const connected = registration.panel.connect({
				pi: this.pi,
				session: runtime.ctx,
				signal: controller.signal,
				invalidate,
			});
			void Promise.resolve(connected)
				.then((dispose) => {
					if (typeof dispose !== "function") return;
					if (!this.isCurrent(runtime) || controller.signal.aborted) dispose();
					else registration.connectionDispose = dispose;
				})
				.catch((error) =>
					this.report(
						`Panel ${registration.panel.id} failed to connect: ${String(error)}`,
					),
				);
		} catch (error) {
			this.report(
				`Panel ${registration.panel.id} failed to connect: ${String(error)}`,
			);
		}
	}

	private disconnectPanel(registration: Registration): void {
		registration.connectionAbort?.abort();
		registration.connectionAbort = undefined;
		try {
			registration.connectionDispose?.();
		} catch (error) {
			this.report(
				`Panel ${registration.panel.id} failed to disconnect: ${String(error)}`,
			);
		}
		registration.connectionDispose = undefined;
	}

	private requestRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		queueMicrotask(() => {
			this.renderQueued = false;
			const runtime = this.session;
			if (runtime) this.syncActivityStatus(runtime);
			for (const component of runtime?.components ?? []) component.invalidate();
			runtime?.surface?.requestRender();
		});
	}

	private syncActivityStatus(runtime: SessionRuntime): void {
		if (!this.isCurrent(runtime)) return;
		const hidden = !this.settings.enabled || runtime.surface?.backend() === "hidden";
		const parts: string[] = [];
		if (hidden) {
			const panels = [...this.registrations.values()]
				.map((registration) => registration.panel)
				.sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
			for (const panel of panels) {
				if (parts.length >= MAX_ACTIVITY_STATUS_PARTS) break;
				try {
					const value = panel.hiddenStatus?.();
					if (typeof value !== "string") continue;
					const safe = truncateToWidth(
						sanitizeSidebarLine(value),
						MAX_ACTIVITY_STATUS_PART_WIDTH,
						"…",
					);
					if (safe.replace(SGR, "").trim()) parts.push(safe);
				} catch {
					// A failing optional summary cannot break the footer or sidebar.
				}
			}
		}
		const value = parts.length
			? truncateToWidth(parts.join(" · "), MAX_ACTIVITY_STATUS_WIDTH, "…")
			: undefined;
		if (runtime.activityStatusInitialized && runtime.activityStatus === value) return;
		try {
			runtime.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, value);
			runtime.activityStatus = value;
			runtime.activityStatusInitialized = true;
		} catch {
			// Replacement sessions can stale an old UI context during teardown.
		}
	}

	private stopSession(): void {
		const runtime = this.session;
		if (!runtime) return;
		this.disposePostFooterSlot(runtime);
		try {
			runtime.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
		} catch {
			// Best effort for stale replacement-session contexts.
		}
		this.session = undefined;
		if (runtime.tick) clearInterval(runtime.tick);
		for (const registration of this.registrations.values())
			this.disconnectPanel(registration);
		try {
			runtime.ctx.ui.setWidget(WIDGET_KEY, undefined);
			runtime.ctx.ui.setWidget(NARROW_WIDGET_KEY, undefined);
		} catch {
			// Best effort for stale replacement-session contexts.
		}
		runtime.surface?.dispose();
	}

	private dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopSession();
		for (const unsubscribe of this.protocolUnsubscribes.splice(0))
			unsubscribe();
		for (const registration of this.registrations.values())
			this.disconnectPanel(registration);
		this.registrations.clear();
		const globals = globalThis as HostGlobal;
		if (globals[HOST_SLOT]?.id === this.hostId) delete globals[HOST_SLOT];
	}

	private report(message: string): void {
		if (this.session) this.session.ctx.ui.notify(message, "warning");
		else console.error(message);
	}

	private isCurrent(runtime: SessionRuntime): boolean {
		return (
			!this.disposed &&
			this.session === runtime &&
			runtime.generation === this.generation
		);
	}
}
