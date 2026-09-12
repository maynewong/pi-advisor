import type { SubagentEvent, SubagentProfile, SubagentResult, SubagentTranscriptItem, SubagentTranscriptMessage, UsageSnapshot } from "../types.ts";
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
	/** Marks a result that landed on the soft turn budget after a wrap-up turn rather than finishing freely. */
	stoppedBy?: SubagentResult["stoppedBy"];
	submitted?: unknown;
	usage?: UsageSnapshot;
	transcript?: string;
	messages?: SubagentTranscriptMessage[];
	items?: SubagentTranscriptItem[];
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
