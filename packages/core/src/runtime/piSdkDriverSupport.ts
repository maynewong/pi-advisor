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

/** Keep Oracle read-only even when a profile loses its allowlist or spawn overrides weaken it. */
export function assertOracleReadOnly(profile: SubagentProfile): void {
	if (profile.name !== "oracle") return;
	if (!profile.tools) throw new Error("Oracle requires an explicit tool allowlist to remain read-only");
	const forbidden = profile.tools.filter((tool) => tool === "bash" || tool === "edit" || tool === "write");
	if (forbidden.length > 0) throw new Error(`Oracle must remain read-only; forbidden tools: ${forbidden.join(", ")}`);
}

export function successfulFileEvent(toolName: string, args: Record<string, unknown>, isError: boolean): SubagentEvent | undefined {
	if (isError || typeof args.path !== "string") return undefined;
	if (toolName === "read") return { type: "file_read", path: args.path };
	if (toolName === "edit" || toolName === "write") return { type: "file_write", path: args.path };
	return undefined;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function truncate(text: string, limit = 80): string {
	return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

/** Renders a short, human-readable description of a tool call for activity disclosure. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
	const path = str(args, "path");
	switch (name) {
		case "read":
			return truncate(`Reading ${path ?? "file"}`);
		case "grep": {
			const pattern = str(args, "pattern") ?? str(args, "query") ?? "";
			const dir = str(args, "path") ?? str(args, "dir");
			return truncate(`Searching "${pattern}"${dir ? ` in ${dir}` : ""}`);
		}
		case "find":
			return truncate(`Finding ${str(args, "pattern") ?? path ?? ""}`);
		case "ls":
			return truncate(`Listing ${path ?? "."}`);
		case "bash": {
			const command = str(args, "command") ?? "";
			return truncate(`Running: ${command.slice(0, 60)}${command.length > 60 ? "..." : ""}`);
		}
		case "edit":
			return truncate(`Editing ${path ?? "file"}`);
		case "write":
			return truncate(`Writing ${path ?? "file"}`);
		default:
			return truncate(name);
	}
}

/** Condenses a thinking/text content block into a single short activity line, or undefined if empty. */
export function thoughtPreview(text: string): string | undefined {
	const trimmed = (text ?? "").trim();
	if (!trimmed) return undefined;
	const firstLine = trimmed.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
	if (!firstLine) return undefined;
	const stripped = firstLine.replace(/^#+\s*/, "").trim();
	if (!stripped) return undefined;
	return stripped.length > 100 ? `${stripped.slice(0, 97)}...` : stripped;
}
