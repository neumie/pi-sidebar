import { randomUUID } from "node:crypto";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
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
const RPC_TIMEOUT_MS = 1_500;
const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 5_000;

interface ForegroundLaunch {
	id: string;
	entries: Array<
		Pick<FleetEntry, "agent" | "role" | "model" | "effort" | "goal" | "kind">
	>;
	startedAt: number;
}

type FleetWorkflowStepState = "pending" | "running" | "completed" | "failed";

interface FleetWorkflowStep {
	key: string;
	agent: string;
	label?: string;
	phase?: string;
	state: FleetWorkflowStepState;
	model?: string;
	effort?: string;
	startedAt?: number;
	tokens: { input: number; output: number; total: number };
	goal?: string;
}

interface FleetWorkflow {
	phase?: string;
	total: number;
	completed: number;
	running: number;
	pending: number;
	failed: number;
	steps: FleetWorkflowStep[];
	omitted: number;
}

interface FleetEntry {
	key: string;
	agent: string;
	role?: string;
	model?: string;
	effort?: string;
	startedAt: number;
	tokens: { input: number; output: number; total: number };
	goal?: string;
	kind?: "workflow";
	workflow?: FleetWorkflow;
}

interface FleetSnapshot {
	entries: FleetEntry[];
	totalActive: number;
}

type ProjectedEntry = Omit<FleetEntry, "key">;

const MAX_FLEET_ENTRIES = 16;
const MAX_WORKFLOW_STEPS = 16;
const MAX_WORKFLOW_TOTAL = 256;
const WORKFLOW_STEP_STATES = new Set<FleetWorkflowStepState>(["pending", "running", "completed", "failed"]);
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

function parseWorkflowStep(value: unknown): FleetWorkflowStep | undefined {
	const step = record(value);
	const key = cleanText(step?.key, 96);
	const agent = cleanText(step?.agent, 96);
	const state = cleanText(step?.state, 16) as FleetWorkflowStepState | undefined;
	const tokens = record(step?.tokens);
	if (!key || !agent || !state || !WORKFLOW_STEP_STATES.has(state) || !tokens) return undefined;
	const startedAt = step?.startedAt;
	const label = cleanText(step?.label, 128);
	const phase = cleanText(step?.phase, 128);
	const model = cleanText(step?.model, 128);
	const effort = cleanText(step?.effort, 64);
	const goal = cleanText(step?.goal, 512);
	return {
		key,
		agent,
		...(label ? { label } : {}),
		...(phase ? { phase } : {}),
		state,
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		...(typeof startedAt === "number" && Number.isSafeInteger(startedAt) && startedAt >= 0 ? { startedAt } : {}),
		tokens: { input: safeCount(tokens.input), output: safeCount(tokens.output), total: safeCount(tokens.total) },
		...(goal ? { goal } : {}),
	};
}

function normalizeWorkflowProgress(workflow: Record<string, unknown>, steps: FleetWorkflowStep[]) {
	const observed = {
		completed: steps.filter((step) => step.state === "completed").length,
		running: steps.filter((step) => step.state === "running").length,
		pending: steps.filter((step) => step.state === "pending").length,
		failed: steps.filter((step) => step.state === "failed").length,
	};
	const boundedCount = (value: unknown) => Math.min(MAX_WORKFLOW_TOTAL, safeCount(value));
	let completed = Math.max(observed.completed, boundedCount(workflow.completed));
	let running = Math.max(observed.running, boundedCount(workflow.running));
	let pending = Math.max(observed.pending, boundedCount(workflow.pending));
	let failed = Math.max(observed.failed, boundedCount(workflow.failed));
	if (completed + running + pending + failed > MAX_WORKFLOW_TOTAL) {
		({ completed, running, pending, failed } = observed);
	}
	const accounted = completed + running + pending + failed;
	const total = Math.min(MAX_WORKFLOW_TOTAL, Math.max(steps.length, accounted, boundedCount(workflow.total)));
	return {
		total,
		completed,
		running,
		pending,
		failed,
		omitted: Math.min(total, Math.max(boundedCount(workflow.omitted), Math.max(0, total - steps.length))),
	};
}

function parseWorkflow(value: unknown): FleetWorkflow | undefined {
	const workflow = record(value);
	if (!workflow || !Array.isArray(workflow.steps)) return undefined;
	const steps = workflow.steps.slice(0, MAX_WORKFLOW_STEPS).flatMap((value) => {
		const step = parseWorkflowStep(value);
		return step ? [step] : [];
	});
	const phase = cleanText(workflow.phase, 128);
	return {
		...(phase ? { phase } : {}),
		...normalizeWorkflowProgress(workflow, steps),
		steps,
	};
}

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
			if (!key || !agent || typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0 || !tokens) continue;
			const role = cleanText(entry?.role, 96);
			const model = cleanText(entry?.model, 128);
			const effort = cleanText(entry?.effort, 64);
			const goal = cleanText(entry?.goal, 512);
			const workflow = entry?.kind === "workflow" ? parseWorkflow(entry.workflow) : undefined;
			entries.push({
				key,
				agent,
				...(role ? { role } : {}),
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
				startedAt,
				tokens: {
					input: safeCount(tokens.input),
					output: safeCount(tokens.output),
					total: safeCount(tokens.total),
				},
				...(goal ? { goal } : {}),
				...(workflow ? { kind: "workflow" as const, workflow } : {}),
			});
		}
		entries.sort((left, right) => left.startedAt - right.startedAt || left.key.localeCompare(right.key));
		return { entries, totalActive: Math.max(entries.length, safeCount(fleet.totalActive)) };
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
	const workflowScript = cleanText(input.workflowScript, 512);
	if (workflowScript) return [{ agent: "workflow", kind: "workflow", goal: workflowScript }];
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
	if (!Number.isSafeInteger(count) || count <= 0) return { lines: [], active: false, count: 0 };
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

function workflowStepGlyph(state: FleetWorkflowStepState, theme: Theme): string {
	if (state === "running") return theme.fg("accent", "◉");
	if (state === "pending") return theme.fg("dim", "○");
	if (state === "failed") return theme.fg("error", "×");
	return theme.fg("success", "✓");
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
	const remote = (snapshot?.entries ?? []).map(({ key: _key, ...entry }) => entry);
	const availableMatches = new Map<string, number>();
	let availableWorkflowMatches = 0;
	for (const entry of remote) {
		if (entry.kind === "workflow") {
			availableWorkflowMatches += 1;
			continue;
		}
		const signature = entrySignature(entry);
		availableMatches.set(signature, (availableMatches.get(signature) ?? 0) + 1);
	}
	const local: ProjectedEntry[] = [];
	for (const launch of foreground.values()) {
		for (const entry of launch.entries) {
			const projected: ProjectedEntry = {
				...entry,
				startedAt: launch.startedAt,
				tokens: { input: 0, output: 0, total: 0 },
			};
			if (projected.kind === "workflow" && availableWorkflowMatches > 0) {
				availableWorkflowMatches -= 1;
				continue;
			}
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
	let probePending = false;
	let statusPending = false;
	let statusDirty = false;
	let generation = 0;
	let invalidate: () => void = () => undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	const pendingRpc = new Set<() => void>();
	const foreground = new Map<string, ForegroundLaunch>();

	const clearPoll = () => {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
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
		probePending = false;
		statusPending = false;
		statusDirty = false;
	};
	const schedulePoll = (delay: number) => {
		clearPoll();
		if (!connected || disposed || !rpcAvailable) return;
		pollTimer = setTimeout(() => void refreshStatus(), delay);
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
					const reply = record(payload);
					if (
						requestGeneration !== generation ||
						reply?.requestId !== requestId
					)
						return;
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
		try {
			const data = record(await rpc("status"));
			if (!connected || requestGeneration !== generation) return;
			const fleet = fleetSupported
				? parseSubagentFleet(data?.fleet)
				: undefined;
			fleetSnapshot = fleet;
			if (fleet) {
				statusLines = [];
				legacyActiveCount = 0;
				statusActive = fleet.totalActive > 0;
			} else {
				const parsed = parseSubagentStatusText(data?.text);
				statusLines = parsed.lines;
				legacyActiveCount = parsed.count;
				statusActive = parsed.active;
			}
			invalidate();
		} catch {
			if (connected && requestGeneration === generation) {
				statusLines = [];
				fleetSnapshot = undefined;
				legacyActiveCount = 0;
				statusActive = false;
				invalidate();
			}
		} finally {
			if (requestGeneration !== generation) return;
			statusPending = false;
			if (statusDirty) {
				statusDirty = false;
				queueMicrotask(() => void refreshStatus());
			} else {
				schedulePoll(
					statusActive || foreground.size ? ACTIVE_POLL_MS : IDLE_POLL_MS,
				);
			}
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
		if (event.toolName !== "subagent") return;
		const entries = launchEntries(event.args);
		if (!entries.length) return;
		foreground.set(event.toolCallId, {
			id: event.toolCallId,
			entries,
			startedAt: Date.now(),
		});
		if (connected) {
			invalidate();
			clearPoll();
			refreshOrProbe();
		}
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "subagent" || !foreground.delete(event.toolCallId))
			return;
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
			if (disposed) return () => undefined;
			generation += 1;
			resetRemoteState();
			foreground.clear();
			connected = true;
			const connectionGeneration = generation;
			invalidate = context.invalidate;
			queueMicrotask(() => void probe());
			const disconnect = () => {
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
			const count = fleetSnapshot ? projection.totalActive : Math.max(projection.totalActive, legacyActiveCount);
			if (count <= 0) return undefined;
			const workflows = projection.entries.filter((entry) => entry.kind === "workflow" && entry.workflow);
			if (workflows.length === 0) return `◆ ${count} agent${count === 1 ? "" : "s"}`;
			const workflowAgents = workflows.reduce((total, entry) => total + (entry.workflow?.running ?? 0) + (entry.workflow?.pending ?? 0), 0);
			const agentCount = Math.max(0, count - workflows.length) + workflowAgents;
			const parts = [`${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`];
			if (agentCount > 0) parts.push(`${agentCount} agent${agentCount === 1 ? "" : "s"}`);
			return `◆ ${parts.join(" · ")}`;
		},
		render({ width, theme, now, height, surface }) {
			const maxRows = Math.max(0, height);
			const divider = theme.fg("dim", " · ");
			const projection = projectEntries(fleetSnapshot, foreground);
			const lines: string[] = [];
			let represented = 0;
			const renderEntry = (entry: ProjectedEntry, budget: number): string[] => {
				const usage = theme.fg("text", `↑${formatTokens(entry.tokens.input)} ↓${formatTokens(entry.tokens.output)}`);
				if (entry.kind === "workflow" && entry.workflow) {
					if (budget <= 0) return [];
					const phase = entry.workflow.phase ? `${divider}${theme.fg("accent", entry.workflow.phase)}` : "";
					const header = `${theme.fg("accent", "◆")} ${theme.bold("Workflow")}${phase}${divider}${theme.fg("dim", elapsed(entry.startedAt, now))}`;
					if (budget === 1) return [header];
					const activeSteps = entry.workflow.steps.filter((step) => step.state === "running" || step.state === "pending");
					const candidates = activeSteps.length > 0 ? activeSteps : entry.workflow.steps;
					const childCapacity = Math.min(2, Math.max(0, budget - 2));
					const children = candidates.slice(0, childCapacity).map((step) => {
						const label = step.label ?? step.key;
						const agent = step.agent !== label ? `${divider}${theme.fg("muted", step.agent)}` : "";
						return `  ${workflowStepGlyph(step.state, theme)} ${label}${agent}`;
					});
					const progress = entry.workflow.total > 0
						? `${entry.workflow.completed}/${entry.workflow.total} complete${entry.workflow.failed > 0 ? ` · ${entry.workflow.failed} failed` : ""}`
						: "waiting for child launch";
					const summary = `${theme.fg("dim", `  ${progress}`)}${divider}${usage}`;
					return [header, ...children, summary];
				}
				const role = entry.role && entry.role !== entry.agent
					? `${entry.role} · ${entry.agent}`
					: entry.agent;
				const identity = `${theme.fg("accent", "◆")} ${role}${divider}${theme.fg("dim", elapsed(entry.startedAt, now))}`;
				const model = entry.model
					? theme.fg("accent", theme.bold(formatModel(entry.model)))
					: theme.fg("muted", "model pending");
				const effortText = entry.effort ?? "effort pending";
				const effort = theme.fg(entry.effort ? effortColor(entry.effort) : "dim", effortText);
				const goal = theme.fg("dim", `↳ ${entry.goal ?? "Goal unavailable"}`);
				if (surface === "narrow") {
					return [`${identity}${divider}${model}${divider}${effort}`, `${usage}${divider}${goal}`];
				}
				return [identity, [model, effort, usage].join(divider), goal];
			};
			for (const entry of projection.entries) {
				const reserveOverflow = projection.totalActive > represented + 1 ? 1 : 0;
				const budget = Math.max(0, maxRows - lines.length - reserveOverflow);
				const entryLines = renderEntry(entry, budget);
				if (entryLines.length === 0 || entryLines.length > budget) break;
				lines.push(...entryLines);
				represented += 1;
			}
			const omitted = Math.max(0, projection.totalActive - represented);
			if (omitted > 0 && lines.length < maxRows) {
				lines.push(withRightHint(
					theme.fg("dim", `+${omitted} more`),
					theme.fg("dim", "/subagents-fleet"),
					width,
				));
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
