import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	createBackgroundJobsPanel,
	parseBackgroundJobsPayload,
} from "../src/adapters/background-jobs.ts";
import {
	createSubagentsPanel,
	parseSubagentStatusText,
} from "../src/adapters/subagents.ts";

class EventBus {
	private listeners = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, listener: (payload: unknown) => void): () => void {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return () => listeners.delete(listener);
	}
	emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
	}
}

function fakePi() {
	const events = new EventBus();
	const handlers = new Map<string, Array<(event: unknown) => void>>();
	const pi = {
		events,
		on(event: string, handler: (event: unknown) => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	return { pi, events, emitLifecycle: (event: string, payload: unknown) => handlers.get(event)?.forEach((handler) => handler(payload)) };
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function connect(panel: ReturnType<typeof createSubagentsPanel> | ReturnType<typeof createBackgroundJobsPanel>, invalidate = () => undefined): () => void {
	const controller = new AbortController();
	const dispose = panel.connect?.({
		pi: {} as ExtensionAPI,
		session: {} as never,
		signal: controller.signal,
		invalidate,
	});
	assert.equal(typeof dispose, "function");
	return dispose as () => void;
}

describe("background jobs adapter", () => {
	it("accepts the documented bounded aggregate payload", () => {
		assert.deepEqual(parseBackgroundJobsPayload({
			runningCount: 2,
			terminalRecentCount: 3,
			oldestStart: 100,
			primary: { id: "01", label: "Typecheck", command: "npm run typecheck", startedAt: 200 },
		}), {
			runningCount: 2,
			terminalRecentCount: 3,
			oldestStart: 100,
			primary: { id: "01", label: "Typecheck", command: "npm run typecheck", startedAt: 200 },
		});
	});

	it("rejects malformed payloads without replacing state", () => {
		assert.equal(parseBackgroundJobsPayload({ runningCount: -1, terminalRecentCount: 0 }), undefined);
		assert.equal(parseBackgroundJobsPayload({ runningCount: 1, terminalRecentCount: 0, primary: { id: 1 } }), undefined);
	});

	it("replays an event received before the panel connects", () => {
		const { pi, events } = fakePi();
		const panel = createBackgroundJobsPanel(pi);
		events.emit("background-jobs:changed", {
			runningCount: 1,
			terminalRecentCount: 0,
			primary: { id: "01", label: "Typecheck", command: "npm test", startedAt: 0 },
		});
		let invalidations = 0;
		const dispose = connect(panel, () => { invalidations += 1; });
		assert.equal(invalidations, 1);
		assert.match(panel.render({ width: 30, height: 5, theme, now: 2_000 }).join("\n"), /Typecheck · 2s/);
		dispose();
	});
});

describe("subagent status adapter", () => {
	it("compacts the documented RPC status text", () => {
		const parsed = parseSubagentStatusText([
			"Spawn budget: unlimited",
			"Active async runs: 1",
			"",
			"- abc123 | running | parallel [fresh] | 2/2 running | /tmp/project",
			"  1. reviewer | running | tool read 2s",
		].join("\n"));
		assert.equal(parsed.active, true);
		assert.deepEqual(parsed.lines, [
			"1 async run",
			"● abc123 | running | parallel [fresh] | 2/2 running",
			"  1. reviewer | running | tool read 2s",
		]);
	});

	it("hides the panel when no async work is active", () => {
		assert.deepEqual(
			parseSubagentStatusText("Spawn budget: unlimited\nNo active async runs."),
			{ lines: [], active: false },
		);
	});

	it("negotiates RPC before status and clears stale activity on failure", async () => {
		const { pi, events } = fakePi();
		let statusCalls = 0;
		const methods: string[] = [];
		events.on("subagents:rpc:v1:request", (payload) => {
			const request = payload as { requestId: string; method: string };
			methods.push(request.method);
			queueMicrotask(() => {
				if (request.method === "ping") {
					events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
						version: 1, requestId: request.requestId, method: "ping", success: true,
						data: { version: 1, methods: ["ping", "status"] },
					});
					return;
				}
				statusCalls += 1;
				events.emit(`subagents:rpc:v1:reply:${request.requestId}`, statusCalls === 1
					? {
						version: 1, requestId: request.requestId, method: "status", success: true,
						data: { text: "Active async runs: 1\n\n- abc | running | single | /tmp/project" },
					}
					: {
						version: 1, requestId: request.requestId, method: "status", success: false,
						error: { code: "unavailable", message: "temporarily unavailable" },
					});
			});
		});
		const panel = createSubagentsPanel(pi);
		let invalidations = 0;
		const dispose = connect(panel, () => { invalidations += 1; });
		await tick();
		await tick();
		assert.deepEqual(methods.slice(0, 2), ["ping", "status"]);
		assert.match(panel.render({ width: 40, height: 10, theme, now: Date.now() }).join("\n"), /abc/);

		events.emit("subagent:async-started", {});
		await tick();
		await tick();
		assert.deepEqual(panel.render({ width: 40, height: 10, theme, now: Date.now() }), []);
		assert.ok(invalidations >= 2);
		dispose();
	});

	it("does not trust lifecycle events before a successful ping", async () => {
		const { pi, events } = fakePi();
		const methods: string[] = [];
		events.on("subagents:rpc:v1:request", (payload) => methods.push((payload as { method: string }).method));
		const panel = createSubagentsPanel(pi);
		const dispose = connect(panel);
		events.emit("subagent:async-started", {});
		await tick();
		assert.deepEqual([...new Set(methods)], ["ping"]);
		dispose();
		await tick();
	});
});
