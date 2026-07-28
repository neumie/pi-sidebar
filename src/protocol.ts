import type { SidebarPanel } from "./api.ts";

export const SIDEBAR_PROTOCOL_VERSION = 1 as const;
export const SIDEBAR_READY_EVENT = "@neumie/pi-sidebar:v1:ready";
export const SIDEBAR_REGISTER_EVENT = "@neumie/pi-sidebar:v1:register";
export const SIDEBAR_UNREGISTER_EVENT = "@neumie/pi-sidebar:v1:unregister";

export interface SidebarReadyEnvelope {
	version: typeof SIDEBAR_PROTOCOL_VERSION;
	hostId: string;
	sessionId?: string;
}

export interface SidebarRegisterEnvelope {
	version: typeof SIDEBAR_PROTOCOL_VERSION;
	token: string;
	panel: SidebarPanel;
}

export interface SidebarUnregisterEnvelope {
	version: typeof SIDEBAR_PROTOCOL_VERSION;
	token: string;
	panelId: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? value as Record<string, unknown>
		: undefined;
}

export function isRegisterEnvelope(value: unknown): value is SidebarRegisterEnvelope {
	const input = record(value);
	const panel = record(input?.panel);
	return input?.version === SIDEBAR_PROTOCOL_VERSION
		&& typeof input.token === "string"
		&& input.token.length > 0
		&& typeof panel?.id === "string"
		&& typeof panel.title === "string"
		&& typeof panel.render === "function";
}

export function isUnregisterEnvelope(value: unknown): value is SidebarUnregisterEnvelope {
	const input = record(value);
	return input?.version === SIDEBAR_PROTOCOL_VERSION
		&& typeof input.token === "string"
		&& input.token.length > 0
		&& typeof input.panelId === "string";
}
