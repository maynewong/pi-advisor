/**
 * Normalizes pi SDK state into the smaller runtime-driver contract. Keeping
 * these projections pure makes error, tool, and disclosure semantics testable
 * without constructing an SDK session.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { OutputContract, SubagentEvent, SubagentProfile, SubagentResult } from "../types.ts";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/**
 * Soft turn budget ("soft landing"). Reaching the profile's `maxTurns` no longer kills the run;
 * instead the child is asked to wrap up and land its best answer in one more turn. Deterministic code
 * keeps a small, explicit finalize window. Investigation tools are removed during that window so the child
 * must answer instead of spending another multiple of its budget on tool calls.
 */
export const DEFAULT_FINALIZE_TURNS = 2;

/** Absolute turn ceiling: investigation budget plus a small finalize-only window. */
export function hardTurnCeiling(maxTurns: number, finalizeTurns = DEFAULT_FINALIZE_TURNS): number {
	return Math.ceil(maxTurns + Math.max(1, finalizeTurns));
}

/** Base wrap-up instruction injected into the child when it reaches its soft turn budget. */
export const WRAP_UP_INSTRUCTION =
	"Turn budget reached. Stop investigating now and submit your best answer from what you have found so far. Mark anything unverified as an assumption.";

/** The wrap-up instruction, extended for schema profiles so the child lands via the output tool. */
export function wrapUpInstruction(output: OutputContract | undefined): string {
	if (output?.kind === "schema") {
		return `${WRAP_UP_INSTRUCTION} Call ${output.toolName ?? "submit_result"} now with your best structured result; use a low/uncertain confidence and record the open questions rather than continuing to investigate.`;
	}
	return WRAP_UP_INSTRUCTION;
}

export type TurnBudgetAction = "continue" | "wrap_up" | "hard_stop";

/**
 * Decide what to do at the start of a turn given the current per-leg turn count.
 * - Under the soft budget: `continue`.
 * - First turn past the soft budget: `wrap_up` (inject the wrap-up instruction, once).
 * - Past the hard ceiling: `hard_stop` (runaway backstop, terminates as `max_turns`).
 */
export function turnBudgetAction(
	legTurns: number,
	maxTurns: number | undefined,
	wrapUpInjected: boolean,
	finalizeTurns = DEFAULT_FINALIZE_TURNS,
): TurnBudgetAction {
	if (!maxTurns) return "continue";
	if (legTurns > hardTurnCeiling(maxTurns, finalizeTurns)) return "hard_stop";
	if (legTurns > maxTurns && !wrapUpInjected) return "wrap_up";
	return "continue";
}

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

/** Keep Advisor read-only even when a profile loses its allowlist or spawn overrides weaken it. */
export function assertAdvisorReadOnly(profile: SubagentProfile): void {
	if (profile.name !== "advisor") return;
	if (!profile.tools) throw new Error("Advisor requires an explicit tool allowlist to remain read-only");
	const forbidden = profile.tools.filter((tool) => tool === "bash" || tool === "edit" || tool === "write");
	if (forbidden.length > 0) throw new Error(`Advisor must remain read-only; forbidden tools: ${forbidden.join(", ")}`);
}

export function splitModelSpec(spec: string): { provider: string; id: string } | undefined {
	const slash = spec.indexOf("/");
	if (slash < 1) return undefined;
	return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

/** Resolve a `provider/id` string from an explicit registry, then from a runtime catalog. */
export function lookupConfiguredModel<T>(
	spec: string,
	registry?: { find(provider: string, id: string): T | undefined },
	runtime?: { getModel(provider: string, id: string): T | undefined },
): T | undefined {
	const parts = splitModelSpec(spec);
	if (!parts) return undefined;
	return registry?.find(parts.provider, parts.id) ?? runtime?.getModel(parts.provider, parts.id);
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
