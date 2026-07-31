import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSidebarPanel } from "../src/api.ts";
import { createBackgroundJobsPanel } from "../src/adapters/background-jobs.ts";
import { createGoalPanel } from "../src/adapters/goals.ts";
import { createIntegrationsPanel } from "../src/adapters/integrations.ts";
import { createSubagentsPanel } from "../src/adapters/subagents.ts";
import { SidebarController } from "../src/controller.ts";

export default function sidebar(pi: ExtensionAPI): void {
	new SidebarController(pi).register();
	registerSidebarPanel(pi, createGoalPanel(pi));
	registerSidebarPanel(pi, createSubagentsPanel(pi));
	registerSidebarPanel(pi, createIntegrationsPanel(pi));
	registerSidebarPanel(pi, createBackgroundJobsPanel(pi));
}
