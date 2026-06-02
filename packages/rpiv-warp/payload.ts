/**
 * rpiv-warp — Warp structured-payload composition.
 *
 * Pure data transforms: branch -> text extraction -> envelope -> JSON.
 * No I/O. One small named function per concern; build* composers assemble
 * them at the call sites consumed by `index.ts`.
 */

import { basename } from "node:path";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { negotiateProtocolVersion, type WarpEvent } from "./protocol.js";

// ---------------------------------------------------------------------------
// Constants — single definition site for tunables
// ---------------------------------------------------------------------------

/**
 * Warp's `CLIAgent::Pi` is routed to `DefaultSessionListener` since Warp's
 * open-source release (warpdotdev/warp `listener/mod.rs:93-99`).
 */
export const AGENT_ID = "pi";
export const TRUNCATE_LIMIT = 200;

// ---------------------------------------------------------------------------
// Types — base envelope + per-event extras
// ---------------------------------------------------------------------------

export interface WarpPayloadBase {
	readonly v: number;
	readonly agent: string;
	readonly event: WarpEvent;
	readonly session_id: string;
	readonly cwd: string;
	readonly project: string;
}

export interface StopExtras {
	readonly query: string;
	readonly response: string;
}
export interface IdlePromptExtras {
	readonly summary: string;
}
export interface PromptSubmitExtras {
	readonly query: string;
}
export interface ToolCompleteExtras {
	readonly tool_name: string;
	readonly tool_input?: Record<string, unknown>;
}

export type WarpPayload = WarpPayloadBase &
	Partial<StopExtras & IdlePromptExtras & PromptSubmitExtras & ToolCompleteExtras>;

// ---------------------------------------------------------------------------
// Text helpers — small, single-purpose, composable
// ---------------------------------------------------------------------------

export function truncate(s: string, max: number = TRUNCATE_LIMIT): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 3)}...`;
}

export function projectName(cwd: string): string {
	return basename(cwd);
}

/**
 * Extract plain text from a UserMessage.content (string | array) OR an
 * AssistantMessage.content (always array). Filters to TextContent entries.
 */
export function extractMessageText(content: UserMessage["content"] | AssistantMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/**
 * oh-my-pi persists a `/skill:<name>` invocation as a `custom_message` entry
 * (customType "skill-prompt") whose `content` is the fully expanded skill body
 * but whose `details` carries the compact { name, args } the user actually
 * typed. Read the latter so the toast shows `/skill:<name> <args>` instead of
 * dumping the expanded prompt. The entry shape is oh-my-pi-specific; the guard
 * is duck-typed and simply never matches on other Pi builds, where it falls
 * through to plain message text.
 */
interface SkillPromptDetails {
	readonly name: string;
	readonly args?: string;
}

function readSkillPromptDetails(entry: SessionEntry): SkillPromptDetails | undefined {
	// Cross-fork boundary: the `custom_message`/`skill-prompt` shape is oh-my-pi-
	// specific and absent from upstream Pi's `SessionEntry` union, so widen via
	// `unknown` and read the fields defensively below.
	const record = entry as unknown as Record<string, unknown>;
	if (record.type !== "custom_message" || record.customType !== "skill-prompt") return undefined;
	const details = record.details;
	if (typeof details !== "object" || details === null) return undefined;
	const name = (details as { name?: unknown }).name;
	if (typeof name !== "string" || name.length === 0) return undefined;
	const rawArgs = (details as { args?: unknown }).args;
	return { name, args: typeof rawArgs === "string" && rawArgs.length > 0 ? rawArgs : undefined };
}

// ---------------------------------------------------------------------------
// Branch traversal — reverse-scan filtered branch for last user/assistant text
// ---------------------------------------------------------------------------

function isMessageEntry(entry: SessionEntry): entry is SessionEntry & { type: "message" } {
	return entry.type === "message";
}

function findLastMessageText(branch: SessionEntry[], role: "user" | "assistant"): string {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (role === "user") {
			const skill = readSkillPromptDetails(entry);
			if (skill) return truncate(skill.args ? `/skill:${skill.name} ${skill.args}` : `/skill:${skill.name}`);
		}
		if (!isMessageEntry(entry)) continue;
		const message = entry.message;
		if (message.role !== role) continue;
		const text = extractMessageText((message as UserMessage | AssistantMessage).content);
		if (text.length > 0) return truncate(text);
	}
	return "";
}

export function lastUserText(branch: SessionEntry[]): string {
	return findLastMessageText(branch, "user");
}

export function lastAssistantText(branch: SessionEntry[]): string {
	return findLastMessageText(branch, "assistant");
}

// ---------------------------------------------------------------------------
// Envelope — common fields for every Warp event
// ---------------------------------------------------------------------------

export function baseEnvelope(event: WarpEvent, ctx: ExtensionContext): WarpPayloadBase {
	const cwd = ctx.cwd;
	return {
		v: negotiateProtocolVersion(),
		agent: AGENT_ID,
		event,
		session_id: ctx.sessionManager.getSessionId(),
		cwd,
		project: projectName(cwd),
	};
}

// ---------------------------------------------------------------------------
// Builders — one per Warp event; composition is linear and named
// ---------------------------------------------------------------------------

export function buildSessionStartPayload(ctx: ExtensionContext): WarpPayload {
	return baseEnvelope("session_start", ctx);
}

export function buildPromptSubmitPayload(ctx: ExtensionContext, query: string = ""): WarpPayload {
	return {
		...baseEnvelope("prompt_submit", ctx),
		query: truncate(query),
	};
}

export function buildQuestionAskedPayload(ctx: ExtensionContext): WarpPayload {
	return baseEnvelope("question_asked", ctx);
}

export function buildStopPayload(ctx: ExtensionContext, branch: SessionEntry[]): WarpPayload {
	return {
		...baseEnvelope("stop", ctx),
		query: lastUserText(branch),
		response: lastAssistantText(branch),
	};
}

export function buildIdlePromptPayload(ctx: ExtensionContext, summary: string): WarpPayload {
	return {
		...baseEnvelope("idle_prompt", ctx),
		summary,
	};
}

export function buildToolCompletePayload(
	ctx: ExtensionContext,
	toolName: string,
	toolInput?: Record<string, unknown>,
): WarpPayload {
	return {
		...baseEnvelope("tool_complete", ctx),
		tool_name: toolName,
		...(toolInput !== undefined ? { tool_input: toolInput } : {}),
	};
}

// ---------------------------------------------------------------------------
// Serializer — single source of truth so tests can assert on JSON shape
// ---------------------------------------------------------------------------

export function serializePayload(payload: WarpPayload): string {
	return JSON.stringify(payload);
}
