import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	SidebarPanel,
	SidebarPanelRenderContext,
} from "../api.ts";

export const CONFIG_STATUS_PROTOCOL_VERSION = 1 as const;
export const CONFIG_STATUS_READY_EVENT = "@neumie/config-status:v1:ready";
export const CONFIG_STATUS_REQUEST_EVENT = "@neumie/config-status:v1:request";
export const CONFIG_STATUS_SNAPSHOT_EVENT = "@neumie/config-status:v1:snapshot";

const MAX_UPDATES = 64;
const MAX_NAME_CHARS = 160;
const MAX_VERSION_CHARS = 80;
const MAX_DETAIL_CHARS = 640;
const KINDS = new Set(["local", "npm", "git", "unknown"]);

export interface ConfigStatusUpdateV1 {
	name: string;
	version?: string;
	kind: "local" | "npm" | "git" | "unknown";
	detail: string;
}

export interface ConfigStatusSnapshotV1 {
	version: typeof CONFIG_STATUS_PROTOCOL_VERSION;
	checkedAt: string;
	updates: ConfigStatusUpdateV1[];
	updatesOmitted: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? value as Record<string, unknown>
		: undefined;
}

function safeLine(value: unknown, maxChars: number): value is string {
	return (
		typeof value === "string" &&
		value.length <= maxChars &&
		!/[\u0000-\u001f\u007f-\u009f]/.test(value)
	);
}

function parseUpdate(value: unknown): ConfigStatusUpdateV1 | undefined {
	const update = record(value);
	if (!safeLine(update?.name, MAX_NAME_CHARS)) return undefined;
	if (!safeLine(update.detail, MAX_DETAIL_CHARS)) return undefined;
	if (!KINDS.has(String(update.kind))) return undefined;
	if (
		update.version !== undefined &&
		!safeLine(update.version, MAX_VERSION_CHARS)
	) {
		return undefined;
	}
	return {
		name: update.name,
		...(typeof update.version === "string"
			? { version: update.version }
			: {}),
		kind: update.kind as ConfigStatusUpdateV1["kind"],
		detail: update.detail,
	};
}

function validOmittedCount(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10_000;
}

export function parseConfigStatusSnapshot(
	value: unknown,
): ConfigStatusSnapshotV1 | undefined {
	const envelope = record(value);
	if (envelope?.version !== CONFIG_STATUS_PROTOCOL_VERSION) return undefined;
	if (!safeLine(envelope.checkedAt, 80)) return undefined;
	if (!Array.isArray(envelope.updates)) return undefined;
	if (envelope.updates.length > MAX_UPDATES) return undefined;
	if (!validOmittedCount(envelope.updatesOmitted)) return undefined;
	const updates: ConfigStatusUpdateV1[] = [];
	for (const raw of envelope.updates) {
		const update = parseUpdate(raw);
		if (!update) return undefined;
		updates.push(update);
	}
	return {
		version: CONFIG_STATUS_PROTOCOL_VERSION,
		checkedAt: envelope.checkedAt,
		updates,
		updatesOmitted: envelope.updatesOmitted,
	};
}

export function renderConfigUpdates(
	snapshot: ConfigStatusSnapshotV1 | undefined,
	context: SidebarPanelRenderContext,
): string[] {
	const updates = snapshot?.updates ?? [];
	if (updates.length === 0 || context.width <= 0 || context.height <= 0) return [];
	const omitted = snapshot?.updatesOmitted ?? 0;
	const totalUpdates = updates.length + omitted;
	const count = omitted === 10_000 ? `${totalUpdates}+` : String(totalUpdates);
	const urgency = omitted > 0 ? "error" : "warning";
	return [
		`${context.theme.fg(urgency, count)}${context.theme.fg("dim", " · /config-status")}`,
	];
}

export function createConfigUpdatesPanel(pi: ExtensionAPI): SidebarPanel {
	let snapshot: ConfigStatusSnapshotV1 | undefined;
	let connected = false;
	let disposed = false;
	let generation = 0;
	let invalidate: () => void = () => undefined;

	const requestStatus = () => {
		if (!connected || disposed) return;
		try {
			pi.events.emit(CONFIG_STATUS_REQUEST_EVENT, {
				version: CONFIG_STATUS_PROTOCOL_VERSION,
				source: { extension: "@neumie/pi-sidebar" },
			});
		} catch {
			// Optional providers cannot break sidebar rendering.
		}
	};
	const unsubscribes = [
		pi.events.on(CONFIG_STATUS_READY_EVENT, requestStatus),
		pi.events.on(CONFIG_STATUS_SNAPSHOT_EVENT, (payload) => {
			const parsed = parseConfigStatusSnapshot(payload);
			if (!parsed) return;
			snapshot = parsed;
			if (connected) invalidate();
		}),
	];
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		connected = false;
		generation += 1;
		for (const unsubscribe of unsubscribes) unsubscribe();
	};
	pi.on("session_shutdown", dispose);

	return {
		id: "neumie.config-updates",
		title: "Config updates",
		showTitleInRight: false,
		showTitleInNarrow: false,
		order: 250,
		connect(context) {
			if (disposed) return () => undefined;
			generation += 1;
			const connectionGeneration = generation;
			connected = true;
			invalidate = context.invalidate;
			queueMicrotask(requestStatus);
			if (snapshot) invalidate();
			const disconnect = () => {
				if (!connected || generation !== connectionGeneration) return;
				connected = false;
				generation += 1;
			};
			context.signal.addEventListener("abort", disconnect, { once: true });
			return disconnect;
		},
		render(context) {
			return renderConfigUpdates(snapshot, context);
		},
	};
}
