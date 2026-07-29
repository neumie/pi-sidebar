export const POST_FOOTER_SLOT_REQUEST_EVENT =
	"pi-footer:post-footer:v1:request";
export const POST_FOOTER_SLOT_READY_EVENT = "pi-footer:post-footer:v1:ready";

const MAX_SESSION_ID_LENGTH = 1_024;
const MAX_CAPABILITY_TOKEN_LENGTH = 128;

export interface PostFooterSlot {
	id: string;
	token: string;
	order: number;
	maxRows: number;
	render(width: number): readonly string[];
}

export interface PostFooterSlotHandle {
	isActive(): boolean;
	dispose(): void;
}

export interface PostFooterSlotReadyPayload {
	version: 1;
	sessionId: string;
	token: string;
	register(slot: PostFooterSlot): PostFooterSlotHandle | undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function parseHandle(value: unknown): PostFooterSlotHandle | undefined {
	try {
		const source = object(value);
		if (
			!source ||
			typeof source.isActive !== "function" ||
			typeof source.dispose !== "function"
		) return undefined;
		const isActive = source.isActive;
		const dispose = source.dispose;
		let disposed = false;
		return Object.freeze({
			isActive: () => {
				if (disposed) return false;
				try {
					return isActive.call(source) === true;
				} catch {
					return false;
				}
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				try {
					dispose.call(source);
				} catch {
					// A stale footer generation must not break sidebar teardown.
				}
			},
		});
	} catch {
		return undefined;
	}
}

export function parsePostFooterSlotReady(
	value: unknown,
): PostFooterSlotReadyPayload | undefined {
	try {
		const source = object(value);
		if (
			source?.version !== 1 ||
			typeof source.sessionId !== "string" ||
			source.sessionId.length === 0 ||
			source.sessionId.length > MAX_SESSION_ID_LENGTH ||
			typeof source.token !== "string" ||
			source.token.length === 0 ||
			source.token.length > MAX_CAPABILITY_TOKEN_LENGTH ||
			typeof source.register !== "function"
		) return undefined;
		const register = source.register;
		return Object.freeze({
			version: 1 as const,
			sessionId: source.sessionId,
			token: source.token,
			register: (slot: PostFooterSlot) => {
				try {
					return parseHandle(register.call(source, slot));
				} catch {
					return undefined;
				}
			},
		});
	} catch {
		return undefined;
	}
}
