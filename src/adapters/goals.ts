import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type {
	SidebarPanel,
	SidebarPanelConnection,
	SidebarPanelRenderContext,
} from "../api.ts";

export const GOAL_STATUS_PROTOCOL_VERSION = 1 as const;
export const GOAL_STATUS_REQUEST_EVENT = "@neumie/pi-subagents-goal:v1:status-request";
export const GOAL_STATUS_EVENT = "@neumie/pi-subagents-goal:v1:status";

const PHASES = new Set([
	"active",
	"paused",
	"cancelling",
	"cancelled",
	"completed",
	"budget_exhausted",
	"faulted",
]);
const WORK_STATES = new Set([
	"queued",
	"running",
	"needs_attention",
	"paused",
	"stopping",
	"succeeded",
	"failed",
	"timed_out",
	"stopped",
	"interrupted",
	"budget_exhausted",
	"unknown",
]);
const OUTPUT_STATES = new Set(["awaiting", "pending_surface", "surfaced", "consumed"]);
const WORK_ROLES = new Set(["work", "review"]);
const CONTINUATIONS = new Set(["reserved", "queued", "running"]);
const REVIEWS = new Set(["none", "pass", "fail"]);

export interface GoalStatusWorkItem {
	label: string;
	role: "work" | "review";
	state: string;
	outputState: string;
}

export interface GoalStatusSnapshot {
	epoch: number;
	phase: string;
	live: boolean;
	objective: string;
	startedAt: number;
	updatedAt: number;
	work: {
		total: number;
		active: number;
		terminal: number;
		unread: number;
		unsuccessful: number;
		items: GoalStatusWorkItem[];
		itemsOmitted: number;
	};
	budget: {
		limits: {
			maxAutomaticTurns: number;
			maxTokens: number | null;
			maxWallClockMs: number | null;
			maxNoProgressTurns: number;
		};
		usage: {
			automaticTurns: number;
			tokens: number;
			noProgressTurns: number;
		};
	};
	continuation?: "reserved" | "queued" | "running";
	review: "none" | "pass" | "fail";
	reason?: string;
}

export interface GoalStatusEnvelope {
	version: 1;
	providerId: string;
	sequence: number;
	sessionId: string;
	goal: GoalStatusSnapshot | null;
	providerError?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function finiteTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
	return (
		typeof value === "string" &&
		value.length <= maximum &&
		(allowEmpty || value.length > 0) &&
		!/[\0]/u.test(value)
	);
}

function optionalLimit(value: unknown): value is number | null {
	return value === null || (safeInteger(value) && value >= 1);
}

interface WorkCounters {
	total: number;
	active: number;
	terminal: number;
	unread: number;
	unsuccessful: number;
	itemsOmitted: number;
}

function parseWorkCounters(input: Record<string, unknown>): WorkCounters | undefined {
	const { total, active, terminal, unread, unsuccessful, itemsOmitted } = input;
	if (!safeInteger(total) || !safeInteger(active) || !safeInteger(terminal)) return undefined;
	if (!safeInteger(unread) || !safeInteger(unsuccessful) || !safeInteger(itemsOmitted))
		return undefined;
	if (active > total || terminal > total) return undefined;
	if (unread > terminal || unsuccessful > terminal) return undefined;
	return { total, active, terminal, unread, unsuccessful, itemsOmitted };
}

function parseWorkItem(value: unknown): GoalStatusWorkItem | undefined {
	const item = record(value);
	if (!item || !boundedText(item.label, 256)) return undefined;
	if (typeof item.role !== "string" || !WORK_ROLES.has(item.role)) return undefined;
	if (typeof item.state !== "string" || !WORK_STATES.has(item.state)) return undefined;
	if (typeof item.outputState !== "string" || !OUTPUT_STATES.has(item.outputState)) return undefined;
	return {
		label: item.label,
		role: item.role as GoalStatusWorkItem["role"],
		state: item.state,
		outputState: item.outputState,
	};
}

function parseWork(value: unknown): GoalStatusSnapshot["work"] | undefined {
	const input = record(value);
	if (!input) return undefined;
	const counters = parseWorkCounters(input);
	if (!counters || !Array.isArray(input.items) || input.items.length > 128) return undefined;
	if (input.items.length + counters.itemsOmitted !== counters.total) return undefined;
	const items: GoalStatusWorkItem[] = [];
	for (const raw of input.items) {
		const item = parseWorkItem(raw);
		if (!item) return undefined;
		items.push(item);
	}
	return { ...counters, items };
}

function parseBudget(value: unknown): GoalStatusSnapshot["budget"] | undefined {
	const input = record(value);
	const limits = record(input?.limits);
	const usage = record(input?.usage);
	if (
		!limits ||
		!usage ||
		!safeInteger(limits.maxAutomaticTurns) ||
		limits.maxAutomaticTurns < 1 ||
		!optionalLimit(limits.maxTokens) ||
		!optionalLimit(limits.maxWallClockMs) ||
		!safeInteger(limits.maxNoProgressTurns) ||
		limits.maxNoProgressTurns < 1 ||
		!safeInteger(usage.automaticTurns) ||
		!safeInteger(usage.tokens) ||
		!safeInteger(usage.noProgressTurns)
	)
		return undefined;
	return {
		limits: {
			maxAutomaticTurns: limits.maxAutomaticTurns,
			maxTokens: limits.maxTokens,
			maxWallClockMs: limits.maxWallClockMs,
			maxNoProgressTurns: limits.maxNoProgressTurns,
		},
		usage: {
			automaticTurns: usage.automaticTurns,
			tokens: usage.tokens,
			noProgressTurns: usage.noProgressTurns,
		},
	};
}

type GoalHeader = Pick<
	GoalStatusSnapshot,
	"epoch" | "phase" | "live" | "objective" | "startedAt" | "updatedAt"
>;
type GoalReview = Pick<GoalStatusSnapshot, "continuation" | "review" | "reason">;

function parseGoalHeader(input: Record<string, unknown>): GoalHeader | undefined {
	if (!safeInteger(input.epoch) || input.epoch < 1) return undefined;
	if (typeof input.phase !== "string" || !PHASES.has(input.phase)) return undefined;
	if (typeof input.live !== "boolean") return undefined;
	if (!boundedText(input.objective, 10_000)) return undefined;
	if (!finiteTimestamp(input.startedAt) || !finiteTimestamp(input.updatedAt)) return undefined;
	if (input.updatedAt < input.startedAt) return undefined;
	return {
		epoch: input.epoch,
		phase: input.phase,
		live: input.live,
		objective: input.objective,
		startedAt: input.startedAt,
		updatedAt: input.updatedAt,
	};
}

function parseGoalReview(input: Record<string, unknown>): GoalReview | undefined {
	if (
		input.continuation !== undefined &&
		(typeof input.continuation !== "string" || !CONTINUATIONS.has(input.continuation))
	)
		return undefined;
	if (typeof input.review !== "string" || !REVIEWS.has(input.review)) return undefined;
	if (input.reason !== undefined && !boundedText(input.reason, 1_000, true)) return undefined;
	return {
		...(typeof input.continuation === "string"
			? { continuation: input.continuation as GoalStatusSnapshot["continuation"] }
			: {}),
		review: input.review as GoalStatusSnapshot["review"],
		...(typeof input.reason === "string" ? { reason: input.reason } : {}),
	};
}

function parseGoal(value: unknown): GoalStatusSnapshot | null | undefined {
	if (value === null) return null;
	const input = record(value);
	if (!input) return undefined;
	const header = parseGoalHeader(input);
	const review = parseGoalReview(input);
	const work = parseWork(input.work);
	const budget = parseBudget(input.budget);
	if (!header || !review || !work || !budget) return undefined;
	const expectedLive = header.phase !== "completed" && header.phase !== "cancelled";
	if (header.live !== expectedLive) return undefined;
	return { ...header, work, budget, ...review };
}

function parseGoalStatusEnvelopeUnsafe(value: unknown): GoalStatusEnvelope | undefined {
	const input = record(value);
	if (
		!input ||
		input.version !== GOAL_STATUS_PROTOCOL_VERSION ||
		!boundedText(input.providerId, 128) ||
		!safeInteger(input.sequence) ||
		!boundedText(input.sessionId, 1_024) ||
		(input.providerError !== undefined && !boundedText(input.providerError, 1_000, true))
	)
		return undefined;
	const goal = parseGoal(input.goal);
	if (goal === undefined) return undefined;
	return {
		version: 1,
		providerId: input.providerId,
		sequence: input.sequence,
		sessionId: input.sessionId,
		goal,
		...(typeof input.providerError === "string" ? { providerError: input.providerError } : {}),
	};
}

export function parseGoalStatusEnvelope(value: unknown): GoalStatusEnvelope | undefined {
	try {
		return parseGoalStatusEnvelopeUnsafe(value);
	} catch {
		return undefined;
	}
}

function statusLine(goal: GoalStatusSnapshot, theme: Theme): string {
	let color: "success" | "warning" | "error" = "error";
	if (goal.phase === "active") color = "success";
	else if (goal.phase === "paused") color = "warning";
	const marker = goal.phase === "active" ? "◆" : "◇";
	return `${theme.fg(color, marker)} ${goal.phase.replaceAll("_", " ")}`;
}

function renderGoal(goal: GoalStatusSnapshot, height: number, theme: Theme): string[] {
	if (!goal.live || height <= 0) return [];
	const lines = [
		statusLine(goal, theme),
		theme.fg("dim", goal.objective),
		`${goal.work.active} active · ${goal.work.unread} unread · ${goal.work.total} total`,
	];
	if (goal.review !== "none") lines.push(`Review · ${goal.review}`);
	for (const item of goal.work.items) {
		const color = item.state === "succeeded" ? "success" : "dim";
		lines.push(
			`${theme.fg(color, "•")} ${item.label} · ${item.state.replaceAll("_", " ")}`,
		);
	}
	if (goal.work.itemsOmitted > 0)
		lines.push(theme.fg("dim", `+${goal.work.itemsOmitted} earlier`));
	if (goal.reason) lines.push(theme.fg("warning", goal.reason));
	return lines.slice(0, Math.max(0, Math.floor(height)));
}

class GoalPanelState {
	private snapshot: GoalStatusEnvelope | undefined;
	private sessionId: string | undefined;
	private invalidate: () => void = () => undefined;
	private connected = false;
	private disposed = false;
	private connectionGeneration = 0;
	private readonly unsubscribe: () => void;

	constructor(private readonly pi: ExtensionAPI) {
		this.unsubscribe = pi.events.on(GOAL_STATUS_EVENT, (payload) => this.accept(payload));
		pi.on("session_shutdown", () => this.dispose());
	}

	connect(context: SidebarPanelConnection): () => void {
		if (this.disposed) return () => undefined;
		this.connected = true;
		this.connectionGeneration += 1;
		const generation = this.connectionGeneration;
		const nextSessionId = context.session.sessionManager.getSessionId();
		if (this.sessionId !== nextSessionId) this.snapshot = undefined;
		this.sessionId = nextSessionId;
		this.invalidate = context.invalidate;
		this.requestStatus();
		const disconnect = () => {
			if (generation !== this.connectionGeneration) return;
			this.connected = false;
		};
		context.signal.addEventListener("abort", disconnect, { once: true });
		if (this.snapshot) this.invalidate();
		return disconnect;
	}

	render(context: SidebarPanelRenderContext): string[] {
		const goal = this.snapshot?.goal;
		return goal ? renderGoal(goal, context.height, context.theme) : [];
	}

	private accept(payload: unknown): void {
		const parsed = parseGoalStatusEnvelope(payload);
		if (!parsed || parsed.sessionId !== this.sessionId) return;
		if (
			this.snapshot?.providerId === parsed.providerId &&
			parsed.sequence <= this.snapshot.sequence
		)
			return;
		this.snapshot = parsed;
		if (this.connected) this.invalidate();
	}

	private requestStatus(): void {
		try {
			this.pi.events.emit(GOAL_STATUS_REQUEST_EVENT, {
				version: GOAL_STATUS_PROTOCOL_VERSION,
				sessionId: this.sessionId,
			});
		} catch {
			// An optional provider cannot break sidebar connection.
		}
	}

	private dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.connected = false;
		this.connectionGeneration += 1;
		this.unsubscribe();
	}
}

export function createGoalPanel(pi: ExtensionAPI): SidebarPanel {
	const state = new GoalPanelState(pi);
	return {
		id: "neumie.goal",
		title: "Goal",
		order: 25,
		connect: (context) => state.connect(context),
		render: (context) => state.render(context),
	};
}
