import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RUNTIME_PROVIDER_API_VERSION,
	RuntimeProviderError,
	type DriverRequest,
	type DriverRunResult,
	type RuntimeDriverProvider,
	type RuntimeProviderHost,
	type RuntimeSelection,
} from "pi-advisor-core";

export type HerdrAdvisorTargetId = string;
export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent";

export interface HerdrAdvisorTarget {
	id: HerdrAdvisorTargetId;
	label: string;
	mode: "local-pane" | "remote";
	agent: "grok" | "codex" | "claude-code";
	/** Shown in `/mode` and run metadata. Launch args belong to the adapter. */
	model?: string;
	/** Provider-owned reasoning effort for agents whose launcher supports it. */
	reasoningEffort?: CodexReasoningEffort;
	/** Provider-owned alias. Hostnames, credentials, pane ids, and ports stay out of Pi Advisor config. */
	destination?: string;
}

export interface HerdrConversation {
	ask(input: {
		prompt: string;
		signal: AbortSignal;
		onActivity(text: string): void;
	}): Promise<string>;
	abort(): Promise<void>;
	close?(): Promise<void>;
}

/** Implement this boundary with the Herdr CLI. A Runtime Provider executes TypeScript, not an Agent Skill. */
export interface HerdrAdapter {
	open(input: {
		target: HerdrAdvisorTarget;
		runId: string;
		cwd: string;
		rules?: string;
	}): Promise<HerdrConversation>;
}

export interface HerdrAdvisorProviderOptions {
	adapter: HerdrAdapter;
	targets?: readonly HerdrAdvisorTarget[];
}

export const exampleHerdrTargets: readonly HerdrAdvisorTarget[] = [
	{
		id: "grok-4.6-high",
		label: "Grok · grok-4.6 · high",
		mode: "local-pane",
		agent: "grok",
		model: "grok-4.6",
		reasoningEffort: "high",
	},
	{
		id: "claude-code-remote",
		label: "Claude Code · Herdr remote",
		mode: "remote",
		agent: "claude-code",
	},
];

const VERDICTS = new Set(["safe_to_proceed", "proceed_with_changes", "blocked", "need_more_information"]);
const CONFIDENCE = new Set(["low", "medium", "high"]);

interface AdvisorSubmission {
	verdict: string;
	confidence: string;
	report_markdown: string;
}

function isAdvisorObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value)
		&& typeof (value as Record<string, unknown>).verdict === "string"
		&& typeof (value as Record<string, unknown>).confidence === "string"
		&& typeof (value as Record<string, unknown>).report_markdown === "string";
}

function repairTerminalWrappedJson(candidate: string): string {
	return candidate
		.replace(/\s+\d{1,2}:\d{2}\s(?:AM|PM)(?=\r?\n)/gu, "")
		.replace(/\r?\n[\t │┆┃]*/gu, "")
		.replace(/[█]+/gu, "")
		.trim();
}

function validAdvisorCandidate(candidate: string): string | undefined {
	for (const value of [candidate, repairTerminalWrappedJson(candidate)]) {
		try {
			if (isAdvisorObject(JSON.parse(value))) return value;
		} catch {}
	}
	return undefined;
}

function advisorCandidates(raw: string): string[] {
	const trimmed = raw.trim();
	const whole = validAdvisorCandidate(trimmed);
	if (whole) return [whole];
	const candidates: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < raw.length; index++) {
		const character = raw[index]!
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === "\"") inString = false;
			continue;
		}
		if (character === "\"") {
			inString = true;
			continue;
		}
		if (character === "{") {
			if (depth === 0) start = index;
			depth += 1;
		} else if (character === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				const candidate = validAdvisorCandidate(raw.slice(start, index + 1));
				if (candidate) candidates.push(candidate);
			}
		}
	}
	return candidates;
}

/** Take the last matching object, including fenced results retained from earlier turns. */
function extractJsonObject(raw: string): string {
	return advisorCandidates(raw).at(-1) ?? raw.trim();
}

function latestCompletedGrokText(raw: string): string {
	const end = raw.lastIndexOf("Worked for");
	const completed = end >= 0 ? raw.slice(0, end) : raw;
	const thought = completed.lastIndexOf("◆ Thought");
	const block = thought >= 0 ? completed.slice(thought) : completed.slice(-4000);
	return block
		.split(/\r?\n/u)
		.map((line) => line
			.replace(/^[\t │┆┃┌└]+/u, "")
			.replace(/\s+\d{1,2}:\d{2}\s(?:AM|PM)\s*$/u, "")
			.replace(/[█]+\s*$/u, "")
			.trimEnd())
		.filter((line) => !/^◆ Thought(?: for .*)?$/u.test(line.trim()))
		.join("\n")
		.trim() || raw.trim();
}

function fallbackAdvisorSubmission(raw: string): AdvisorSubmission {
	return {
		verdict: "need_more_information",
		confidence: "low",
		report_markdown: latestCompletedGrokText(raw),
	};
}

function parseAdvisorSubmission(raw: string): AdvisorSubmission {
	let parsed: unknown;
	try {
		parsed = JSON.parse(extractJsonObject(raw));
	} catch (error) {
		throw new RuntimeProviderError(`Herdr advisor returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new RuntimeProviderError("Herdr advisor result must be a JSON object");
	}
	const value = parsed as Record<string, unknown>;
	if (typeof value.verdict !== "string" || !VERDICTS.has(value.verdict)) {
		throw new RuntimeProviderError("Herdr advisor result has an invalid verdict");
	}
	if (typeof value.confidence !== "string" || !CONFIDENCE.has(value.confidence)) {
		throw new RuntimeProviderError("Herdr advisor result has an invalid confidence");
	}
	if (typeof value.report_markdown !== "string" || !value.report_markdown.trim()) {
		throw new RuntimeProviderError("Herdr advisor result requires non-empty report_markdown");
	}
	return {
		verdict: value.verdict,
		confidence: value.confidence,
		report_markdown: value.report_markdown,
	};
}

export interface AdvisorSubmissionMarker {
	count: number;
	fingerprint: string;
}

/** Identify completed structured results independently of animated terminal chrome. */
export function advisorSubmissionMarker(raw: string): AdvisorSubmissionMarker | undefined {
	const candidates = advisorCandidates(raw);
	const fingerprint = candidates.at(-1);
	return fingerprint ? { count: candidates.length, fingerprint } : undefined;
}

/** Session rules for Grok `--rules`. Keep this out of the pane user message. */
export function grokAdvisorRules(systemPrompt: string): string {
	return [
		systemPrompt.trim(),
		"Stay read-only. Do not edit files or run mutating commands.",
		"Finish with one compact JSON object: verdict, confidence, report_markdown.",
		"Keep report_markdown under 1200 characters so the terminal result stays bounded.",
		"verdict: safe_to_proceed | proceed_with_changes | blocked | need_more_information",
		"confidence: low | medium | high",
	].join("\n");
}

interface ContextReference {
	dir: string;
	path: string;
	bytes: number;
}

function materializedContext(request: DriverRequest): string | undefined {
	const prefix = `${request.task}\n\n# Context packet\n\n`;
	return request.prompt.startsWith(prefix) ? request.prompt.slice(prefix.length).trim() : undefined;
}

async function writeContextReference(request: DriverRequest): Promise<ContextReference | undefined> {
	const context = materializedContext(request);
	if (!context) return undefined;
	const dir = await mkdtemp(join(tmpdir(), "pi-advisor-context-"));
	const path = join(dir, "context.md");
	try {
		await writeFile(path, `${context}\n`, { encoding: "utf8", mode: 0o600 });
		return { dir, path, bytes: Buffer.byteLength(context, "utf8") };
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

/** Keep the first pane message lean; the local Grok can read the bounded packet only when the task needs it. */
function consultationText(request: DriverRequest, message?: string, context?: ContextReference): string {
	if (message !== undefined) return message.trim();
	if (!context) return request.prompt.trim();
	const sources = request.context
		? [
			request.context.files?.length ? `${request.context.files.length} scope path(s)` : undefined,
			request.context.diff ? "working-tree diff" : undefined,
			request.context.text?.length ? `${request.context.text.length} text block(s)` : undefined,
		].filter(Boolean).join(", ")
		: "selected context";
	return [
		request.task.trim(),
		`Optional context packet (${context.bytes} bytes; ${sources || "selected context"}): ${context.path}`,
		"Read it only if the task needs diff, scoped-file, or inherited-conversation evidence.",
	].join("\n\n");
}

function targetFor(selection: RuntimeSelection, targets: readonly HerdrAdvisorTarget[]): HerdrAdvisorTarget {
	const id = selection.target ?? "grok-4.6-high";
	const target = targets.find((candidate) => candidate.id === id);
	if (!target) {
		throw new RuntimeProviderError(`Unknown Herdr advisor target ${JSON.stringify(id)}. Available: ${targets.map((item) => item.id).join(", ")}`);
	}
	return target;
}

async function resultFrom(
	conversation: HerdrConversation,
	request: DriverRequest,
	host: RuntimeProviderHost,
	controller: AbortController,
	message?: string,
	context?: ContextReference,
): Promise<DriverRunResult> {
	const raw = await conversation.ask({
		prompt: consultationText(request, message, context),
		signal: controller.signal,
		onActivity: (text) => host.emit({ type: "progress", text }),
	});
	let submitted: AdvisorSubmission;
	try {
		submitted = parseAdvisorSubmission(raw);
	} catch {
		submitted = fallbackAdvisorSubmission(raw);
	}
	return {
		text: submitted.report_markdown,
		submitted,
		transcript: raw,
	};
}

/** A complete provider example; only the HerdrAdapter is installation-specific. */
export function createHerdrAdvisorProvider(options: HerdrAdvisorProviderOptions): RuntimeDriverProvider {
	const targets = options.targets ?? exampleHerdrTargets;
	return {
		id: "herdr-advisor",
		apiVersion: RUNTIME_PROVIDER_API_VERSION,
		displayName: "Herdr Advisor Examples",
		capabilities: {
			resume: true,
			steer: false,
			followUp: false,
			contextModes: ["fresh", "selected", "fork"],
			modelResolution: "provider",
			policyEnforcement: "adapter",
			structuredOutput: true,
		},
		describeTarget(selection) {
			const target = targetFor(selection, targets);
			return {
				label: target.label,
				model: target.model ?? target.agent,
				location: target.mode === "remote" ? "remote" : "local",
				note: "Read-only enforcement is owned by the Herdr adapter and external agent configuration.",
			};
		},
		concurrencyKey(selection, request) {
			const target = targetFor(selection, targets);
			return target.mode === "local-pane"
				? `herdr-advisor:${target.id}:${request.id}`
				: `herdr-advisor:${target.id}:${target.destination ?? "default"}`;
		},
		async create(selection, request, host) {
			const target = targetFor(selection, targets);
			let conversation: HerdrConversation | undefined;
			let context: ContextReference | undefined;
			let controller = new AbortController();

			async function ensureContext(): Promise<ContextReference | undefined> {
				if (target.mode !== "local-pane") return undefined;
				context ??= await writeContextReference(request);
				return context;
			}

			async function ensureConversation(): Promise<HerdrConversation> {
				if (conversation) return conversation;
				host.emit({ type: "progress", text: `Connecting to ${target.label}` });
				conversation = await options.adapter.open({
					target,
					runId: request.id,
					cwd: request.cwd,
					rules: grokAdvisorRules(request.profile.systemPrompt),
				});
				return conversation;
			}

			return {
				async run() {
					return resultFrom(await ensureConversation(), request, host, controller, undefined, await ensureContext());
				},
				async resume(message) {
					controller = new AbortController();
					host.emit({ type: "progress", text: `Continuing ${target.label}` });
					return resultFrom(await ensureConversation(), request, host, controller, message, context);
				},
				async abort() {
					controller.abort(new Error("Pi Advisor aborted the Herdr consultation"));
					await conversation?.abort();
				},
				async dispose() {
					try {
						await conversation?.close?.();
					} finally {
						if (context) await rm(context.dir, { recursive: true, force: true });
					}
				},
			};
		},
	};
}
