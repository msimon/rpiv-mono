import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function makeUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export interface AssistantMessageInput {
	text?: string;
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export function makeAssistantMessage(input: AssistantMessageInput): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (input.text) content.push({ type: "text", text: input.text });
	for (const tc of input.toolCalls ?? []) {
		content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments });
	}
	return { role: "assistant", content, timestamp: Date.now() } as unknown as AssistantMessage;
}

export interface ToolResultInput {
	toolCallId?: string;
	toolName: string;
	text?: string;
	details?: unknown;
	isError?: boolean;
}

export function makeToolResult(input: ToolResultInput): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: input.toolCallId ?? `call-${input.toolName}-${Date.now()}`,
		toolName: input.toolName,
		content: input.text ? [{ type: "text", text: input.text }] : [],
		details: input.details,
		isError: input.isError ?? false,
		timestamp: Date.now(),
	} as unknown as ToolResultMessage;
}

export function makeMessageEntry(message: Message): SessionEntry {
	return { type: "message", message } as unknown as SessionEntry;
}

export interface SkillPromptInput {
	name: string;
	args?: string;
	content?: string;
	path?: string;
	lineCount?: number;
}

/**
 * Build a `custom_message` entry with customType "skill-prompt" — the shape
 * oh-my-pi persists for a `/skill:<name>` invocation. `content` holds the
 * expanded skill body (model-facing); `details` carries the compact
 * { name, args } a renderer should surface instead.
 */
export function makeSkillPromptEntry(input: SkillPromptInput): SessionEntry {
	return {
		type: "custom_message",
		customType: "skill-prompt",
		content: input.content ?? `<expanded ${input.name} skill body>`,
		details: {
			name: input.name,
			path: input.path ?? `/abs/${input.name}/SKILL.md`,
			args: input.args,
			lineCount: input.lineCount ?? 1,
		},
		display: true,
		attribution: "user",
	} as unknown as SessionEntry;
}

export function buildSessionEntries(messages: Message[]): SessionEntry[] {
	return messages.map(makeMessageEntry);
}

export function buildLlmMessages(messages: Message[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

export function makeTodoToolResult(details: unknown, text = "ok"): ToolResultMessage {
	return makeToolResult({ toolName: "todo", text, details });
}

export function makeInflightAdvisorAssistant(): AssistantMessage {
	return makeAssistantMessage({
		toolCalls: [{ id: "advisor-inflight", name: "advisor", arguments: {} }],
	});
}
