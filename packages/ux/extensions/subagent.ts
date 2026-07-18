/**
 * pi extension exposing the generic subagent runtime as a `subagent` tool
 * plus a `/subagents` command, with a rich TUI display modeled on the
 * Amp / Claude Code subagent UIs: a live "N subagents running" overview
 * widget, a compact renderCall line, and a renderResult view that shows
 * milestones/activity while running and a full markdown report when done.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import {
	SubagentManager,
	loadProfileFile,
	pruneSubagentRuns,
	type ContextInput,
	type SpawnOptions,
	type SubagentEvent,
	type SubagentHandle,
	type SubagentProfile,
	type SubagentResult,
	type SubagentStatus,
	type UsageSnapshot,
} from "pi-subagent-core";
import {
	builtInAgentNames,
	createModelResolver,
	loadBuiltInAgent,
	oracleReportSchema,
	type BuiltInAgentName,
} from "../src/index.ts";

// Shared parameter fragments so the generic tool and the per-role tools describe identical fields identically.
const taskParam = Type.String({ description: "The task for the subagent" });
const filesParam = Type.Optional(Type.Array(Type.String(), {
	description: "Optional files to inject into the subagent context packet",
}));
const inheritConversationParam = Type.Optional(Type.Boolean({
	description: "Fork the current conversation into the subagent so it inherits the parent context. Overrides the agent's context mode to fork; requires a persisted session.",
}));
const backgroundParam = Type.Optional(Type.Boolean({
	description: "Start the run in the background and return immediately with a run id; fetch the result later with subagent_result.",
}));
const includeDiffParam = (defaultTrue: boolean) => Type.Optional(Type.Boolean({
	description: `Inject the current git working tree diff (the working tree compared against HEAD) into the subagent context packet.${defaultTrue ? " Defaults to true; set false to opt out." : ""}`,
}));

const parameters = Type.Object({
	agent: Type.String({
		description: `Agent to run: one of ${builtInAgentNames.join(", ")}, or a path to a profile .md file`,
	}),
	task: taskParam,
	files: filesParam,
	includeDiff: includeDiffParam(false),
	inheritConversation: inheritConversationParam,
	writeScope: Type.Optional(Type.Array(Type.String(), {
		description: "Restrict the subagent's file writes to these globs (relative to cwd).",
	})),
	maxTurns: Type.Optional(Type.Number({
		description: "Cap the subagent's turn budget for this run.",
	})),
	background: backgroundParam,
});

const oracleParameters = Type.Object({
	task: Type.String({ description: "The decision, plan, diff, or failing-test situation to get a read-only second opinion on" }),
	files: filesParam,
	includeDiff: includeDiffParam(true),
	inheritConversation: inheritConversationParam,
	background: backgroundParam,
});

const searchParameters = Type.Object({
	task: Type.String({ description: "What to locate in the repository (paths, symbols, callers, config)" }),
	files: filesParam,
	background: backgroundParam,
});

const reviewerParameters = Type.Object({
	task: Type.String({ description: "The change to review; describe intent and point at the diff or files" }),
	files: filesParam,
	includeDiff: includeDiffParam(true),
	background: backgroundParam,
});

const resultParameters = Type.Object({
	id: Type.String({ description: "Run id returned by a background subagent call" }),
	wait: Type.Optional(Type.Boolean({ description: "Block until the run reaches a terminal state before returning." })),
});

const sendParameters = Type.Object({
	id: Type.String({ description: "Run id of a subagent run in this session" }),
	message: Type.String({ description: "Message to send. A running run is redirected (steered) mid-flight; a completed run continues the conversation with a new turn." }),
	wait: Type.Optional(Type.Boolean({ description: "When continuing a completed run, block for the new result (default true). Ignored while steering a running run." })),
});

const ORACLE_TOOL_DESCRIPTION =
	"Consult Oracle, a read-only senior reasoner, for a second opinion before acting. It returns a verdict, confidence, and a Markdown report; it never edits files. The current working-tree diff is included by default.\n" +
	"Use Oracle when: the change touches auth, billing, permissions, data migration, or a public API contract; tests are failing and the root cause is not yet confirmed; you are choosing between architectural approaches; or your confidence in the plan is low. " +
	"Do not use Oracle for typo fixes, renames, small clearly-scoped bugs, or file search (use the search tool instead).";

/** Normalized inputs shared by the generic and per-role subagent tools. */
export interface AgentRunParams {
	task: string;
	files?: string[];
	includeDiff?: boolean;
	inheritConversation?: boolean;
	writeScope?: string[];
	maxTurns?: number;
	background?: boolean;
}

/** Declarative spec for a dedicated built-in-role tool: its trigger surface and how its params map onto a run. */
export interface RoleToolSpec {
	name: BuiltInAgentName;
	label: string;
	description: string;
	parameters: TSchema;
	toRunParams: (params: Record<string, unknown>) => AgentRunParams;
}

/**
 * One dedicated tool per built-in role. Each is a thin, role-tailored trigger surface over the shared run machinery;
 * `toRunParams` applies the role's defaults (e.g. Oracle and Reviewer include the working-tree diff unless opted out).
 */
export const roleToolSpecs: RoleToolSpec[] = [
	{
		name: "oracle",
		label: "Oracle",
		description: ORACLE_TOOL_DESCRIPTION,
		parameters: oracleParameters,
		toRunParams: (params) => ({
			task: params.task as string,
			files: params.files as string[] | undefined,
			includeDiff: (params.includeDiff as boolean | undefined) ?? true,
			inheritConversation: params.inheritConversation as boolean | undefined,
			background: params.background as boolean | undefined,
		}),
	},
	{
		name: "search",
		label: "Search",
		description:
			"Fast read-only repository reconnaissance. Use BEFORE grepping around yourself when the search is non-trivial " +
			"(finding where a symbol is defined and used, tracing a call path, locating config). Returns exact paths and symbols; never edits files.",
		parameters: searchParameters,
		toRunParams: (params) => ({
			task: params.task as string,
			files: params.files as string[] | undefined,
			background: params.background as boolean | undefined,
		}),
	},
	{
		name: "reviewer",
		label: "Reviewer",
		description:
			"Adversarial review of a diff or change for concrete bugs, behavioral regressions, security risks, and missing tests. " +
			"The current working-tree diff is included by default; point it at the intent and any extra files. Read-only; cites exact files.",
		parameters: reviewerParameters,
		toRunParams: (params) => ({
			task: params.task as string,
			files: params.files as string[] | undefined,
			includeDiff: (params.includeDiff as boolean | undefined) ?? true,
			background: params.background as boolean | undefined,
		}),
	},
];

const MODEL_CONFIG_FILE = "subagent-kit.json";
const ORACLE_GUIDANCE = `Consider consulting the oracle subagent (read-only second opinion) before editing when:
- the change touches auth, billing, permissions, data migration, or a public API contract;
- tests are failing and the root cause is not yet confirmed;
- you are choosing between architectural approaches;
- your own confidence in the plan is low.
Always tell the user you are consulting oracle and why. Never use oracle for typo fixes, renames, small clearly-scoped bugs, or file search (use the search tool instead).`;

/** Enum sets for Oracle routing, derived from the shared output schema so they are never hardcoded twice. */
function schemaEnum(key: string): Set<string> {
	const prop = (oracleReportSchema as { properties?: Record<string, { enum?: unknown }> }).properties?.[key];
	return new Set(Array.isArray(prop?.enum) ? (prop.enum as string[]) : []);
}
const ORACLE_VERDICTS = schemaEnum("verdict");
const ORACLE_CONFIDENCE = schemaEnum("confidence");

const DISCLOSURE_LIMIT = 20;
const TERMINAL_STATUSES = new Set<SubagentStatus>(["completed", "failed", "aborted", "timeout"]);

export interface SubagentUserConfig {
	agents: Record<string, { model?: string }>;
	oracleGuidance?: boolean;
	artifactsDir?: string;
	retentionDays?: number;
	maxRuns?: number;
}

export interface OracleReportView {
	verdict: string;
	confidence: string;
	reportMarkdown: string;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validateNonNegativeNumber(value: unknown, path: string, key: string): void {
	if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
		throw new Error(`Invalid ${path}: ${key} must be a non-negative number`);
	}
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
	const root = parsed as Record<string, unknown>;
	const agents = root.agents;
	const config: SubagentUserConfig = { agents: {} };
	if (agents !== undefined) {
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
		config.agents = agents as SubagentUserConfig["agents"];
	}
	if (root.oracleGuidance !== undefined) {
		if (typeof root.oracleGuidance !== "boolean") throw new Error(`Invalid ${path}: oracleGuidance must be a boolean`);
		config.oracleGuidance = root.oracleGuidance;
	}
	if (root.artifactsDir !== undefined) {
		if (typeof root.artifactsDir !== "string" || !root.artifactsDir.trim()) throw new Error(`Invalid ${path}: artifactsDir must be a non-empty string`);
		config.artifactsDir = root.artifactsDir;
	}
	validateNonNegativeNumber(root.retentionDays, path, "retentionDays");
	validateNonNegativeNumber(root.maxRuns, path, "maxRuns");
	if (root.retentionDays !== undefined) config.retentionDays = root.retentionDays as number;
	if (root.maxRuns !== undefined) config.maxRuns = root.maxRuns as number;
	return config;
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

/** Resolve the per-project artifacts bucket, honoring an explicit override relative to cwd. */
export function resolveArtifactsDir(cwd: string, override?: string): string {
	if (override) return isAbsolute(override) ? override : resolve(cwd, override);
	const collapsed = cwd.replace(/[^a-zA-Z0-9]+/g, "-");
	const slug = collapsed.slice(-40).replace(/^-+|-+$/g, "");
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
	return join(getAgentDir(), "subagent-runs", `${slug}-${hash}`);
}

/** Ask the host to approve or deny a suspended tool call; fail closed when no interactive UI is available. */
export async function escalationDecision(
	ui: Pick<ExtensionUIContext, "confirm">,
	hasUI: boolean,
	event: { tool: string; question: string },
): Promise<"allow" | "deny"> {
	if (!hasUI) return "deny";
	const approved = await ui.confirm("Subagent permission request", `${event.tool}: ${event.question}`);
	return approved ? "allow" : "deny";
}

function isBuiltIn(name: string): name is BuiltInAgentName {
	return (builtInAgentNames as readonly string[]).includes(name);
}

/** Structured details streamed via onUpdate and returned in the final tool result. */
interface RunDetails {
	id: string;
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
	filesReadMore?: string;
	filesModifiedMore?: string;
	artifactsDir?: string;
	verdict?: string;
	confidence?: string;
	error?: string;
	finalText?: string;
}

interface TrackedRun {
	handle: SubagentHandle;
	profile: SubagentProfile;
	details: RunDetails;
	artifactsDir: string;
	finalize: Promise<SubagentResult>;
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

/** Cap a disclosure list for the parent-facing surfaces; the full list stays in artifacts. */
function capDisclosure(paths: string[], artifactsDir?: string): { list: string[]; more?: string } {
	if (paths.length <= DISCLOSURE_LIMIT) return { list: paths };
	const remaining = paths.length - DISCLOSURE_LIMIT;
	return { list: paths.slice(0, DISCLOSURE_LIMIT), more: `(+${remaining} more, see artifacts${artifactsDir ? ` ${artifactsDir}` : ""})` };
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

/** Fold a terminal result into the streamed details, capping disclosure for parent-facing surfaces. */
function applyResult(details: RunDetails, result: SubagentResult): void {
	details.status = result.status;
	details.usage = result.usage;
	details.artifactsDir = result.artifacts?.dir;
	const read = capDisclosure(result.disclosure.filesRead, result.artifacts?.dir);
	const modified = capDisclosure(result.disclosure.filesModified, result.artifacts?.dir);
	details.filesRead = read.list;
	details.filesReadMore = read.more;
	details.filesModified = modified.list;
	details.filesModifiedMore = modified.more;
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
}

/** Build the completed-run summary text shared by the foreground path and subagent_result. */
function completedSummary(profileName: string, result: SubagentResult, details: RunDetails): string {
	const readLine = details.filesRead.length
		? `read: ${details.filesRead.join(", ")}${details.filesReadMore ? ` ${details.filesReadMore}` : ""}`
		: "";
	const modifiedLine = details.filesModified.length
		? `modified: ${details.filesModified.join(", ")}${details.filesModifiedMore ? ` ${details.filesModifiedMore}` : ""}`
		: "";
	return [
		`agent: ${profileName} · status: ${result.status} · turns: ${result.usage.turns} · cost: $${result.usage.cost.toFixed(4)}`,
		readLine,
		modifiedLine,
		result.error ? `error(${result.error.kind}): ${result.error.message}` : "",
		result.artifacts?.dir ? `artifacts: ${result.artifacts.dir}` : "",
		"",
		details.finalText ?? "",
	].filter((line) => line !== "").join("\n");
}

/** Compact call line; per-role tools pass their fixed role name, the generic tool reads it from args. */
function renderCallFor(fixedAgent?: string) {
	// Accept any tool's args shape; only the generic tool carries an `agent` field, and `task` is common.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (args: any, theme: Theme) => {
		const agentName = fixedAgent ?? (typeof args?.agent === "string" ? args.agent : undefined) ?? "...";
		const firstLine = (typeof args?.task === "string" ? args.task : "").split("\n")[0] ?? "";
		const preview = firstLine.length > 70 ? `${firstLine.slice(0, 70)}...` : firstLine;
		const text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", agentName) +
			`\n${theme.fg("dim", preview)}`;
		return new Text(text, 0, 0);
	};
}

/** Rich result view shared by every subagent tool; it keys off details.agent, so the role name is preserved. */
function renderRunResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
) {
	const details = result.details as RunDetails | undefined;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text ?? "(no output)" : "(no output)", 0, 0);
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
		const suffix = details.filesReadMore ? `, ${details.filesReadMore}` : "";
		container.addChild(new Text(theme.fg("muted", "read: ") + theme.fg("dim", details.filesRead.join(", ") + suffix), 0, 0));
	}
	if (details.filesModified.length > 0) {
		const suffix = details.filesModifiedMore ? `, ${details.filesModifiedMore}` : "";
		container.addChild(
			new Text(theme.fg("muted", "modified: ") + theme.fg("dim", details.filesModified.join(", ") + suffix), 0, 0),
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
}

export default function subagentExtension(pi: ExtensionAPI) {
	const managers = new Map<string, { manager: SubagentManager; artifactsDir: string }>();
	const trackedRuns = new Map<string, TrackedRun>();

	const getManager = (ctx: ExtensionContext, config: SubagentUserConfig): { manager: SubagentManager; artifactsDir: string } => {
		const existing = managers.get(ctx.cwd);
		if (existing) return existing;
		const artifactsDir = resolveArtifactsDir(ctx.cwd, config.artifactsDir);
		const resolveModelFn = createModelResolver({ registry: ctx.modelRegistry, parentModel: ctx.model });
		const manager = new SubagentManager({
			cwd: ctx.cwd,
			authStorage: ctx.modelRegistry.authStorage,
			modelRegistry: ctx.modelRegistry,
			resolveModel: resolveModelFn,
			artifactsDir,
		});
		const entry = { manager, artifactsDir };
		managers.set(ctx.cwd, entry);
		// Lazy retention: fire-and-forget prune of this project's bucket; never fail a spawn on cleanup errors.
		void pruneSubagentRuns(artifactsDir, {
			retentionDays: config.retentionDays ?? 14,
			maxRuns: config.maxRuns ?? 200,
		}).catch(() => {});
		return entry;
	};

	pi.on("session_shutdown", async () => {
		await Promise.all([...managers.values()].map((entry) => entry.manager.abortAll()));
	});

	// Oracle consultation guidance now lives in the dedicated `oracle` tool description, so it no longer needs to
	// be injected into the parent system prompt. The `oracleGuidance` config key is still accepted for
	// backwards compatibility (see loadSubagentConfig) but has no effect.

	/** Spawn a run, wire live streaming/overview, and return a detached finalize promise. */
	const startRun = (
		ctx: ExtensionContext,
		profile: SubagentProfile,
		task: string,
		spawnOptions: SpawnOptions,
		artifactsBucket: string,
		manager: SubagentManager,
		onUpdate: ((update: { content: { type: "text"; text: string }[]; details: RunDetails }) => void) | undefined,
		background: boolean,
	): TrackedRun => {
		const handle = manager.spawn(profile, task, spawnOptions);
		const details: RunDetails = {
			id: handle.id,
			agent: profile.name,
			task,
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
			if (background) return;
			const preview = [
				`subagent ${details.agent} · ${statusWord(details.status)}`,
				...details.milestones.slice(-3),
				...details.activity.slice(-3),
			].join("\n");
			onUpdate?.({ content: [{ type: "text", text: preview }], details });
		};

		const unsubscribe = handle.subscribe((event: SubagentEvent) => {
			if (event.type === "progress") {
				details.milestones.push(event.text);
			} else if (event.type === "permission_blocked") {
				details.milestones.push(`⛔ ${event.tool}: ${event.reason}`);
			} else if (event.type === "escalation") {
				void escalationDecision(ctx.ui, ctx.hasUI, event)
					.catch(() => "deny" as const)
					.then((decision) => {
						handle.resolveEscalation(event.id, decision);
						details.milestones.push(`${decision === "allow" ? "✅ allowed" : "⛔ denied"} escalation: ${event.tool}`);
						emit();
					});
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

		const finalize = handle.wait().then((result) => {
			applyResult(details, result);
			return result;
		}).finally(() => {
			// Subscription cleanup is tied to run termination, not to the tool call that started it.
			unsubscribe();
			activeRuns.delete(handle.id);
			renderOverview(ctx);
		});

		const tracked: TrackedRun = { handle, profile, details, artifactsDir: join(artifactsBucket, handle.id), finalize };
		trackedRuns.set(handle.id, tracked);
		return tracked;
	};

	/** Shared spawn/return path for the generic and per-role tools; per-role tools are thin wrappers over this. */
	const runAgentTool = async (
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onUpdate: ((update: { content: { type: "text"; text: string }[]; details: RunDetails }) => void) | undefined,
		profile: SubagentProfile,
		params: AgentRunParams,
	) => {
		const config = await loadSubagentConfig();
		const { manager, artifactsDir } = getManager(ctx, config);

		const forkRequested = params.inheritConversation === true || profile.contextMode === "fork";
		const sessionFile = forkRequested ? ctx.sessionManager.getSessionFile() : undefined;
		if (forkRequested && !sessionFile) {
			throw new Error(`${profile.name} requires a persisted parent session to inherit the conversation`);
		}
		const leafId = sessionFile ? ctx.sessionManager.getLeafId() : undefined;
		const context = contextForSubagent(
			params.files,
			params.includeDiff,
			sessionFile ? { sessionFile, ...(leafId ? { entryId: leafId } : {}) } : undefined,
		);

		const overrides: Partial<SubagentProfile> = {};
		const configuredModel = config.agents[profile.name]?.model;
		if (configuredModel) overrides.model = configuredModel;
		if (forkRequested) overrides.contextMode = "fork";
		if (params.writeScope?.length) {
			overrides.permission = {
				...profile.permission,
				write: { allow: params.writeScope, ...(profile.permission?.write?.deny ? { deny: profile.permission.write.deny } : {}) },
			};
		}
		if (typeof params.maxTurns === "number") overrides.maxTurns = params.maxTurns;

		const background = params.background === true;
		const spawnOptions: SpawnOptions = {
			...(context ? { context } : {}),
			...(signal && !background ? { signal } : {}),
			...(Object.keys(overrides).length ? { overrides } : {}),
		};

		const tracked = startRun(ctx, profile, params.task, spawnOptions, artifactsDir, manager, onUpdate, background);

		if (background) {
			const text = [
				`agent: ${profile.name} · started in background · id: ${tracked.handle.id}`,
				`artifacts: ${tracked.artifactsDir}`,
				`Fetch the result with subagent_result { id: ${JSON.stringify(tracked.handle.id)} }.`,
			].join("\n");
			return { content: [{ type: "text" as const, text }], details: tracked.details, isError: false };
		}

		const result = await tracked.finalize;
		return {
			content: [{ type: "text" as const, text: completedSummary(profile.name, result, tracked.details) }],
			details: tracked.details,
			isError: result.status !== "completed",
		};
	};

	/** Register a dedicated tool for one built-in role; it resolves the same profile and shares the run machinery. */
	const registerRoleTool = (spec: RoleToolSpec): void => {
		pi.registerTool({
			name: spec.name,
			label: spec.label,
			description: spec.description,
			parameters: spec.parameters,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const profile = await loadBuiltInAgent(spec.name);
				return runAgentTool(ctx, signal, onUpdate, profile, spec.toRunParams(params as Record<string, unknown>));
			},
			renderCall: renderCallFor(spec.name),
			renderResult: renderRunResult,
		});
	};
	for (const spec of roleToolSpecs) registerRoleTool(spec);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run a custom role card in an isolated child agent and return its result. " +
			`Primarily for profile .md paths (e.g. the bundled worker card for scoped implementation). The ${roleToolSpecs.map((spec) => spec.name).join(", ")} roles each have their own dedicated tool, which are the preferred triggers; ` +
			`this tool also accepts any built-in name (${builtInAgentNames.join(", ")}).`,
		parameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const profile: SubagentProfile = isBuiltIn(params.agent)
				? await loadBuiltInAgent(params.agent)
				: await loadProfileFile(params.agent);
			return runAgentTool(ctx, signal, onUpdate, profile, params);
		},
		renderCall: renderCallFor(),
		renderResult: renderRunResult,
	});

	pi.registerTool({
		name: "subagent_result",
		label: "Subagent Result",
		description:
			"Fetch the result of a background subagent run by id. Pass wait: true to block until it finishes. " +
			"This also returns the latest result of a run that was continued with subagent_send.",
		parameters: resultParameters,
		async execute(_toolCallId, params) {
			const tracked = trackedRuns.get(params.id);
			if (!tracked) {
				return { content: [{ type: "text", text: `No subagent run with id ${params.id}` }], details: undefined, isError: true };
			}
			const terminal = TERMINAL_STATUSES.has(tracked.handle.status);
			if (params.wait || terminal) {
				const result = await tracked.finalize;
				return {
					content: [{ type: "text", text: completedSummary(tracked.profile.name, result, tracked.details) }],
					details: tracked.details,
					isError: result.status !== "completed",
				};
			}
			const details = tracked.details;
			const text = [
				`agent: ${details.agent} · status: ${statusWord(details.status)} · turns: ${details.usage.turns}`,
				`id: ${tracked.handle.id} · artifacts: ${tracked.artifactsDir}`,
				...details.milestones.slice(-5),
			].join("\n");
			return { content: [{ type: "text", text }], details, isError: false };
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Subagent Send",
		description:
			"Send a follow-up message to an existing subagent run in this session. " +
			"If the run is still running it is redirected mid-flight (steered) and this returns immediately; the run's own result surfaces via its original call or subagent_result. " +
			"If the run has completed, its conversation continues with a new turn on the retained session, and (unless wait: false) this blocks and returns the new result. " +
			"Runs that ended as failed, aborted, or timed out cannot be continued.",
		parameters: sendParameters,
		async execute(_toolCallId, params) {
			const tracked = trackedRuns.get(params.id);
			if (!tracked) {
				return { content: [{ type: "text", text: `No subagent run with id ${params.id}` }], details: undefined, isError: true };
			}
			const status = tracked.handle.status;
			if (!TERMINAL_STATUSES.has(status)) {
				// A live run is redirected via steer (interrupt); its terminal result still arrives on the original path.
				tracked.handle.steer(params.message);
				tracked.details.milestones.push(`↪ steered: ${params.message.split("\n")[0]?.slice(0, 60) ?? ""}`);
				const text = `agent: ${tracked.details.agent} · steered running run ${tracked.handle.id}. Fetch the eventual result with subagent_result { id: ${JSON.stringify(tracked.handle.id)} }.`;
				return { content: [{ type: "text", text }], details: tracked.details, isError: false };
			}
			if (status !== "completed") {
				return { content: [{ type: "text", text: `Run ${params.id} ended as ${status} and cannot be continued.` }], details: tracked.details, isError: true };
			}
			// Continue a completed run on its retained session. Core resolves failures as data, not rejections.
			if (params.wait === false) {
				tracked.finalize = tracked.handle.resume(params.message).then((result) => {
					applyResult(tracked.details, result);
					return result;
				});
				const text = `agent: ${tracked.details.agent} · continuing completed run ${tracked.handle.id} in background. Fetch the new result with subagent_result { id: ${JSON.stringify(tracked.handle.id)} }.`;
				return { content: [{ type: "text", text }], details: tracked.details, isError: false };
			}
			const result = await tracked.handle.resume(params.message);
			applyResult(tracked.details, result);
			tracked.finalize = Promise.resolve(result);
			return {
				content: [{ type: "text", text: completedSummary(tracked.profile.name, result, tracked.details) }],
				details: tracked.details,
				isError: result.status !== "completed",
			};
		},
		renderCall: renderCallFor("send"),
		renderResult: renderRunResult,
	});

	pi.registerCommand("subagents", {
		description: "List subagent runs in this session, or `abort <id>` to abort one",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "abort") {
				const id = parts[1];
				const tracked = id ? trackedRuns.get(id) : undefined;
				if (!tracked) {
					if (ctx.hasUI) ctx.ui.notify(id ? `No subagent run with id ${id}` : "Usage: /subagents abort <id>", "error");
					return;
				}
				await tracked.handle.abort();
				if (ctx.hasUI) ctx.ui.notify(`Aborted subagent ${id}`, "info");
				return;
			}
			const lines = trackedRuns.size
				? [...trackedRuns.values()].map((tracked) => {
						const run = tracked.handle;
						const usage = run.usage;
						const model = resolveModel(run.profile, usage, ctx) ?? "";
						return (
							`${run.id}  ${run.profile.name}  ${run.status}  turns=${usage.turns}  ` +
							`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}  $${usage.cost.toFixed(4)}` +
							(model ? `  ${model}` : "") +
							`\n  ${tracked.artifactsDir}`
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
