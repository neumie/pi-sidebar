import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { SidebarPanel } from "../api.ts";

export interface BackgroundJobsSnapshot {
	runningCount: number;
	terminalRecentCount: number;
	oldestStart?: number;
	primary?: { id: string; label?: string; command: string; startedAt: number };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function parseBackgroundJobsPayload(value: unknown): BackgroundJobsSnapshot | undefined {
	const input = record(value);
	if (!input
		|| !Number.isInteger(input.runningCount) || (input.runningCount as number) < 0
		|| !Number.isInteger(input.terminalRecentCount) || (input.terminalRecentCount as number) < 0) return undefined;
	const primaryInput = record(input.primary);
	let primary: BackgroundJobsSnapshot["primary"];
	if (primaryInput !== undefined) {
		if (typeof primaryInput.id !== "string"
			|| typeof primaryInput.command !== "string"
			|| typeof primaryInput.startedAt !== "number"
			|| !Number.isFinite(primaryInput.startedAt)
			|| (primaryInput.label !== undefined && typeof primaryInput.label !== "string")) return undefined;
		primary = {
			id: primaryInput.id,
			command: primaryInput.command,
			startedAt: primaryInput.startedAt,
			...(typeof primaryInput.label === "string" ? { label: primaryInput.label } : {}),
		};
	}
	const oldestStart = typeof input.oldestStart === "number" && Number.isFinite(input.oldestStart)
		? input.oldestStart
		: undefined;
	return {
		runningCount: input.runningCount as number,
		terminalRecentCount: input.terminalRecentCount as number,
		...(oldestStart !== undefined ? { oldestStart } : {}),
		...(primary ? { primary } : {}),
	};
}

function elapsed(startedAt: number | undefined, now: number): string | undefined {
	if (startedAt === undefined) return undefined;
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function primaryLine(snapshot: BackgroundJobsSnapshot, theme: Theme, now: number): string {
	const primary = snapshot.primary;
	const label = primary?.label || primary?.command || "Background job";
	const age = elapsed(primary?.startedAt ?? snapshot.oldestStart, now);
	return `${theme.fg("accent", "●")} ${label}${age ? theme.fg("dim", ` · ${age}`) : ""}`;
}

export function createBackgroundJobsPanel(pi: ExtensionAPI): SidebarPanel {
	let snapshot: BackgroundJobsSnapshot | undefined;
	let invalidate: () => void = () => undefined;
	let connected = false;
	let disposed = false;
	const unsubscribe = pi.events.on("background-jobs:changed", (payload) => {
		const parsed = parseBackgroundJobsPayload(payload);
		if (!parsed) return;
		snapshot = parsed;
		if (connected) invalidate();
	});
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		connected = false;
		unsubscribe();
	};
	pi.on("session_shutdown", dispose);

	return {
		id: "neumie.background-jobs",
		title: "Background jobs",
		order: 200,
		connect(context) {
			connected = true;
			invalidate = context.invalidate;
			context.signal.addEventListener("abort", () => { connected = false; }, { once: true });
			if (snapshot) invalidate();
			return dispose;
		},
		render({ theme, now }) {
			if (!snapshot || snapshot.runningCount === 0) return [];
			const more = Math.max(0, snapshot.runningCount - 1);
			return [
				primaryLine(snapshot, theme, now),
				theme.fg("dim", `${snapshot.runningCount} running${more ? ` · +${more} more` : ""}${snapshot.terminalRecentCount ? ` · ${snapshot.terminalRecentCount} recent` : ""}`),
			];
		},
	};
}
