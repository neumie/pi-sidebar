import { randomUUID } from "node:crypto";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SidebarPanel } from "../api.ts";
import { sanitizeSidebarLine, withRightHint } from "../render.ts";

const RPC_READY_EVENT = "subagents:rpc:v1:ready";
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const REFRESH_EVENTS = [
	"subagent:async-started",
	"subagent:async-complete",
	"subagent:foreground-complete",
	"subagent:control-event",
] as const;
const MAX_WORKFLOW_DETAILS = 8;
const MAX_TARGETED_STATUS_PER_REFRESH = 2;
const WORKFLOW_STATES = new Set([
	"queued",
	"running",
	"completed",
	"failed",
	"paused",
	"stopped",
]);
const ASYNC_SNAPSHOT_STATES = new Set([
	"queued",
	"running",
	"complete",
	"failed",
	"partial",
	"paused",
	"stopped",
	"rejected",
]);
const RPC_TIMEOUT_MS = 1_500;
const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 30_000;
const ELAPSED_REFRESH_MS = 1_000;

interface ForegroundLaunch {
	id: string;
	entries: Array<
		Pick<FleetEntry, "agent" | "role" | "model" | "effort" | "goal">
	>;
	startedAt: number;
}

interface FleetEntry {
	key: string;
	agent: string;
	role?: string;
	model?: string;
	effort?: string;
	startedAt: number;
	tokens: { input?: number; output?: number; total?: number };
	goal?: string;
}

interface FleetSnapshot {
	entries: FleetEntry[];
	totalActive: number;
	omitted?: number;
}

interface WorkflowDetailChild {
	childId: string;
	agent?: string;
	sessionName?: string;
	model?: string;
	thinking?: string;
	state: string;
	activity?: { inputTokens?: number; outputTokens?: number; tokens?: number };
}
interface WorkflowDetail {
	workflowRunId: string;
	parentToolCallId: string;
	workflowState: string;
	inventoryComplete: boolean;
	children: WorkflowDetailChild[];
	startedAt: number;
}
interface AsyncSnapshotRun {
	id: string;
	kind: string;
	state: string;
	label: string;
	startedAt?: number;
	updatedAt?: number;
}

type ProjectedEntry = Omit<FleetEntry, "key">;

const MAX_FLEET_ENTRIES = 16;
const SGR = /\x1b\[[0-?]*[ -/]*m/g;

function cleanText(value: unknown, maximum: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = sanitizeSidebarLine(value)
		.replace(SGR, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maximum);
	return text || undefined;
}

function safeCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
		: 0;
}

function validNativeId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 4_096 &&
		value.trim().length > 0 &&
		Buffer.byteLength(value, "utf8") <= 4_096
	);
}

function parseWorkflowChildren(
	value: unknown,
	expectedRunId?: string,
	expectedToolCallId?: string,
): WorkflowDetail | undefined {
	try {
		const source = record(value);
		if (
			!source ||
			source.version !== 1 ||
			!validNativeId(source.workflowRunId) ||
			!validNativeId(source.parentToolCallId) ||
			(expectedRunId && source.workflowRunId !== expectedRunId) ||
			(expectedToolCallId && source.parentToolCallId !== expectedToolCallId) ||
			typeof source.inventoryComplete !== "boolean" ||
			!WORKFLOW_STATES.has(String(source.workflowState)) ||
			!Array.isArray(source.children)
		)
			return undefined;
		const complete = source.children.length <= 32;
		const children: WorkflowDetailChild[] = [];
		const childIds = new Set<string>();
		for (const raw of source.children.slice(0, 32)) {
			const child = record(raw);
			if (
				!child ||
				typeof child.childId !== "string" ||
				!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(child.childId) ||
				childIds.has(child.childId) ||
				![
					"pending",
					"running",
					"completed",
					"failed",
					"paused",
					"stopped",
					"rejected",
					"detached",
				].includes(String(child.state))
			)
				continue;
			childIds.add(child.childId);
			const activity =
				child.state === "running" ? record(child.activity) : undefined;
			children.push({
				childId: child.childId,
				...(cleanText(child.agent, 96)
					? { agent: cleanText(child.agent, 96) }
					: {}),
				...(cleanText(child.sessionName, 96)
					? { sessionName: cleanText(child.sessionName, 96) }
					: {}),
				...(cleanText(child.model, 128)
					? { model: cleanText(child.model, 128) }
					: {}),
				...(cleanText(child.thinking, 64)
					? { thinking: cleanText(child.thinking, 64) }
					: {}),
				state: String(child.state),
				...(activity
					? {
							activity: {
								...(typeof activity.inputTokens === "number" &&
								Number.isFinite(activity.inputTokens) &&
								activity.inputTokens >= 0
									? { inputTokens: safeCount(activity.inputTokens) }
									: {}),
								...(typeof activity.outputTokens === "number" &&
								Number.isFinite(activity.outputTokens) &&
								activity.outputTokens >= 0
									? { outputTokens: safeCount(activity.outputTokens) }
									: {}),
								...(typeof activity.tokens === "number" &&
								Number.isFinite(activity.tokens) &&
								activity.tokens >= 0
									? { tokens: safeCount(activity.tokens) }
									: {}),
							},
						}
					: {}),
			});
		}
		// Native summaries have no timestamp. This is first observation, not child runtime.
		return {
			workflowRunId: source.workflowRunId,
			parentToolCallId: source.parentToolCallId,
			workflowState: String(source.workflowState),
			inventoryComplete:
				source.inventoryComplete &&
				complete &&
				children.length === source.children.length,
			children,
			startedAt: Date.now(),
		};
	} catch {
		return undefined;
	}
}

function parseAsyncSnapshot(value: unknown): AsyncSnapshotRun[] {
	try {
		const snapshot = record(value);
		if (
			!snapshot ||
			snapshot.version !== 1 ||
			snapshot.kind !== "pi-subagents.async-status-snapshot" ||
			!Array.isArray(snapshot.runs)
		)
			return [];
		const seen = new Set<string>();
		return snapshot.runs.slice(0, 64).flatMap((raw) => {
			const run = record(raw);
			if (
				!run ||
				!validNativeId(run.id) ||
				seen.has(run.id) ||
				run.kind !== "workflow" ||
				!ASYNC_SNAPSHOT_STATES.has(String(run.state))
			)
				return [];
			seen.add(run.id);
			return [
				{
					id: run.id,
					kind: "workflow",
					state: String(run.state),
					label: cleanText(run.label, 128) ?? "workflow",
					...(typeof run.startedAt === "number" &&
					Number.isSafeInteger(run.startedAt) &&
					run.startedAt >= 0
						? { startedAt: run.startedAt }
						: {}),
					...(typeof run.updatedAt === "number" &&
					Number.isSafeInteger(run.updatedAt) &&
					run.updatedAt >= 0
						? { updatedAt: run.updatedAt }
						: {}),
				},
			];
		});
	} catch {
		return [];
	}
}

export { parseWorkflowChildren, parseAsyncSnapshot };

/** Parse the documented optional v1 fleet capability; malformed entries are dropped. */
export function parseSubagentFleet(value: unknown): FleetSnapshot | undefined {
	try {
		const fleet = record(value);
		if (fleet?.version !== 1 || !Array.isArray(fleet.entries)) return undefined;
		const entries: FleetEntry[] = [];
		for (const value of fleet.entries.slice(0, MAX_FLEET_ENTRIES)) {
			const entry = record(value);
			const key = cleanText(entry?.key, 128);
			const agent = cleanText(entry?.agent, 96);
			const startedAt = entry?.startedAt;
			const tokens = record(entry?.tokens);
			if (
				!key ||
				!agent ||
				typeof startedAt !== "number" ||
				!Number.isSafeInteger(startedAt) ||
				startedAt < 0 ||
				!tokens
			)
				continue;
			const role = cleanText(entry?.role, 96);
			const model = cleanText(entry?.model, 128);
			const effort = cleanText(entry?.effort, 64);
			const goal = cleanText(entry?.goal, 512);
			entries.push({
				key,
				agent,
				...(role ? { role } : {}),
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
				startedAt,
				tokens: {
					...(typeof tokens.input === "number" && Number.isFinite(tokens.input)
						? { input: safeCount(tokens.input) }
						: {}),
					...(typeof tokens.output === "number" &&
					Number.isFinite(tokens.output)
						? { output: safeCount(tokens.output) }
						: {}),
					...(typeof tokens.total === "number" && Number.isFinite(tokens.total)
						? { total: safeCount(tokens.total) }
						: {}),
				},
				...(goal ? { goal } : {}),
			});
		}
		entries.sort(
			(left, right) =>
				left.startedAt - right.startedAt || left.key.localeCompare(right.key),
		);
		return {
			entries,
			totalActive: Math.max(entries.length, safeCount(fleet.totalActive)),
			...(fleet.omitted === undefined
				? {}
				: { omitted: Math.min(10_000, safeCount(fleet.omitted)) }),
		};
	} catch {
		return undefined;
	}
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

function formatModel(value: string): string {
	const model =
		cleanText(value, 160)
			?.split("/")
			.at(-1)
			?.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "") ?? "";
	const tier = model.match(/^gpt-5\.6-(sol|terra|luna)$/i)?.[1];
	return tier
		? `GPT-5.6 ${tier.charAt(0).toUpperCase()}${tier.slice(1).toLowerCase()}`
		: model.replace(/^claude-/, "");
}

function effortColor(effort: string): Parameters<Theme["fg"]>[0] {
	if (effort === "off") return "dim";
	if (effort === "minimal" || effort === "low") return "muted";
	if (effort === "medium") return "accent";
	if (effort === "high" || effort === "xhigh") return "warning";
	return effort === "max" ? "error" : "text";
}

function modelAndEffort(
	entry: Pick<FleetEntry, "model" | "effort">,
	theme: Theme,
	width?: number,
): string {
	const model = entry.model
		? theme.fg("accent", theme.bold(formatModel(entry.model)))
		: theme.fg("muted", "model pending");
	const effort = theme.fg(
		entry.effort ? effortColor(entry.effort) : "dim",
		entry.effort ?? "effort pending",
	);
	const divider = theme.fg("dim", " · ");
	if (width === undefined) return `${model}${divider}${effort}`;
	// Keep effort visible even when a long model name needs clipping.
	const modelWidth = Math.max(0, width - visibleWidth(divider + effort));
	return truncateToWidth(
		`${truncateToWidth(model, modelWidth)}${divider}${effort}`,
		width,
	);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function launchEntries(value: unknown): ForegroundLaunch["entries"] {
	const input = record(value);
	if (!input || typeof input.action === "string") return [];
	const entry = (
		candidate: unknown,
	): ForegroundLaunch["entries"][number] | undefined => {
		const item = record(candidate);
		const agent = cleanText(item?.agent, 96);
		if (!agent) return undefined;
		return {
			agent,
			...(cleanText(item?.role, 96) ? { role: cleanText(item?.role, 96) } : {}),
			...(cleanText(item?.model, 128)
				? { model: cleanText(item?.model, 128) }
				: {}),
			...(cleanText(item?.thinking ?? item?.effort, 64)
				? { effort: cleanText(item?.thinking ?? item?.effort, 64) }
				: {}),
			...(cleanText(item?.task ?? item?.goal, 512)
				? { goal: cleanText(item?.task ?? item?.goal, 512) }
				: {}),
		};
	};
	if (Array.isArray(input.tasks))
		return input.tasks
			.map(entry)
			.filter((item): item is ForegroundLaunch["entries"][number] =>
				Boolean(item),
			);
	if (Array.isArray(input.chain))
		return input.chain.flatMap((step) => {
			const item = record(step);
			const children = Array.isArray(item?.parallel) ? item.parallel : [step];
			return children
				.map(entry)
				.filter((child): child is ForegroundLaunch["entries"][number] =>
					Boolean(child),
				);
		});
	return [entry(input)].filter(
		(item): item is ForegroundLaunch["entries"][number] => Boolean(item),
	);
}

export function parseSubagentStatusText(value: unknown): {
	lines: string[];
	active: boolean;
	count: number;
} {
	if (typeof value !== "string") return { lines: [], active: false, count: 0 };
	const trimmed = value.trim();
	if (!trimmed) return { lines: [], active: false, count: 0 };
	const source = trimmed
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim());
	if (source.some((line) => /^No active async runs\.?$/i.test(line.trim()))) {
		return { lines: [], active: false, count: 0 };
	}
	const headingIndex = source.findIndex((line) =>
		/^Active async runs:\s*\d+/i.test(line.trim()),
	);
	if (headingIndex < 0) return { lines: [], active: false, count: 0 };
	const heading = source[headingIndex]!.trim().match(
		/^Active async runs:\s*(\d+)/i,
	);
	const countText = heading?.[1];
	const count = countText ? Number(countText) : 0;
	if (!Number.isSafeInteger(count) || count <= 0)
		return { lines: [], active: false, count: 0 };
	// Legacy peers expose only human text, whose child lines can contain private IDs.
	// Keep it as an availability fallback, never a child-detail source.
	const lines = [`${count} async run${count === 1 ? "" : "s"}`];
	return { lines, active: true, count };
}

function elapsed(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
	return seconds < 60
		? `${seconds}s`
		: `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function activeState(state: string): boolean {
	return state === "running" || state === "pending" || state === "queued";
}

function activeDetail(detail: WorkflowDetail): boolean {
	return (
		activeState(detail.workflowState) ||
		detail.children.some((child) => activeState(child.state))
	);
}

function parseWorkflowResult(
	value: unknown,
	runId: string,
	toolCallId?: string,
): WorkflowDetail | undefined {
	try {
		const envelope = record(value);
		if (envelope?.mode !== "workflow" || envelope.runId !== runId)
			return undefined;
		return parseWorkflowChildren(envelope.workflowChildren, runId, toolCallId);
	} catch {
		return undefined;
	}
}

function workflowDetailLines(
	detail: WorkflowDetail,
	theme: Theme,
	width: number,
	now: number,
): string[] {
	const fit = (line: string) => truncateToWidth(line, Math.max(0, width));
	const divider = theme.fg("dim", " · ");
	const lines = [
		fit(
			`${theme.fg("accent", "◇")} ${theme.bold("Workflow detail")}${divider}${detail.workflowState}${divider}${theme.fg("dim", `seen ${elapsed(detail.startedAt, now)}`)}`,
		),
	];
	const active = detail.children.filter((child) => activeState(child.state));
	const selected = (active.length > 0 ? active : detail.children).slice(0, 2);
	for (const child of selected) {
		// Separate bounded rows keep state, effort and usage out of the outer clipper.
		const prefix = `  ${workflowStateGlyph(child.state, theme)} `;
		const label = child.sessionName ?? child.agent ?? "child";
		const labelWidth = Math.max(
			0,
			width - visibleWidth(prefix) - child.state.length - 1,
		);
		lines.push(
			fit(
				withRightHint(
					`${prefix}${truncateToWidth(label, labelWidth)}`,
					child.state,
					width,
				),
			),
		);
		const effort = truncateToWidth(
			child.thinking ?? "effort n/a",
			Math.min(10, Math.max(0, width - 4)),
		);
		const model = child.model ? formatModel(child.model) : "model n/a";
		const modelWidth = Math.max(0, width - 4 - visibleWidth(divider + effort));
		lines.push(
			fit(
				`    ${theme.fg("accent", truncateToWidth(model, modelWidth))}${divider}${theme.fg("text", effort)}`,
			),
		);
		const usage =
			child.state === "running" &&
			child.activity &&
			(child.activity.inputTokens !== undefined ||
				child.activity.outputTokens !== undefined)
				? `↑${child.activity.inputTokens === undefined ? "unavailable" : formatTokens(child.activity.inputTokens)} ↓${child.activity.outputTokens === undefined ? "unavailable" : formatTokens(child.activity.outputTokens)}`
				: "usage unavailable";
		lines.push(fit(theme.fg("muted", `    ${usage}`)));
	}
	const completed = detail.children.filter(
		(child) => child.state === "completed",
	).length;
	const hidden = detail.children.length - selected.length;
	lines.push(
		fit(
			theme.fg(
				"dim",
				`  ${detail.children.length} observed${completed ? ` · ${completed} completed` : ""}`,
			),
		),
	);
	if (hidden > 0)
		lines.push(fit(theme.fg("dim", `  ${hidden} children hidden`)));
	if (!detail.inventoryComplete)
		lines.push(fit(theme.fg("dim", "  inventory incomplete")));
	return lines;
}

function workflowStateGlyph(state: string, theme: Theme): string {
	if (state === "running") return theme.fg("accent", "◉");
	if (state === "pending" || state === "queued") return theme.fg("muted", "○");
	if (state === "completed") return theme.fg("success", "✓");
	if (state === "failed" || state === "rejected") return theme.fg("error", "×");
	if (state === "paused" || state === "detached")
		return theme.fg("warning", "‖");
	return theme.fg("dim", "–");
}

function colorStatusLine(line: string, theme: Theme): string {
	if (line.startsWith("●") || line.startsWith("◆")) {
		return `${theme.fg("accent", "◆")}${line.slice(1)}`;
	}
	const color = /failed|needs attention|error/i.test(line)
		? "warning"
		: /complete|done/i.test(line)
			? "success"
			: "dim";
	return `${theme.fg("accent", "◆")} ${theme.fg(color, line)}`;
}

function entrySignature(entry: Pick<ProjectedEntry, "agent" | "goal">): string {
	return `${entry.agent.toLowerCase()}\u0000${entry.goal?.toLowerCase() ?? ""}`;
}

function projectEntries(
	snapshot: FleetSnapshot | undefined,
	foreground: ReadonlyMap<string, ForegroundLaunch>,
): { entries: ProjectedEntry[]; totalActive: number } {
	const remote = (snapshot?.entries ?? []).map(
		({ key: _key, ...entry }) => entry,
	);
	const availableMatches = new Map<string, number>();
	for (const entry of remote) {
		const signature = entrySignature(entry);
		availableMatches.set(signature, (availableMatches.get(signature) ?? 0) + 1);
	}
	const local: ProjectedEntry[] = [];
	for (const launch of foreground.values()) {
		for (const entry of launch.entries) {
			const projected: ProjectedEntry = {
				...entry,
				startedAt: launch.startedAt,
				tokens: {},
			};
			const signature = entrySignature(projected);
			const matches = availableMatches.get(signature) ?? 0;
			if (matches > 0) {
				availableMatches.set(signature, matches - 1);
				continue;
			}
			local.push(projected);
		}
	}
	return {
		entries: [...remote, ...local],
		totalActive: (snapshot?.totalActive ?? 0) + local.length,
	};
}

export function createSubagentsPanel(pi: ExtensionAPI): SidebarPanel {
	let statusLines: string[] = [];
	let fleetSnapshot: FleetSnapshot | undefined;
	let legacyActiveCount = 0;
	let statusActive = false;
	let connected = false;
	let disposed = false;
	let rpcAvailable = false;
	let fleetSupported = false;
	let foregroundDetails = new Map<string, WorkflowDetail>();
	let asyncDetails = new Map<string, WorkflowDetail>();
	const detailKey = (detail: WorkflowDetail): string =>
		JSON.stringify([detail.parentToolCallId, detail.workflowRunId]);
	const retainDetails = () => {
		while (foregroundDetails.size + asyncDetails.size > MAX_WORKFLOW_DETAILS) {
			if (asyncDetails.size > 0)
				asyncDetails.delete(asyncDetails.keys().next().value!);
			else foregroundDetails.delete(foregroundDetails.keys().next().value!);
		}
	};
	const allDetails = () => [
		...foregroundDetails.values(),
		...asyncDetails.values(),
	];
	let workflowRunIds: string[] = [];
	let workflowQueue: string[] = [];
	let targetedRequestTimes: number[] = [];
	let snapshotIncomplete = false;
	let snapshotActive = false;
	let probePending = false;
	let statusPending = false;
	let statusDirty = false;
	let generation = 0;
	let invalidate: () => void = () => undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let pollDueAt = Infinity;
	const pendingRpc = new Set<() => void>();
	const foreground = new Map<string, ForegroundLaunch>();
	// Lifecycle ownership is independent of optional ordinary-launch placeholders.
	const liveCalls = new Map<string, { startedAt: number; runId?: string }>();

	const visibleStateKey = (): string => {
		if (
			!fleetSnapshot?.totalActive &&
			!statusLines.length &&
			!legacyActiveCount &&
			!allDetails().length &&
			!workflowRunIds.length &&
			!snapshotIncomplete
		)
			return "idle";
		return JSON.stringify({
			fleet: fleetSnapshot,
			statusLines,
			legacyActiveCount,
			details: allDetails(),
			workflowRunIds,
			snapshotIncomplete,
		});
	};
	const clearPoll = () => {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
		pollDueAt = Infinity;
	};
	const resetRemoteState = () => {
		clearPoll();
		for (const cancel of [...pendingRpc]) cancel();
		statusLines = [];
		fleetSnapshot = undefined;
		legacyActiveCount = 0;
		statusActive = false;
		rpcAvailable = false;
		fleetSupported = false;
		foregroundDetails = new Map();
		asyncDetails = new Map();
		workflowRunIds = [];
		workflowQueue = [];
		targetedRequestTimes = [];
		snapshotIncomplete = false;
		snapshotActive = false;
		liveCalls.clear();
		probePending = false;
		statusPending = false;
		statusDirty = false;
	};
	const schedulePoll = (delay: number) => {
		clearPoll();
		if (!connected || disposed || !rpcAvailable) return;
		pollDueAt = Date.now() + delay;
		pollTimer = setTimeout(() => {
			pollTimer = undefined;
			pollDueAt = Infinity;
			void refreshStatus();
		}, delay);
		pollTimer.unref?.();
	};

	const rpc = (
		method: "ping" | "status",
		params?: Record<string, unknown>,
	): Promise<unknown> => {
		const requestId = randomUUID();
		const requestGeneration = generation;
		return new Promise((resolve, reject) => {
			let settled = false;
			let unsubscribe: () => void = () => undefined;
			const finish = (error?: Error, data?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				pendingRpc.delete(cancel);
				if (error) reject(error);
				else resolve(data);
			};
			const cancel = () => finish(new Error("Subagent RPC cancelled."));
			pendingRpc.add(cancel);
			unsubscribe = pi.events.on(
				`${RPC_REPLY_PREFIX}${requestId}`,
				(payload) => {
					try {
						const reply = record(payload);
						if (
							requestGeneration !== generation ||
							reply?.requestId !== requestId
						)
							return;
						if (reply.version !== 1 || reply.method !== method) {
							finish(new Error("Invalid subagent RPC envelope."));
							return;
						}
						if (reply.success !== true) {
							const error = record(reply.error);
							finish(
								new Error(
									typeof error?.message === "string"
										? error.message
										: "Subagent RPC failed.",
								),
							);
							return;
						}
						finish(undefined, reply.data);
					} catch {
						finish(new Error("Malformed subagent RPC response."));
					}
				},
			);
			const timer = setTimeout(
				() => finish(new Error("Subagent RPC timed out.")),
				RPC_TIMEOUT_MS,
			);
			timer.unref?.();
			pi.events.emit(RPC_REQUEST_EVENT, {
				version: 1,
				requestId,
				method,
				...(params ? { params } : {}),
				source: { extension: "@neumie/pi-sidebar" },
			});
		});
	};

	const refreshStatus = async () => {
		if (!connected || disposed || !rpcAvailable) return;
		if (statusPending) {
			statusDirty = true;
			return;
		}
		statusPending = true;
		const requestGeneration = generation;
		const current = () =>
			connected && !disposed && requestGeneration === generation;
		try {
			const data = record(await rpc("status"));
			if (!current()) return;
			const snapshotRuns = parseAsyncSnapshot(data?.asyncSnapshot);
			const nextIds = snapshotRuns.map((run) => run.id);
			const ids = new Set(nextIds);
			// Preserve queue order under changing inventories; new IDs join the tail.
			workflowQueue = workflowQueue.filter((id) => ids.has(id));
			const queued = new Set(workflowQueue);
			workflowQueue.push(...nextIds.filter((id) => !queued.has(id)));
			const nextDetails = new Map(
				[...asyncDetails].filter(([id]) => ids.has(id)),
			);
			for (
				let i = 0;
				i < Math.min(MAX_TARGETED_STATUS_PER_REFRESH, nextIds.length);
				i++
			) {
				if (!current()) return;
				targetedRequestTimes = targetedRequestTimes.filter(
					(time) => Date.now() - time < ACTIVE_POLL_MS,
				);
				if (targetedRequestTimes.length >= MAX_TARGETED_STATUS_PER_REFRESH)
					break;
				const runId = workflowQueue.shift()!;
				workflowQueue.push(runId);
				targetedRequestTimes.push(Date.now());
				const previous = nextDetails.get(runId);
				nextDetails.delete(runId);
				try {
					const targeted = record(await rpc("status", { runId }));
					if (!current()) return;
					const detail = parseWorkflowResult(targeted?.details, runId);
					if (detail) {
						const start = previous?.startedAt ?? detail.startedAt;
						nextDetails.set(runId, { ...detail, startedAt: start });
					}
				} catch {
					if (!current()) return;
				}
			}
			if (!current()) return;
			const previousStateKey = visibleStateKey();
			workflowRunIds = nextIds;
			snapshotActive = snapshotRuns.some((run) => activeState(run.state));
			const snapshot = record(data?.asyncSnapshot);
			const omitted = record(snapshot?.omitted);
			snapshotIncomplete =
				safeCount(omitted?.runs) > 0 ||
				safeCount(omitted?.children) > 0 ||
				omitted?.byteLimitExceeded === true ||
				(Array.isArray(snapshot?.runs) && snapshot.runs.length > 64);
			// Compare against live foreground ownership AFTER awaits, never a stale copy.
			asyncDetails = new Map(
				[...nextDetails].filter(
					([, detail]) => !foregroundDetails.has(detailKey(detail)),
				),
			);
			retainDetails();
			fleetSnapshot = fleetSupported
				? parseSubagentFleet(data?.fleet)
				: undefined;
			const parsed = fleetSnapshot
				? { lines: [], count: 0, active: fleetSnapshot.totalActive > 0 }
				: parseSubagentStatusText(data?.text);
			statusLines = parsed.lines;
			legacyActiveCount = parsed.count;
			statusActive = parsed.active;
			if (visibleStateKey() !== previousStateKey) invalidate();
		} catch {
			if (current()) {
				const previousStateKey = visibleStateKey();
				statusLines = [];
				fleetSnapshot = undefined;
				legacyActiveCount = 0;
				statusActive = false;
				asyncDetails.clear();
				workflowRunIds = [];
				workflowQueue = [];
				snapshotIncomplete = false;
				snapshotActive = false;
				if (visibleStateKey() !== previousStateKey) invalidate();
			}
		} finally {
			if (requestGeneration !== generation) return;
			statusPending = false;
			const active =
				statusActive ||
				snapshotActive ||
				foreground.size > 0 ||
				allDetails().some(activeDetail);
			let delay = active || statusDirty ? ACTIVE_POLL_MS : IDLE_POLL_MS;
			// Event refreshes must not postpone the next eligible targeted cadence.
			if (
				(active || statusDirty) &&
				workflowQueue.length &&
				targetedRequestTimes.length
			) {
				delay = Math.max(
					0,
					ACTIVE_POLL_MS - (Date.now() - targetedRequestTimes[0]!),
				);
			}
			statusDirty = false;
			schedulePoll(delay);
		}
	};

	const probe = async () => {
		if (!connected || disposed || probePending) return;
		probePending = true;
		const requestGeneration = generation;
		try {
			const data = record(await rpc("ping"));
			if (!connected || requestGeneration !== generation) return;
			const methods = Array.isArray(data?.methods) ? data.methods : [];
			const capabilities = record(data?.capabilities);
			const fleetCapability = record(capabilities?.fleetStatus);
			fleetSupported = fleetCapability?.version === 1;
			rpcAvailable = data?.version === 1 && methods.includes("status");
			if (rpcAvailable) await refreshStatus();
		} catch {
			if (requestGeneration === generation) rpcAvailable = false;
		} finally {
			if (requestGeneration === generation) probePending = false;
		}
	};

	const refreshOrProbe = () => {
		if (!connected) return;
		if (rpcAvailable) void refreshStatus();
		else void probe();
	};
	const busUnsubscribes = [
		pi.events.on(RPC_READY_EVENT, refreshOrProbe),
		...REFRESH_EVENTS.map((event) => pi.events.on(event, refreshOrProbe)),
	];

	pi.on("tool_execution_start", (event) => {
		if (
			event.toolName !== "subagent" ||
			!connected ||
			disposed ||
			!validNativeId(event.toolCallId)
		)
			return;
		if (liveCalls.has(event.toolCallId)) return;
		const startedAt = Date.now();
		liveCalls.set(event.toolCallId, { startedAt });
		const entries = launchEntries(event.args);
		if (entries.length) {
			foreground.set(event.toolCallId, {
				id: event.toolCallId,
				entries,
				startedAt,
			});
			invalidate();
		}
		refreshOrProbe();
	});
	pi.on("tool_execution_update", (event) => {
		if (event.toolName !== "subagent" || !connected || disposed) return;
		const call = liveCalls.get(event.toolCallId);
		if (!call) return;
		try {
			const envelope = record(record(event.partialResult)?.details);
			if (!validNativeId(envelope?.runId)) return;
			const parsed = parseWorkflowResult(
				envelope,
				envelope.runId,
				event.toolCallId,
			);
			if (
				!parsed ||
				(call.runId !== undefined && call.runId !== parsed.workflowRunId)
			)
				return;
			const before = visibleStateKey();
			call.runId = parsed.workflowRunId;
			foregroundDetails.set(detailKey(parsed), {
				...parsed,
				startedAt: call.startedAt,
			});
			const remote = asyncDetails.get(parsed.workflowRunId);
			if (remote && detailKey(remote) === detailKey(parsed))
				asyncDetails.delete(parsed.workflowRunId);
			retainDetails();
			if (before !== visibleStateKey()) invalidate();
			if (activeDetail(parsed) && Date.now() + ACTIVE_POLL_MS < pollDueAt)
				schedulePoll(ACTIVE_POLL_MS);
		} catch {
			/* Malformed external event data must not break the host. */
		}
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "subagent") return;
		const removedCall = liveCalls.delete(event.toolCallId);
		const removedForeground = foreground.delete(event.toolCallId);
		let removedDetail = false;
		for (const [runId, detail] of foregroundDetails) {
			if (detail.parentToolCallId === event.toolCallId) {
				foregroundDetails.delete(runId);
				removedDetail = true;
			}
		}
		if (!removedCall && !removedForeground && !removedDetail) return;
		if (connected) {
			invalidate();
			clearPoll();
			refreshOrProbe();
		}
	});

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		connected = false;
		generation += 1;
		resetRemoteState();
		for (const unsubscribe of busUnsubscribes) unsubscribe();
		foreground.clear();
	};
	pi.on("session_shutdown", dispose);

	return {
		id: "neumie.subagents",
		title: "Subagents",
		showTitleInNarrow: false,
		order: 100,
		connect(context) {
			if (disposed || context.signal.aborted) return () => undefined;
			generation += 1;
			resetRemoteState();
			foreground.clear();
			connected = true;
			const connectionGeneration = generation;
			invalidate = context.invalidate;
			queueMicrotask(() => void probe());
			const disconnect = () => {
				context.signal.removeEventListener("abort", disconnect);
				if (!connected || generation !== connectionGeneration) return;
				connected = false;
				generation += 1;
				resetRemoteState();
				foreground.clear();
			};
			context.signal.addEventListener("abort", disconnect, { once: true });
			return disconnect;
		},
		hiddenStatus() {
			const projection = projectEntries(fleetSnapshot, foreground);
			const count = fleetSnapshot
				? projection.totalActive
				: Math.max(projection.totalActive, legacyActiveCount);
			const details = allDetails().length;
			if (count <= 0 && details <= 0) return undefined;
			const parts: string[] = [];
			if (count > 0)
				parts.push(`◆ ${count} fleet agent${count === 1 ? "" : "s"}`);
			if (details > 0)
				parts.push(`◇ ${details} workflow detail${details === 1 ? "" : "s"}`);
			return parts.join(" · ");
		},
		refreshIntervalMs() {
			return foreground.size > 0 ||
				(fleetSnapshot?.entries.length ?? 0) > 0 ||
				allDetails().some(activeDetail)
				? ELAPSED_REFRESH_MS
				: undefined;
		},
		render({ width, theme, now, height, surface }) {
			const maxRows = Math.max(0, height);
			const divider = theme.fg("dim", " · ");
			const projection = projectEntries(fleetSnapshot, foreground);
			const lines: string[] = [];
			if (maxRows <= 0 || width <= 0) return [];
			const retained = allDetails();
			const known = new Set([
				...workflowRunIds,
				...retained.map((detail) => detail.workflowRunId),
				...[...liveCalls.values()].flatMap((call) =>
					call.runId === undefined ? [] : [call.runId],
				),
			]);
			const knownCount = Math.max(known.size, retained.length);
			const fleetCount = Math.max(
				projection.totalActive,
				fleetSnapshot ? 0 : legacyActiveCount,
			);
			const hasDetails = knownCount > 0 || snapshotIncomplete;
			const hint = theme.fg("dim", "/subagents-fleet");
			if (hasDetails && maxRows === 1) {
				const overview = `${fleetCount ? `◆ ${fleetCount} fleet · ` : "◇ "}${knownCount} details hidden${snapshotIncomplete ? " · async incomplete" : ""}`;
				return [truncateToWidth(withRightHint(overview, hint, width), width)];
			}
			const cards = retained.map((detail) =>
				workflowDetailLines(detail, theme, width, now),
			);
			const fleetReserve = fleetCount > 0 ? 1 : 0;
			const needsFooter =
				snapshotIncomplete ||
				knownCount > retained.length ||
				cards.reduce((sum, card) => sum + card.length, 0) >
					maxRows - fleetReserve;
			const detailBudget = Math.max(
				0,
				maxRows - fleetReserve - (needsFooter ? 1 : 0),
			);
			let shown = 0;
			let clipped = 0;
			for (const card of cards) {
				const available = detailBudget - lines.length;
				if (available <= 0) break;
				lines.push(...card.slice(0, available));
				shown++;
				if (card.length > available) clipped++;
			}
			if (needsFooter && lines.length < maxRows - fleetReserve) {
				const hidden = Math.max(0, knownCount - shown);
				const parts = [
					hidden > 0 ? `+${hidden} details hidden` : "",
					clipped > 0 ? `${clipped} detail clipped` : "",
					snapshotIncomplete ? "async inventory incomplete" : "",
				].filter(Boolean);
				lines.push(
					truncateToWidth(
						withRightHint(theme.fg("dim", parts.join(" · ")), hint, width),
						width,
					),
				);
			}
			let represented = 0;
			const renderEntry = (entry: ProjectedEntry): string[] => {
				const usage = theme.fg(
					"text",
					`↑${entry.tokens.input === undefined ? "unavailable" : formatTokens(entry.tokens.input)} ↓${entry.tokens.output === undefined ? "unavailable" : formatTokens(entry.tokens.output)}`,
				);
				const role =
					entry.role && entry.role !== entry.agent
						? `${entry.role} · ${entry.agent}`
						: entry.agent;
				const identity = `${theme.fg("accent", "◆")} ${role}${divider}${theme.fg("dim", elapsed(entry.startedAt, now))}`;
				const metadata = modelAndEffort(entry, theme);
				const goal = theme.fg("dim", `↳ ${entry.goal ?? "Goal unavailable"}`);
				if (surface === "narrow") {
					return [
						`${identity}${divider}${metadata}`,
						`${usage}${divider}${goal}`,
					];
				}
				return [identity, `${metadata}${divider}${usage}`, goal];
			};
			for (const entry of projection.entries) {
				const reserveOverflow =
					projection.totalActive > represented + 1 ? 1 : 0;
				const budget = Math.max(0, maxRows - lines.length - reserveOverflow);
				const entryLines = renderEntry(entry);
				if (entryLines.length === 0 || entryLines.length > budget) break;
				lines.push(...entryLines);
				represented += 1;
			}
			const omitted = Math.max(0, projection.totalActive - represented);
			if (omitted > 0 && lines.length < maxRows) {
				lines.push(
					withRightHint(
						theme.fg("dim", `+${omitted} more fleet entries`),
						theme.fg("dim", "/subagents-fleet"),
						width,
					),
				);
			}
			if (!fleetSnapshot) {
				for (const line of statusLines) {
					if (lines.length >= maxRows) break;
					lines.push(colorStatusLine(line, theme));
				}
			}
			return lines;
		},
	};
}
