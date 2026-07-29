import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	createBackgroundJobsPanel,
	parseBackgroundJobsPayload,
} from "../src/adapters/background-jobs.ts";
import {
	FOOTER_STATUS_SOURCE_READY_EVENT,
	FOOTER_STATUS_SOURCE_REQUEST_EVENT,
	createIntegrationsPanel,
	parseFooterStatusSource,
	parseMcpHealthUpdate,
	readLspFailure,
} from "../src/adapters/integrations.ts";
import {
	createSubagentsPanel,
	parseSubagentFleet,
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
	const handlers = new Map<
		string,
		Array<(event: unknown, context?: unknown) => void>
	>();
	const pi = {
		events,
		on(event: string, handler: (event: unknown, context?: unknown) => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		events,
		emitLifecycle: (event: string, payload: unknown, context?: unknown) =>
			handlers.get(event)?.forEach((handler) => handler(payload, context)),
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function connect(
	panel:
		| ReturnType<typeof createSubagentsPanel>
		| ReturnType<typeof createBackgroundJobsPanel>
		| ReturnType<typeof createIntegrationsPanel>,
	invalidate = () => undefined,
	session = "adapter-test-session",
): () => void {
	const controller = new AbortController();
	const dispose = panel.connect?.({
		pi: {} as ExtensionAPI,
		session: { sessionManager: { getSessionId: () => session } } as never,
		signal: controller.signal,
		invalidate,
	});
	assert.equal(typeof dispose, "function");
	return dispose as () => void;
}

describe("background jobs adapter", () => {
	it("accepts the documented bounded aggregate payload", () => {
		assert.deepEqual(
			parseBackgroundJobsPayload({
				runningCount: 2,
				terminalRecentCount: 3,
				oldestStart: 100,
				primary: {
					id: "01",
					label: "Typecheck",
					command: "npm run typecheck",
					startedAt: 200,
				},
			}),
			{
				runningCount: 2,
				terminalRecentCount: 3,
				oldestStart: 100,
				primary: {
					id: "01",
					label: "Typecheck",
					command: "npm run typecheck",
					startedAt: 200,
				},
			},
		);
	});

	it("rejects malformed payloads without replacing state", () => {
		assert.equal(
			parseBackgroundJobsPayload({ runningCount: -1, terminalRecentCount: 0 }),
			undefined,
		);
		assert.equal(
			parseBackgroundJobsPayload({
				runningCount: 1,
				terminalRecentCount: 0,
				primary: { id: 1 },
			}),
			undefined,
		);
	});

	it("replays an event received before the panel connects", () => {
		const { pi, events } = fakePi();
		const panel = createBackgroundJobsPanel(pi);
		events.emit("background-jobs:changed", {
			runningCount: 1,
			terminalRecentCount: 0,
			primary: {
				id: "01",
				label: "Typecheck",
				command: "npm test",
				startedAt: 0,
			},
		});
		let invalidations = 0;
		const dispose = connect(panel, () => {
			invalidations += 1;
		});
		assert.equal(invalidations, 1);
		assert.match(
			panel.render({ width: 30, height: 5, theme, now: 2_000 }).join("\n"),
			/Typecheck · 2s/,
		);
		dispose();
	});
});

describe("degraded integrations adapter", () => {
	const renderContext = { width: 40, height: 5, theme, now: 0 };
	const runtimeContext = (id: string) => ({
		sessionManager: { getSessionId: () => id },
	});

	it("accepts only a valid footer source and sanitizes actionable LSP failures", () => {
		const active = parseFooterStatusSource({
			version: 1,
			sessionId: "session",
			token: "token",
			readStatuses: () => [
				{ key: "pi-lens-lsp", text: "LSP Active: typescript" },
			],
		});
		assert.ok(active);
		assert.equal(readLspFailure(active), undefined);
		const failed = parseFooterStatusSource({
			version: 1,
			sessionId: "session",
			token: "token",
			readStatuses: () => [
				{
					key: "pi-lens-lsp",
					text: "\x1b[32mLSP Active: typescript\x1b[0m · \x1b[31mLSP Failed: ruby-lsp\x1b[0m\x1b[2J\nINJECTED",
				},
			],
		});
		assert.ok(failed);
		assert.equal(readLspFailure(failed), "ruby-lsp failed");
		assert.equal(
			parseFooterStatusSource({ version: 2, readStatuses() {} }),
			undefined,
		);
		assert.equal(
			readLspFailure({
				...failed,
				readStatuses: () => {
					throw new Error("hostile");
				},
			}),
			undefined,
		);
	});

	it("classifies only actionable MCP connectivity and authentication states", () => {
		assert.deepEqual(
			parseMcpHealthUpdate({
				toolName: "mcp",
				details: {
					mode: "status",
					servers: [
						{ name: "healthy", status: "connected", failedAgo: null },
						{ name: "lazy", status: "cached", failedAgo: null },
						{ name: "mail", status: "needs-auth", failedAgo: null },
						{ name: "calendar", status: "failed", failedAgo: 7.8 },
					],
				},
			}),
			{
				kind: "replace",
				issues: [
					{ server: "mail", detail: "authentication required" },
					{ server: "calendar", detail: "failed 7s ago" },
				],
			},
		);
		assert.deepEqual(
			parseMcpHealthUpdate({
				toolName: "mcp",
				details: {
					mode: "status",
					servers: [{ name: "lazy", status: "not connected" }],
				},
			}),
			{ kind: "replace", issues: [] },
		);
		assert.deepEqual(
			parseMcpHealthUpdate({
				toolName: "mcp",
				details: { error: "auth_required", server: "mail" },
			}),
			{
				kind: "set",
				issue: { server: "mail", detail: "authentication required" },
			},
		);
		assert.deepEqual(
			parseMcpHealthUpdate({
				toolName: "mcp",
				details: { error: "connect_failed", server: "mail", message: "secret" },
			}),
			{ kind: "set", issue: { server: "mail", detail: "connection failed" } },
		);
		assert.deepEqual(
			parseMcpHealthUpdate({
				toolName: "mcp",
				details: { error: "connect_failed", message: "secret" },
			}),
			{ kind: "set", issue: { server: "MCP", detail: "connection failed" } },
		);
		for (const error of [
			"not_connected",
			"tool_error",
			"call_failed",
			"aborted",
			"bad_input",
		]) {
			assert.equal(
				parseMcpHealthUpdate({
					toolName: "mcp",
					details: { error, server: "mail" },
				}),
				undefined,
			);
		}
		assert.deepEqual(
			parseMcpHealthUpdate({
				toolName: "mcp",
				input: { connect: "mail" },
				isError: false,
				details: { mode: "list", server: "mail" },
			}),
			{ kind: "clear", server: "mail" },
		);
		assert.equal(
			parseMcpHealthUpdate({
				toolName: "mcp",
				input: { connect: "mail" },
				isError: true,
				details: { mode: "list", server: "mail" },
			}),
			undefined,
		);
		assert.equal(
			parseMcpHealthUpdate({
				toolName: "database",
				details: { error: "connect_failed", server: "production" },
			}),
			undefined,
		);
		assert.equal(
			parseMcpHealthUpdate({
				toolName: "apple_mail",
				input: {},
				isError: false,
				details: { server: "mail" },
			}),
			undefined,
		);
	});

	it("stays hidden while healthy and reacts to degraded then recovered integrations", () => {
		const { pi, events, emitLifecycle } = fakePi();
		let lspStatus = "LSP Active: typescript";
		events.on(FOOTER_STATUS_SOURCE_REQUEST_EVENT, (payload) => {
			const request = payload as { sessionId?: string };
			events.emit(FOOTER_STATUS_SOURCE_READY_EVENT, {
				version: 1,
				sessionId: request.sessionId,
				token: "source",
				readStatuses: () => [{ key: "pi-lens-lsp", text: lspStatus }],
			});
		});
		const panel = createIntegrationsPanel(pi);
		let invalidations = 0;
		const dispose = connect(panel, () => {
			invalidations += 1;
		});
		assert.deepEqual(panel.render(renderContext), []);

		lspStatus = "LSP Failed: typescript";
		assert.match(
			panel.render(renderContext).join("\n"),
			/LSP · typescript failed/,
		);
		emitLifecycle(
			"tool_result",
			{
				toolName: "mcp",
				input: {},
				isError: false,
				details: { error: "auth_required", server: "calendar" },
			},
			runtimeContext("adapter-test-session"),
		);
		assert.match(
			panel.render(renderContext).join("\n"),
			/MCP · calendar authentication required/,
		);
		assert.match(
			panel.render({ ...renderContext, height: 1 }).join("\n"),
			/LSP \+ MCP · degraded/,
		);

		lspStatus = "LSP Active: typescript";
		emitLifecycle(
			"tool_result",
			{
				toolName: "mcp",
				input: {},
				isError: false,
				details: {
					mode: "status",
					servers: [{ name: "calendar", status: "connected" }],
				},
			},
			runtimeContext("adapter-test-session"),
		);
		assert.deepEqual(panel.render(renderContext), []);

		emitLifecycle(
			"tool_result",
			{
				toolName: "mcp",
				input: {},
				isError: false,
				details: { error: "init_failed" },
			},
			runtimeContext("adapter-test-session"),
		);
		assert.match(
			panel.render(renderContext).join("\n"),
			/MCP · initialization failed/,
		);
		emitLifecycle(
			"tool_result",
			{
				toolName: "mcp",
				input: { tool: "clientcare_list", server: "clientcare" },
				isError: false,
				details: { mode: "call", server: "clientcare" },
			},
			runtimeContext("adapter-test-session"),
		);
		assert.deepEqual(panel.render(renderContext), []);
		assert.ok(invalidations >= 4);
		dispose();
	});

	it("ignores an old connection abort after a replacement connects", () => {
		const { pi, emitLifecycle } = fakePi();
		const panel = createIntegrationsPanel(pi);
		const first = new AbortController();
		const second = new AbortController();
		const connection = (signal: AbortSignal) =>
			panel.connect?.({
				pi,
				session: runtimeContext("same-session") as never,
				signal,
				invalidate() {},
			});
		connection(first.signal);
		connection(second.signal);
		first.abort();
		emitLifecycle(
			"tool_result",
			{
				toolName: "mcp",
				input: {},
				isError: false,
				details: { error: "server_unavailable", server: "mail" },
			},
			runtimeContext("same-session"),
		);
		assert.match(
			panel.render(renderContext).join("\n"),
			/mail server unavailable/,
		);
		second.abort();
	});
});

describe("subagent status adapter", () => {
	function serveFleet(
		events: EventBus,
		fleet: () => unknown,
		shouldReply: () => boolean = () => true,
	): void {
		events.on("subagents:rpc:v1:request", (payload) => {
			if (!shouldReply()) return;
			const request = payload as { requestId: string; method: string };
			queueMicrotask(() => events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				method: request.method,
				success: true,
				data: request.method === "ping"
					? { version: 1, methods: ["ping", "status"], capabilities: { fleetStatus: { version: 1 } } }
					: { text: "Active async runs", fleet: fleet() },
			}));
		});
	}

	it("compacts the documented RPC status text", () => {
		const parsed = parseSubagentStatusText(
			[
				"Spawn budget: unlimited",
				"Active async runs: 1",
				"",
				"- abc123 | running | parallel [fresh] | 2/2 running | /tmp/project",
				"  1. reviewer | running | tool read 2s",
			].join("\n"),
		);
		assert.equal(parsed.active, true);
		assert.deepEqual(parsed.lines, ["1 async run"]);
	});

	it("accepts bounded structured fleet entries and drops malformed data", () => {
		const entries = parseSubagentFleet({
			version: 1,
			entries: [
				{
					key: "fleet-1",
					agent: "\u001b[31mreviewer\u001b[0m",
					model: "anthropic/claude-opus-4-8:high",
					effort: "high",
					startedAt: 100,
					tokens: { input: 1234, output: 56, total: 1290 },
					goal: "Review\n\u001b]8;;https://hostile\u0007this diff",
				},
				{ key: "bad", agent: "worker", startedAt: "now", tokens: {} },
			],
		});
		assert.deepEqual(entries, {
			entries: [
				{
					key: "fleet-1",
					agent: "reviewer",
					model: "anthropic/claude-opus-4-8:high",
					effort: "high",
					startedAt: 100,
					tokens: { input: 1234, output: 56, total: 1290 },
					goal: "Review this diff",
				},
			],
			totalActive: 1,
		});
		assert.equal(parseSubagentFleet({ version: 2, entries: [] }), undefined);
		assert.equal(parseSubagentFleet(new Proxy({}, { get() { throw new Error("hostile"); } })), undefined);
		assert.deepEqual(parseSubagentFleet({
			version: 1,
			totalActive: 4,
			entries: [{ key: "bad-time", agent: "worker", startedAt: Number.MAX_SAFE_INTEGER + 1, tokens: {} }],
		}), { entries: [], totalActive: 4 });
	});

	it("replaces a foreground placeholder with its structured fleet record", async () => {
		const { pi, events, emitLifecycle } = fakePi();
		events.on("subagents:rpc:v1:request", (payload) => {
			const request = payload as { requestId: string; method: string };
			queueMicrotask(() =>
				events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
					version: 1,
					requestId: request.requestId,
					method: request.method,
					success: true,
					data:
						request.method === "ping"
							? {
									version: 1,
									methods: ["ping", "status"],
									capabilities: { fleetStatus: { version: 1 } },
								}
							: {
									text: "Active async runs: 1",
									fleet: {
										version: 1,
										entries: [
											{
												key: "fleet-1",
												agent: "reviewer",
												role: "review",
												model: "anthropic/claude-opus-4-8:high",
												effort: "high",
												startedAt: 100,
												tokens: { input: 12, output: 34, total: 46 },
												goal: "Review the diff",
											},
										],
									},
								},
				}),
			);
		});
		const panel = createSubagentsPanel(pi);
		emitLifecycle("tool_execution_start", {
			toolName: "subagent",
			toolCallId: "local-placeholder",
			args: { agent: "reviewer", task: "Review the diff" },
		});
		const dispose = connect(panel);
		await tick();
		await tick();
		const lines = panel.render({ width: 80, height: 5, surface: "narrow", theme, now: 1_000 });
		assert.equal(lines.length, 2);
		assert.equal(lines.filter((line) => line.includes("reviewer")).length, 1);
		assert.equal(
			lines.some((line) => line.includes("+1 more")),
			false,
		);
		assert.match(lines.join("\n"), /review · reviewer.*opus-4-8.*high/);
		assert.match(lines.join("\n"), /↑12 ↓34.*Review the diff/);
		dispose();
	});

	it("shows two narrow children, dedicated rail goals, and bounded overflow", async () => {
		const { pi, events } = fakePi();
		serveFleet(events, () => ({
			version: 1,
			totalActive: 3,
			omitted: 1,
			entries: [
				{
					key: "fleet-1", agent: "worker", model: "openai/gpt-5.6-terra:high", effort: "high",
					startedAt: 0, tokens: { input: 12_340, output: 567, total: 12_907 }, goal: "Fix slash completion",
				},
				{
					key: "fleet-2", agent: "reviewer", model: "anthropic/claude-opus-4-8:medium", effort: "medium",
					startedAt: 30_000, tokens: { input: 4_200, output: 890, total: 5_090 }, goal: "Review protocol safety",
				},
			],
		}));
		const panel = createSubagentsPanel(pi);
		const dispose = connect(panel);
		await tick();
		await tick();

		const narrow = panel.render({ width: 75, height: 5, surface: "narrow", theme, now: 120_000 });
		assert.equal(narrow.length, 5);
		assert.match(narrow.join("\n"), /worker.*2m 0s.*GPT-5\.6 Terra.*high/);
		assert.match(narrow.join("\n"), /↑12k ↓567.*Fix slash completion/);
		assert.match(narrow.join("\n"), /reviewer.*1m 30s.*opus-4-8.*medium/);
		assert.match(narrow.join("\n"), /↑4\.2k ↓890.*Review protocol safety/);
		assert.equal(narrow.at(-1), "+1 more");

		const rail = panel.render({ width: 36, height: 7, surface: "right", theme, now: 120_000 });
		assert.equal(rail.length, 7);
		assert.equal(rail.some((line) => line === "↳ Fix slash completion"), true);
		assert.equal(rail.some((line) => line === "↳ Review protocol safety"), true);
		assert.equal(rail.at(-1), "+1 more");
		dispose();
	});

	it("reconciles duplicate placeholders one-to-one and clears remote state on reconnect", async () => {
		const { pi, events, emitLifecycle } = fakePi();
		let reply = true;
		let remoteEntries: Array<Record<string, unknown>> = [];
		serveFleet(events, () => ({
			version: 1,
			totalActive: remoteEntries.length,
			omitted: 0,
			entries: remoteEntries,
		}), () => reply);
		const panel = createSubagentsPanel(pi);
		const firstDisconnect = connect(panel);
		await tick();
		await tick();

		for (const toolCallId of ["local-1", "local-2"]) {
			emitLifecycle("tool_execution_start", {
				toolName: "subagent",
				toolCallId,
				args: { agent: "reviewer", task: "Review the diff", model: "anthropic/claude-opus-4-8", thinking: "high" },
			});
		}
		const immediate = panel.render({ width: 75, height: 5, surface: "narrow", theme, now: Date.now() });
		assert.equal(immediate.filter((line) => /reviewer/.test(line)).length, 2);

		remoteEntries = [{
			key: "fleet-1", agent: "reviewer", model: "anthropic/claude-opus-4-8", effort: "high",
			startedAt: Date.now(), tokens: { input: 1, output: 2, total: 3 }, goal: "Review the diff",
		}];
		events.emit("subagent:async-started", {});
		await tick();
		await tick();
		const reconciled = panel.render({ width: 75, height: 5, surface: "narrow", theme, now: Date.now() });
		assert.equal(reconciled.filter((line) => /reviewer/.test(line)).length, 2);
		assert.equal(reconciled.some((line) => /more/.test(line)), false);

		firstDisconnect();
		reply = false;
		const secondDisconnect = connect(panel);
		assert.deepEqual(panel.render({ width: 75, height: 5, surface: "narrow", theme, now: Date.now() }), []);
		secondDisconnect();
	});

	it("shows explicit pending telemetry and zero split usage for a new local child", async () => {
		const { pi, events, emitLifecycle } = fakePi();
		serveFleet(events, () => ({ version: 1, totalActive: 0, omitted: 0, entries: [] }));
		const panel = createSubagentsPanel(pi);
		const dispose = connect(panel);
		await tick();
		await tick();
		emitLifecycle("tool_execution_start", {
			toolName: "subagent",
			toolCallId: "pending-child",
			args: { agent: "worker", task: "Start the task" },
		});
		const lines = panel.render({ width: 36, height: 3, surface: "right", theme, now: Date.now() });
		assert.match(lines.join("\n"), /worker.*model pending.*effort pending.*↑0 ↓0.*Start the task/s);
		dispose();
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
						version: 1,
						requestId: request.requestId,
						method: "ping",
						success: true,
						data: { version: 1, methods: ["ping", "status"] },
					});
					return;
				}
				statusCalls += 1;
				events.emit(
					`subagents:rpc:v1:reply:${request.requestId}`,
					statusCalls === 1
						? {
								version: 1,
								requestId: request.requestId,
								method: "status",
								success: true,
								data: {
									text: "Active async runs: 1\n\n- abc | running | single | /tmp/project",
								},
							}
						: {
								version: 1,
								requestId: request.requestId,
								method: "status",
								success: false,
								error: {
									code: "unavailable",
									message: "temporarily unavailable",
								},
							},
				);
			});
		});
		const panel = createSubagentsPanel(pi);
		let invalidations = 0;
		const dispose = connect(panel, () => {
			invalidations += 1;
		});
		await tick();
		await tick();
		assert.deepEqual(methods.slice(0, 2), ["ping", "status"]);
		assert.match(
			panel
				.render({ width: 40, height: 10, theme, now: Date.now() })
				.join("\n"),
			/1 async run/,
		);

		events.emit("subagent:async-started", {});
		await tick();
		await tick();
		assert.deepEqual(
			panel.render({ width: 40, height: 10, theme, now: Date.now() }),
			[],
		);
		assert.ok(invalidations >= 2);
		dispose();
	});

	it("does not trust lifecycle events before a successful ping", async () => {
		const { pi, events } = fakePi();
		const methods: string[] = [];
		events.on("subagents:rpc:v1:request", (payload) =>
			methods.push((payload as { method: string }).method),
		);
		const panel = createSubagentsPanel(pi);
		const dispose = connect(panel);
		events.emit("subagent:async-started", {});
		await tick();
		assert.deepEqual([...new Set(methods)], ["ping"]);
		dispose();
		await tick();
	});
});
