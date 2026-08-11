import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { SidebarPanel } from "../api.ts";
import { withRightHint } from "../render.ts";

const MAX_RUNNING_JOBS = 16;
const MAX_DISPLAY_TEXT = 240;
const MAX_PRIVATE_ID = 128;
const ELAPSED_REFRESH_MS = 1_000;

export interface BackgroundJobSummary {
	label?: string;
	startedAt: number;
}

export interface BackgroundJobsSnapshot {
	runningCount: number;
	terminalRecentCount: number;
	oldestStart?: number;
	primary?: { id: string; label?: string; startedAt: number };
	running?: BackgroundJobSummary[];
	runningOmitted?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function displayText(value: unknown, required = true): string | undefined {
	if (value === undefined && !required) return undefined;
	return typeof value === "string" && value.length <= MAX_DISPLAY_TEXT
		? value
		: undefined;
}

function privateId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_PRIVATE_ID
		? value
		: undefined;
}

function nonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

interface ParseResult<T> {
	valid: boolean;
	value?: T;
}

interface StructuredRunning {
	running: BackgroundJobSummary[];
	runningOmitted: number;
}

function parseRunningJob(value: unknown): BackgroundJobSummary | undefined {
	const input = record(value);
	if (!input) return undefined;
	const label = displayText(input.label, false);
	if ((input.label !== undefined && label === undefined)
		|| typeof input.startedAt !== "number"
		|| !Number.isFinite(input.startedAt)) return undefined;
	return {
		startedAt: input.startedAt,
		...(label !== undefined ? { label } : {}),
	};
}

function parsePrimary(value: unknown): ParseResult<NonNullable<BackgroundJobsSnapshot["primary"]>> {
	if (value === undefined) return { valid: true };
	const input = record(value);
	if (!input) return { valid: false };
	const id = privateId(input.id);
	const command = displayText(input.command);
	const label = displayText(input.label, false);
	if (id === undefined
		|| command === undefined
		|| (input.label !== undefined && label === undefined)
		|| typeof input.startedAt !== "number"
		|| !Number.isFinite(input.startedAt)) return { valid: false };
	return {
		valid: true,
		value: {
			id,
			startedAt: input.startedAt,
			...(label !== undefined ? { label } : {}),
		},
	};
}

function parseStructuredRunning(
	value: unknown,
	omittedValue: unknown,
	runningCount: number,
): ParseResult<StructuredRunning> {
	if (value === undefined && omittedValue === undefined) return { valid: true };
	if (!Array.isArray(value)
		|| value.length > MAX_RUNNING_JOBS
		|| !nonNegativeSafeInteger(omittedValue)) return { valid: false };
	const running: BackgroundJobSummary[] = [];
	for (const item of value) {
		const job = parseRunningJob(item);
		if (!job) return { valid: false };
		running.push(job);
	}
	if (running.length + omittedValue !== runningCount) return { valid: false };
	return {
		valid: true,
		value: { running, runningOmitted: omittedValue },
	};
}

function parseBackgroundJobsPayloadUnsafe(value: unknown): BackgroundJobsSnapshot | undefined {
	const input = record(value);
	if (!input
		|| !nonNegativeSafeInteger(input.runningCount)
		|| !nonNegativeSafeInteger(input.terminalRecentCount)) return undefined;
	const primary = parsePrimary(input.primary);
	const structured = parseStructuredRunning(
		input.running,
		input.runningOmitted,
		input.runningCount,
	);
	if (!primary.valid || !structured.valid) return undefined;
	const oldestStart = typeof input.oldestStart === "number" && Number.isFinite(input.oldestStart)
		? input.oldestStart
		: undefined;
	return {
		runningCount: input.runningCount,
		terminalRecentCount: input.terminalRecentCount,
		...(oldestStart !== undefined ? { oldestStart } : {}),
		...(primary.value ? { primary: primary.value } : {}),
		...(structured.value ?? {}),
	};
}

export function parseBackgroundJobsPayload(
	value: unknown,
): BackgroundJobsSnapshot | undefined {
	try {
		return parseBackgroundJobsPayloadUnsafe(value);
	} catch {
		return undefined;
	}
}

function elapsed(startedAt: number | undefined, now: number): string | undefined {
	if (startedAt === undefined) return undefined;
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function jobLine(
	job: BackgroundJobSummary,
	theme: Theme,
	now: number,
): string {
	const label = job.label || "Background job";
	const age = elapsed(job.startedAt, now);
	return `${theme.fg("success", "▸")} ${label}${age ? theme.fg("dim", ` · ${age}`) : ""}`;
}

function primaryLine(snapshot: BackgroundJobsSnapshot, theme: Theme, now: number): string {
	const primary = snapshot.primary;
	const label = primary?.label || "Background job";
	const age = elapsed(primary?.startedAt ?? snapshot.oldestStart, now);
	return `${theme.fg("success", "▸")} ${label}${age ? theme.fg("dim", ` · ${age}`) : ""}`;
}

function renderLegacyJobs(
	snapshot: BackgroundJobsSnapshot,
	theme: Theme,
	now: number,
	available: number,
	width: number,
): string[] {
	const more = Math.max(0, snapshot.runningCount - 1);
	const summary = theme.fg(
		"dim",
		`${snapshot.runningCount} running${more ? ` · +${more} more` : ""}`,
	);
	return [
		primaryLine(snapshot, theme, now),
		more > 0
			? withRightHint(summary, theme.fg("dim", "/jobs"), width)
			: summary,
	].slice(0, available);
}

function renderStructuredJobs(
	snapshot: BackgroundJobsSnapshot & { running: BackgroundJobSummary[] },
	theme: Theme,
	now: number,
	available: number,
	width: number,
): string[] {
	const needsOverflow = snapshot.runningCount > available
		|| snapshot.runningCount > snapshot.running.length;
	const jobCapacity = needsOverflow && available > 1 ? available - 1 : available;
	const lines = snapshot.running
		.slice(0, jobCapacity)
		.map((job) => jobLine(job, theme, now));
	const hidden = Math.max(0, snapshot.runningCount - lines.length);
	if (hidden > 0 && lines.length < available) {
		const summary = theme.fg("dim", `+${hidden} more`);
		lines.push(withRightHint(summary, theme.fg("dim", "/jobs"), width));
		return lines;
	}
	if (hidden > 0 && available === 1 && lines.length === 1) {
		lines[0] += theme.fg("dim", ` · +${hidden}`);
		lines[0] = withRightHint(lines[0], theme.fg("dim", "/jobs"), width);
		return lines;
	}
	return lines;
}

function renderRunningJobs(
	snapshot: BackgroundJobsSnapshot,
	theme: Theme,
	now: number,
	width: number,
	height: number,
): string[] {
	const available = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
	const fittedWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (available === 0 || fittedWidth === 0) return [];
	return snapshot.running
		? renderStructuredJobs(
			{ ...snapshot, running: snapshot.running },
			theme,
			now,
			available,
			fittedWidth,
		)
		: renderLegacyJobs(snapshot, theme, now, available, fittedWidth);
}

export function createBackgroundJobsPanel(pi: ExtensionAPI): SidebarPanel {
	let snapshot: BackgroundJobsSnapshot | undefined;
	let invalidate: () => void = () => undefined;
	let connected = false;
	let disposed = false;
	let connectionGeneration = 0;
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
		connectionGeneration += 1;
		unsubscribe();
	};
	pi.on("session_shutdown", dispose);

	return {
		id: "neumie.background-jobs",
		title: "Background jobs",
		showTitleInNarrow: false,
		order: 200,
		connect(context) {
			if (disposed) return () => undefined;
			connected = true;
			connectionGeneration += 1;
			const generation = connectionGeneration;
			invalidate = context.invalidate;
			const disconnect = () => {
				if (generation !== connectionGeneration) return;
				connected = false;
			};
			context.signal.addEventListener("abort", disconnect, { once: true });
			if (snapshot) invalidate();
			return disconnect;
		},
		hiddenStatus() {
			const count = snapshot?.runningCount ?? 0;
			return count > 0 ? `▸ ${count} job${count === 1 ? "" : "s"}` : undefined;
		},
		refreshIntervalMs() {
			const hasElapsedTime = snapshot?.running !== undefined
				? snapshot.running.length > 0
				: snapshot?.primary !== undefined || snapshot?.oldestStart !== undefined;
			return (snapshot?.runningCount ?? 0) > 0 && hasElapsedTime
				? ELAPSED_REFRESH_MS
				: undefined;
		},
		render({ width, height, theme, now }) {
			if (!snapshot || snapshot.runningCount === 0) return [];
			return renderRunningJobs(snapshot, theme, now, width, height);
		},
	};
}
