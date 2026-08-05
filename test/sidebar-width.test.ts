import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { responsiveSidebarWidth } from "../src/sidebar-width.ts";

describe("responsiveSidebarWidth", () => {
	it("grows through bounded four-column steps on wide terminals", () => {
		for (const [terminalWidth, sidebarWidth] of [
			[0, 42],
			[159, 42],
			[160, 46],
			[191, 46],
			[192, 50],
			[223, 50],
			[224, 54],
			[255, 54],
			[256, 58],
			[400, 58],
		] as const) {
			assert.equal(responsiveSidebarWidth(terminalWidth), sidebarWidth);
		}
	});

	it("uses the base width for invalid terminal geometry", () => {
		assert.equal(responsiveSidebarWidth(Number.NaN), 42);
		assert.equal(responsiveSidebarWidth(Number.POSITIVE_INFINITY), 42);
	});
});
