import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSidebarPanel, type SidebarPanel } from "../src/api.ts";
import {
	SIDEBAR_READY_EVENT,
	SIDEBAR_REGISTER_EVENT,
	SIDEBAR_UNREGISTER_EVENT,
} from "../src/protocol.ts";

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
	const handlers = new Map<string, Array<() => void>>();
	const pi = {
		events,
		on(event: string, handler: () => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	return { pi, events, shutdown: () => handlers.get("session_shutdown")?.forEach((handler) => handler()) };
}

const panel: SidebarPanel = {
	id: "example.deployments",
	title: "Deployments",
	render: () => ["one active"],
};

describe("registerSidebarPanel", () => {
	it("announces immediately, replays on ready, and unregisters by token", () => {
		const { pi, events } = fakePi();
		const registrations: unknown[] = [];
		const unregistrations: unknown[] = [];
		events.on(SIDEBAR_REGISTER_EVENT, (payload) => registrations.push(payload));
		events.on(SIDEBAR_UNREGISTER_EVENT, (payload) => unregistrations.push(payload));

		const dispose = registerSidebarPanel(pi, panel);
		assert.equal(registrations.length, 1);
		events.emit(SIDEBAR_READY_EVENT, { version: 1, hostId: "host" });
		assert.equal(registrations.length, 2);
		assert.equal((registrations[0] as { token: string }).token, (registrations[1] as { token: string }).token);

		dispose();
		assert.equal(unregistrations.length, 1);
		events.emit(SIDEBAR_READY_EVENT, { version: 1, hostId: "other" });
		assert.equal(registrations.length, 2);
	});

	it("rejects malformed public definitions", () => {
		const { pi } = fakePi();
		assert.throws(() => registerSidebarPanel(pi, { ...panel, id: "spaces are invalid" }), /identifier/);
		assert.throws(() => registerSidebarPanel(pi, { ...panel, title: "bad\ntitle" }), /one line/);
		assert.throws(
			() => registerSidebarPanel(pi, { ...panel, hiddenStatus: "active" } as unknown as SidebarPanel),
			/hiddenStatus/,
		);
		assert.throws(
			() => registerSidebarPanel(pi, { ...panel, showTitleInRight: "no" } as unknown as SidebarPanel),
			/showTitleInRight/,
		);
	});
});
