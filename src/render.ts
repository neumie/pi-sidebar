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

const MAX_PANEL_LINES = 24;
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

function hasVisibleContent(value: unknown): boolean {
	const plain = sanitizeSidebarLine(value).replace(SGR, "").trim();
	return plain.length > 0 && visibleWidth(plain) > 0;
}

function normalizedSize(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
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

		const contentWidth = Math.max(
			0,
			width - DIVIDER_WIDTH - LEFT_PADDING - RIGHT_PADDING,
		);
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

			let title = "Panel";
			let body: string[] = [];
			try {
				title = bounded(panel.title, contentWidth) || title;
				const rendered = panel.render({
					width: bodyWidth,
					height: remainingBodyRows,
					theme,
					now,
				});
				if (!Array.isArray(rendered)) throw new TypeError("panel render must return an array of lines");
				const lineCount = Math.min(rendered.length, remainingBodyRows);
				for (let index = 0; index < lineCount; index += 1) {
					const line = bounded(rendered[index], bodyWidth);
					if (hasVisibleContent(line)) body.push(line);
				}
			} catch (error) {
				body = [bounded(theme.fg("error", `Unavailable · ${errorMessage(error)}`), bodyWidth)];
			}
			if (body.length === 0) continue;

			if (renderedPanels > 0) lines.push(row());
			lines.push(row(theme.fg("muted", theme.bold(title))));
			for (const bodyLine of body) lines.push(row(bodyLine, BODY_INDENT));
			renderedPanels += 1;
		}

		if (renderedPanels === 0 && lines.length < panelLimit) {
			lines.push(row(theme.fg("muted", theme.bold("No active work"))));
			if (lines.length < panelLimit) {
				lines.push(row(theme.fg("dim", "Start a subagent or background job"), BODY_INDENT));
			}
		}
		if (presentation === "dock") {
			while (lines.length < panelLimit) lines.push(row());
		}
		if (hasHint && lines.length < height) {
			lines.push(row(theme.fg("dim", "/sidebar")));
		}
		if (lines.length > height) lines.length = height;
		return lines;
	}
}
