import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { SidebarPanel } from "../api.ts";
import { sanitizeSidebarLine } from "../render.ts";

export const FOOTER_STATUS_SOURCE_REQUEST_EVENT = "pi-footer:status-source:v1:request";
export const FOOTER_STATUS_SOURCE_READY_EVENT = "pi-footer:status-source:v1:ready";

export interface FooterStatusEntry {
	key: string;
	text: string;
}

export interface FooterStatusSource {
	version: 1;
	sessionId: string;
	token: string;
	readStatuses(): readonly FooterStatusEntry[];
}

export interface McpIssue {
	server: string;
	detail: string;
}

export type McpHealthUpdate =
	| { kind: "replace"; issues: readonly McpIssue[] }
	| { kind: "set"; issue: McpIssue }
	| { kind: "clear"; server: string };

const MAX_STATUS_ENTRIES = 64;
const MAX_SERVER_NAME_LENGTH = 80;
const SGR_PATTERN = /\x1b\[[0-9;:]*m/g;
const CONTROL_PATTERN = /[\x00-\x1f\x7f-\x9f]/;
const LSP_FAILED_PREFIX = "LSP Failed:";
const MCP_DEGRADED_ERRORS = new Map<string, string>([
	["auth_required", "authentication required"],
	["connect_failed", "connection failed"],
	["server_backoff", "connection failed"],
	["server_unavailable", "server unavailable"],
]);

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: undefined;
}

function plainText(value: unknown): string {
	if (typeof value !== "string") return "";
	const withoutSgr = value.replace(SGR_PATTERN, "");
	const controlIndex = withoutSgr.search(CONTROL_PATTERN);
	const firstLine = controlIndex >= 0 ? withoutSgr.slice(0, controlIndex) : withoutSgr;
	return sanitizeSidebarLine(firstLine).trim();
}

function serverName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const sanitized = plainText(value).slice(0, MAX_SERVER_NAME_LENGTH).trim();
	return sanitized.length > 0 ? sanitized : undefined;
}

function sessionId(value: unknown): string | undefined {
	try {
		const context = record(value);
		const manager = record(context?.sessionManager);
		const getter = manager?.getSessionId;
		if (typeof getter !== "function") return undefined;
		const id = getter.call(manager);
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

export function parseFooterStatusSource(value: unknown): FooterStatusSource | undefined {
	try {
		const source = record(value);
		if (
			source?.version !== 1 ||
			typeof source.sessionId !== "string" || source.sessionId.length === 0 ||
			typeof source.token !== "string" || source.token.length === 0 ||
			typeof source.readStatuses !== "function"
		) return undefined;
		const readStatuses = source.readStatuses;
		return Object.freeze({
			version: 1 as const,
			sessionId: source.sessionId,
			token: source.token,
			readStatuses: () => readStatuses.call(source),
		});
	} catch {
		return undefined;
	}
}

export function readLspFailure(source: FooterStatusSource | undefined): string | undefined {
	if (!source) return undefined;
	try {
		const statuses = source.readStatuses();
		if (!Array.isArray(statuses)) return undefined;
		for (const entry of statuses.slice(0, MAX_STATUS_ENTRIES)) {
			const status = record(entry);
			if (status?.key !== "pi-lens-lsp" || typeof status.text !== "string") continue;
			const text = plainText(status.text);
			const failedSegment = text
				.split(/\s+·\s+/u)
				.find((segment) => segment.startsWith(LSP_FAILED_PREFIX));
			if (!failedSegment) return undefined;
			const failed = failedSegment.slice(LSP_FAILED_PREFIX.length).trim();
			return failed.length > 0 ? `${failed} failed` : "failed";
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function parseMcpStatusUpdate(details: Record<string, unknown>): McpHealthUpdate | undefined {
	if (!Array.isArray(details.servers)) return undefined;
	const issues: McpIssue[] = [];
	for (const candidate of details.servers.slice(0, MAX_STATUS_ENTRIES)) {
		const server = record(candidate);
		const name = serverName(server?.name);
		if (!name || typeof server?.status !== "string") return undefined;
		if (server.status === "needs-auth") {
			issues.push({ server: name, detail: "authentication required" });
			continue;
		}
		if (server.status !== "failed") continue;
		const age = typeof server.failedAgo === "number" && Number.isFinite(server.failedAgo) && server.failedAgo >= 0
			? Math.floor(server.failedAgo)
			: undefined;
		issues.push({ server: name, detail: age === undefined ? "connection failed" : `failed ${age}s ago` });
	}
	return { kind: "replace", issues };
}

function parseMcpFailureUpdate(
	error: string,
	input: Record<string, unknown> | undefined,
	details: Record<string, unknown>,
): McpHealthUpdate | undefined {
	if (error === "init_failed") {
		return { kind: "set", issue: { server: "MCP", detail: "initialization failed" } };
	}
	const detail = MCP_DEGRADED_ERRORS.get(error);
	if (!detail) return undefined;
	const server = serverName(details.server ?? input?.server) ?? "MCP";
	return { kind: "set", issue: { server, detail } };
}

function parseMcpRecoveryUpdate(
	input: Record<string, unknown> | undefined,
	details: Record<string, unknown>,
): McpHealthUpdate | undefined {
	if (details.mode === "auth-complete" && details.authenticated === true) {
		const server = serverName(details.server ?? input?.server);
		return server ? { kind: "clear", server } : undefined;
	}
	if (typeof input?.connect === "string") {
		const server = serverName(input.connect);
		return server ? { kind: "clear", server } : undefined;
	}
	if (typeof input?.tool !== "string") return undefined;
	const server = serverName(details.server ?? input.server);
	return server ? { kind: "clear", server } : undefined;
}

function parseMcpReactiveUpdate(
	event: Record<string, unknown>,
	details: Record<string, unknown>,
): McpHealthUpdate | undefined {
	const input = record(event.input);
	const error = typeof details.error === "string" ? details.error : undefined;
	if (error !== undefined) return parseMcpFailureUpdate(error, input, details);
	if (event.isError === true) return undefined;
	return parseMcpRecoveryUpdate(input, details);
}

export function parseMcpHealthUpdate(value: unknown): McpHealthUpdate | undefined {
	try {
		const event = record(value);
		if (event?.toolName !== "mcp") return undefined;
		const details = record(event.details);
		if (!details) return undefined;
		return details.mode === "status"
			? parseMcpStatusUpdate(details)
			: parseMcpReactiveUpdate(event, details);
	} catch {
		return undefined;
	}
}

function sameMcpIssues(left: ReadonlyMap<string, McpIssue>, right: ReadonlyMap<string, McpIssue>): boolean {
	if (left.size !== right.size) return false;
	for (const [key, issue] of left) {
		const candidate = right.get(key);
		if (!candidate || candidate.server !== issue.server || candidate.detail !== issue.detail) return false;
	}
	return true;
}

function applyMcpUpdate(issues: Map<string, McpIssue>, update: McpHealthUpdate): boolean {
	if (update.kind === "replace") {
		const replacement = new Map(update.issues.map((issue) => [issue.server, issue]));
		if (sameMcpIssues(issues, replacement)) return false;
		issues.clear();
		for (const [key, issue] of replacement) issues.set(key, issue);
		return true;
	}
	if (update.kind === "set") {
		const current = issues.get(update.issue.server);
		if (current?.detail === update.issue.detail) return false;
		issues.set(update.issue.server, update.issue);
		return true;
	}
	const clearedServer = issues.delete(update.server);
	const clearedInitialization = update.server === "MCP" ? false : issues.delete("MCP");
	return clearedServer || clearedInitialization;
}

function issueLine(theme: Theme, integration: string, detail: string): string {
	return `${theme.fg("warning", "!")} ${integration} · ${theme.fg("dim", detail)}`;
}

function renderIntegrationLines(
	statusSource: FooterStatusSource | undefined,
	mcpIssues: ReadonlyMap<string, McpIssue>,
	height: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const lspFailure = readLspFailure(statusSource);
	if (lspFailure) lines.push(issueLine(theme, "LSP", lspFailure));
	const degradedMcp = [...mcpIssues.values()].sort((left, right) => left.server.localeCompare(right.server));
	const [issue] = degradedMcp;
	if (degradedMcp.length === 1 && issue) {
		const detail = issue.server === "MCP" ? issue.detail : `${issue.server} ${issue.detail}`;
		lines.push(issueLine(theme, "MCP", detail));
	} else if (degradedMcp.length > 1) {
		lines.push(issueLine(theme, "MCP", `${degradedMcp.length} servers degraded`));
	}
	const available = Math.max(0, Math.floor(height));
	if (available === 1 && lines.length > 1) return [issueLine(theme, "LSP + MCP", "degraded")];
	return lines.slice(0, available);
}

export function createIntegrationsPanel(pi: ExtensionAPI): SidebarPanel {
	let currentSessionId: string | undefined;
	let latestSource: FooterStatusSource | undefined;
	let statusSource: FooterStatusSource | undefined;
	let invalidate: () => void = () => undefined;
	let connected = false;
	let connectionGeneration = 0;
	const mcpIssues = new Map<string, McpIssue>();

	pi.events.on(FOOTER_STATUS_SOURCE_READY_EVENT, (payload) => {
		const source = parseFooterStatusSource(payload);
		if (!source) return;
		latestSource = source;
		if (!connected || source.sessionId !== currentSessionId) return;
		statusSource = source;
		invalidate();
	});

	pi.on("tool_result", (event, context) => {
		if (!connected || sessionId(context) !== currentSessionId) return;
		const update = parseMcpHealthUpdate(event);
		if (update && applyMcpUpdate(mcpIssues, update)) invalidate();
	});

	return {
		id: "neumie.integrations",
		title: "Integrations",
		order: 150,
		connect(context) {
			const nextSessionId = sessionId(context.session);
			const generation = ++connectionGeneration;
			if (nextSessionId !== currentSessionId) mcpIssues.clear();
			currentSessionId = nextSessionId;
			connected = nextSessionId !== undefined;
			invalidate = context.invalidate;
			statusSource = latestSource?.sessionId === nextSessionId ? latestSource : undefined;
			if (nextSessionId) {
				pi.events.emit(FOOTER_STATUS_SOURCE_REQUEST_EVENT, { version: 1, sessionId: nextSessionId });
			}
			context.signal.addEventListener("abort", () => {
				if (generation !== connectionGeneration) return;
				connected = false;
				statusSource = undefined;
			}, { once: true });
			return () => {
				if (generation !== connectionGeneration) return;
				connected = false;
				statusSource = undefined;
			};
		},
		render({ height, theme }) {
			return renderIntegrationLines(statusSource, mcpIssues, height, theme);
		},
	};
}
