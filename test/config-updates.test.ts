import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CONFIG_STATUS_READY_EVENT,
	CONFIG_STATUS_REQUEST_EVENT,
	CONFIG_STATUS_SNAPSHOT_EVENT,
	createConfigUpdatesPanel,
	parseConfigStatusSnapshot,
	renderConfigUpdates,
	type ConfigStatusSnapshotV1,
} from "../src/adapters/config-updates.ts";

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
	const handlers = new Map<string, Array<() => void>>();
	const pi = {
		events,
		on(event: string, handler: () => void) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		events,
		shutdown: () => handlers.get("session_shutdown")?.forEach((handler) => handler()),
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const snapshot: ConfigStatusSnapshotV1 = {
	version: 1,
	checkedAt: "2026-07-31T12:00:00.000Z",
	updates: [
		{
			name: "pi",
			version: "0.83.0",
			kind: "local",
			detail: "main clean · fork +1/-71 vs upstream/main · CI none",
		},
		{
			name: "@narumitw/pi-btw",
			version: "0.32.0",
			kind: "npm",
			detail: "installed 0.32.0 → 0.34.0 · latest 0.39.0 age-held",
		},
		{
			name: "pi-subagents",
			version: "0.38.1",
			kind: "local",
			detail: "main clean · fork +3/-9 vs upstream/main · CI passed 12",
		},
		{
			name: "pi-web-access",
			version: "0.14.0",
			kind: "npm",
			detail: "installed 0.14.0 → 0.15.0 · latest 0.17.0 age-held",
		},
	],
	updatesOmitted: 0,
};

function renderContext(width = 60, height = 3) {
	return {
		width,
		height,
		surface: "right" as const,
		theme,
		now: Date.now(),
	};
}

describe("config update snapshots", () => {
	it("validates the complete bounded v1 display contract", () => {
		assert.deepEqual(parseConfigStatusSnapshot(snapshot), snapshot);
		assert.equal(
			parseConfigStatusSnapshot({ ...snapshot, version: 2 }),
			undefined,
		);
		assert.equal(
			parseConfigStatusSnapshot({
				...snapshot,
				updates: [{ ...snapshot.updates[0], name: "unsafe\nname" }],
			}),
			undefined,
		);
		assert.equal(
			parseConfigStatusSnapshot({
				...snapshot,
				updates: Array.from({ length: 65 }, () => snapshot.updates[0]),
			}),
			undefined,
		);
		assert.equal(
			parseConfigStatusSnapshot({ ...snapshot, updatesOmitted: -1 }),
			undefined,
		);
		assert.equal(
			parseConfigStatusSnapshot({ ...snapshot, updatesOmitted: 10_001 }),
			undefined,
		);
	});

	it("renders only a colored count and the detail command", () => {
		const colors: string[] = [];
		const context = {
			...renderContext(),
			theme: {
				...theme,
				fg(color: string, text: string) {
					colors.push(color);
					return text;
				},
			} as Theme,
		};
		const lines = renderConfigUpdates(snapshot, context);
		assert.equal(lines.length, 1);
		assert.equal(lines[0], "4 · /config-status");
		assert.doesNotMatch(lines[0] ?? "", /pi|narumitw|subagents|web-access/);
		assert.equal(colors[0], "warning");

		colors.length = 0;
		const overflow = renderConfigUpdates({ ...snapshot, updatesOmitted: 2 }, context);
		assert.equal(overflow[0], "6 · /config-status");
		assert.equal(colors[0], "error");
		assert.deepEqual(
			renderConfigUpdates({ ...snapshot, updates: [], updatesOmitted: 0 }, renderContext()),
			[],
		);
	});
});

describe("config updates panel", () => {
	it("requests on connect/provider readiness and hides empty snapshots", async () => {
		const { pi, events, shutdown } = fakePi();
		const panel = createConfigUpdatesPanel(pi);
		let invalidations = 0;
		const controller = new AbortController();
		const disconnect = panel.connect?.({
			pi,
			session: {} as ExtensionContext,
			signal: controller.signal,
			invalidate: () => {
				invalidations += 1;
			},
		});
		assert.equal(typeof disconnect, "function");
		assert.equal(panel.showTitleInRight, false);
		assert.equal(panel.showTitleInNarrow, false);
		await tick();
		const requests = () =>
			events.emitted.filter((entry) => entry.event === CONFIG_STATUS_REQUEST_EVENT);
		assert.equal(requests().length, 1);
		assert.deepEqual(requests()[0]?.payload, {
			version: 1,
			source: { extension: "@neumie/pi-sidebar" },
		});

		events.emit(CONFIG_STATUS_READY_EVENT, { version: 1 });
		assert.equal(requests().length, 2);
		events.emit(CONFIG_STATUS_SNAPSHOT_EVENT, snapshot);
		assert.equal(invalidations, 1);
		assert.equal(panel.render(renderContext())[0], "4 · /config-status");

		events.emit(CONFIG_STATUS_SNAPSHOT_EVENT, {
			...snapshot,
			updates: [],
			updatesOmitted: 0,
		});
		assert.equal(invalidations, 2);
		assert.deepEqual(panel.render(renderContext()), []);

		events.emit(CONFIG_STATUS_SNAPSHOT_EVENT, { ...snapshot, version: 2 });
		assert.equal(invalidations, 2);
		assert.deepEqual(panel.render(renderContext()), []);
		if (typeof disconnect === "function") disconnect();
		shutdown();
		events.emit(CONFIG_STATUS_READY_EVENT, { version: 1 });
		assert.equal(requests().length, 2);
	});
});
