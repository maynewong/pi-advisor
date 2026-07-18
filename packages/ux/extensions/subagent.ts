/**
 * pi extension exposing the generic subagent runtime as a `subagent` tool
 * plus a `/subagents` command, with a rich TUI display modeled on the
 * Amp / Claude Code subagent UIs: a live "N subagents running" overview
 * widget, a compact renderCall line, and a renderResult view that shows
 * milestones/activity while running and a full markdown report when done.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	SubagentManager,
	loadProfileFile,
	type ContextInput,
	type ModelSpec,
	type SubagentEvent,
	type SubagentHandle,
	type SubagentProfile,
	type SubagentStatus,
	type UsageSnapshot,
} from "pi-subagent-core";
import { builtInAgentNames, loadBuiltInAgent, type BuiltInAgentName } from "../src/index.ts";

const parameters = Type.Object({
	agent: Type.String({
		description: `Agent to run: one of ${builtInAgentNames.join(", ")}, or a path to a profile .md file`,
	}),
	task: Type.String({ description: "The task for the subagent" }),
	files: Type.Optional(Type.Array(Type.String(), {
		description: "Optional files to inject into the subagent context packet",
	})),
	includeDiff: Type.Optional(Type.Boolean({
		description: "Inject the current git working tree diff into the subagent context packet",
	})),
});

const STRONG_REASONING_ALIAS = "strong-reasoning";
const MODEL_CONFIG_FILE = "subagent-kit.json";
const ORACLE_GUIDANCE = `Consider consulting the oracle subagent (read-only second opinion) before editing when:
- the change touches auth, billing, permissions, data migration, or a public API contract;
- tests are failing and the root cause is not yet confirmed;
- you are choosing between architectural approaches;
- your own confidence in the plan is low.
Always tell the user you are consulting oracle and why. Never use oracle for typo fixes, renames, small clearly-scoped bugs, or file search (use scout for search).`;

const ORACLE_VERDICTS = new Set(["safe_to_proceed", "proceed_with_changes", "blocked", "need_more_information"]);
const ORACLE_CONFIDENCE = new Set(["low", "medium", "high"]);

export interface SubagentUserConfig {
	agents: Record<string, { model?: string }>;
}

export interface OracleReportView {
	verdict: string;
	confidence: string;
	reportMarkdown: string;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Load user-scoped agent overrides without reading project configuration or provider credentials. */
export async function loadSubagentConfig(agentDir = getAgentDir()): Promise<SubagentUserConfig> {
	const path = join(agentDir, MODEL_CONFIG_FILE);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return { agents: {} };
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid ${path}: expected an object`);
	const agents = (parsed as Record<string, unknown>).agents;
	if (agents === undefined) return { agents: {} };
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) throw new Error(`Invalid ${path}: agents must be an object`);
	for (const [name, settings] of Object.entries(agents)) {
		if (!name.trim() || !settings || typeof settings !== "object" || Array.isArray(settings)) {
			throw new Error(`Invalid ${path}: agents entries must be named objects`);
		}
		const model = (settings as Record<string, unknown>).model;
		if (model !== undefined && (typeof model !== "string" || !model.trim())) {
			throw new Error(`Invalid ${path}: agents.${name}.model must be a non-empty string`);
		}
	}
	return { agents: agents as SubagentUserConfig["agents"] };
}

/** Append the parent-facing consultation policy once per assembled prompt. */
export function appendOracleGuidance(systemPrompt: string): string {
	return systemPrompt.includes(ORACLE_GUIDANCE) ? systemPrompt : `${systemPrompt}\n\n${ORACLE_GUIDANCE}`;
}

/** Build a parent-agent request that invokes Oracle with the current working-tree diff. */
export function oracleCommandPrompt(question: string): string | undefined {
	const task = question.trim();
	if (!task) return undefined;
	return `Call the subagent tool with exactly these inputs:\n- agent: "oracle"\n- task: ${JSON.stringify(task)}\n- includeDiff: true\nTell me you are consulting Oracle before the tool call, then summarize its verdict.`;
}

/** Project validated Oracle schema output into fields consumed by the result renderer. */
export function oracleReportFromOutput(output: unknown): OracleReportView | undefined {
	if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
	const report = output as Record<string, unknown>;
	if (typeof report.verdict !== "string" || !ORACLE_VERDICTS.has(report.verdict)) return undefined;
	if (typeof report.confidence !== "string" || !ORACLE_CONFIDENCE.has(report.confidence)) return undefined;
	if (typeof report.report_markdown !== "string") return undefined;
	return { verdict: report.verdict, confidence: report.confidence, reportMarkdown: report.report_markdown };
}

/** Build only the caller-selected context, using execFile-backed git diff handling in core. */
export function contextForSubagent(
	files: string[] | undefined,
	includeDiff: boolean | undefined,
	forkFrom?: NonNullable<ContextInput["forkFrom"]>,
): ContextInput | undefined {
	if (!files?.length && !includeDiff && !forkFrom) return undefined;
	return {
		...(files?.length ? { files } : {}),
		...(includeDiff ? { diff: { base: "HEAD" } } : {}),
		...(forkFrom ? { forkFrom } : {}),
	};
}

type ExtensionModel = NonNullable<ExtensionContext["model"]>;

/** Resolve an agent's explicit model override; preserve profile and parent fallback behavior otherwise. */
export function resolveProfileModel(
	spec: ModelSpec | undefined,
	registry: ExtensionContext["modelRegistry"],
	parentModel: ExtensionContext["model"],
	configuredModel?: string,
): { model: ExtensionModel | undefined } {
	if (configuredModel || spec === STRONG_REASONING_ALIAS) {
		const target = configuredModel ?? STRONG_REASONING_ALIAS;
		const source = typeof spec === "string" ? spec : "profile";
		const available = registry.getAvailable();
		const slash = target.indexOf("/");
		const matches = slash > 0
			? available.filter((model) => model.provider === target.slice(0, slash) && model.id === target.slice(slash + 1))
			: available.filter((model) => model.id === target || model.name === target);
		if (matches.length === 1) return { model: matches[0] };
		if (matches.length > 1) {
			throw new Error(`Model selection for "${source}" is ambiguous: ${matches.map((model) => `${model.provider}/${model.id}`).join(", ")}`);
		}
		if (!configuredModel) return { model: parentModel };
		throw new Error(`Model selection for "${source}" target "${target}" is not available`);
	}
	if (spec && typeof spec !== "string") return { model: spec };
	if (typeof spec === "string") {
		const slash = spec.indexOf("/");
		return {
			model: slash > 0 ? registry.find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined,
		};
	}
	return { model: parentModel };
}

function isBuiltIn(name: string): name is BuiltInAgentName {
	return (builtInAgentNames as readonly string[]).includes(name);
}

/** Structured details streamed via onUpdate and returned in the final tool result. */
interface RunDetails {
	agent: string;
	task: string;
	model?: string;
	status: SubagentStatus;
	usage: UsageSnapshot;
	/** Major-progress notes surfaced by the subagent (and blocked-permission notices). */
	milestones: string[];
	/** Rolling window of recent low-level activity lines. */
	activity: string[];
	filesRead: string[];
	filesModified: string[];
	verdict?: string;
	confidence?: string;
	error?: string;
	finalText?: string;
}

const ACTIVITY_LIMIT = 6;
const COLLAPSED_LINE_LIMIT = 6;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageSnapshot, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function activityLine(event: SubagentEvent): string | undefined {
	switch (event.type) {
		case "tool_call":
			return event.summary ?? `→ ${event.name} ${event.argsPreview.slice(0, 60)}`;
		case "tool_result":
			return event.ok ? undefined : `← ${event.name} ${event.summary.slice(0, 60)}`;
		case "thought":
			return `✻ ${event.text}`;
		case "turn":
			return `turn ${event.index}`;
		default:
			return undefined;
	}
}

function resolveModel(profile: SubagentProfile, usage: UsageSnapshot, ctx: ExtensionContext): string | undefined {
	if (profile.model) return typeof profile.model === "string" ? profile.model : profile.model.id;
	if (usage.model) return usage.model;
	return ctx.model?.id;
}

function statusWord(status: SubagentStatus): string {
	switch (status) {
		case "waiting_permission": return "waiting for permission";
		case "queued": return "queued";
		case "running": return "running";
		case "completed": return "completed";
		case "failed": return "failed";
		case "aborted": return "aborted";
		case "timeout": return "timed out";
		default: return status;
	}
}

function statusIcon(status: SubagentStatus, theme: Theme): string {
	switch (status) {
		case "running":
		case "queued":
			return theme.fg("warning", "◐");
		case "waiting_permission":
			return theme.fg("warning", "⏸");
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
		case "timeout":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("muted", "⊘");
		default:
			return theme.fg("muted", "?");
	}
}

/** Overview lines shown above the editor while any subagent runs are active. */
const activeRuns = new Map<string, RunDetails>();

function overviewIcon(status: SubagentStatus): string {
	switch (status) {
		case "waiting_permission": return "⏸";
		case "completed": return "✓";
		case "failed":
		case "timeout": return "✗";
		case "aborted": return "⊘";
		default: return "◐";
	}
}

function renderOverview(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (activeRuns.size === 0) {
		ctx.ui.setWidget("subagent-overview", undefined);
		return;
	}
	const lines: string[] = [`Subagents · ${activeRuns.size} running`];
	for (const details of activeRuns.values()) {
		const usage = details.usage;
		const latest = details.activity[details.activity.length - 1] ?? details.milestones[details.milestones.length - 1] ?? "";
		const trimmedLatest = latest.length > 50 ? `${latest.slice(0, 50)}...` : latest;
		lines.push(
			[
				`${overviewIcon(details.status)} ${details.agent}`,
				statusWord(details.status),
				`${usage.turns} turns`,
				`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`,
				`$${usage.cost.toFixed(4)}`,
				details.model ?? "",
			]
				.filter(Boolean)
				.join(" · ") + (trimmedLatest ? ` — ${trimmedLatest}` : ""),
		);
	}
	ctx.ui.setWidget("subagent-overview", lines);
}

export default function subagentExtension(pi: ExtensionAPI) {
	let manager: SubagentManager | undefined;
	const runs: SubagentHandle[] = [];

	const getManager = (ctx: ExtensionContext): SubagentManager => {
		manager ??= new SubagentManager({
			cwd: ctx.cwd,
			authStorage: ctx.modelRegistry.authStorage,
			modelRegistry: ctx.modelRegistry,
			artifactsDir: `${ctx.cwd}/.pi/subagent-runs`,
		});
		return manager;
	};

	pi.on("session_shutdown", async () => {
		await manager?.abortAll();
	});

	pi.on("before_agent_start", (event) => ({ systemPrompt: appendOracleGuidance(event.systemPrompt) }));

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run a task in an isolated child agent and return its result. " +
			`Available agents: ${builtInAgentNames.join(", ")}, or pass a profile .md path. ` +
			"Use for reconnaissance, second opinions, reviews, and scoped implementation.",
		parameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const profile: SubagentProfile = isBuiltIn(params.agent)
				? await loadBuiltInAgent(params.agent)
				: await loadProfileFile(params.agent);
			const config = await loadSubagentConfig();
			const modelResolution = resolveProfileModel(profile.model, ctx.modelRegistry, ctx.model, config.agents[profile.name]?.model);
			const sessionFile = profile.contextMode === "fork" ? ctx.sessionManager.getSessionFile() : undefined;
			if (profile.contextMode === "fork" && !sessionFile) throw new Error(`${profile.name} requires a persisted parent session`);
			const leafId = sessionFile ? ctx.sessionManager.getLeafId() : undefined;
			const context = contextForSubagent(
				params.files,
				params.includeDiff,
				sessionFile ? { sessionFile, ...(leafId ? { entryId: leafId } : {}) } : undefined,
			);
			const handle = getManager(ctx).spawn(profile, params.task, {
				...(context ? { context } : {}),
				...(signal ? { signal } : {}),
				...(modelResolution.model ? { overrides: { model: modelResolution.model } } : {}),
			});
			runs.push(handle);

			const details: RunDetails = {
				agent: profile.name,
				task: params.task,
				model: resolveModel(handle.profile, handle.usage, ctx),
				status: handle.status,
				usage: handle.usage,
				milestones: [],
				activity: [],
				filesRead: [],
				filesModified: [],
			};
			activeRuns.set(handle.id, details);

			const emit = () => {
				details.status = handle.status;
				details.usage = handle.usage;
				details.model = resolveModel(handle.profile, handle.usage, ctx);
				renderOverview(ctx);
				const preview = [
					`subagent ${details.agent} · ${statusWord(details.status)}`,
					...details.milestones.slice(-3),
					...details.activity.slice(-3),
				].join("\n");
				onUpdate?.({
					content: [{ type: "text", text: preview }],
					details,
				});
			};

			const unsubscribe = handle.subscribe((event: SubagentEvent) => {
				if (event.type === "progress") {
					details.milestones.push(event.text);
				} else if (event.type === "permission_blocked") {
					details.milestones.push(`⛔ ${event.tool}: ${event.reason}`);
				} else if (event.type === "failed") {
					details.error = event.error;
				}
				const line = activityLine(event);
				if (line !== undefined) {
					details.activity.push(line);
					if (details.activity.length > ACTIVITY_LIMIT) details.activity.shift();
				}
				emit();
			});

			let result: Awaited<ReturnType<typeof handle.wait>>;
			try {
				result = await handle.wait();
			} finally {
				unsubscribe();
				activeRuns.delete(handle.id);
				renderOverview(ctx);
			}

			details.status = result.status;
			details.usage = result.usage;
			details.filesRead = result.disclosure.filesRead;
			details.filesModified = result.disclosure.filesModified;
			const oracleReport = oracleReportFromOutput(result.output);
			if (oracleReport) {
				details.verdict = oracleReport.verdict;
				details.confidence = oracleReport.confidence;
				details.finalText = oracleReport.reportMarkdown;
			} else {
				details.finalText = result.output !== undefined && typeof result.output !== "string"
					? JSON.stringify(result.output, null, 2)
					: result.text;
			}
			if (result.error) details.error = `${result.error.kind}: ${result.error.message}`;

			const summary = [
				`agent: ${profile.name} · status: ${result.status} · turns: ${result.usage.turns} · cost: $${result.usage.cost.toFixed(4)}`,
				result.disclosure.filesRead.length ? `read: ${result.disclosure.filesRead.join(", ")}` : "",
				result.disclosure.filesModified.length ? `modified: ${result.disclosure.filesModified.join(", ")}` : "",
				result.error ? `error(${result.error.kind}): ${result.error.message}` : "",
				"",
				details.finalText ?? "",
			].filter((line) => line !== "").join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details,
				isError: result.status !== "completed",
			};
		},

		renderCall(args, theme) {
			const agentName = args.agent || "...";
			const firstLine = (args.task ?? "").split("\n")[0] ?? "";
			const preview = firstLine.length > 70 ? `${firstLine.slice(0, 70)}...` : firstLine;
			const text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				`\n${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as RunDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const titleLine = () => {
				const usageStr = formatUsageStats(details.usage, details.model);
				let line =
					`${statusIcon(details.status, theme)} ${theme.fg("toolTitle", theme.bold(details.agent))} ` +
					theme.fg("muted", statusWord(details.status));
				if (usageStr) line += ` ${theme.fg("dim", usageStr)}`;
				if (details.verdict) line += ` ${theme.fg(details.verdict === "blocked" ? "error" : "accent", details.verdict)}`;
				if (details.confidence) line += ` ${theme.fg("dim", `confidence:${details.confidence}`)}`;
				return line;
			};

			if (isPartial) {
				let text = titleLine();
				for (const milestone of details.milestones) {
					text += `\n${theme.fg("accent", "● ")}${milestone}`;
				}
				for (const line of details.activity) {
					text += `\n  ${theme.fg("dim", line)}`;
				}
				return new Text(text, 0, 0);
			}

			if (!expanded) {
				let text = titleLine();
				for (const milestone of details.milestones) {
					text += `\n${theme.fg("accent", "● ")}${milestone}`;
				}
				if (details.error) {
					text += `\n${theme.fg("error", details.error)}`;
				} else if (details.finalText) {
					const lines = details.finalText.split("\n");
					const shown = lines.slice(0, COLLAPSED_LINE_LIMIT);
					text += `\n${theme.fg("toolOutput", shown.join("\n"))}`;
					if (lines.length > COLLAPSED_LINE_LIMIT) text += `\n${theme.fg("muted", "(ctrl+o expand)")}`;
				}
				return new Text(text, 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(titleLine(), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
			if (details.milestones.length > 0) {
				container.addChild(new Spacer(1));
				for (const milestone of details.milestones) {
					container.addChild(new Text(theme.fg("accent", "● ") + milestone, 0, 0));
				}
			}
			if (details.filesRead.length > 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "read: ") + theme.fg("dim", details.filesRead.join(", ")), 0, 0));
			}
			if (details.filesModified.length > 0) {
				container.addChild(
					new Text(theme.fg("muted", "modified: ") + theme.fg("dim", details.filesModified.join(", ")), 0, 0),
				);
			}
			if (details.error) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("error", details.error), 0, 0));
			}
			if (details.finalText) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(details.finalText.trim(), 0, 0, getMarkdownTheme()));
			}
			const usageStr = formatUsageStats(details.usage, details.model);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			return container;
		},
	});

	pi.registerCommand("subagents", {
		description: "List subagent runs in this session",
		handler: async (_args, ctx) => {
			const lines = runs.length
				? runs.map((run) => {
						const usage = run.usage;
						const model = resolveModel(run.profile, usage, ctx) ?? "";
						return (
							`${run.profile.name}  ${run.status}  turns=${usage.turns}  ` +
							`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}  $${usage.cost.toFixed(4)}` +
							(model ? `  ${model}` : "")
						);
					})
				: ["No subagent runs yet."];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("oracle", {
		description: "Ask Oracle for a read-only second opinion with the current diff",
		handler: async (args, ctx) => {
			const prompt = oracleCommandPrompt(args);
			if (!prompt) {
				ctx.ui.notify("Usage: /oracle <question>", "error");
				return;
			}
			pi.sendUserMessage(prompt);
		},
	});
}
