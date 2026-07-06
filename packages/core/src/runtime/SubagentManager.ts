import { randomUUID } from "node:crypto";
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { ArtifactWriter } from "../artifacts/ArtifactWriter.ts";
import { buildContextPacket } from "../context/buildContext.ts";
import { resolveOutput } from "../output/resolveOutput.ts";
import { createPiSdkDriver } from "./piSdkDriver.ts";
import { assertOracleReadOnly } from "./piSdkDriverSupport.ts";
import { ManagedSubagentHandle, type SubagentHandle } from "./SubagentHandle.ts";
import type { DriverEvent, DriverRequest, RuntimeDriverFactory } from "./driver.ts";
import { EMPTY_USAGE, type ModelSpec, type SpawnOptions, type SubagentDisclosure, type SubagentProfile, type SubagentResult } from "../types.ts";
import { GitWorktreeProvider, type ProvisionedWorkspace, type WorkspaceProvider } from "../workspace/WorkspaceProvider.ts";

export interface SubagentManagerOptions {
	cwd: string;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	resolveModel?: (spec: ModelSpec, profile: SubagentProfile) => Promise<Model<any>>;
	maxConcurrent?: number;
	maxConcurrentPerKey?: number;
	resolveConcurrencyKey?: (profile: SubagentProfile) => string | undefined;
	maxDepth?: number;
	artifactsDir?: string;
	createDriver?: RuntimeDriverFactory;
	workspaceProvider?: WorkspaceProvider;
}

interface QueuedRun {
	handle: ManagedSubagentHandle;
	profile: SubagentProfile;
	task: string;
	options: SpawnOptions;
	concurrencyKey?: string;
}

const TERMINAL = new Set(["completed", "failed", "aborted", "timeout"]);

export class SubagentManager {
	private readonly handles = new Map<string, ManagedSubagentHandle>();
	private readonly queue: QueuedRun[] = [];
	private active = 0;
	private readonly maxConcurrent: number;
	private readonly maxDepth: number;
	private readonly maxConcurrentPerKey: number;
	private readonly createDriver: RuntimeDriverFactory;
	private readonly depths = new Map<string, number>();
	private readonly activeByKey = new Map<string, number>();
	private readonly workspaceProvider: WorkspaceProvider;

	constructor(private readonly options: SubagentManagerOptions) {
		if (!options.cwd) throw new Error("SubagentManager requires an explicit cwd");
		this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4);
		this.maxConcurrentPerKey = Math.max(1, options.maxConcurrentPerKey ?? this.maxConcurrent);
		this.maxDepth = Math.max(0, options.maxDepth ?? 1);
		this.workspaceProvider = options.workspaceProvider ?? new GitWorktreeProvider();
		this.createDriver = options.createDriver ?? createPiSdkDriver({
			cwd: options.cwd,
			authStorage: options.authStorage,
			modelRegistry: options.modelRegistry,
			resolveModel: options.resolveModel,
		});
	}

	spawn(profile: SubagentProfile, task: string, options: SpawnOptions = {}): SubagentHandle {
		if (!task.trim()) throw new Error("Subagent task cannot be empty");
		if ((options.depth ?? 0) >= this.maxDepth) throw new Error(`Subagent max depth ${this.maxDepth} exceeded`);
		if ((profile.contextMode ?? "fresh") === "fork" && !options.context?.forkFrom) throw new Error("fork context mode requires context.forkFrom");
		const effective = { ...profile, ...options.overrides };
		const oracleName = profile.name === "oracle" || profile.name === "oracle-plan" ? profile.name : undefined;
		assertOracleReadOnly(oracleName ? { ...effective, name: oracleName } : effective);
		const handle = new ManagedSubagentHandle(randomUUID(), effective);
		const concurrencyKey = options.metadata?.concurrencyKey as string | undefined ?? this.options.resolveConcurrencyKey?.(effective);
		const run = { handle, profile: effective, task, options, ...(concurrencyKey ? { concurrencyKey } : {}) };
		this.handles.set(handle.id, handle);
		this.depths.set(handle.id, options.depth ?? 0);
		handle.setQueuedAbort(async () => this.abortQueued(run));
		this.queue.push(run);
		if (options.signal) {
			if (options.signal.aborted) void handle.abort();
			else options.signal.addEventListener("abort", () => void handle.abort(), { once: true });
		}
		queueMicrotask(() => this.pump());
		return handle;
	}

	spawnChild(parentId: string, profile: SubagentProfile, task: string, options: Omit<SpawnOptions, "depth"> = {}): SubagentHandle {
		const parentDepth = this.depths.get(parentId);
		if (parentDepth === undefined) throw new Error(`Unknown parent subagent: ${parentId}`);
		return this.spawn(profile, task, { ...options, depth: parentDepth + 1 });
	}

	list(): SubagentHandle[] { return [...this.handles.values()]; }
	get(id: string): SubagentHandle | undefined { return this.handles.get(id); }

	async abortAll(): Promise<void> {
		await Promise.all([...this.handles.values()].filter((handle) => !TERMINAL.has(handle.status)).map((handle) => handle.abort()));
	}

	private async abortQueued(run: QueuedRun): Promise<void> {
		const index = this.queue.indexOf(run);
		if (index < 0) return;
		this.queue.splice(index, 1);
		const result = this.baseResult(run, "aborted", "", { message: "Subagent aborted while queued", kind: "aborted" });
		run.handle.emit({ type: "aborted" });
		run.handle.complete(result);
	}

	private pump(): void {
		while (this.active < this.maxConcurrent && this.queue.length > 0) {
			const index = this.queue.findIndex((candidate) => !candidate.concurrencyKey || (this.activeByKey.get(candidate.concurrencyKey) ?? 0) < this.maxConcurrentPerKey);
			if (index < 0) return;
			const [run] = this.queue.splice(index, 1);
			this.active += 1;
			if (run.concurrencyKey) this.activeByKey.set(run.concurrencyKey, (this.activeByKey.get(run.concurrencyKey) ?? 0) + 1);
			void this.execute(run).finally(() => {
				this.active -= 1;
				if (run.concurrencyKey) {
					const remaining = (this.activeByKey.get(run.concurrencyKey) ?? 1) - 1;
					if (remaining > 0) this.activeByKey.set(run.concurrencyKey, remaining);
					else this.activeByKey.delete(run.concurrencyKey);
				}
				this.pump();
			});
		}
	}

	private async execute(run: QueuedRun): Promise<void> {
		const { handle, profile, task, options } = run;
		let writer: ArtifactWriter | undefined;
		let transcript: string | undefined;
		let workspace: ProvisionedWorkspace | undefined;
		handle.setStatus("running");
		try {
			workspace = options.workspace ? await this.workspaceProvider.prepare(handle.id, options.workspace, this.options.cwd) : undefined;
			const runCwd = workspace?.cwd ?? this.options.cwd;
			const packet = await buildContextPacket(options.context, { cwd: runCwd });
			const prompt = packet.text ? `${task}\n\n# Context packet\n\n${packet.text}` : task;
			if (this.options.artifactsDir) {
				const candidate = new ArtifactWriter(this.options.artifactsDir, handle.id);
				await candidate.initialize(profile, task, prompt);
				writer = candidate;
			}
			const disclosure: SubagentDisclosure = { filesRead: [], filesModified: [], commandsRun: [], contextSources: packet.sources, truncated: packet.truncated };
			const emit = (event: DriverEvent) => {
				if (event.type === "escalation") handle.setStatus("waiting_permission");
				if (event.type === "permission_blocked") handle.setStatus("running");
				if (event.type === "file_read" && !disclosure.filesRead.includes(event.path)) disclosure.filesRead.push(event.path);
				if (event.type === "file_write" && !disclosure.filesModified.includes(event.path)) disclosure.filesModified.push(event.path);
				if (event.type === "tool_call" && event.name === "bash") disclosure.commandsRun.push(event.argsPreview);
				handle.emit(event);
				writer?.appendEvent(event);
			};
			const request: DriverRequest = { id: handle.id, cwd: runCwd, profile, task, prompt, ...(options.context ? { context: options.context } : {}), ...(options.metadata ? { metadata: options.metadata } : {}) };
			const driver = await this.createDriver(request, emit);
			handle.setDriver(driver);
			if (handle.wasAbortRequested) await driver.abort();
			emit({ type: "started", id: handle.id, ...(options.metadata ? { metadata: options.metadata } : {}) });
			const timeoutMs = profile.timeoutMs;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timedOut = Symbol("timeout");
			const aborted = Symbol("aborted");
			const races: Array<Promise<Awaited<ReturnType<typeof driver.run>> | typeof timedOut | typeof aborted>> = [
				driver.run(),
				handle.abortRequestedPromise.then(() => aborted),
			];
			if (timeoutMs) races.push(new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), timeoutMs); }));
			const outcome = await Promise.race(races);
			if (timer) clearTimeout(timer);
			if (outcome === aborted) {
				const result = this.baseResult(run, "aborted", "", { message: "Subagent aborted", kind: "aborted" }, disclosure);
				emit({ type: "aborted" });
				await this.finish(run, result, writer, undefined, workspace);
				return;
			}
			if (outcome === timedOut) {
				await driver.abort();
				const result = this.baseResult(run, "timeout", "", { message: `Subagent timed out after ${timeoutMs}ms`, kind: "timeout" }, disclosure);
				emit({ type: "timeout" });
				await this.finish(run, result, writer, undefined, workspace);
				return;
			}
			transcript = outcome.transcript;
			if (outcome.error) {
				const status = outcome.error.kind === "aborted" ? "aborted" : "failed";
				const result = this.baseResult(run, status, outcome.text, outcome.error, disclosure, outcome.usage, undefined, outcome.sessionFile);
				emit(status === "aborted" ? { type: "aborted" } : { type: "failed", error: outcome.error.message });
				await this.finish(run, result, writer, transcript, workspace);
				return;
			}
			const resolved = resolveOutput(profile.output, outcome.text, outcome.submitted);
			const result = this.baseResult(
				run,
				resolved.error ? "failed" : "completed",
				outcome.text,
				resolved.error,
				disclosure,
				outcome.usage,
				resolved.output,
				outcome.sessionFile,
			);
			emit(resolved.error ? { type: "failed", error: resolved.error.message } : { type: "completed" });
			await this.finish(run, result, writer, transcript, workspace);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = handle.wasAbortRequested;
			const result = this.baseResult(run, aborted ? "aborted" : "failed", "", { message: aborted ? "Subagent aborted" : message, kind: aborted ? "aborted" : "model" });
			const event = aborted ? { type: "aborted" as const } : { type: "failed" as const, error: message };
			handle.emit(event);
			writer?.appendEvent(event);
			await this.finish(run, result, writer, transcript, workspace);
		}
	}

	private baseResult(
		run: QueuedRun,
		status: SubagentResult["status"],
		text: string,
		error?: SubagentResult["error"],
		disclosure: SubagentDisclosure = { filesRead: [], filesModified: [], commandsRun: [], contextSources: [], truncated: [] },
		usage = EMPTY_USAGE,
		output?: unknown,
		sessionFile?: string,
	): SubagentResult {
		return { status, text, usage: { ...usage }, disclosure, ...(error ? { error } : {}), ...(output !== undefined ? { output } : {}), ...(sessionFile ? { sessionRef: { file: sessionFile } } : {}) };
	}

	private async finish(run: QueuedRun, result: SubagentResult, writer?: ArtifactWriter, transcript?: string, workspace?: ProvisionedWorkspace): Promise<void> {
		await run.handle.disposeDriver();
		if (workspace) {
			const retained = run.options.workspace?.retain ?? true;
			result.workspace = { path: workspace.cwd, retained };
			if (!retained) {
				try {
					await workspace.cleanup();
				} catch (error) {
					result.status = "failed";
					result.error = { kind: "tool", message: `Workspace cleanup failed: ${error instanceof Error ? error.message : String(error)}` };
				}
			}
		}
		if (writer) {
			try {
				result.artifacts = { dir: writer.dir, events: writer.eventsPath, result: writer.resultPath, ...(transcript ? { transcript: writer.transcriptPath } : {}) };
				await writer.finish(result, transcript);
			} catch (error) {
				result.status = "failed";
				result.error = { kind: "tool", message: `Artifact write failed: ${error instanceof Error ? error.message : String(error)}` };
				delete result.artifacts;
			}
		}
		run.handle.complete(result);
	}
}
