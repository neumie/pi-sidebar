import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
	SidebarPanel,
	SidebarPanelRenderContext,
} from "../src/api.ts";
import {
	NarrowSidebarComponent,
	sanitizeSidebarLine,
	SidebarComponent,
	type NarrowSidebarPosition,
	type SidebarPresentation,
} from "../src/render.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function component(
	panels: SidebarPanel[],
	height = 12,
	presentation: SidebarPresentation = "dock",
): SidebarComponent {
	const result = new SidebarComponent({
		theme,
		getPanels: () => panels,
		getTerminalHeight: () => height,
		getPresentation: () => presentation,
	});
	result.setPresentation(presentation);
	return result;
}

function assertMinimalRail(lines: string[], width: number): void {
	assert.ok(lines.every((line) => visibleWidth(line) === width));
	assert.ok(lines.every((line) => line.startsWith("│")));
	assert.doesNotMatch(lines.join("\n"), /[╭╮╰╯─]/);
}

function assertNarrowShelf(
	lines: string[],
	width: number,
	position: NarrowSidebarPosition,
): void {
	assert.ok(lines.every((line) => visibleWidth(line) === width));
	const content = position === "top" ? lines.slice(0, -1) : lines.slice(1);
	assert.ok(content.every((line) => !line.startsWith("│")));
	assert.doesNotMatch(content.join("\n"), /[╭╮╰╯─]/);
	assert.equal(position === "top" ? lines.at(-1) : lines[0], "─".repeat(width));
}

describe("SidebarComponent", () => {
	it("renders a Helm-inspired single rail with exact provider geometry", () => {
		const contexts: Array<{ id: string; context: SidebarPanelRenderContext }> = [];
		const panels: SidebarPanel[] = [
			{
				id: "example.second",
				title: "Second panel",
				order: 20,
				render: (context) => {
					contexts.push({ id: "second", context });
					return ["three"];
				},
			},
			{
				id: "example.first",
				title: "First panel",
				order: 10,
				render: (context) => {
					contexts.push({ id: "first", context });
					return ["one", "two"];
				},
			},
		];
		const lines = component(panels).render(34);

		assert.equal(lines.length, 12);
		assertMinimalRail(lines, 34);
		assert.equal(lines[0], `│${" ".repeat(33)}`);
		assert.match(lines[1]!, /^│  First panel/);
		assert.match(lines[2]!, /^│    one/);
		assert.match(lines[3]!, /^│    two/);
		assert.equal(lines[4], `│${" ".repeat(33)}`);
		assert.match(lines[5]!, /^│  Second panel/);
		assert.match(lines[6]!, /^│    three/);
		assert.doesNotMatch(lines.join("\n"), /│  Activity/);
		assert.match(lines.at(-1)!, /^│  \/sidebar/);
		assert.deepEqual(
			contexts.map(({ id, context }) => ({
				id,
				width: context.width,
				height: context.height,
			})),
			[
				{ id: "first", width: 28, height: 9 },
				{ id: "second", width: 28, height: 5 },
			],
		);
		assert.equal(contexts[0]?.context.now, contexts[1]?.context.now);
	});

	it("centers the empty state within the dock", () => {
		const lines = component([], 12).render(42);
		const blank = `│${" ".repeat(41)}`;

		assert.equal(lines.length, 12);
		assertMinimalRail(lines, 42);
		assert.ok(lines.slice(0, 4).every((line) => line === blank));
		assert.match(lines[4]!, /^│ {14}No active work/);
		assert.match(lines[5]!, /^│ {4}Start a subagent or background job/);
		assert.ok(lines.slice(6, 11).every((line) => line === blank));
		assert.match(lines[11]!, /^│  \/sidebar/);
	});

	it("hides empty, whitespace-only, and SGR-only panels", () => {
		const panels: SidebarPanel[] = [
			{ id: "example.empty", title: "Empty", render: () => [] },
			{ id: "example.space", title: "Whitespace", render: () => ["  ", "\x1b[31m\x1b[0m"] },
		];
		const output = component(panels, 8).render(30).join("\n");
		assert.match(output, /No active work/);
		assert.match(output, /Start a subagent or bac/);
		assert.doesNotMatch(output, /Empty|Whitespace/);
	});

	it("isolates throwing and malformed panels and continues rendering", () => {
		const failing: SidebarPanel = {
			id: "example.fail",
			title: "Fail",
			render: () => { throw new Error("boom"); },
		};
		const malformed = {
			id: "example.malformed",
			title: "Malformed",
			render: () => null,
		} as unknown as SidebarPanel;
		const trappedArray = new Proxy([], {
			get(target, property, receiver) {
				if (property === "length") throw new Error("length trap");
				return Reflect.get(target, property, receiver);
			},
		});
		const trapped: SidebarPanel = {
			id: "example.trapped",
			title: "Trapped",
			render: () => trappedArray,
		};
		const throwingElement: SidebarPanel = {
			id: "example.element",
			title: "Element",
			render: () => [{ toString() { throw new Error("element trap"); } }] as unknown as string[],
		};
		const healthy: SidebarPanel = {
			id: "example.ok",
			title: "Healthy",
			render: () => ["ready"],
		};
		const lines = component([failing, malformed, trapped, throwingElement, healthy], 24).render(40);
		const output = lines.join("\n");
		assertMinimalRail(lines, 40);
		assert.match(output, /Unavailable · boom/);
		assert.match(output, /panel render must r/);
		assert.match(output, /length trap/);
		assert.match(output, /element trap/);
		assert.match(output, /Healthy/);
		assert.match(output, /ready/);
	});

	it("never exceeds tiny terminal heights", () => {
		assert.deepEqual(component([], 0).render(30), []);
		for (const height of [1, 2, 3, 4]) {
			const lines = component([], height).render(30);
			assert.equal(lines.length, height);
			assertMinimalRail(lines, 30);
		}
		assert.doesNotMatch(component([], 1).render(30).join("\n"), /\/sidebar/);
		assert.match(component([], 2).render(30).at(-1) ?? "", /\/sidebar/);
	});

	it("caps overlay height while keeping a compact empty state", () => {
		const busy: SidebarPanel = {
			id: "example.busy",
			title: "Busy",
			render: () => Array.from({ length: 24 }, (_, index) => `line ${index + 1}`),
		};
		const busyLines = component([busy], 40, "overlay").render(34);
		assert.equal(busyLines.length, 26);
		assertMinimalRail(busyLines, 34);

		const emptyLines = component([], 40, "overlay").render(34);
		assert.equal(emptyLines.length, 4);
		assertMinimalRail(emptyLines, 34);
		assert.match(emptyLines.join("\n"), /No active work/);
	});

	it("keeps exact widths and uses the dim theme color for the rail", () => {
		const dividerColors: string[] = [];
		const ansiTheme = {
			fg: (color: string, text: string) => {
				if (text === "│") dividerColors.push(color);
				return `\x1b[38;5;8m${text}\x1b[0m`;
			},
			bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		} as unknown as Theme;
		const sidebar = new SidebarComponent({
			theme: ansiTheme,
			getPanels: () => [{
				id: "example.ansi",
				title: "Styled",
				render: () => [ansiTheme.fg("accent", "● active")],
			}],
			getTerminalHeight: () => 8,
			getPresentation: () => "dock",
		});
		const lines = sidebar.render(32);
		assert.equal(lines.length, 8);
		assert.ok(lines.every((line) => visibleWidth(line) === 32));
		assert.deepEqual([...new Set(dividerColors)], ["dim"]);
	});

	it("preserves SGR but removes every other terminal control family", () => {
		assert.equal(sanitizeSidebarLine("safe\x1b[31m red\x1b[0m"), "safe\x1b[31m red\x1b[0m");
		assert.equal(sanitizeSidebarLine("safe\x1b[2J text\x1b]0;title\x07"), "safe text");
		assert.equal(sanitizeSidebarLine("a\x1bPpayload\x1b\\b\x1b_hidden\x1b\\c"), "abc");
		assert.equal(sanitizeSidebarLine("a\x1b"), "a");
		assert.equal(sanitizeSidebarLine("a\x90payload\x9cb"), "ab");
	});
});

describe("NarrowSidebarComponent", () => {
	function narrowComponent(
		panels: SidebarPanel[],
		position: NarrowSidebarPosition = "top",
		testTheme: Theme = theme,
	): NarrowSidebarComponent {
		return new NarrowSidebarComponent({
			theme: testTheme,
			getPanels: () => panels,
			getTerminalHeight: () => 40,
			getRows: () => 8,
			getPosition: () => position,
		});
	}

	it("stacks panels in one column even when the narrow shelf is wide", () => {
		const contexts: Array<{ id: string; context: SidebarPanelRenderContext }> = [];
		const panels: SidebarPanel[] = [
			{
				id: "example.subagents",
				title: "Subagents",
				order: 10,
				render: (context) => {
					contexts.push({ id: "subagents", context });
					return ["● reviewer", "2 tools · 18s"];
				},
			},
			{
				id: "example.jobs",
				title: "Background jobs",
				order: 20,
				render: (context) => {
					contexts.push({ id: "jobs", context });
					return ["● Typecheck", "1 running"];
				},
			},
		];
		const lines = narrowComponent(panels).render(80);
		assert.equal(lines.length, 8);
		assertNarrowShelf(lines, 80, "top");
		assert.match(lines[0]!, /^  Subagents/);
		assert.match(lines[1]!, /^    ● reviewer/);
		assert.match(lines[2]!, /^    2 tools · 18s/);
		assert.equal(lines[3], " ".repeat(80));
		assert.match(lines[4]!, /^  Background jobs/);
		assert.match(lines[5]!, /^    ● Typecheck/);
		assert.match(lines[6]!, /^    1 running/);
		assert.deepEqual(
			contexts.map(({ id, context }) => ({ id, width: context.width, height: context.height })),
			[
				{ id: "subagents", width: 75, height: 2 },
				{ id: "jobs", width: 75, height: 2 },
			],
		);
		assert.equal(contexts[0]?.context.now, contexts[1]?.context.now);
	});

	it("stacks the same panels in one column on narrower terminals", () => {
		const panels: SidebarPanel[] = [
			{ id: "example.subagents", title: "Subagents", order: 10, render: () => ["● reviewer", "18s"] },
			{ id: "example.jobs", title: "Background jobs", order: 20, render: () => ["● Typecheck"] },
		];
		const lines = narrowComponent(panels).render(60);
		assert.equal(lines.length, 8);
		assertNarrowShelf(lines, 60, "top");
		assert.match(lines[0]!, /^  Subagents/);
		assert.match(lines[1]!, /^    ● reviewer/);
		assert.equal(lines[3], " ".repeat(60));
		assert.match(lines[4]!, /^  Background jobs/);
		assert.match(lines[5]!, /^    ● Typecheck/);
	});

	it("moves the divider above content in bottom position", () => {
		const panels: SidebarPanel[] = [
			{ id: "example.subagents", title: "Subagents", render: () => ["● reviewer"] },
		];
		const lines = narrowComponent(panels, "bottom").render(60);
		assert.equal(lines.length, 8);
		assertNarrowShelf(lines, 60, "bottom");
		assert.match(lines[1]!, /^  Subagents/);
		assert.match(lines[2]!, /^    ● reviewer/);
	});

	it("does not change layout at the former two-column threshold", () => {
		const panels: SidebarPanel[] = [
			{ id: "one", title: "First panel", render: () => ["first", "detail"] },
			{ id: "two", title: "Second panel", render: () => ["second", "detail"] },
		];
		for (const width of [71, 72, 120]) {
			const lines = narrowComponent(panels).render(width);
			assert.match(lines[0]!, /First panel/);
			assert.doesNotMatch(lines[0]!, /Second panel/);
			assert.match(lines[4]!, /Second panel/);
		}
	});

	it("centers an empty directive state with the odd spare row below", () => {
		const topLines = narrowComponent([]).render(60);
		assert.equal(topLines.length, 8);
		assertNarrowShelf(topLines, 60, "top");
		assert.ok(topLines.slice(0, 2).every((line) => line.trim() === ""));
		assert.match(topLines[2]!, /No active work/);
		assert.match(topLines[3]!, /Start a subagent or background job/);
		assert.ok(topLines.slice(4, 7).every((line) => line.trim() === ""));

		const bottomLines = narrowComponent([], "bottom").render(60);
		assert.equal(bottomLines.length, 8);
		assertNarrowShelf(bottomLines, 60, "bottom");
		assert.ok(bottomLines.slice(1, 3).every((line) => line.trim() === ""));
		assert.match(bottomLines[3]!, /No active work/);
		assert.match(bottomLines[4]!, /Start a subagent or background job/);
		assert.ok(bottomLines.slice(5).every((line) => line.trim() === ""));
	});

	it("uses the dim theme color for either structural divider", () => {
		const dividerColors: string[] = [];
		const ansiTheme = {
			fg: (color: string, text: string) => {
				if (text === "─".repeat(60)) dividerColors.push(color);
				return text;
			},
			bold: (text: string) => text,
		} as unknown as Theme;
		assertNarrowShelf(narrowComponent([], "top", ansiTheme).render(60), 60, "top");
		assertNarrowShelf(narrowComponent([], "bottom", ansiTheme).render(60), 60, "bottom");
		assert.deepEqual(dividerColors, ["dim", "dim"]);
	});
});
