import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type Component,
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
const ESC = "\x1b";
const BEL = "\x07";
const C1_ST = "\x9c";
const STRING_CONTROL_INTRODUCERS = new Set(["]", "P", "_", "^", "X"]);
const C1_STRING_CONTROL_CODES = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
const SAFE_SGR = /^\x1b\[[0-9:;]*m$/;

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
	return (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id);
}

function bounded(text: string, width: number, pad = false): string {
	return truncateToWidth(sanitizeSidebarLine(text), Math.max(0, width), "…", pad);
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

	render(width: number): string[] {
		if (width < 12) return [];
		const terminalHeight = Math.max(3, this.options.getTerminalHeight());
		const presentation = this.presentation ?? this.options.getPresentation();
		const height = presentation === "dock" ? terminalHeight : Math.min(terminalHeight, 26);
		const innerWidth = width - 2;
		const contentWidth = Math.max(1, innerWidth - 3);
		const theme = this.options.theme;
		const border = (text: string) => theme.fg("border", text);
		const row = (content = "") => `${border("│")}${bounded(` ${content}`, innerWidth, true)}${border("│")}`;
		const lines: string[] = [];
		const title = presentation === "dock" ? " PI SIDEBAR · DOCK " : " PI SIDEBAR · OVERLAY ";
		const titleText = bounded(title, innerWidth);
		lines.push(`${border("╭")}${theme.fg("accent", theme.bold(titleText))}${border("─".repeat(Math.max(0, innerWidth - titleText.length)) + "╮")}`);

		let renderedPanels = 0;
		const availableBodyRows = Math.max(1, height - 3);
		for (const panel of [...this.options.getPanels()].sort(panelOrder)) {
			const separatorRows = renderedPanels > 0 ? 1 : 0;
			const remainingBodyRows = availableBodyRows - (lines.length - 1) - separatorRows - 1;
			if (remainingBodyRows <= 0) break;
			let panelLines: readonly string[];
			try {
				const rendered = panel.render({
					width: contentWidth,
					height: remainingBodyRows,
					theme,
					now: Date.now(),
				});
				if (!Array.isArray(rendered)) throw new TypeError("panel render must return an array of lines");
				panelLines = rendered;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				panelLines = [theme.fg("error", `unavailable: ${message}`)];
			}
			const body = [...panelLines]
				.slice(0, MAX_PANEL_LINES)
				.map((line) => bounded(line, contentWidth))
				.filter((line) => line.length > 0);
			if (body.length === 0) continue;
			if (renderedPanels > 0) lines.push(row(theme.fg("dim", "─".repeat(contentWidth))));
			lines.push(row(theme.fg("accent", theme.bold(panel.title))));
			for (const bodyLine of body) {
				if (lines.length - 1 >= availableBodyRows) break;
				lines.push(row(`  ${bodyLine}`));
			}
			renderedPanels += 1;
		}

		if (renderedPanels === 0) lines.push(row(theme.fg("dim", "No active work")));
		const hint = theme.fg("dim", "/sidebar · /sidebar status");
		if (presentation === "dock") {
			while (lines.length < height - 2) lines.push(row());
		}
		if (lines.length < height - 1) lines.push(row(hint));
		if (lines.length > height - 1) lines.length = height - 1;
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}
}
