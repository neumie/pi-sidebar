import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
	SidebarPanel,
	SidebarPanelConnection,
	SidebarPanelRenderContext,
} from "../api.ts";
import { withRightHint } from "../render.ts";

export const PI_TODO_PROTOCOL_VERSION = 1 as const;
export const PI_TODO_READY_EVENT = "@neumie/pi-todo:v1:ready";
export const PI_TODO_REQUEST_EVENT = "@neumie/pi-todo:v1:request";
export const PI_TODO_SNAPSHOT_EVENT = "@neumie/pi-todo:v1:snapshot";

const MAX_ITEMS = 16;
const MAX_TOTAL = 64;
const MAX_PROVIDER_ID_CHARS = 128;
const MAX_SESSION_ID_CHARS = 1_024;
const MAX_TEXT_CODE_POINTS = 256;
const MAX_TEXT_UNITS = 512;
const MAX_RETIRED_PROVIDERS = 64;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface PiTodoReadyV1 {
	version: 1;
	providerId: string;
	sessionId: string;
}

export interface PiTodoDisplayItemV1 {
	status: "queued" | "active";
	text: string;
}

export interface PiTodoSnapshotV1 {
	version: 1;
	providerId: string;
	sequence: number;
	sessionId: string;
	queued: number;
	active: number;
	total: number;
	items: PiTodoDisplayItemV1[];
	itemsOmitted: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function exactKeys(input: Record<string, unknown>, expected: readonly string[]): boolean {
	const compare = (left: string, right: string) => left.localeCompare(right);
	const expectedKeys = [...expected].sort(compare);
	const keys = Object.keys(input).sort(compare);
	return keys.length === expectedKeys.length
		&& keys.every((key, index) => key === expectedKeys[index]);
}

function safeIdentifier(value: unknown, maximum: number): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= maximum
		&& !CONTROL_PATTERN.test(value);
}

function safeCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TOTAL;
}

function safeSequence(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}

function safeText(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_TEXT_UNITS
		&& value.trim() === value
		&& Array.from(value).length <= MAX_TEXT_CODE_POINTS
		&& !CONTROL_PATTERN.test(value);
}

function isMatchingIncompatibleReady(value: unknown, sessionId: string | undefined): boolean {
	try {
		const input = record(value);
		return Boolean(
			input
			&& input.sessionId === sessionId
			&& input.version !== PI_TODO_PROTOCOL_VERSION,
		);
	} catch {
		return false;
	}
}

export function parsePiTodoReady(value: unknown): PiTodoReadyV1 | undefined {
	try {
		const input = record(value);
		if (!input || !exactKeys(input, ["providerId", "sessionId", "version"])) return undefined;
		if (input.version !== PI_TODO_PROTOCOL_VERSION) return undefined;
		if (!safeIdentifier(input.providerId, MAX_PROVIDER_ID_CHARS)) return undefined;
		if (!safeIdentifier(input.sessionId, MAX_SESSION_ID_CHARS)) return undefined;
		return {
			version: PI_TODO_PROTOCOL_VERSION,
			providerId: input.providerId,
			sessionId: input.sessionId,
		};
	} catch {
		return undefined;
	}
}

function parseItem(value: unknown): PiTodoDisplayItemV1 | undefined {
	const input = record(value);
	if (!input || !exactKeys(input, ["status", "text"])) return undefined;
	if (input.status !== "queued" && input.status !== "active") return undefined;
	if (!safeText(input.text)) return undefined;
	return { status: input.status, text: input.text };
}

export function parsePiTodoSnapshot(value: unknown): PiTodoSnapshotV1 | undefined {
	try {
		const input = record(value);
		if (!input || !exactKeys(input, [
			"active",
			"items",
			"itemsOmitted",
			"providerId",
			"queued",
			"sequence",
			"sessionId",
			"total",
			"version",
		])) return undefined;
		if (input.version !== PI_TODO_PROTOCOL_VERSION) return undefined;
		if (!safeIdentifier(input.providerId, MAX_PROVIDER_ID_CHARS)) return undefined;
		if (!safeIdentifier(input.sessionId, MAX_SESSION_ID_CHARS)) return undefined;
		if (!safeSequence(input.sequence)) return undefined;
		if (!safeCount(input.queued) || !safeCount(input.active) || !safeCount(input.total)) return undefined;
		if (input.active > 1 || input.queued + input.active !== input.total) return undefined;
		if (!Array.isArray(input.items) || input.items.length > MAX_ITEMS) return undefined;
		if (!safeCount(input.itemsOmitted) || input.items.length + input.itemsOmitted !== input.total) return undefined;
		const items: PiTodoDisplayItemV1[] = [];
		for (const candidate of input.items) {
			const item = parseItem(candidate);
			if (!item) return undefined;
			items.push(item);
		}
		const displayedActive = items.filter((item) => item.status === "active").length;
		const displayedQueued = items.length - displayedActive;
		if (displayedActive !== input.active) return undefined;
		if (input.active === 1 && items[0]?.status !== "active") return undefined;
		if (displayedQueued + input.itemsOmitted !== input.queued) return undefined;
		return {
			version: PI_TODO_PROTOCOL_VERSION,
			providerId: input.providerId,
			sequence: input.sequence,
			sessionId: input.sessionId,
			queued: input.queued,
			active: input.active,
			total: input.total,
			items,
			itemsOmitted: input.itemsOmitted,
		};
	} catch {
		return undefined;
	}
}

function normalizedSize(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function renderPiTodo(
	snapshot: PiTodoSnapshotV1 | undefined,
	context: SidebarPanelRenderContext,
): string[] {
	const width = normalizedSize(context.width);
	const height = normalizedSize(context.height);
	if (!snapshot || snapshot.total === 0 || width === 0 || height === 0) return [];
	const needsOverflow = snapshot.total > Math.min(snapshot.items.length, height);
	const itemCapacity = needsOverflow ? Math.max(0, height - 1) : height;
	const lines = snapshot.items.slice(0, itemCapacity).map((item) => {
		const marker = item.status === "active"
			? context.theme.fg("accent", "◆")
			: context.theme.fg("dim", "○");
		return truncateToWidth(`${marker} ${item.text}`, width, "…");
	});
	const hidden = Math.max(0, snapshot.total - lines.length);
	if (hidden > 0 && lines.length < height) {
		const summary = context.theme.fg("dim", `+${hidden} more`);
		const hint = context.theme.fg("dim", "/todos");
		lines.push(truncateToWidth(withRightHint(summary, hint, width), width, "…"));
	}
	return lines.slice(0, height);
}

class PiTodoPanelState {
	private snapshot: PiTodoSnapshotV1 | undefined;
	private sessionId: string | undefined;
	private providerId: string | undefined;
	private sequence = 0;
	private invalidate: () => void = () => undefined;
	private connected = false;
	private disposed = false;
	private requiresReady = false;
	private replacementLocked = false;
	private generation = 0;
	private readonly retiredProviders = new Set<string>();
	private readonly unsubscribes: Array<() => void>;

	constructor(private readonly pi: ExtensionAPI) {
		this.unsubscribes = [
			pi.events.on(PI_TODO_READY_EVENT, (payload) => this.acceptReady(payload)),
			pi.events.on(PI_TODO_SNAPSHOT_EVENT, (payload) => this.acceptSnapshot(payload)),
		];
		pi.on("session_shutdown", () => this.dispose());
	}

	connect(context: SidebarPanelConnection): () => void {
		if (this.disposed) return () => undefined;
		const generation = ++this.generation;
		this.connected = true;
		this.sessionId = context.session.sessionManager.getSessionId();
		this.snapshot = undefined;
		this.providerId = undefined;
		this.sequence = 0;
		this.requiresReady = false;
		this.replacementLocked = false;
		this.retiredProviders.clear();
		this.invalidate = context.invalidate;
		queueMicrotask(() => this.request(generation));
		const disconnect = () => {
			if (generation !== this.generation) return;
			this.connected = false;
			this.snapshot = undefined;
			this.providerId = undefined;
			this.sequence = 0;
			this.requiresReady = false;
			this.replacementLocked = false;
		};
		context.signal.addEventListener("abort", disconnect, { once: true });
		return disconnect;
	}

	render(context: SidebarPanelRenderContext): string[] {
		return renderPiTodo(this.snapshot, context);
	}

	hiddenStatus(): string | undefined {
		if (!this.snapshot || this.snapshot.total === 0) return undefined;
		if (this.snapshot.active > 0 && this.snapshot.queued > 0) {
			return `◆ 1 active · ○ ${this.snapshot.queued} queued`;
		}
		if (this.snapshot.active > 0) return "◆ 1 active";
		return `○ ${this.snapshot.queued} queued`;
	}

	private acceptReady(value: unknown): void {
		const ready = parsePiTodoReady(value);
		if (!ready) {
			if (this.connected && isMatchingIncompatibleReady(value, this.sessionId)) {
				this.clearVisibleState(true);
			}
			return;
		}
		if (!this.connected || ready.sessionId !== this.sessionId) return;
		if (this.replacementLocked || this.retiredProviders.has(ready.providerId)) return;
		if (this.providerId !== ready.providerId) {
			if (this.providerId) {
				if (this.retiredProviders.size >= MAX_RETIRED_PROVIDERS) {
					this.replacementLocked = true;
					this.clearVisibleState(true);
					return;
				}
				this.retiredProviders.add(this.providerId);
			}
			this.providerId = ready.providerId;
			this.sequence = 0;
			this.snapshot = undefined;
			this.invalidate();
		}
		this.requiresReady = false;
		this.request(this.generation);
	}

	private acceptSnapshot(value: unknown): void {
		const snapshot = parsePiTodoSnapshot(value);
		if (
			!snapshot
			|| !this.connected
			|| this.requiresReady
			|| this.replacementLocked
			|| snapshot.sessionId !== this.sessionId
		) return;
		if (this.providerId === undefined) this.providerId = snapshot.providerId;
		if (snapshot.providerId !== this.providerId || snapshot.sequence <= this.sequence) return;
		this.sequence = snapshot.sequence;
		this.snapshot = snapshot;
		this.invalidate();
	}

	private request(generation: number): void {
		if (!this.connected || this.disposed || generation !== this.generation || !this.sessionId) return;
		try {
			this.pi.events.emit(PI_TODO_REQUEST_EVENT, {
				version: PI_TODO_PROTOCOL_VERSION,
				sessionId: this.sessionId,
			});
		} catch {
			// An optional provider cannot break sidebar rendering.
		}
	}

	private clearVisibleState(requireReady = false): void {
		this.snapshot = undefined;
		this.providerId = undefined;
		this.sequence = 0;
		this.requiresReady = requireReady;
		this.invalidate();
	}

	private dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.connected = false;
		this.generation += 1;
		this.snapshot = undefined;
		this.providerId = undefined;
		this.requiresReady = true;
		this.replacementLocked = true;
		for (const unsubscribe of this.unsubscribes) unsubscribe();
	}
}

export function createPiTodoPanel(pi: ExtensionAPI): SidebarPanel {
	const state = new PiTodoPanelState(pi);
	return {
		id: "neumie.pi-todo",
		title: "Todos",
		order: 175,
		connect: (context) => state.connect(context),
		hiddenStatus: () => state.hiddenStatus(),
		render: (context) => state.render(context),
	};
}
