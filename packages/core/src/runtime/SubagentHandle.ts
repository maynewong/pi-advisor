import { EventStream } from "./EventStream.ts";
import type { RuntimeDriver } from "./driver.ts";
import { EMPTY_USAGE, type SubagentEvent, type SubagentProfile, type SubagentResult, type SubagentStatus, type UsageSnapshot } from "../types.ts";
import type { EscalationDecision } from "../permission/PermissionEscalations.ts";

export interface SubagentHandle {
	readonly id: string;
	readonly profile: SubagentProfile;
	readonly status: SubagentStatus;
	readonly usage: UsageSnapshot;
	/** Finite event stream for the initial invocation only. */
	readonly events: AsyncIterable<SubagentEvent>;
	/** Live, no-replay callback subscription across initial execution and resumes. Unsubscribe explicitly. */
	subscribe(listener: (event: SubagentEvent) => void): () => void;
	steer(message: string): void;
	followUp(message: string): void;
	/** Continue a completed run with a follow-up message, resolving with the new terminal result. */
	resume(message: string): Promise<SubagentResult>;
	resolveEscalation(id: string, decision: EscalationDecision): boolean;
	abort(): Promise<void>;
	wait(): Promise<SubagentResult>;
}

export class ManagedSubagentHandle implements SubagentHandle {
	private currentStatus: SubagentStatus = "queued";
	private currentUsage: UsageSnapshot = { ...EMPTY_USAGE };
	private readonly stream = new EventStream<SubagentEvent>();
	private readonly listeners = new Set<(event: SubagentEvent) => void>();
	private readonly resultPromise: Promise<SubagentResult>;
	private resolveResult!: (result: SubagentResult) => void;
	private driver?: RuntimeDriver;
	private resumeRun?: (message: string) => Promise<SubagentResult>;
	private abortQueued?: () => Promise<void>;
	private abortRequested = false;
	private resolveAbortRequested!: () => void;
	readonly abortRequestedPromise: Promise<void>;

	constructor(readonly id: string, readonly profile: SubagentProfile) {
		this.resultPromise = new Promise((resolve) => { this.resolveResult = resolve; });
		this.abortRequestedPromise = new Promise((resolve) => { this.resolveAbortRequested = resolve; });
	}

	get status(): SubagentStatus { return this.currentStatus; }
	get usage(): UsageSnapshot { return { ...this.currentUsage }; }
	get events(): AsyncIterable<SubagentEvent> { return this.stream; }

	subscribe(listener: (event: SubagentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	wait(): Promise<SubagentResult> { return this.resultPromise; }

	steer(message: string): void {
		if (!this.driver?.steer) throw new Error("Subagent is not running or does not support steering");
		void this.driver.steer(message);
	}

	followUp(message: string): void {
		if (!this.driver?.followUp) throw new Error("Subagent is not running or does not support follow-up messages");
		void this.driver.followUp(message);
	}

	resume(message: string): Promise<SubagentResult> {
		if (!this.resumeRun) throw new Error("Subagent run cannot be resumed");
		return this.resumeRun(message);
	}

	resolveEscalation(id: string, decision: EscalationDecision): boolean {
		const resolved = this.driver?.resolveEscalation?.(id, decision) ?? false;
		if (resolved && this.currentStatus === "waiting_permission") this.currentStatus = "running";
		return resolved;
	}

	async abort(): Promise<void> {
		if (this.abortRequested || ["completed", "failed", "aborted", "timeout"].includes(this.currentStatus)) return;
		this.abortRequested = true;
		this.resolveAbortRequested();
		if (this.driver) await this.driver.abort();
		else await this.abortQueued?.();
	}

	setDriver(driver: RuntimeDriver): void { this.driver = driver; }
	setResume(resume: (message: string) => Promise<SubagentResult>): void { this.resumeRun = resume; }
	setQueuedAbort(abort: () => Promise<void>): void { this.abortQueued = abort; }
	setStatus(status: SubagentStatus): void { this.currentStatus = status; }
	setUsage(usage: UsageSnapshot): void { this.currentUsage = { ...usage }; }
	emit(event: SubagentEvent): void {
		this.stream.push(event);
		// Snapshot additions; honor removals made during notification. Observers cannot fail the run.
		for (const listener of [...this.listeners]) {
			if (!this.listeners.has(listener)) continue;
			try { listener(event); }
			catch (error) { console.error("Subagent event listener failed", error); }
		}
	}
	get wasAbortRequested(): boolean { return this.abortRequested; }
	async disposeDriver(): Promise<void> { await this.driver?.dispose?.(); }

	complete(result: SubagentResult): void {
		this.currentStatus = result.status;
		this.currentUsage = { ...result.usage };
		this.resolveResult(result);
		this.stream.close();
	}

	/** Reflect a resumed turn's terminal state without re-arming the already-resolved wait() promise or reopened stream. */
	applyResume(result: SubagentResult): void {
		this.currentStatus = result.status;
		this.currentUsage = { ...result.usage };
	}
}
