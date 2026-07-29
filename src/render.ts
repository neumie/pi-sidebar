import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type Component,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { SidebarPanel } from "./api.ts";

export type SidebarPresentation = "dock" | "overlay";

export interface SidebarComponentOptions {
	theme: Theme;
	getPanels(): readonly SidebarPanel[];
	getTerminalHeight(): number;
	getPresentation(): SidebarPresentation;
}

export type NarrowSidebarPosition = "top" | "bottom";

export interface NarrowSidebarComponentOptions {
	theme: Theme;
	getPanels(): readonly SidebarPanel[];
	getTerminalHeight(): number;
	getRows(): number;
	/** @deprecated Narrow shelves always render in one column. */
	getTwoColumnMinWidth?(): number;
	getPosition(): NarrowSidebarPosition;
}

const MAX_PANEL_LINES = 24;
const SHELF_PANEL_LINES = 5;
const MAX_SOURCE_CHARS = 4_096;
const MIN_RENDER_WIDTH = 12;
const OVERLAY_MAX_HEIGHT = 26;
const DIVIDER_WIDTH = 1;
const LEFT_PADDING = 2;
const RIGHT_PADDING = 1;
const BODY_INDENT = 2;
const ESC = "\x1b";
const BEL = "\x07";
const C1_ST = "\x9c";
const STRING_CONTROL_INTRODUCERS = new Set(["]", "P", "_", "^", "X"]);
const C1_STRING_CONTROL_CODES = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
const SAFE_SGR = /^\x1b\[[0-9:;]*m$/;
const SGR = /\x1b\[[0-9:;]*m/g;

interface RenderedPanel {
	title: string;
	body: string[];
}

interface CellLine {
	content: string;
	indent?: number;
}

function skipStringControl(input: string, start: number): number {
	for (let index = start; index < input.length; index += 1) {
		if (input[index] === BEL || input[index] === C1_ST) return index + 1;
		if (input[index] === ESC && input[index + 1] === "\\") return index + 2;
	}
	return input.length;
}

function skipCsi(input: string, start: number): { end: number; sequence: string } {
	for (let index = start; index < input.length; index += 1) {
		const code = input.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) {
			return { end: index + 1, sequence: input.slice(start - 2, index + 1) };
		}
	}
	return { end: input.length, sequence: "" };
}

/** Preserve only ordinary text and complete SGR color/style sequences. */
export function sanitizeSidebarLine(value: unknown): string {
	const input = (typeof value === "string" ? value : String(value ?? "")).slice(0, MAX_SOURCE_CHARS);
	let output = "";
	for (let index = 0; index < input.length;) {
		const character = input[index]!;
		const code = input.charCodeAt(index);
		if (character === ESC) {
			const next = input[index + 1];
			if (next === "[") {
				const csi = skipCsi(input, index + 2);
				if (SAFE_SGR.test(csi.sequence)) output += csi.sequence;
				index = csi.end;
				continue;
			}
			if (next && STRING_CONTROL_INTRODUCERS.has(next)) {
				index = skipStringControl(input, index + 2);
				continue;
			}
			index += next === undefined ? 1 : 2;
			continue;
		}
		if (code === 0x9b) {
			index = skipCsi(input, index + 1).end;
			continue;
		}
		if (C1_STRING_CONTROL_CODES.has(code)) {
			index = skipStringControl(input, index + 1);
			continue;
		}
		if (character === "\r" || character === "\n" || character === "\t") {
			output += " ";
			index += 1;
			continue;
		}
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			index += 1;
			continue;
		}
		output += character;
		index += 1;
	}
	return output;
}

function panelOrder(left: SidebarPanel, right: SidebarPanel): number {
	try {
		return (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id);
	} catch {
		return 0;
	}
}

function errorMessage(value: unknown): string {
	try {
		return value instanceof Error ? value.message : String(value);
	} catch {
		return "Unknown panel error";
	}
}

function bounded(value: unknown, width: number, pad = false): string {
	return truncateToWidth(sanitizeSidebarLine(value), Math.max(0, width), "…", pad);
}

function centered(value: unknown, width: number): string {
	const text = bounded(value, width);
	const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
	return bounded(`${" ".repeat(left)}${text}`, width, true);
}

function hasVisibleContent(value: unknown): boolean {
	const plain = sanitizeSidebarLine(value).replace(SGR, "").trim();
	return plain.length > 0 && visibleWidth(plain) > 0;
}

function normalizedSize(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function renderPanel(
	panel: SidebarPanel,
	titleWidth: number,
	bodyWidth: number,
	bodyHeight: number,
	surface: "right" | "narrow",
	theme: Theme,
	now: number,
): RenderedPanel {
	let title = "Panel";
	let body: string[] = [];
	try {
		title = bounded(panel.title, titleWidth) || title;
		const rendered = panel.render({ width: bodyWidth, height: bodyHeight, surface, theme, now });
		if (!Array.isArray(rendered)) throw new TypeError("panel render must return an array of lines");
		const lineCount = Math.min(rendered.length, bodyHeight);
		for (let index = 0; index < lineCount; index += 1) {
			const line = bounded(rendered[index], bodyWidth);
			if (hasVisibleContent(line)) body.push(line);
		}
	} catch (error) {
		body = [bounded(theme.fg("error", `Unavailable · ${errorMessage(error)}`), bodyWidth)];
	}
	return { title, body };
}

export class SidebarComponent implements Component {
	private presentation: SidebarPresentation | undefined;

	constructor(private readonly options: SidebarComponentOptions) {}

	setPresentation(presentation: SidebarPresentation): void {
		this.presentation = presentation;
	}

	invalidate(): void {
		// Rendering is intentionally stateless so theme and provider updates are immediate.
	}

	render(requestedWidth: number): string[] {
		const width = normalizedSize(requestedWidth);
		const terminalHeight = normalizedSize(this.options.getTerminalHeight());
		if (width < MIN_RENDER_WIDTH || terminalHeight === 0) return [];

		const presentation = this.presentation ?? this.options.getPresentation();
		const height = presentation === "dock"
			? terminalHeight
			: Math.min(terminalHeight, OVERLAY_MAX_HEIGHT);
		if (height === 0) return [];

		const contentWidth = Math.max(0, width - DIVIDER_WIDTH - LEFT_PADDING - RIGHT_PADDING);
		const bodyWidth = Math.max(1, contentWidth - BODY_INDENT);
		const theme = this.options.theme;
		const divider = theme.fg("dim", "│");
		const row = (content: unknown = "", indent = 0) => {
			const safeIndent = Math.min(Math.max(0, indent), contentWidth);
			return [
				divider,
				" ".repeat(LEFT_PADDING + safeIndent),
				bounded(content, contentWidth - safeIndent, true),
				" ".repeat(RIGHT_PADDING),
			].join("");
		};

		const lines: string[] = [];
		const hasHint = height >= 2;
		const panelLimit = height - (hasHint ? 1 : 0);
		if (height >= 5 && lines.length < panelLimit) lines.push(row());

		let renderedPanels = 0;
		const now = Date.now();
		for (const panel of [...this.options.getPanels()].sort(panelOrder)) {
			const separatorRows = renderedPanels > 0 ? 1 : 0;
			const remainingBodyRows = Math.min(
				MAX_PANEL_LINES,
				panelLimit - lines.length - separatorRows - 1,
			);
			if (remainingBodyRows <= 0) break;

			const rendered = renderPanel(
				panel,
				contentWidth,
				bodyWidth,
				remainingBodyRows,
				"right",
				theme,
				now,
			);
			if (rendered.body.length === 0) continue;

			if (renderedPanels > 0) lines.push(row());
			lines.push(row(theme.fg("muted", theme.bold(rendered.title))));
			for (const bodyLine of rendered.body) lines.push(row(bodyLine, BODY_INDENT));
			renderedPanels += 1;
		}

		if (renderedPanels === 0 && lines.length < panelLimit) {
			const emptyState = [
				theme.fg("muted", theme.bold("No active work")),
				theme.fg("dim", "Start a subagent or background job"),
			].slice(0, panelLimit);
			if (presentation === "dock") {
				lines.length = 0;
				const topPadding = Math.floor((panelLimit - emptyState.length) / 2);
				while (lines.length < topPadding) lines.push(row());
			}
			for (const content of emptyState) lines.push(row(centered(content, contentWidth)));
		}
		if (presentation === "dock") {
			while (lines.length < panelLimit) lines.push(row());
		}
		if (hasHint && lines.length < height) lines.push(row(theme.fg("dim", "/sidebar")));
		if (lines.length > height) lines.length = height;
		return lines;
	}
}

/** Fixed-height shelf used above or below Pi on narrow, tall terminals. */
export class NarrowSidebarComponent implements Component {
	constructor(private readonly options: NarrowSidebarComponentOptions) {}

	invalidate(): void {
		// Rendering is intentionally stateless.
	}

	render(requestedWidth: number): string[] {
		const width = normalizedSize(requestedWidth);
		const rows = Math.min(
			normalizedSize(this.options.getRows()),
			normalizedSize(this.options.getTerminalHeight()),
		);
		if (width < MIN_RENDER_WIDTH || rows === 0) return [];

		const theme = this.options.theme;
		const position = this.options.getPosition();
		const contentRows = Math.max(0, rows - 1);
		const contentWidth = Math.max(0, width - LEFT_PADDING - RIGHT_PADDING);
		const lines: CellLine[] = [];
		const now = Date.now();
		let renderedPanels = 0;

		for (const panel of [...this.options.getPanels()].sort(panelOrder)) {
			const availableRows = contentRows - lines.length;
			const bodyHeight = Math.min(SHELF_PANEL_LINES, availableRows - 1);
			if (bodyHeight <= 0) break;
			const bodyWidth = Math.max(1, contentWidth - BODY_INDENT);
			const rendered = renderPanel(panel, contentWidth, bodyWidth, bodyHeight, "narrow", theme, now);
			if (rendered.body.length === 0) continue;
			const panelRows = rendered.body.length + 1;
			if (lines.length > 0 && availableRows > panelRows) lines.push({ content: "" });
			lines.push({ content: theme.fg("muted", theme.bold(rendered.title)) });
			for (const bodyLine of rendered.body) lines.push({ content: bodyLine, indent: BODY_INDENT });
			renderedPanels += 1;
		}

		const divider = theme.fg("dim", "─".repeat(width));
		const output: string[] = position === "bottom" ? [divider] : [];
		const contentRow = (content: unknown = "") =>
			`${" ".repeat(LEFT_PADDING)}${bounded(content, contentWidth, true)}${" ".repeat(RIGHT_PADDING)}`;
		if (renderedPanels === 0) {
			const availablePadding = Math.max(0, contentRows - 2);
			const stateRow = Math.floor(availablePadding / 2);
			for (let rowIndex = 0; rowIndex < contentRows; rowIndex += 1) {
				let content = "";
				if (rowIndex === stateRow) {
					content = centered(theme.fg("muted", theme.bold("No active work")), contentWidth);
				}
				if (rowIndex === stateRow + 1) {
					content = centered(theme.fg("dim", "Start a subagent or background job"), contentWidth);
				}
				output.push(contentRow(content));
			}
		} else {
			for (let rowIndex = 0; rowIndex < contentRows; rowIndex += 1) {
				const cell = lines[rowIndex];
				const indent = Math.min(Math.max(0, cell?.indent ?? 0), contentWidth);
				const content = `${" ".repeat(indent)}${bounded(cell?.content ?? "", contentWidth - indent, true)}`;
				output.push(contentRow(content));
			}
		}
		if (position === "top") output.push(divider);
		return output;
	}
}
