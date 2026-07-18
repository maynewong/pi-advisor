import type { SubagentEvent, SubagentProfile, SubagentResult, UsageSnapshot } from "../types.ts";
import type { ContextInput } from "../types.ts";
import type { EscalationDecision } from "../permission/PermissionEscalations.ts";

export type DriverEvent = SubagentEvent;

export interface DriverRequest {
	id: string;
	cwd: string;
	profile: SubagentProfile;
	task: string;
	prompt: string;
	context?: ContextInput;
	metadata?: Record<string, unknown>;
}

export interface DriverRunResult {
	text: string;
	error?: SubagentResult["error"];
	submitted?: unknown;
	usage?: UsageSnapshot;
	transcript?: string;
	sessionFile?: string;
}

export interface RuntimeDriver {
	run(): Promise<DriverRunResult>;
	abort(): Promise<void>;
	steer?(message: string): void | Promise<void>;
	followUp?(message: string): void | Promise<void>;
	/** Run another turn on the same retained session after a terminal run, producing a fresh result. */
	resume?(message: string): Promise<DriverRunResult>;
	resolveEscalation?(id: string, decision: EscalationDecision): boolean;
	dispose?(): void | Promise<void>;
}

export type RuntimeDriverFactory = (request: DriverRequest, emit: (event: DriverEvent) => void) => Promise<RuntimeDriver>;
