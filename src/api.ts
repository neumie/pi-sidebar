import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	SIDEBAR_PROTOCOL_VERSION,
	SIDEBAR_READY_EVENT,
	SIDEBAR_REGISTER_EVENT,
	SIDEBAR_UNREGISTER_EVENT,
	type SidebarRegisterEnvelope,
	type SidebarUnregisterEnvelope,
} from "./protocol.ts";

export interface SidebarPanelConnection {
	readonly pi: ExtensionAPI;
	readonly session: ExtensionContext;
	readonly signal: AbortSignal;
	invalidate(): void;
}

export interface SidebarPanelRenderContext {
	/** Usable body columns after host chrome; title-free narrow panels reclaim the body indent. */
	readonly width: number;
	/** Remaining body rows, excluding host-owned headings and section spacing. */
	readonly height: number;
	/** Host surface; absent only for older third-party hosts. */
	readonly surface?: "right" | "narrow";
	readonly theme: Theme;
	readonly now: number;
}

export interface SidebarPanel {
	/** Globally unique stable identifier, preferably namespaced. */
	readonly id: string;
	/** Short sentence-case section title. */
	readonly title: string;
	/** Set false when the right-rail rendering is self-identifying without a heading. */
	readonly showTitleInRight?: boolean;
	/** Set false when the narrow rendering is self-identifying without a heading. */
	readonly showTitleInNarrow?: boolean;
	readonly order?: number;
	connect?(
		context: SidebarPanelConnection,
	): void | (() => void) | Promise<void | (() => void)>;
	/** Compact, private-ID-free activity text shown in the footer only while the host is hidden. */
	hiddenStatus?(): string | undefined;
	/** Return no lines to hide this panel. Rendering must be synchronous. */
	render(context: SidebarPanelRenderContext): readonly string[];
}

const PANEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

export function assertSidebarPanel(panel: SidebarPanel): void {
	if (!panel || typeof panel !== "object") throw new Error("Sidebar panel must be an object.");
	if (!PANEL_ID.test(panel.id) || panel.id.length > 120) {
		throw new Error("Sidebar panel id must be a namespaced identifier up to 120 characters.");
	}
	if (!panel.title.trim() || panel.title.length > 80 || /[\r\n]/.test(panel.title)) {
		throw new Error("Sidebar panel title must be one line between 1 and 80 characters.");
	}
	if (panel.showTitleInRight !== undefined && typeof panel.showTitleInRight !== "boolean") {
		throw new Error("Sidebar panel showTitleInRight must be boolean when provided.");
	}
	if (panel.showTitleInNarrow !== undefined && typeof panel.showTitleInNarrow !== "boolean") {
		throw new Error("Sidebar panel showTitleInNarrow must be boolean when provided.");
	}
	if (panel.order !== undefined && !Number.isFinite(panel.order)) {
		throw new Error("Sidebar panel order must be finite when provided.");
	}
	if (panel.hiddenStatus !== undefined && typeof panel.hiddenStatus !== "function") {
		throw new Error("Sidebar panel hiddenStatus must be a function when provided.");
	}
	if (typeof panel.render !== "function") throw new Error("Sidebar panel render must be a function.");
	if (panel.connect !== undefined && typeof panel.connect !== "function") {
		throw new Error("Sidebar panel connect must be a function when provided.");
	}
}

/**
 * Register a panel with the process-local sidebar host.
 *
 * Registration is replayed whenever a host announces a new session, so provider
 * and host package load order does not matter. The disposer is token-safe: an
 * old extension instance cannot unregister a newer replacement with the same id.
 */
export function registerSidebarPanel(pi: ExtensionAPI, panel: SidebarPanel): () => void {
	assertSidebarPanel(panel);
	const token = randomUUID();
	let disposed = false;

	const announce = () => {
		if (disposed) return;
		const envelope: SidebarRegisterEnvelope = {
			version: SIDEBAR_PROTOCOL_VERSION,
			token,
			panel,
		};
		pi.events.emit(SIDEBAR_REGISTER_EVENT, envelope);
	};
	const unsubscribeReady = pi.events.on(SIDEBAR_READY_EVENT, announce);

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		unsubscribeReady();
		const envelope: SidebarUnregisterEnvelope = {
			version: SIDEBAR_PROTOCOL_VERSION,
			token,
			panelId: panel.id,
		};
		pi.events.emit(SIDEBAR_UNREGISTER_EVENT, envelope);
	};

	pi.on("session_shutdown", dispose);
	announce();
	return dispose;
}
