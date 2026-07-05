/**
 * Normalizes pi SDK state into the smaller runtime-driver contract. Keeping
 * these projections pure makes error, tool, and disclosure semantics testable
 * without constructing an SDK session.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SubagentEvent, SubagentProfile, SubagentResult } from "../types.ts";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

export function driverErrorFromMessages(messages: AgentMessage[]): SubagentResult["error"] | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "error") return { kind: "model", message: assistant.errorMessage?.trim() || "Model request failed" };
		if (assistant.stopReason === "aborted") return { kind: "aborted", message: assistant.errorMessage?.trim() || "Subagent aborted" };
		return undefined;
	}
	return undefined;
}

export function resolveActiveTools(profile: SubagentProfile): string[] | undefined {
	if (profile.output?.kind !== "schema") return profile.tools;
	const outputTool = profile.output.toolName ?? "submit_result";
	return [...new Set([...(profile.tools ?? DEFAULT_TOOLS), outputTool])];
}

export function successfulFileEvent(toolName: string, args: Record<string, unknown>, isError: boolean): SubagentEvent | undefined {
	if (isError || typeof args.path !== "string") return undefined;
	if (toolName === "read") return { type: "file_read", path: args.path };
	if (toolName === "edit" || toolName === "write") return { type: "file_write", path: args.path };
	return undefined;
}
