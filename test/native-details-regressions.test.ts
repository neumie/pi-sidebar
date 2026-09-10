import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createSubagentsPanel,
	parseWorkflowChildren,
} from "../src/adapters/subagents.ts";

// Fixtures model the public RPC/lifecycle boundary, never private adapter state.
type Payload = Record<string, any>;
class Bus {
	private listeners = new Map<string, Set<(value: any) => void>>();
	on(name: string, fn: (value: any) => void) {
		const set = this.listeners.get(name) ?? new Set();
		set.add(fn);
		this.listeners.set(name, set);
		return () => {
			set.delete(fn);
		};
	}
	emit(name: string, value: unknown) {
		for (const fn of this.listeners.get(name) ?? []) fn(value);
	}
}
const theme = {
	fg: (_: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const child = (agent: string, state = "running", extra: Payload = {}) => ({
	childId: `key-${agent}`,
	agent,
	state,
	...extra,
});
function details(
	runId: string,
	parent: string,
	children: Payload[] = [],
	state = "running",
) {
	return {
		mode: "workflow",
		runId,
		workflowChildren: {
			version: 1,
			workflowRunId: runId,
			parentToolCallId: parent,
			workflowState: state,
			inventoryComplete:
				state === "completed" || state === "failed" || state === "stopped",
			children,
		},
	};
}
async function flush() {
	await tick();
	await tick();
}
async function harness(
	t: TestContext,
	ids: string[] = [],
	hold: string[] = [],
) {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
	const bus = new Bus();
	const hooks = new Map<string, Array<(value: any) => void>>();
	const pi = {
		events: bus,
		on(name: string, fn: (value: any) => void) {
			const list = hooks.get(name) ?? [];
			list.push(fn);
			hooks.set(name, list);
		},
	} as unknown as ExtensionAPI;
	const state = {
		runs: ids.map((id) => ({
			id,
			kind: "workflow",
			state: "running",
			label: "Workflow",
			startedAt: 9_000,
		})),
		fleet: { version: 1, totalActive: 0, omitted: 0, entries: [] as Payload[] },
		omitted: { runs: 0, children: 0, byteLimitExceeded: false },
		summaries: new Map(
			ids.map((id) => [
				id,
				details(id, `parent-${id}`, [child(`async-${id}`)]),
			]),
		),
		fail: new Set<string>(),
		hold: new Set(hold),
		held: [] as Payload[],
		requests: [] as Payload[],
		failStatus: false,
		invalidations: 0,
	};
	function reply(
		req: Payload,
		data?: unknown,
		success = true,
		envelope: Payload = {},
	) {
		queueMicrotask(() =>
			bus.emit(`subagents:rpc:v1:reply:${req.requestId}`, {
				version: 1,
				requestId: req.requestId,
				method: req.method,
				success,
				...(success
					? { data }
					: {
							error: { code: "fixture_failure", message: "not display-safe" },
						}),
				...envelope,
			}),
		);
	}
	bus.on("subagents:rpc:v1:request", (req: Payload) => {
		state.requests.push({ ...req, at: Date.now() });
		if (req.method === "ping")
			return reply(req, {
				version: 1,
				methods: ["ping", "status"],
				capabilities: { fleetStatus: { version: 1 } },
			});
		const id = req.params?.runId;
		if (id && state.hold.has(id)) {
			state.held.push(req);
			return;
		}
		if (id)
			return reply(
				req,
				{ details: state.summaries.get(id) },
				!state.fail.has(id),
			);
		reply(
			req,
			{
				fleet: state.fleet,
				asyncSnapshot: {
					kind: "pi-subagents.async-status-snapshot",
					version: 1,
					generatedAt: Date.now(),
					caps: {
						maxRuns: 20,
						maxChildrenPerNode: 8,
						maxDepth: 3,
						maxStringLength: 160,
						maxSerializedBytes: 32768,
					},
					runs: state.runs,
					omitted: state.omitted,
				},
			},
			!state.failStatus,
		);
	});
	const panel = createSubagentsPanel(pi);
	function connection() {
		const controller = new AbortController();
		const disconnect = panel.connect?.({
			pi,
			session: { sessionManager: { getSessionId: () => "fixture" } } as never,
			signal: controller.signal,
			invalidate() {
				state.invalidations++;
			},
		});
		assert.equal(typeof disconnect, "function");
		return () => {
			controller.abort();
			(disconnect as () => void)();
		};
	}
	let disconnect = connection();
	t.after(() => {
		disconnect();
		t.mock.timers.reset();
	});
	const emit = (name: string, value: unknown) => {
		for (const fn of hooks.get(name) ?? []) fn(value);
	};
	await flush();
	return {
		state,
		panel,
		reply,
		events: bus,
		start(id: string) {
			emit("tool_execution_start", {
				toolName: "subagent",
				toolCallId: id,
				args: { workflowScript: 'return "fixture";' },
			});
		},
		update(
			id: string,
			run: string,
			children: Payload[] = [],
			status = "running",
		) {
			emit("tool_execution_update", {
				toolName: "subagent",
				toolCallId: id,
				partialResult: { details: details(run, id, children, status) },
			});
		},
		end(id: string) {
			emit("tool_execution_end", { toolName: "subagent", toolCallId: id });
		},
		reconnect() {
			disconnect();
			disconnect = connection();
		},
		dispose() {
			emit("session_shutdown", {});
			disconnect();
		},
		async event() {
			bus.emit("subagent:control-event", {});
			await flush();
		},
		async advance(ms = 2_000) {
			t.mock.timers.tick(ms);
			await flush();
		},
		count() {
			return Number(
				panel.hiddenStatus?.()?.match(/(\d+) workflow detail/)?.[1] ?? 0,
			);
		},
		lines(width = 100, height = 100) {
			return [
				...panel.render({
					width,
					height,
					surface: "right",
					theme,
					now: Date.now(),
				}),
			];
		},
		text(width = 100, height = 100) {
			return this.lines(width, height).join("\n");
		},
		targets() {
			return state.requests
				.filter((req) => req.params?.runId)
				.map((req) => req.params.runId as string);
		},
	};
}

it("accepts workflowScript starts and rejects late, foreign, or changed-run updates", async (t) => {
	const h = await harness(t);
	h.update("call", "private-run", [child("too-early")]);
	assert.equal(h.count(), 0);
	h.start("call");
	h.update("call", "private-run", [child("visible-worker")]);
	assert.equal(h.count(), 1);
	assert.match(h.text(), /visible-worker/);
	assert.doesNotMatch(h.text(), /private-run|key-visible-worker/);
	h.update("other", "private-run", [child("foreign")]);
	h.update("call", "changed-run", [child("wrong-run")]);
	assert.equal(h.count(), 1);
	assert.doesNotMatch(h.text(), /foreign|wrong-run/);
	h.end("call");
	h.update("call", "private-run", [child("late")]);
	assert.equal(h.count(), 0);
	h.dispose();
	h.start("after-dispose");
	h.update("after-dispose", "r", [child("late")]);
	assert.equal(h.count(), 0);
});

it("rejects malformed or miscorrelated targeted envelopes and contains throwing replies", async (t) => {
	const h = await harness(t, ["a"], ["a"]);
	const held = h.state.held[0]!;
	h.reply(held, { details: h.state.summaries.get("a") }, true, { version: 2 });
	await flush();
	assert.equal(h.count(), 0);
	h.reconnect();
	await flush();
	const next = h.state.held.at(-1)!;
	assert.doesNotThrow(() =>
		h.events.emit(`subagents:rpc:v1:reply:${next.requestId}`, {
			requestId: next.requestId,
			get version() {
				throw new Error("hostile reply");
			},
		}),
	);
	await flush();
	assert.equal(h.count(), 0);
	h.state.hold.clear();
	h.state.summaries.set("a", {
		...details("wrong-run", "p", [child("must-not-render")]),
		mode: "single",
	});
	await h.advance();
	assert.equal(h.count(), 0);
	assert.doesNotMatch(h.text(), /must-not-render/);
});

it("caps mixed retained records at eight with foreground priority", async (t) => {
	const h = await harness(t, ["a", "b"]);
	assert.equal(h.count(), 2);
	for (let i = 0; i < 8; i++) {
		h.start(`f${i}`);
		h.update(`f${i}`, `private-${i}`, [child(`front${i}`)]);
		assert.ok(h.count() <= 8);
	}
	await h.advance();
	assert.equal(h.count(), 8);
	for (let i = 0; i < 8; i++) assert.match(h.text(), new RegExp(`front${i}`));
	assert.doesNotMatch(h.text(), /async-a|async-b/);
	h.start("f8");
	h.update("f8", "private-8", [child("front8")]);
	assert.equal(h.count(), 8);
	assert.doesNotMatch(h.text(), /front0/);
});

it("removes absent and failed async details while preserving live foreground", async (t) => {
	const h = await harness(t, ["a", "b"]);
	h.start("f");
	h.update("f", "fore", [child("foreground-worker")]);
	assert.equal(h.count(), 3);
	await flush(); // Settle the start-triggered snapshot before publishing its replacement.
	h.state.runs = h.state.runs.filter((run) => run.id !== "a");
	await h.event();
	assert.equal(h.count(), 2);
	assert.doesNotMatch(h.text(), /async-a/);
	h.state.fail.add("b");
	await h.advance();
	assert.equal(h.count(), 1);
	assert.match(h.text(), /foreground-worker/);
	assert.doesNotMatch(h.text(), /async-b/);
	h.state.failStatus = true;
	await h.event();
	assert.equal(h.count(), 1);
});

it("reconciles complete, partial, and rejected snapshots into terminal native summaries", async (t) => {
	const h = await harness(t, ["a"]);
	for (const [snapshotState, workflowState, childState] of [
		["complete", "completed", "completed"],
		["partial", "failed", "failed"],
		["rejected", "failed", "rejected"],
	]) {
		h.state.runs[0]!.state = snapshotState!;
		h.state.summaries.set(
			"a",
			details(
				"a",
				"parent-a",
				[child("terminal-worker", childState)],
				workflowState,
			),
		);
		await h.advance();
		await h.event();
		assert.equal(h.count(), 1);
		assert.match(h.text(), new RegExp(childState!));
		assert.doesNotMatch(h.text(), /running/);
		assert.equal(h.panel.refreshIntervalMs?.(), undefined);
	}
});

it("rotates all ten discovered IDs despite non-targeted event storms", async (t) => {
	const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
	const h = await harness(t, ids);
	for (let cycle = 0; cycle < 5; cycle++) {
		const before = h.targets().length;
		await h.advance(500);
		for (let i = 0; i < 20; i++) await h.event();
		assert.equal(
			h.targets().length,
			before,
			"non-target events cannot spend another budget",
		);
		await h.advance(1_500);
	}
	assert.deepEqual(h.targets().slice(0, 10), ids);
	const windows = new Map<number, number>();
	for (const req of h.state.requests.filter((r) => r.params?.runId)) {
		const window = Math.floor((req.at - 10_000) / 2_000);
		windows.set(window, (windows.get(window) ?? 0) + 1);
	}
	assert.ok([...windows.values()].every((count) => count <= 2));
});

it("does not resurrect ended foreground or overwrite newer updates after a held target", async (t) => {
	const h = await harness(t, ["a", "b"], ["a"]);
	assert.equal(h.state.held.length, 1);
	h.start("ended");
	h.update("ended", "old", [child("ended-worker")]);
	h.end("ended");
	h.start("live");
	h.update("live", "new", [child("before")]);
	h.update("live", "new", [child("newest")]);
	h.reply(h.state.held[0]!, { details: h.state.summaries.get("a") });
	await flush();
	assert.match(h.text(), /newest/);
	assert.doesNotMatch(h.text(), /ended-worker|before/);
});

it("never emits the old second target after reconnect cancels the first", async (t) => {
	const h = await harness(t, ["old-a", "old-b"], ["old-a"]);
	assert.deepEqual(h.targets(), ["old-a"]);
	const held = h.state.held[0]!;
	h.state.runs = [
		{
			id: "new",
			kind: "workflow",
			state: "running",
			label: "Workflow",
			startedAt: 9_000,
		},
	];
	h.state.summaries.set(
		"new",
		details("new", "new-parent", [child("new-worker")]),
	);
	h.reconnect();
	await flush();
	h.reply(held, { details: details("old-a", "old-parent", [child("stale")]) });
	await flush();
	assert.deepEqual(h.targets(), ["old-a", "new"]);
	assert.equal(h.count(), 1);
	assert.match(h.text(), /new-worker/);
	assert.doesNotMatch(h.text(), /stale/);
});

it("keeps colon tuples and long common-prefix parent/run identities distinct", async (t) => {
	const h = await harness(t);
	const pairs = [
		["a:b", "c"],
		["a", "b:c"],
		["p".repeat(200) + "x", "r".repeat(200) + "x"],
		["p".repeat(200) + "y", "r".repeat(200) + "y"],
	];
	pairs.forEach(([p, r], i) => {
		h.start(p!);
		h.update(p!, r!, [child(`unique${i}`)]);
	});
	assert.equal(h.count(), 4);
	for (let i = 0; i < 4; i++) assert.match(h.text(), new RegExp(`unique${i}`));
});

it("matches native UTF-8 parent/run limits and ASCII child-key bounds", () => {
	const exact = "界".repeat(1_365) + "x";
	assert.equal(Buffer.byteLength(exact), 4_096);
	const raw = details(exact, exact, [
		child("worker", "running", { childId: "a".repeat(128) }),
	]).workflowChildren;
	assert.equal(parseWorkflowChildren(raw)?.workflowRunId, exact);
	assert.equal(
		parseWorkflowChildren({ ...raw, workflowRunId: exact + "x" }),
		undefined,
	);
	assert.equal(
		parseWorkflowChildren({ ...raw, parentToolCallId: exact + "x" }),
		undefined,
	);
	for (const id of ["a".repeat(129), "has:colon", "界", ""]) {
		const parsed = parseWorkflowChildren({
			...raw,
			children: [child("worker", "running", { childId: id })],
		});
		assert.equal(parsed?.children.length ?? 0, 0);
		assert.ok(!parsed?.inventoryComplete);
	}
});

it("invalidates changed or removed details but not identical foreground replays", async (t) => {
	const h = await harness(t);
	h.start("f");
	const before = h.state.invalidations;
	h.update("f", "r", [child("worker")]);
	assert.ok(h.state.invalidations > before);
	const rendered = h.state.invalidations;
	h.update("f", "r", [child("worker")]);
	assert.equal(h.state.invalidations, rendered);
	h.update("f", "r", [child("worker", "completed")], "completed");
	assert.ok(h.state.invalidations > rendered);
	const terminal = h.state.invalidations;
	h.end("f");
	assert.ok(h.state.invalidations > terminal);
});

it("invalidates detail-only async changes and removal with an unchanged empty fleet", async (t) => {
	const h = await harness(t, ["a"]);
	const before = h.state.invalidations;
	h.state.summaries.set("a", details("a", "parent-a", [child("updated")]));
	await h.advance();
	assert.ok(h.state.invalidations > before);
	const updated = h.state.invalidations;
	await h.advance();
	assert.equal(h.state.invalidations, updated);
	h.state.runs = [];
	await h.event();
	assert.ok(h.state.invalidations > updated);
	assert.equal(h.count(), 0);
});

it("schedules queued/pending detail activity but not terminal records", async (t) => {
	const h = await harness(t, ["a"]);
	h.state.summaries.set(
		"a",
		details("a", "parent-a", [child("waiting", "pending")], "queued"),
	);
	await h.advance();
	assert.equal(h.panel.refreshIntervalMs?.(), 1_000);
	h.state.summaries.set(
		"a",
		details("a", "parent-a", [child("waiting", "paused")], "paused"),
	);
	await h.advance();
	assert.equal(h.panel.refreshIntervalMs?.(), undefined);
});

it("promotes a late foreground summary to active polling without postponement on replay", async (t) => {
	const h = await harness(t);
	h.start("late");
	await flush();
	const requests = h.state.requests.length;
	h.update("late", "late-run", [child("worker")]);
	await h.advance(1_000);
	h.update("late", "late-run", [child("worker")]);
	await h.advance(1_000);
	assert.ok(
		h.state.requests.length > requests,
		"idle polling must become active by two seconds",
	);
	h.end("late");
	await flush();
	assert.equal(h.panel.refreshIntervalMs?.(), undefined);
});

it("preserves fleet and detail overflow at each height from one through five", async (t) => {
	const h = await harness(
		t,
		Array.from({ length: 9 }, (_, i) => `r${i}`),
	);
	h.state.fleet = {
		version: 1,
		totalActive: 3,
		omitted: 2,
		entries: [
			{ key: "opaque", agent: "fleet-worker", startedAt: 1, tokens: {} },
		],
	};
	await h.event();
	for (let height = 1; height <= 5; height++) {
		const lines = h.lines(80, height);
		const output = lines.join("\n");
		assert.ok(lines.length <= height);
		assert.match(output, /fleet/i, `height ${height}`);
		assert.match(
			output,
			/details? (hidden|clipped)|hidden.*details?/i,
			`height ${height}: missing detail overflow`,
		);
		assert.ok(lines.every((line) => visibleWidth(line) <= 80));
	}
});

it("reports global snapshot incompleteness without making up workflow totals", async (t) => {
	const h = await harness(t, ["a"]);
	h.state.omitted = { runs: 7, children: 12, byteLimitExceeded: true };
	await h.event();
	assert.match(h.text(), /async (inventory )?incomplete/i);
	assert.doesNotMatch(h.text(), /7 (more )?workflow|12 (more )?child/);
});

it("prioritizes later active children and fits state effort and usage at narrow widths", async (t) => {
	const h = await harness(t);
	h.start("p");
	h.update("p", "private", [
		child("done1", "completed"),
		child("done2", "completed"),
		child("active", "running", {
			model: "provider/" + "long-model-".repeat(15),
			thinking: "xhigh",
			activity: { inputTokens: 123, outputTokens: 456 },
		}),
	]);
	const lines = h.lines(32, 20);
	const output = lines.join("\n");
	assert.match(output, /active/);
	assert.match(output, /running/);
	assert.match(output, /xhigh/);
	assert.match(output, /↑123.*↓456/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 32));
	assert.doesNotMatch(output, /done1|done2/);
	assert.match(output, /3 observed/);
	assert.match(output, /2 (completed|hidden)/);
});

it("does not turn invalid or terminal activity into fabricated zero usage", () => {
	const raw = details("r", "p", [
		child("worker", "running", {
			activity: { inputTokens: -1, outputTokens: 0 },
		}),
	]).workflowChildren;
	assert.equal(
		parseWorkflowChildren(raw)?.children[0]?.activity?.inputTokens,
		undefined,
	);
	assert.equal(
		parseWorkflowChildren(raw)?.children[0]?.activity?.outputTokens,
		0,
	);
	assert.equal(
		parseWorkflowChildren({
			...raw,
			children: [{ ...raw.children[0], state: "completed" }],
		})?.children[0]?.activity,
		undefined,
	);
	assert.equal(
		parseWorkflowChildren({ ...raw, parentToolCallId: "   " }),
		undefined,
	);
});

it("distinguishes terminal child states and preserves the first observation time", async (t) => {
	const h = await harness(t);
	for (const status of [
		"failed",
		"rejected",
		"paused",
		"detached",
		"stopped",
		"completed",
	]) {
		h.start(status);
		h.update(
			status,
			`private-${status}`,
			[child(`agent-${status}`, status)],
			"completed",
		);
		assert.match(h.text(), new RegExp(`\\b${status}\\b`));
		h.end(status);
	}
	h.start("clock");
	h.update("clock", "clock-run", [child("clock-worker")]);
	await h.advance();
	h.update("clock", "clock-run", [child("clock-worker")]);
	assert.match(h.text(), /2s/);
});
