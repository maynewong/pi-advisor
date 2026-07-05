import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { WorkspaceRequest } from "./workspace/WorkspaceProvider.ts";

export type ModelSpec = string | Model<any>;
export type ContextMode = "fresh" | "selected" | "fork";

export interface PermissionPolicy {
	write?: { allow: string[]; deny?: string[] };
	bash?: { allow?: string[]; deny?: string[]; mode: "allowlist" | "denylist" | "off" };
	network?: boolean;
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
	maxTurns?: number;
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

export type SubagentEvent =
	| { type: "started"; id: string; metadata?: Record<string, unknown> }
	| { type: "turn"; index: number }
	| { type: "tool_call"; name: string; argsPreview: string }
	| { type: "tool_result"; name: string; ok: boolean; summary: string }
	| { type: "file_read"; path: string }
	| { type: "file_write"; path: string }
	| { type: "permission_blocked"; tool: string; reason: string }
	| { type: "escalation"; id: string; tool: string; question: string }
	| { type: "progress"; text: string }
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
	error?: { message: string; kind: "model" | "tool" | "timeout" | "aborted" | "protocol" | "max_turns" };
	usage: UsageSnapshot;
	disclosure: SubagentDisclosure;
	artifacts?: { dir: string; transcript?: string; events?: string; result?: string };
	sessionRef?: { file?: string };
	workspace?: { path: string; retained: boolean };
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
