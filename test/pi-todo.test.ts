import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	PI_TODO_READY_EVENT,
	PI_TODO_REQUEST_EVENT,
	PI_TODO_SNAPSHOT_EVENT,
	createPiTodoPanel,
	parsePiTodoReady,
	parsePiTodoSnapshot,
	renderPiTodo,
	type PiTodoSnapshotV1,
} from "../src/adapters/pi-todo.ts";

class EventBus {
	private listeners = new Map<string, Set<(payload: unknown) => void>>();
	readonly emitted: Array<{ event: string; payload: unknown }> = [];

	on(event: string, listener: (payload: unknown) => void): () => void {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return () => listeners.delete(listener);
	}

	emit(event: string, payload: unknown): void {
		this.emitted.push({ event, payload });
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
	}
}

function fakePi() {
	const events = new EventBus();
	const lifecycle = new Map<string, Array<() => void>>();
	const pi = {
		events,
		on(event: string, handler: () => void) {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		events,
		shutdown: () => lifecycle.get("session_shutdown")?.forEach((handler) => handler()),
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function snapshot(overrides: Partial<PiTodoSnapshotV1> = {}): PiTodoSnapshotV1 {
	return {
		version: 1,
		providerId: "provider-1",
		sequence: 1,
		sessionId: "todo-session",
		queued: 1,
		active: 1,
		total: 2,
		items: [
			{ status: "active", text: "active work" },
			{ status: "queued", text: "queued work" },
		],
		itemsOmitted: 0,
		...overrides,
	};
}

function connect(
	panel: ReturnType<typeof createPiTodoPanel>,
	sessionId = "todo-session",
	invalidate = () => undefined,
) {
	const controller = new AbortController();
	const dispose = panel.connect?.({
		pi: {} as ExtensionAPI,
		session: {
			sessionManager: { getSessionId: () => sessionId },
		} as unknown as ExtensionContext,
		signal: controller.signal,
		invalidate,
	});
	assert.equal(typeof dispose, "function");
	return { controller, dispose: dispose as () => void };
}

const renderContext = (width = 40, height = 5) => ({
	width,
	height,
	surface: "right" as const,
	theme,
	now: 0,
});

describe("pi-todo protocol parsing", () => {
	it("accepts the exact bounded display DTO", () => {
		assert.deepEqual(parsePiTodoReady({ version: 1, providerId: "provider-1", sessionId: "todo-session" }), {
			version: 1,
			providerId: "provider-1",
			sessionId: "todo-session",
		});
		assert.deepEqual(parsePiTodoSnapshot(snapshot()), snapshot());
	});

	it("rejects hostile, oversized, malformed, and inconsistent values", () => {
		const hostile = new Proxy({}, { get() { throw new Error("hostile"); } });
		assert.doesNotThrow(() => parsePiTodoSnapshot(hostile));
		assert.equal(parsePiTodoSnapshot(hostile), undefined);
		assert.equal(parsePiTodoReady({ version: 2, providerId: "provider", sessionId: "session" }), undefined);
		assert.equal(parsePiTodoSnapshot({ ...snapshot(), extra: true }), undefined);
		assert.equal(parsePiTodoSnapshot(snapshot({ version: 2 as 1 })), undefined);
		assert.equal(parsePiTodoSnapshot(snapshot({ items: [{ status: "active", text: "bad\x1b[2J" }, { status: "queued", text: "ok" }] })), undefined);
		assert.equal(parsePiTodoSnapshot(snapshot({ items: [{ status: "active", text: "x".repeat(513) }, { status: "queued", text: "ok" }] })), undefined);
		assert.equal(parsePiTodoSnapshot(snapshot({ queued: 2, total: 2 })), undefined);
		assert.equal(parsePiTodoSnapshot(snapshot({ itemsOmitted: 1 })), undefined);
		assert.equal(parsePiTodoSnapshot(snapshot({ active: 0 })), undefined);
		assert.equal(parsePiTodoSnapshot(snapshot({ items: [{ status: "queued", text: "queued" }, { status: "active", text: "active" }] })), undefined);
		assert.equal(parsePiTodoSnapshot(snapshot({ items: [{ status: "completed" as "active", text: "done" }, { status: "queued", text: "queued" }] })), undefined);
		assert.equal(parsePiTodoSnapshot({
			...snapshot({ active: 0, queued: 17, total: 17, itemsOmitted: 0 }),
			items: Array.from({ length: 17 }, (_, index) => ({ status: "queued", text: `item ${index}` })),
		}), undefined);
	});
});

describe("pi-todo panel lifecycle", () => {
	it("replays when the provider loaded before the sidebar", async () => {
		const { pi, events } = fakePi();
		const panel = createPiTodoPanel(pi);
		events.emit(PI_TODO_READY_EVENT, { version: 1, providerId: "provider-1", sessionId: "todo-session" });
		events.on(PI_TODO_REQUEST_EVENT, (request) => {
			if ((request as { sessionId?: string }).sessionId === "todo-session") {
				events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot());
			}
		});
		connect(panel);
		await tick();
		assert.match(panel.render(renderContext()).join("\n"), /active work.*queued work/s);
	});

	it("replays when the sidebar loaded before the provider", async () => {
		const { pi, events } = fakePi();
		const panel = createPiTodoPanel(pi);
		connect(panel);
		await tick();
		assert.deepEqual(panel.render(renderContext()), []);
		events.on(PI_TODO_REQUEST_EVENT, () => events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot()));
		events.emit(PI_TODO_READY_EVENT, { version: 1, providerId: "provider-1", sessionId: "todo-session" });
		assert.match(panel.render(renderContext()).join("\n"), /active work/);
	});

	it("rejects foreign/stale snapshots and pins replacement provider identity", () => {
		const { pi, events } = fakePi();
		const panel = createPiTodoPanel(pi);
		let invalidations = 0;
		connect(panel, "todo-session", () => { invalidations += 1; });
		events.emit(PI_TODO_READY_EVENT, { version: 1, providerId: "provider-1", sessionId: "todo-session" });
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ sequence: 2 }));
		assert.match(panel.render(renderContext()).join("\n"), /active work/);
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ sequence: 1, items: [{ status: "active", text: "stale" }, { status: "queued", text: "stale" }] }));
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ sequence: 99, sessionId: "foreign" }));
		assert.doesNotMatch(panel.render(renderContext()).join("\n"), /stale/);

		events.emit(PI_TODO_READY_EVENT, { version: 1, providerId: "provider-2", sessionId: "todo-session" });
		assert.deepEqual(panel.render(renderContext()), []);
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ providerId: "provider-1", sequence: 100 }));
		assert.deepEqual(panel.render(renderContext()), []);
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ providerId: "provider-2", sequence: 1, items: [{ status: "active", text: "replacement" }, { status: "queued", text: "later" }] }));
		assert.match(panel.render(renderContext()).join("\n"), /replacement/);
		events.emit(PI_TODO_READY_EVENT, { version: 1, providerId: "provider-1", sessionId: "todo-session" });
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ providerId: "provider-1", sequence: 101 }));
		assert.match(panel.render(renderContext()).join("\n"), /replacement/);
		assert.ok(invalidations >= 3);
	});

	it("hides on version mismatch, abort, reconnect, and disposal", () => {
		const { pi, events, shutdown } = fakePi();
		const panel = createPiTodoPanel(pi);
		const first = connect(panel);
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot());
		assert.match(panel.render(renderContext()).join("\n"), /active work/);
		events.emit(PI_TODO_READY_EVENT, { version: 2, providerId: "provider-2", sessionId: "todo-session" });
		assert.deepEqual(panel.render(renderContext()), []);
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot());
		assert.deepEqual(panel.render(renderContext()), []);
		events.emit(PI_TODO_READY_EVENT, { version: 1, providerId: "provider-2", sessionId: "todo-session" });
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ providerId: "provider-2", sequence: 1 }));
		assert.match(panel.render(renderContext()).join("\n"), /active work/);
		first.controller.abort();
		assert.deepEqual(panel.render(renderContext()), []);

		const second = connect(panel, "replacement-session");
		assert.deepEqual(panel.render(renderContext()), []);
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ sessionId: "todo-session" }));
		assert.deepEqual(panel.render(renderContext()), []);
		second.dispose();
		shutdown();
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ sessionId: "replacement-session" }));
		assert.deepEqual(panel.render(renderContext()), []);
	});

	it("ignores hostile ready payloads at the event-listener boundary", () => {
		const { pi, events } = fakePi();
		const panel = createPiTodoPanel(pi);
		connect(panel);
		const hostile = new Proxy({}, { get() { throw new Error("hostile getter"); } });
		assert.doesNotThrow(() => events.emit(PI_TODO_READY_EVENT, hostile));
		assert.deepEqual(panel.render(renderContext()), []);
	});

	it("fails closed when bounded provider-retirement memory is exhausted", () => {
		const { pi, events } = fakePi();
		const panel = createPiTodoPanel(pi);
		connect(panel);
		for (let index = 0; index <= 64; index += 1) {
			events.emit(PI_TODO_READY_EVENT, {
				version: 1,
				providerId: `provider-${index}`,
				sessionId: "todo-session",
			});
		}
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ providerId: "provider-64" }));
		assert.match(panel.render(renderContext()).join("\n"), /active work/);

		events.emit(PI_TODO_READY_EVENT, {
			version: 1,
			providerId: "provider-65",
			sessionId: "todo-session",
		});
		assert.deepEqual(panel.render(renderContext()), []);
		events.emit(PI_TODO_READY_EVENT, {
			version: 1,
			providerId: "provider-64",
			sessionId: "todo-session",
		});
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ providerId: "provider-64", sequence: 2 }));
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ providerId: "provider-65", sequence: 1 }));
		assert.deepEqual(panel.render(renderContext()), []);
	});
});

describe("pi-todo rendering", () => {
	it("renders concise markers, reserves overflow, and bounds every row", () => {
		assert.deepEqual(renderPiTodo(undefined, renderContext()), []);
		assert.deepEqual(renderPiTodo(snapshot(), renderContext(0, 5)), []);
		assert.deepEqual(renderPiTodo(snapshot(), renderContext(20, 0)), []);
		assert.deepEqual(renderPiTodo(snapshot(), renderContext(20, 1)), ["+2 more       /todos"]);
		assert.deepEqual(renderPiTodo(snapshot(), renderContext(8, 1)), ["+2 more"]);
		const lines = renderPiTodo(snapshot({
			queued: 3,
			active: 1,
			total: 4,
			items: [
				{ status: "active", text: "active work" },
				{ status: "queued", text: "queued one" },
				{ status: "queued", text: "queued two" },
				{ status: "queued", text: "queued three" },
			],
		}), renderContext(18, 3));
		assert.equal(lines.length, 3);
		assert.match(lines[0] ?? "", /^◆ active work/);
		assert.match(lines[1] ?? "", /^○ queued one/);
		assert.match(lines[2] ?? "", /\+2 more.*\/todos/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 18));
	});

	it("exposes only aggregate hidden status", () => {
		const { pi, events } = fakePi();
		const panel = createPiTodoPanel(pi);
		connect(panel);
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot());
		assert.equal(panel.hiddenStatus?.(), "◆ 1 active · ○ 1 queued");
		assert.doesNotMatch(panel.hiddenStatus?.() ?? "", /#|active work|queued work/);
		events.emit(PI_TODO_SNAPSHOT_EVENT, snapshot({ sequence: 2, active: 0, queued: 0, total: 0, items: [] }));
		assert.equal(panel.hiddenStatus?.(), undefined);
	});
});
