import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SidebarPanel } from "../src/api.ts";
import { sanitizeSidebarLine, SidebarComponent } from "../src/render.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function component(panels: SidebarPanel[], height = 12): SidebarComponent {
	const result = new SidebarComponent({
		theme,
		getPanels: () => panels,
		getTerminalHeight: () => height,
		getPresentation: () => "dock",
	});
	result.setPresentation("dock");
	return result;
}

describe("SidebarComponent", () => {
	it("bounds every row and fills the dock height", () => {
		const panel: SidebarPanel = {
			id: "example.long",
			title: "Long values",
			render: () => ["界".repeat(100), "plain"],
		};
		const lines = component([panel]).render(34);
		assert.equal(lines.length, 12);
		assert.ok(lines.every((line) => visibleWidth(line) <= 34));
		assert.match(lines.join("\n"), /Long values/);
	});

	it("isolates throwing and malformed panels and continues rendering", () => {
		const failing: SidebarPanel = { id: "example.fail", title: "Fail", render: () => { throw new Error("boom"); } };
		const malformed = {
			id: "example.malformed",
			title: "Malformed",
			render: () => null,
		} as unknown as SidebarPanel;
		const healthy: SidebarPanel = { id: "example.ok", title: "Healthy", render: () => ["ready"] };
		const output = component([failing, malformed, healthy], 20).render(40).join("\n");
		assert.match(output, /unavailable: boom/);
		assert.match(output, /panel render must ret/);
		assert.match(output, /Healthy/);
		assert.match(output, /ready/);
	});

	it("preserves SGR but removes every other terminal control family", () => {
		assert.equal(sanitizeSidebarLine("safe\x1b[31m red\x1b[0m"), "safe\x1b[31m red\x1b[0m");
		assert.equal(sanitizeSidebarLine("safe\x1b[2J text\x1b]0;title\x07"), "safe text");
		assert.equal(sanitizeSidebarLine("a\x1bPpayload\x1b\\b\x1b_hidden\x1b\\c"), "abc");
		assert.equal(sanitizeSidebarLine("a\x1b"), "a");
		assert.equal(sanitizeSidebarLine("a\x90payload\x9cb"), "ab");
	});
});
