export const DEFAULT_SIDEBAR_WIDTH = 42;
export const MAX_RESPONSIVE_SIDEBAR_WIDTH = 58;

const RESPONSIVE_START_COLUMNS = 160;
const RESPONSIVE_STEP_COLUMNS = 32;
const RESPONSIVE_STEP_WIDTH = 4;
const RESPONSIVE_STEP_COUNT =
	(MAX_RESPONSIVE_SIDEBAR_WIDTH - DEFAULT_SIDEBAR_WIDTH) /
	RESPONSIVE_STEP_WIDTH;

/** Default rail width policy: fixed on ordinary terminals, then bounded steps on wide ones. */
export function responsiveSidebarWidth(terminalWidth: number): number {
	if (!Number.isFinite(terminalWidth)) return DEFAULT_SIDEBAR_WIDTH;
	const width = Math.max(0, Math.floor(terminalWidth));
	if (width < RESPONSIVE_START_COLUMNS) return DEFAULT_SIDEBAR_WIDTH;
	const steps = Math.min(
		RESPONSIVE_STEP_COUNT,
		Math.floor((width - RESPONSIVE_START_COLUMNS) / RESPONSIVE_STEP_COLUMNS) + 1,
	);
	return DEFAULT_SIDEBAR_WIDTH + steps * RESPONSIVE_STEP_WIDTH;
}
