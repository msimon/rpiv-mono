import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_HEARTBEAT_MS, getBlockingTools, getHeartbeatMs } from "./config.js";
import {
	buildIdlePromptPayload,
	buildPromptSubmitPayload,
	buildQuestionAskedPayload,
	buildSessionStartPayload,
	buildStopPayload,
	buildToolCompletePayload,
	lastAssistantText,
	lastUserText,
	serializePayload,
	type WarpPayload,
} from "./payload.js";
import { detectWarpEnvironment } from "./protocol.js";
import { startSpinner, stopSpinner } from "./title-spinner.js";
import { writeOSC777 } from "./warp-notify.js";

// ---------------------------------------------------------------------------
// Module-level timer state — __resetState() clears for test isolation
// ---------------------------------------------------------------------------

interface PendingBlockingCall {
	readonly toolName: string;
	readonly input?: Record<string, unknown>;
}

let pendingQuery = "";
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
let heartbeatMs = DEFAULT_HEARTBEAT_MS;
// Outstanding blocking-tool calls keyed by toolCallId. Populated on `tool_call`,
// drained on `tool_execution_end`. An ESC/abort during a blocking tool never
// fires `tool_execution_end`, so entries linger here until `agent_end` drains
// them — that drain is what clears Warp's stale "Blocked" badge.
const pendingBlockingCalls = new Map<string, PendingBlockingCall>();

export function __resetState(): void {
	pendingQuery = "";
	if (idleTimer !== undefined) {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	}
	if (heartbeatInterval !== undefined) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = undefined;
	}
	heartbeatMs = DEFAULT_HEARTBEAT_MS;
	pendingBlockingCalls.clear();
}

const TITLE = "warp://cli-agent";

function emit(payload: WarpPayload): void {
	writeOSC777(TITLE, serializePayload(payload));
}

function cancelIdleTimer(): void {
	if (idleTimer !== undefined) {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	}
}

function startIdleTimer(ctx: ExtensionContext, branch: SessionEntry[]): void {
	cancelIdleTimer();
	idleTimer = setTimeout(() => {
		idleTimer = undefined;
		const summary = lastAssistantText(branch);
		emit(buildIdlePromptPayload(ctx, summary));
	}, 300);
	if (typeof (idleTimer as ReturnType<typeof setTimeout>).unref === "function") {
		(idleTimer as ReturnType<typeof setTimeout>).unref();
	}
}

function startHeartbeat(ctx: ExtensionContext, ms: number): void {
	stopHeartbeat();
	if (ms <= 0) return; // disabled
	heartbeatInterval = setInterval(() => {
		emit(buildPromptSubmitPayload(ctx, pendingQuery));
	}, ms);
	if (typeof heartbeatInterval.unref === "function") {
		heartbeatInterval.unref();
	}
}

function stopHeartbeat(): void {
	if (heartbeatInterval !== undefined) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = undefined;
	}
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
	return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined;
}

function captureBlockingCall(toolCallId: string, toolName: string, input: unknown): void {
	pendingBlockingCalls.set(toolCallId, { toolName, input: asRecord(input) });
}

function consumeBlockingCall(toolCallId: string): PendingBlockingCall | undefined {
	const call = pendingBlockingCalls.get(toolCallId);
	pendingBlockingCalls.delete(toolCallId);
	return call;
}

function readBranch(ctx: ExtensionContext): SessionEntry[] {
	return ctx.sessionManager.getBranch() as SessionEntry[];
}

// Mirror Pi's startup tab title `<mascot> - <repo>`. We only own the first
// character (the spinner glyph during animation); push/pop restores Pi's
// mascot verbatim on stop.
function titleSuffix(ctx: ExtensionContext): string {
	return ` - ${basename(ctx.cwd)}`;
}

export default function (pi: ExtensionAPI): void {
	const warp = detectWarpEnvironment();
	if (!warp.isWarp || !warp.supportsStructured) return;

	const blockingTools = getBlockingTools();
	heartbeatMs = getHeartbeatMs();

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		emit(buildSessionStartPayload(ctx));
	});

	pi.on("before_agent_start", async (event) => {
		pendingQuery = event.prompt ?? "";
	});

	pi.on("agent_start", async (_event, ctx) => {
		emit(buildSessionStartPayload(ctx)); // Item 2: defensive re-announce
		// Prefer the branch's last user-attributed entry so a skill invocation
		// renders as `/skill:<name> <args>` (from the skill-prompt entry's
		// details) rather than the expanded prompt body. Falls back to the raw
		// before_agent_start prompt for turns with no user entry (e.g. synthetic).
		const branchQuery = lastUserText(readBranch(ctx));
		if (branchQuery.length > 0) pendingQuery = branchQuery;
		emit(buildPromptSubmitPayload(ctx, pendingQuery));
		startSpinner(titleSuffix(ctx));
		cancelIdleTimer(); // Item 3: cancel pending idle from previous turn
		startHeartbeat(ctx, heartbeatMs); // Item 4: heartbeat
	});

	pi.on("agent_end", async (_event, ctx) => {
		// ESC/abort during a blocking tool never fires `tool_execution_end`, so the
		// "Blocked" badge would stay stale. Drain any outstanding blocking calls
		// (emit `tool_complete` for each) to unblock before announcing the stop.
		for (const [, call] of pendingBlockingCalls) {
			emit(buildToolCompletePayload(ctx, call.toolName, call.input));
		}
		pendingBlockingCalls.clear();
		emit(buildStopPayload(ctx, readBranch(ctx)));
		stopSpinner();
		stopHeartbeat(); // Item 4: stop heartbeat
		startIdleTimer(ctx, readBranch(ctx)); // Item 3: schedule idle_prompt after 300ms
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!blockingTools.has(event.toolName)) return;
		captureBlockingCall(event.toolCallId, event.toolName, event.input); // Item 6: capture input
		emit(buildQuestionAskedPayload(ctx));
		stopSpinner();
		stopHeartbeat(); // Item 4: pause heartbeat
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!blockingTools.has(event.toolName)) return;
		const pending = consumeBlockingCall(event.toolCallId); // Item 6: consume input
		emit(buildToolCompletePayload(ctx, event.toolName, pending?.input));
		startSpinner(titleSuffix(ctx));
		startHeartbeat(ctx, heartbeatMs); // Item 4: resume heartbeat
	});

	pi.on("session_shutdown", async () => {
		cancelIdleTimer();
		stopHeartbeat();
		pendingQuery = "";
		pendingBlockingCalls.clear();
		stopSpinner();
	});
}
