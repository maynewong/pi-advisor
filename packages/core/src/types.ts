import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { WorkspaceRequest } from "./workspace/WorkspaceProvider.ts";

export type ModelSpec = string | Model<any>;
export type ContextMode = "fresh" | "selected" | "fork";

export interface PermissionPolicy {
	write?: { allow: string[]; deny?: string[] };
	bash?: { allow?: string[]; deny?: string[]; mode: "allowlist" | "denylist" | "off" };
	onViolation?: "block" | "escalate";
	escalationTimeoutMs?: number;
}

export type OutputContract = { kind: "text" } | { kind: "schema"; schema: TSchema; toolName?: string };

export interface SubagentProfile {
	name: string;
	description: string;
	systemPrompt: string;
	model?: ModelSpec;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	permission?: PermissionPolicy;
	contextMode?: ContextMode;
	output?: OutputContract;
	skills?: string[];
	/** Investigation turns before the runtime enters finalize-only mode. */
	maxTurns?: number;
	/** Additional turns allowed to produce the final answer after investigation stops. Default: 2. */
	finalizeTurns?: number;
	/** Maximum UTF-8 bytes injected through the context packet for this role. */
	contextMaxBytes?: number;
	timeoutMs?: number;
}

export interface ContextInput {
	files?: string[];
	diff?: string | { base: string };
	text?: string[];
	forkFrom?: { sessionFile: string; entryId?: string };
}

export interface UsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	contextTokens?: number;
	model?: string;
}

export const EMPTY_USAGE: UsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

export type SubagentStatus = "queued" | "running" | "waiting_permission" | "completed" | "failed" | "aborted" | "timeout";

export interface SubagentTranscriptMessage {
	role: "user" | "assistant" | "tool";
	text: string;
	toolName?: string;
	isError?: boolean;
	timestamp?: number;
}

export type SubagentTranscriptItem =
	| { id: string; kind: "user"; markdown: string; timestamp?: number }
	| { id: string; kind: "assistant"; markdown: string; timestamp?: number }
	| { id: string; kind: "thinking"; summary: string; text?: string; timestamp?: number }
	| {
		id: string;
		kind: "tool";
		callId: string;
		name: string;
		args: unknown;
		status: "running" | "completed" | "failed";
		summary: string;
		resultText?: string;
		details?: unknown;
		timestamp?: number;
	};

export type SubagentEvent =
	| { type: "started"; id: string; metadata?: Record<string, unknown> }
	| { type: "message"; message: SubagentTranscriptMessage }
	| { type: "transcript"; item: SubagentTranscriptItem }
	| { type: "turn"; index: number }
	| { type: "usage"; usage: UsageSnapshot }
	| { type: "tool_call"; name: string; argsPreview: string; summary?: string; callId?: string; args?: unknown }
	| { type: "tool_result"; name: string; ok: boolean; summary: string; callId?: string; details?: unknown }
	| { type: "file_read"; path: string }
	| { type: "file_write"; path: string }
	| { type: "permission_blocked"; tool: string; reason: string }
	| { type: "escalation"; id: string; tool: string; question: string }
	| { type: "progress"; text: string }
	| { type: "thought"; text: string }
	| { type: "completed" }
	| { type: "failed"; error: string }
	| { type: "aborted" }
	| { type: "timeout" };

export interface SubagentDisclosure {
	filesRead: string[];
	filesModified: string[];
	commandsRun: string[];
	contextSources: string[];
	truncated: string[];
}

export interface SubagentResult {
	status: SubagentStatus;
	output?: unknown;
	text: string;
	/**
	 * Set when a run completed only because it reached its soft turn budget and was asked to wrap up.
	 * The answer is a best-effort partial: the parent may extend it via the resume path (subagent_send).
	 */
	stoppedBy?: "turn_budget";
	error?: { message: string; kind: "model" | "tool" | "timeout" | "aborted" | "protocol" | "max_turns" };
	usage: UsageSnapshot;
	disclosure: SubagentDisclosure;
	artifacts?: { dir: string; transcript?: string; events?: string; result?: string };
	sessionRef?: { file?: string };
	workspace?: { path: string; retained: boolean };
	/** Full normalized child conversation for hosts that render a Main/specialist workspace. */
	messages?: SubagentTranscriptMessage[];
	/** Structured conversation items with stable IDs and tool call pairing. */
	items?: SubagentTranscriptItem[];
}

export interface SpawnOptions {
	context?: ContextInput;
	signal?: AbortSignal;
	runMode?: "foreground" | "background";
	overrides?: Partial<SubagentProfile>;
	metadata?: Record<string, unknown>;
	depth?: number;
	workspace?: WorkspaceRequest;
}
