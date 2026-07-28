import { randomUUID } from "node:crypto";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { SidebarPanel } from "../api.ts";

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
const MAX_STATUS_LINES = 10;

interface ForegroundLaunch {
	id: string;
	labels: string[];
	startedAt: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function launchLabels(value: unknown): string[] {
	const input = record(value);
	if (!input || typeof input.action === "string") return [];
	if (Array.isArray(input.tasks)) {
		const labels = input.tasks.flatMap((task) => {
			const item = record(task);
			return typeof item?.agent === "string" ? [item.agent] : [];
		});
		return labels.length ? labels : [`${input.tasks.length} parallel agents`];
	}
	if (Array.isArray(input.chain)) {
		const agents = input.chain.flatMap((step) => {
			const item = record(step);
			if (typeof item?.agent === "string") return [item.agent];
			if (Array.isArray(item?.parallel)) return [`${item.parallel.length} parallel`];
			return [];
		});
		return agents.length ? [`chain · ${agents.join(" → ")}`] : [`chain · ${input.chain.length} steps`];
	}
	return typeof input.agent === "string" ? [input.agent] : ["subagent"];
}

export function parseSubagentStatusText(value: unknown): { lines: string[]; active: boolean } {
	if (typeof value !== "string") return { lines: [], active: false };
	const trimmed = value.trim();
	if (!trimmed) return { lines: [], active: false };
	const source = trimmed.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
	if (source.some((line) => /^No active async runs\.?$/i.test(line.trim()))) {
		return { lines: [], active: false };
	}
	const headingIndex = source.findIndex((line) => /^Active async runs:\s*\d+/i.test(line.trim()));
	if (headingIndex < 0) return { lines: [], active: false };
	const heading = source[headingIndex]!.trim().match(/^Active async runs:\s*(\d+)/i);
	if (!heading || heading[1] === "0") return { lines: [], active: false };
	const lines: string[] = [`${heading[1]} async run${heading[1] === "1" ? "" : "s"}`];
	for (const original of source.slice(headingIndex + 1)) {
		let line = original.trim();
		if (line.startsWith("- ")) line = `● ${line.slice(2)}`;
		else if (/^\d+\./.test(line)) line = `  ${line}`;
		line = line.replace(/\s+\|\s+(?:~|\/)[^|]+$/, "");
		lines.push(line);
		if (lines.length >= MAX_STATUS_LINES) break;
	}
	return { lines, active: lines.length > 0 };
}

function elapsed(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function colorStatusLine(line: string, theme: Theme): string {
	if (line.startsWith("●")) return `${theme.fg("accent", "●")}${line.slice(1)}`;
	if (/failed|needs attention|error/i.test(line)) return theme.fg("warning", line);
	if (/complete|done/i.test(line)) return theme.fg("success", line);
	return theme.fg("dim", line);
}

export function createSubagentsPanel(pi: ExtensionAPI): SidebarPanel {
	let statusLines: string[] = [];
	let statusActive = false;
	let connected = false;
	let disposed = false;
	let rpcAvailable = false;
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
	const schedulePoll = (delay: number) => {
		clearPoll();
		if (!connected || disposed || !rpcAvailable) return;
		pollTimer = setTimeout(() => void refreshStatus(), delay);
		pollTimer.unref?.();
	};

	const rpc = (method: "ping" | "status", params?: Record<string, unknown>): Promise<unknown> => {
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
			unsubscribe = pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, (payload) => {
				const reply = record(payload);
				if (requestGeneration !== generation || reply?.requestId !== requestId) return;
				if (reply.success !== true) {
					const error = record(reply.error);
					finish(new Error(typeof error?.message === "string" ? error.message : "Subagent RPC failed."));
					return;
				}
				finish(undefined, reply.data);
			});
			const timer = setTimeout(() => finish(new Error("Subagent RPC timed out.")), RPC_TIMEOUT_MS);
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
			const parsed = parseSubagentStatusText(data?.text);
			statusLines = parsed.lines;
			statusActive = parsed.active;
			invalidate();
		} catch {
			if (connected && requestGeneration === generation) {
				statusLines = [];
				statusActive = false;
				invalidate();
			}
		} finally {
			statusPending = false;
			if (statusDirty) {
				statusDirty = false;
				queueMicrotask(() => void refreshStatus());
			} else {
				schedulePoll(statusActive || foreground.size ? ACTIVE_POLL_MS : IDLE_POLL_MS);
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
			rpcAvailable = data?.version === 1 && methods.includes("status");
			if (rpcAvailable) await refreshStatus();
		} catch {
			if (requestGeneration === generation) rpcAvailable = false;
		} finally {
			probePending = false;
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
		const labels = launchLabels(event.args);
		if (!labels.length) return;
		foreground.set(event.toolCallId, { id: event.toolCallId, labels, startedAt: Date.now() });
		if (connected) invalidate();
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "subagent" || !foreground.delete(event.toolCallId)) return;
		if (connected) {
			invalidate();
			void refreshStatus();
		}
	});

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		connected = false;
		generation += 1;
		clearPoll();
		for (const cancel of [...pendingRpc]) cancel();
		for (const unsubscribe of busUnsubscribes) unsubscribe();
		foreground.clear();
	};
	pi.on("session_shutdown", dispose);

	return {
		id: "neumie.subagents",
		title: "Subagents",
		order: 100,
		connect(context) {
			connected = true;
			generation += 1;
			invalidate = context.invalidate;
			queueMicrotask(() => void probe());
			context.signal.addEventListener("abort", () => {
				connected = false;
				generation += 1;
				clearPoll();
				for (const cancel of [...pendingRpc]) cancel();
			}, { once: true });
			return dispose;
		},
		render({ theme, now }) {
			const lines: string[] = [];
			for (const launch of foreground.values()) {
				for (const [index, label] of launch.labels.slice(0, 4).entries()) {
					const prefix = index === 0 ? `${theme.fg("accent", "●")} ` : "  ";
					const age = index === 0 ? theme.fg("dim", ` · ${elapsed(launch.startedAt, now)}`) : "";
					lines.push(`${prefix}${label}${age}`);
				}
			}
			for (const line of statusLines) lines.push(colorStatusLine(line, theme));
			return lines.slice(0, MAX_STATUS_LINES + 4);
		},
	};
}
