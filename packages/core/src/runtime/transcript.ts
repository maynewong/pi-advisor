import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SubagentTranscriptItem, SubagentTranscriptMessage } from "../types.ts";
import { describeToolCall, thoughtPreview } from "./piSdkDriverSupport.ts";

function preview(value: unknown, limit = 500): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return (text ?? "").slice(0, limit);
}

export function resultTextFromUnknown(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (value && typeof value === "object") {
		const record = value as { content?: unknown; text?: unknown };
		const fromContent = contentText(record.content).trim();
		if (fromContent) return fromContent;
		if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
	}
	const previewed = preview(value).trim();
	return previewed || undefined;
}

export function contentText(content: unknown, includeToolCalls = false): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		if ((part as { type?: string }).type === "text") return [(part as { text?: string }).text ?? ""];
		if ((part as { type?: string }).type === "thinking") return [(part as { thinking?: string }).thinking ?? ""];
		if (includeToolCalls && (part as { type?: string }).type === "toolCall") {
			const call = part as { name?: string; arguments?: unknown };
			return [`→ ${call.name ?? "tool"} ${preview(call.arguments)}`];
		}
		return [];
	}).filter(Boolean).join("\n");
}

function asArgs(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function itemId(kind: string, key: string): string {
	return `${kind}:${key}`;
}

export function itemsFromAgentMessage(
	message: AgentMessage,
	options: { includeTools?: boolean } = {},
): SubagentTranscriptItem[] {
	if (message.role === "user") {
		return [{
			id: itemId("user", String(message.timestamp)),
			kind: "user",
			markdown: contentText(message.content).trim() || "(no text)",
			timestamp: message.timestamp,
		}];
	}
	if (message.role === "assistant") {
		const items: SubagentTranscriptItem[] = [];
		let thinkingIndex = 0;
		let textIndex = 0;
		for (const part of message.content) {
			if (part.type === "thinking") {
				const text = part.thinking ?? "";
				items.push({
					id: itemId("thinking", `${message.timestamp}:${thinkingIndex++}`),
					kind: "thinking",
					summary: thoughtPreview(text) ?? "Thinking",
					text,
					timestamp: message.timestamp,
				});
			} else if (part.type === "text") {
				const markdown = (part.text ?? "").trim();
				if (!markdown) continue;
				items.push({
					id: itemId("assistant", `${message.timestamp}:${textIndex++}`),
					kind: "assistant",
					markdown,
					timestamp: message.timestamp,
				});
			} else if (part.type === "toolCall" && options.includeTools !== false) {
				const args = asArgs(part.arguments);
				items.push({
					id: itemId("tool", part.id),
					kind: "tool",
					callId: part.id,
					name: part.name,
					args,
					status: "running",
					summary: describeToolCall(part.name, args),
					timestamp: message.timestamp,
				});
			}
		}
		return items;
	}
	if (message.role === "toolResult") {
		const args = asArgs((message as { details?: unknown }).details);
		return [{
			id: itemId("tool", message.toolCallId),
			kind: "tool",
			callId: message.toolCallId,
			name: message.toolName,
			args,
			status: message.isError ? "failed" : "completed",
			summary: describeToolCall(message.toolName, args),
			resultText: contentText(message.content).trim() || undefined,
			details: message.details,
			timestamp: message.timestamp,
		}];
	}
	return [];
}

export function mergeTranscriptItem(previous: SubagentTranscriptItem, next: SubagentTranscriptItem): SubagentTranscriptItem {
	if (previous.kind === "tool" && next.kind === "tool") {
		return {
			...previous,
			...next,
			args: next.args ?? previous.args,
			summary: next.summary || previous.summary,
			resultText: next.resultText ?? previous.resultText,
			details: next.details ?? previous.details,
		};
	}
	return next;
}

export function upsertTranscriptItem(items: SubagentTranscriptItem[], item: SubagentTranscriptItem): void {
	const index = items.findIndex((candidate) => candidate.id === item.id);
	if (index >= 0) items[index] = mergeTranscriptItem(items[index]!, item);
	else items.push(item);
}

export function itemsFromAgentMessages(messages: AgentMessage[]): SubagentTranscriptItem[] {
	const items: SubagentTranscriptItem[] = [];
	for (const message of messages) {
		for (const item of itemsFromAgentMessage(message)) upsertTranscriptItem(items, item);
	}
	return items;
}

export function legacyMessageFromItem(item: SubagentTranscriptItem): SubagentTranscriptMessage {
	if (item.kind === "user") return { role: "user", text: item.markdown, timestamp: item.timestamp };
	if (item.kind === "assistant") return { role: "assistant", text: item.markdown, timestamp: item.timestamp };
	if (item.kind === "thinking") return { role: "assistant", text: item.summary, timestamp: item.timestamp };
	return {
		role: "tool",
		text: item.resultText ?? item.summary,
		toolName: item.name,
		isError: item.status === "failed",
		timestamp: item.timestamp,
	};
}

export function legacyMessagesFromItems(items: SubagentTranscriptItem[]): SubagentTranscriptMessage[] {
	return items.filter((item) => item.kind !== "thinking").map(legacyMessageFromItem);
}

export function liveToolItem(input: {
	callId: string;
	name: string;
	args?: unknown;
	status: "running" | "completed" | "failed";
	resultText?: string;
	details?: unknown;
	timestamp?: number;
}): SubagentTranscriptItem {
	const args = asArgs(input.args);
	return {
		id: itemId("tool", input.callId),
		kind: "tool",
		callId: input.callId,
		name: input.name,
		args,
		status: input.status,
		summary: describeToolCall(input.name, args),
		resultText: input.resultText,
		details: input.details,
		timestamp: input.timestamp,
	};
}
