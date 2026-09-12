import { randomBytes } from "node:crypto";
import { advisorSubmissionMarker, type CodexReasoningEffort, type HerdrAdapter, type HerdrConversation } from "./provider.ts";
import { createExecFileCli, herdrResult, herdrTextResult, type HerdrCli } from "./cli.ts";

export const GROK_HIGH_TARGET = "grok-4.6-high";
export const DEFAULT_GROK_MODEL = "grok-4.6";
export const DEFAULT_RUN_NAME_PREFIX = "grok-advisor";
export const DEFAULT_CODEX_RUN_NAME_PREFIX = "codex-advisor";
const FALLBACK_ADVISOR_RULES = "Act as a read-only advisor. Never edit files or run mutating commands. Return one compact JSON result object.";
const GROK_COMPLETION_MARKER = "Worked for";
const CODEX_DISABLED_FEATURES = ["apps", "browser_use", "computer_use", "plugins"] as const;

function codexFeatureDisableArgs(): string[] {
	return CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]);
}

export interface HerdrCliAdapterOptions {
	/** Injected CLI for tests. Real installs leave this unset and spawn `herdr`. */
	cli?: HerdrCli;
	/** Injected Codex configuration reader; production resolves config in the run cwd. */
	codexCli?: HerdrCli;
	command?: string;
	/** Grok model override. */
	model?: string;
	/** Codex model override. */
	codexModel?: string;
	/** Codex reasoning-effort override. */
	codexReasoningEffort?: CodexReasoningEffort;
	/** Prefix for fresh Grok pane and Herdr agent names. */
	runNamePrefix?: string;
	/** Prefix for fresh Codex pane and Herdr agent names. */
	codexRunNamePrefix?: string;
	/** Injected deterministic suffix factory for tests. Defaults to twelve random hex characters. */
	createRunSuffix?: () => string;
	direction?: "right" | "down";
	ratio?: number;
	startupTimeoutMs?: number;
	timeoutMs?: number;
	shellReadyTimeoutMs?: number;
	shellReadyPollMs?: number;
	shellInitGraceMs?: number;
	/** Grace period after detecting the shell, so its interactive line editor can leave canonical mode. */
	shellSettleMs?: number;
	/** Injected timer for tests. */
	sleep?: (ms: number) => Promise<void>;
	resultPollMs?: number;
	/** Consecutive identical completed transcripts required before parsing the result. */
	completionStableReads?: number;
	/** Set false in tests. Live installs require Pi to already be inside Herdr. */
	requireHerdrEnv?: boolean;
}

interface PaneRecord {
	pane_id?: string;
	label?: string;
	agent?: string;
	agent_status?: string;
}

interface AgentRecord {
	pane_id?: string;
	name?: string;
	agent?: string;
	agent_status?: string;
	terminal_id?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function paneFrom(value: unknown): PaneRecord | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	return {
		...(typeof record.pane_id === "string" ? { pane_id: record.pane_id } : {}),
		...(typeof record.label === "string" ? { label: record.label } : {}),
		...(typeof record.agent === "string" ? { agent: record.agent } : {}),
		...(typeof record.agent_status === "string" ? { agent_status: record.agent_status } : {}),
	};
}

function agentFrom(value: unknown): AgentRecord | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	return {
		...(typeof record.pane_id === "string" ? { pane_id: record.pane_id } : {}),
		...(typeof record.name === "string" ? { name: record.name } : {}),
		...(typeof record.agent === "string" ? { agent: record.agent } : {}),
		...(typeof record.agent_status === "string" ? { agent_status: record.agent_status } : {}),
		...(typeof record.terminal_id === "string" ? { terminal_id: record.terminal_id } : {}),
	};
}

function shellSafeAgentArgument(value: string): string {
	// Herdr's managed `agent start` rejects argv containing control characters.
	// Advisor rules are intentionally multiline, so flatten them without changing
	// their words before passing the value through the target shell.
	return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function grokLaunchArgs(model: string, reasoningEffort: string, rules?: string): string[] {
	const safeRules = rules ? shellSafeAgentArgument(rules) : "";
	return [
		"-m", model,
		"--reasoning-effort", reasoningEffort,
		"--permission-mode", "plan",
		"--deny", "Edit(**)",
		"--deny", "Write(**)",
		"--deny", "Bash(**)",
		...(safeRules ? ["--rules", safeRules] : []),
	];
}

function codexLaunchArgs(model: string, reasoningEffort: string, cwd: string, disabledServerArgs: string[], rules?: string): string[] {
	const safeRules = rules ? shellSafeAgentArgument(rules) : "";
	return [
		"-m", model,
		"-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
		// Trust only this run's explicit working directory. This suppresses the
		// first-use dialog without persisting trust into the user's Codex config.
		"-c", `projects.${JSON.stringify(cwd)}.trust_level=${JSON.stringify("trusted")}`,
		"--sandbox", "read-only",
		"--ask-for-approval", "never",
		...codexFeatureDisableArgs(),
		...disabledServerArgs,
		"--no-alt-screen",
		...(safeRules ? ["-c", `developer_instructions=${JSON.stringify(safeRules)}`] : []),
	];
}

/**
 * Minimal local-pane adapter for Grok and Codex: Herdr CLI only, no skill, no socket client.
 * `herdr agent prompt` takes one shell-free argv; the provider keeps large context behind an on-demand file reference.
 */
export function createHerdrCliAdapter(options: HerdrCliAdapterOptions = {}): HerdrAdapter {
	const cli = options.cli ?? createExecFileCli(options.command ?? "herdr");
	const createRunSuffix = options.createRunSuffix ?? (() => randomBytes(6).toString("hex"));
	const direction = options.direction ?? "right";
	const ratio = options.ratio ?? 0.42;
	const startupTimeoutMs = options.startupTimeoutMs ?? 90_000;
	const timeoutMs = options.timeoutMs ?? 600_000;
	const shellReadyTimeoutMs = options.shellReadyTimeoutMs ?? 30_000;
	const shellReadyPollMs = options.shellReadyPollMs ?? 200;
	const shellInitGraceMs = options.shellInitGraceMs ?? 3_000;
	const shellSettleMs = options.shellSettleMs ?? 3_000;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const resultPollMs = options.resultPollMs ?? 500;
	const completionStableReads = Math.max(2, options.completionStableReads ?? 3);
	const requireHerdrEnv = options.requireHerdrEnv ?? options.cli === undefined;

	async function run(args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
		return herdrResult(cli, args, signal);
	}

	return {
		async open({ target, cwd, rules }) {
			if (requireHerdrEnv && process.env.HERDR_ENV !== "1") {
				throw new Error(`${target.id} requires Pi to run inside Herdr (HERDR_ENV=1)`);
			}
			if (target.mode !== "local-pane" || (target.agent !== "grok" && target.agent !== "codex")) {
				throw new Error(`${target.id} is not implemented by the local Herdr CLI adapter. Configure a local Grok or Codex target.`);
			}
			const isGrok = target.agent === "grok";
			const model = isGrok ? options.model ?? target.model ?? DEFAULT_GROK_MODEL : options.codexModel ?? target.model;
			if (!model?.trim()) throw new Error(`Herdr Advisor target ${target.id} requires a model in provider configuration`);
			const reasoningEffort = isGrok ? target.reasoningEffort : options.codexReasoningEffort ?? target.reasoningEffort;
			if (!reasoningEffort) throw new Error(`${isGrok ? "Grok" : "Codex"} target ${target.id} requires reasoningEffort in provider configuration`);
			const runNamePrefix = isGrok
				? options.runNamePrefix ?? DEFAULT_RUN_NAME_PREFIX
				: options.codexRunNamePrefix ?? DEFAULT_CODEX_RUN_NAME_PREFIX;
			const effectiveRules = rules?.trim() || FALLBACK_ADVISOR_RULES;
			const runName = `${runNamePrefix}-${createRunSuffix()}`;
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(runName)) throw new Error(`Invalid generated Advisor run name: ${runName}`);
			const disabledServerArgs = isGrok ? [] : await disableInheritedMcp(cwd);
			const paneId = await createFreshAgentPane(cwd, target.agent, model, reasoningEffort, effectiveRules, runName, disabledServerArgs);
			let active: AbortController | undefined;
			let closed = false;

			const conversation: HerdrConversation = {
				async ask({ prompt, signal, onActivity }) {
					onActivity(`Submitting consultation to ${model}`);
					const baseline = await readPane(paneId, signal);
					active = new AbortController();
					if (signal.aborted) throw signal.reason ?? new Error("Aborted");
					const onAbort = () => active?.abort(signal.reason);
					signal.addEventListener("abort", onAbort, { once: true });
					try {
						await run(["agent", "prompt", runName, prompt], active.signal);
						if (isGrok) {
							onActivity("Waiting for Grok result");
							return await waitForGrokResult(paneId, runName, baseline, active.signal);
						}
						onActivity("Waiting for Codex result");
						return await waitForCodexResult(paneId, runName, baseline, active.signal);
					} finally {
						signal.removeEventListener("abort", onAbort);
						active = undefined;
					}
				},
				async abort() {
					active?.abort(new Error("Pi Advisor aborted the Herdr consultation"));
					await run(["pane", "send-keys", paneId, "ctrl+c"]).catch(() => {});
				},
				async close() {
					if (closed) return;
					closed = true;
					active?.abort(new Error("Pi Advisor disposed the Herdr consultation"));
					await run(["pane", "close", paneId]).catch(() => {});
				},
			};
			return conversation;
		},
	};

	async function disableInheritedMcp(cwd: string): Promise<string[]> {
		// Empty TOML tables merge with inherited config; disable each effective server instead.
		const reader = options.codexCli ?? createExecFileCli("codex", cwd);
		// Inventory with the launch-time feature flags already disabled. Some Codex
		// builds inject feature-owned MCPs (for example cua_repl) that disappear when
		// their feature is off and cannot be overridden as ordinary configured servers.
		const raw = await herdrTextResult(reader, [...codexFeatureDisableArgs(), "mcp", "list", "--json"], undefined, "codex");
		const servers: unknown = JSON.parse(raw);
		if (!Array.isArray(servers)) throw new Error("Codex MCP inventory must be an array");
		return servers.flatMap((server: unknown) => {
			const name = asRecord(server)?.name;
			// Codex CLI splits override paths on dots; reject names that cannot be addressed safely.
			if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/u.test(name)) {
				throw new Error("Cannot safely disable an inherited Codex MCP server name");
			}
			return ["-c", `mcp_servers.${name}.enabled=false`];
		});
	}

	async function readPane(paneId: string, signal: AbortSignal): Promise<string> {
		return herdrTextResult(cli, [
			"pane", "read", paneId,
			"--source", "recent-unwrapped",
			"--lines", "1000",
		], signal);
	}

	function countOccurrences(text: string, marker: string): number {
		return text.split(marker).length - 1;
	}

	async function waitForGrokResult(paneId: string, runName: string, baseline: string, signal: AbortSignal): Promise<string> {
		const baselineCompletions = countOccurrences(baseline, GROK_COMPLETION_MARKER);
		const deadline = Date.now() + timeoutMs;
		let completedCandidate: string | undefined;
		let stableCompletedReads = 0;
		while (true) {
			const text = await readPane(paneId, signal);
			if (countOccurrences(text, GROK_COMPLETION_MARKER) > baselineCompletions) {
				if (text === completedCandidate) stableCompletedReads += 1;
				else {
					completedCandidate = text;
					stableCompletedReads = 1;
				}
				if (stableCompletedReads >= completionStableReads) return text;
			} else {
				completedCandidate = undefined;
				stableCompletedReads = 0;
			}
			const agent = await run(["agent", "get", runName], signal).then((result) => agentFrom(result.agent));
			if (agent?.agent_status === "blocked") {
				throw new Error("Grok is blocked in the pane; resolve the permission prompt, then retry");
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for Grok result after ${timeoutMs}ms`);
			await sleep(resultPollMs);
		}
	}

	async function waitForCodexResult(
		paneId: string,
		runName: string,
		baseline: string,
		signal: AbortSignal,
	): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		const baselineMarker = advisorSubmissionMarker(baseline);
		let candidate: string | undefined;
		let stableReads = 0;
		while (true) {
			const agent = await run(["agent", "get", runName], signal).then((result) => agentFrom(result.agent));
			if (agent?.agent_status === "blocked") {
				throw new Error("Codex is blocked in the pane; resolve the prompt, then retry");
			}
			const text = await readPane(paneId, signal);
			const marker = advisorSubmissionMarker(text);
			const hasNewResult = marker && (
				!baselineMarker
				|| marker.count > baselineMarker.count
				|| marker.fingerprint !== baselineMarker.fingerprint
			);
			if (hasNewResult) {
				const fingerprint = `${marker.count}\u0000${marker.fingerprint}`;
				if (fingerprint === candidate) stableReads += 1;
				else {
					candidate = fingerprint;
					stableReads = 1;
				}
				if (stableReads >= completionStableReads) return text;
			} else {
				candidate = undefined;
				stableReads = 0;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for Codex result after ${timeoutMs}ms`);
			await sleep(resultPollMs);
		}
	}

	async function createFreshAgentPane(
		cwd: string,
		agent: "grok" | "codex" | "claude-code",
		model: string,
		reasoningEffort: string | undefined,
		rules: string,
		runName: string,
		disabledServerArgs: string[],
	): Promise<string> {
		const current = paneFrom((await run(["pane", "current", "--current"])).pane);
		if (!current?.pane_id) throw new Error("Herdr did not report the current pane id");
		const split = paneFrom((await run([
			"pane", "split", "--pane", current.pane_id,
			"--direction", direction,
			"--ratio", String(ratio),
			"--cwd", cwd,
			"--no-focus",
		])).pane);
		if (!split?.pane_id) throw new Error("Herdr did not return the new Advisor pane id");
		try {
			await run(["pane", "rename", split.pane_id, runName]);
			await waitForAvailableShell(split.pane_id, true);
			// A newly spawned shell can already be the foreground process while its
			// terminal is still in canonical mode. On macOS that silently truncates
			// a long launch line at 1024 bytes, dropping the closing quote and Enter.
			// Give the interactive line editor time to initialize, then verify that
			// no startup hook took the foreground before submitting the command.
			if (shellSettleMs > 0) {
				await sleep(shellSettleMs);
				await waitForAvailableShell(split.pane_id, false);
			}
			await startAgent(split.pane_id, cwd, agent, model, reasoningEffort, rules, runName, disabledServerArgs);
			return split.pane_id;
		} catch (error) {
			await run(["pane", "close", split.pane_id]).catch(() => {});
			throw error;
		}
	}

	async function waitForAvailableShell(paneId: string, interruptStuckInitialization: boolean): Promise<void> {
		const startedAt = Date.now();
		const deadline = startedAt + shellReadyTimeoutMs;
		let interrupted = false;
		while (true) {
			const result = await run(["pane", "process-info", "--pane", paneId]);
			const info = asRecord(result.process_info);
			const shellPid = info?.shell_pid;
			const foregroundProcessGroupId = info?.foreground_process_group_id;
			if (typeof shellPid === "number" && foregroundProcessGroupId === shellPid) return;
			const now = Date.now();
			if (interruptStuckInitialization && !interrupted && now - startedAt >= shellInitGraceMs) {
				// Dedicated panes can be trapped indefinitely by shell startup hooks
				// (observed with pyenv-rehash). Interrupt once to recover the prompt.
				await run(["pane", "send-keys", paneId, "ctrl+c"]);
				interrupted = true;
			}
			if (now >= deadline) {
				throw new Error(`Timed out waiting for pane ${paneId} to finish shell initialization`);
			}
			await sleep(shellReadyPollMs);
		}
	}

	async function startAgent(
		paneId: string,
		cwd: string,
		agent: "grok" | "codex" | "claude-code",
		model: string,
		reasoningEffort: string | undefined,
		rules: string,
		runName: string,
		disabledServerArgs: string[],
	): Promise<void> {
		if (agent !== "grok" && agent !== "codex") throw new Error(`Unsupported local Herdr agent ${agent}`);
		if (!reasoningEffort) throw new Error(`${agent === "grok" ? "Grok" : "Codex"} reasoning effort was not configured`);
		const launchArgs = agent === "grok"
			? [...grokLaunchArgs(model, reasoningEffort, rules), "--minimal"]
			: codexLaunchArgs(model, reasoningEffort, cwd, disabledServerArgs, rules);
		await run([
			"agent", "start", runName,
			"--kind", agent,
			"--pane", paneId,
			"--timeout", String(startupTimeoutMs),
			"--",
			...launchArgs,
		]);
	}
}
