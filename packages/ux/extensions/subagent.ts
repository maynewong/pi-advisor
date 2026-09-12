/**
 * pi extension exposing the generic subagent runtime as a `subagent` tool
 * plus a `/subagents` command, with a rich TUI display modeled on the
 * Amp / Claude Code subagent UIs: a live "N subagents running" overview
 * widget, a compact renderCall line, and a renderResult view that shows
 * milestones/activity while running and a full markdown report when done.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionUIContext, ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import {
	SubagentManager,
	assertRuntimeProviderSupports,
	createPiSdkDriver,
	createRuntimeProviderDispatcher,
	discoverRuntimeProviders,
	mergeRuntimeProviderMetadata,
	RUNTIME_PROVIDER_REGISTER_EVENT,
	resolveRuntimeProviderConcurrencyKey,
	runtimeProviderRunMetadata,
	validateRuntimeDriverProvider,
	loadProfileFile,
	pruneSubagentRuns,
	type ContextInput,
	type SpawnOptions,
	type SubagentEvent,
	type SubagentHandle,
	type SubagentProfile,
	type DriverRequest,
	type RuntimeDriverFactory,
	type RuntimeDriverProvider,
	type RuntimeSelection,
	type SubagentResult,
	type SubagentStatus,
	type SubagentTranscriptItem,
	type SubagentTranscriptMessage,
	type UsageSnapshot,
} from "pi-advisor-core";
import {
	builtInAgentNames,
	buildRoutingTable,
	createModelResolver,
	DEFAULT_MODE,
	filterPoolSize,
	loadBuiltInAgent,
	MODE_ROUTING_TABLE,
	MODEL_TIERS,
	advisorReportSchema,
	PARENT_MODE_ENTRY,
	sameModel,
	SUBAGENT_MODES,
	type BuiltInAgentName,
	type ModelResolverOptions,
	type ResolvedRoleRouting,
	type SubagentMode,
	type TierRule,
} from "../src/index.ts";
import { SubagentViewer, type ViewerRun } from "../src/viewer.ts";
import { createSubagentSwitchEditor, SubagentWorkspaceController, type WorkspaceRunView } from "../src/workspace.ts";
import {
	ambientHeadline,
	compactActivity,
	displayAgentName,
	firstTaskLine,
	selectAmbientRuns,
} from "../src/presentation.ts";

// Shared parameter fragments so the generic tool and the per-role tools describe identical fields identically.
const taskParam = Type.String({ description: "The task for the subagent" });
const filesParam = Type.Optional(Type.Array(Type.String(), {
	description: "Optional paths to give the subagent as scope. Contents are not inlined; the child reads them if needed.",
}));
const inheritConversationParam = Type.Optional(Type.Boolean({
	description: "Include the parent conversation as read-only user/assistant text. Requires a persisted session.",
}));
const backgroundParam = Type.Optional(Type.Boolean({
	description: "Start the run in the background and return immediately with a run id; fetch the result later with subagent_result.",
}));
const includeDiffParam = (defaultTrue: boolean) => Type.Optional(Type.Boolean({
	description: defaultTrue
		? "Include the working-tree diff. Defaults to true; set false to opt out."
		: "Include the working-tree diff.",
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

const advisorParameters = Type.Object({
	task: Type.String({ description: "The decision, plan, diff, or failing-test situation to get a read-only second opinion on" }),
	files: filesParam,
	includeDiff: includeDiffParam(true),
	inheritConversation: inheritConversationParam,
	background: backgroundParam,
});

const searchParameters = Type.Object({
	task: Type.String({
		description: "The delegated breadth question. Name what the parent already inspected and the lateral scope to cover.",
	}),
	root: Type.Optional(Type.String({
		description: "Repository root to search from. May be absolute or relative to the current cwd. Use this instead of passing a repository outside cwd through files.",
	})),
	files: filesParam,
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

const ADVISOR_TOOL_DESCRIPTION =
	"Read-only second opinion before acting on auth, billing, permissions, migrations, public APIs, failing tests, a low-confidence plan, or a finished change that needs adversarial review for bugs, regressions, security risks, and missing tests. Do not use for typos, renames, file search, or small clearly-scoped bugs.";

/** Normalized inputs shared by the generic and per-role subagent tools. */
export interface AgentRunParams {
	task: string;
	files?: string[];
	includeDiff?: boolean;
	inheritConversation?: boolean;
	writeScope?: string[];
	maxTurns?: number;
	background?: boolean;
	/** Alternate cwd for a read-only repository run. Currently exposed only by the built-in search tool. */
	root?: string;
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
 * `toRunParams` applies the role's defaults (e.g. Advisor includes the working-tree diff unless opted out).
 */
export const roleToolSpecs: RoleToolSpec[] = [
	{
		name: "advisor",
		label: "Advisor",
		description: ADVISOR_TOOL_DESCRIPTION,
		parameters: advisorParameters,
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
			"Read-only breadth reconnaissance after the parent has inspected the primary path and files it may edit. Use for exhaustive callers, cross-repository or parallel questions; do not delegate the initial read of the main path.",
		parameters: searchParameters,
		toRunParams: (params) => ({
			task: params.task as string,
			root: params.root as string | undefined,
			files: params.files as string[] | undefined,
			background: params.background as boolean | undefined,
		}),
	},
];

const ADVISOR_CONFIG_FILE = "pi-advisor.json";
const LEGACY_CONFIG_FILE = "subagent-kit.json";
const ADVISOR_GUIDANCE = `Consider consulting the advisor specialist (read-only second opinion) before editing when:
- the change touches auth, billing, permissions, data migration, or a public API contract;
- tests are failing and the root cause is not yet confirmed;
- you are choosing between architectural approaches;
- your own confidence in the plan is low.
Always tell the user you are consulting advisor and why. Never use advisor for typo fixes, renames, small clearly-scoped bugs, or file search (use the search tool instead).`;

/** Enum sets for Advisor routing, derived from the shared output schema so they are never hardcoded twice. */
function schemaEnum(key: string): Set<string> {
	const prop = (advisorReportSchema as { properties?: Record<string, { enum?: unknown }> }).properties?.[key];
	return new Set(Array.isArray(prop?.enum) ? (prop.enum as string[]) : []);
}
const ADVISOR_VERDICTS = schemaEnum("verdict");
const ADVISOR_CONFIDENCE = schemaEnum("confidence");

const DISCLOSURE_LIMIT = 20;
const TERMINAL_STATUSES = new Set<SubagentStatus>(["completed", "failed", "aborted", "timeout"]);

export interface AgentUserConfig {
	/** Optional external runtime target. Provider configuration and secrets stay outside pi-advisor.json. */
	runtime?: RuntimeSelection;
	/** Optional exact authenticated model id overriding the mode table. */
	model?: string;
	/** Explicit provider reasoning effort. */
	thinkingLevel?: NonNullable<SubagentProfile["thinkingLevel"]>;
	/** Override the routed investigation budget for this role. */
	maxTurns?: number;
	/** Turns reserved for final-answer-only mode after maxTurns. */
	finalizeTurns?: number;
	/** Override this role's total context-packet budget in UTF-8 bytes. */
	contextMaxBytes?: number;
	/**
	 * Tiers this override applies to. When set, the override takes effect ONLY in these effort tiers;
	 * in every other tier the role falls back to the shipped mode table. Omit to apply it in all tiers.
	 */
	onlyInModes?: SubagentMode[];
}

/**
 * Resolve a role's override for a given tier. A tier-gated override (`onlyInModes`) is dropped outside its tiers,
 * so the role falls back to the shipped mode table there; an ungated override applies in every tier. Kept pure and
 * exported so both the run path and the `/mode` display resolve overrides identically.
 */
export function effectiveAgentConfig(agent: AgentUserConfig | undefined, mode: SubagentMode): AgentUserConfig | undefined {
	if (!agent) return undefined;
	if (agent.onlyInModes && !agent.onlyInModes.includes(mode)) return undefined;
	return agent;
}

/** Merge a JSON-declared tier route over the legacy shipped entry, preserving default turn budgets when omitted. */
export function effectiveModeRoute(
	config: Pick<SubagentUserConfig, "modes">,
	mode: SubagentMode,
	role: string,
): ModeRouteConfig | undefined {
	const configured = config.modes?.[mode]?.[role];
	const legacy = role === "agent" ? PARENT_MODE_ENTRY[mode] : MODE_ROUTING_TABLE[role]?.[mode];
	if (!configured) return legacy;
	return { ...legacy, ...configured };
}

export interface ModeRouteConfig {
	/** Exact authenticated model id, preferably provider-qualified. */
	model: string;
	thinkingLevel: NonNullable<SubagentProfile["thinkingLevel"]>;
	maxTurns?: number;
}

export interface ModeUserConfig {
	/** Parent/orchestrator route for this tier. */
	agent?: ModeRouteConfig;
	/** Subagent role routes for this tier. */
	[key: string]: ModeRouteConfig | undefined;
}

export interface SubagentUserConfig {
	/** Selected named configuration; absent for legacy flat settings. */
	profile?: string;
	agents: Record<string, AgentUserConfig>;
	/** Complete per-tier routing declared by the user. Entries override the legacy shipped table. */
	modes?: Partial<Record<SubagentMode, ModeUserConfig>>;
	/** Preferred effort tier. It does not auto-activate a new session unless autoActivate is true. */
	mode?: SubagentMode | "off";
	/** Expose tools automatically in every new session. Default false. */
	autoActivate?: boolean;
	advisorGuidance?: boolean;
	artifactsDir?: string;
	retentionDays?: number;
	maxRuns?: number;
	/** Legacy alias-routing settings, retained only for config compatibility. */
	modelFilter?: string | string[];
	tiers?: TierRule[];
	/** Exact model for the parent session in every mode, overriding the parent mode table. */
	parentModel?: string;
}

export interface AdvisorReportView {
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

export type RoutingProfileConfig = Pick<SubagentUserConfig, "parentModel" | "agents" | "modes">;

/** File declaration, kept separate from the single resolved session configuration. */
export type PiAdvisorConfig = Omit<SubagentUserConfig, "agents"> & {
	agents?: Record<string, AgentUserConfig>;
	profiles?: Record<string, RoutingProfileConfig>;
};

type ConfigFileSource = "advisor" | "legacy" | "missing";

interface RawConfigFile {
	path: string;
	source: ConfigFileSource;
	raw?: string;
}

/** Prefer Pi Advisor's canonical file and fall back only when it is absent. */
async function readRawConfigFile(agentDir: string): Promise<RawConfigFile> {
	const advisorPath = join(agentDir, ADVISOR_CONFIG_FILE);
	try {
		return { path: advisorPath, source: "advisor", raw: await readFile(advisorPath, "utf8") };
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
	const legacyPath = join(agentDir, LEGACY_CONFIG_FILE);
	try {
		return { path: legacyPath, source: "legacy", raw: await readFile(legacyPath, "utf8") };
	} catch (error) {
		if (isMissingFile(error)) return { path: advisorPath, source: "missing" };
		throw error;
	}
}

function parseRawConfig(raw: string, path: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid ${path}: expected an object`);
	return parsed as Record<string, unknown>;
}

/** Load only user-scoped settings, never project configuration or provider credentials. */
export async function loadPiAdvisorConfig(agentDir = getAgentDir()): Promise<PiAdvisorConfig> {
	const config = await readRawConfigFile(agentDir);
	if (!config.raw) return { agents: {} };
	return parsePiAdvisorConfig(parseRawConfig(config.raw, config.path), config.path);
}

export async function loadSubagentConfig(agentDir = getAgentDir()): Promise<SubagentUserConfig> {
	return resolveProfile(await loadPiAdvisorConfig(agentDir));
}

/** Pure parsing makes validation identical for file loads and profile switches. */
export function parsePiAdvisorConfig(parsed: unknown, path = ADVISOR_CONFIG_FILE): PiAdvisorConfig {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid ${path}: expected an object`);
	const root = structuredClone(parsed) as Record<string, unknown>;
	if (root.profiles === undefined) {
		if (root.profile !== undefined) throw new Error(`Invalid ${path}: profile requires profiles`);
		return parseFlatSubagentConfig(root, path);
	}
	if (!root.profiles || typeof root.profiles !== "object" || Array.isArray(root.profiles) || Object.keys(root.profiles).length === 0) {
		throw new Error(`Invalid ${path}: profiles must be a non-empty object`);
	}
	for (const key of ["parentModel", "agents", "modes"]) {
		if (root[key] !== undefined) throw new Error(`Invalid ${path}: move top-level ${key} into profiles; routing sources cannot be mixed`);
	}
	if (typeof root.profile !== "string" || !Object.hasOwn(root.profiles, root.profile)) {
		throw new Error(`Invalid ${path}: profile must name an existing profiles entry`);
	}
	const profiles: Record<string, RoutingProfileConfig> = Object.create(null);
	for (const [name, rawProfile] of Object.entries(root.profiles)) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error(`Invalid ${path}: profile names must use letters, numbers, underscores or dashes`);
		if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) throw new Error(`Invalid ${path}: profiles.${name} must be an object`);
		for (const key of Object.keys(rawProfile)) {
			if (!["parentModel", "agents", "modes"].includes(key)) throw new Error(`Invalid ${path}: profiles.${name}.${key} is not supported`);
		}
		const profile = parseFlatSubagentConfig(rawProfile as Record<string, unknown>, `${path}: profiles.${name}`);
		validateProfileRoutes(profile, `${path}: profiles.${name}`);
		profiles[name] = profile;
	}
	const { agents: _agents, ...common } = parseFlatSubagentConfig(root, path);
	return { ...common, profile: root.profile, profiles };
}

/** Profiles never inherit routing from another profile or the shipped model table. */
export function resolveProfile(config: PiAdvisorConfig, name = config.profile): SubagentUserConfig {
	const { profiles, profile: _profile, ...common } = config;
	if (!profiles) {
		if (name !== undefined) throw new Error(`Unknown profile: ${name}`);
		return structuredClone({ ...common, agents: common.agents ?? {} });
	}
	if (name === undefined || !Object.hasOwn(profiles, name)) throw new Error(`Unknown profile: ${name ?? "(not selected)"}`);
	return structuredClone({ ...common, ...profiles[name], profile: name, agents: profiles[name].agents ?? {} });
}

function validateProfileRoutes(config: RoutingProfileConfig, path: string): void {
	const qualifiedModel = (model: string | undefined, key: string) => {
		if (model !== undefined && !/^[^/\s]+\/\S+$/.test(model)) throw new Error(`Invalid ${path}: ${key} must use provider/model-id`);
	};
	qualifiedModel(config.parentModel, "parentModel");
	for (const [role, agent] of Object.entries(config.agents)) qualifiedModel(agent.model, `agents.${role}.model`);
	for (const [mode, routes] of Object.entries(config.modes ?? {})) {
		for (const [role, route] of Object.entries(routes ?? {})) qualifiedModel(route?.model, `modes.${mode}.${role}.model`);
	}
	for (const mode of SUBAGENT_MODES) {
		if (!config.parentModel && !config.modes?.[mode]?.agent) throw new Error(`Invalid ${path}: missing parent route for ${mode}; set parentModel or modes.${mode}.agent`);
		for (const role of builtInAgentNames) {
			const agent = effectiveAgentConfig(config.agents[role], mode);
			if (!agent?.model && !agent?.runtime && !config.modes?.[mode]?.[role]) {
				throw new Error(`Invalid ${path}: missing ${role} route for ${mode}; profiles do not fall back to shipped models`);
			}
		}
	}
}

function parseFlatSubagentConfig(root: Record<string, unknown>, path: string): SubagentUserConfig {
	const agents = root.agents;
	const config: SubagentUserConfig = { agents: {} };
	if (agents !== undefined) {
		if (!agents || typeof agents !== "object" || Array.isArray(agents)) throw new Error(`Invalid ${path}: agents must be an object`);
		for (const [name, settings] of Object.entries(agents)) {
			if (!name.trim() || !settings || typeof settings !== "object" || Array.isArray(settings)) {
				throw new Error(`Invalid ${path}: agents entries must be named objects`);
			}
			const agent = settings as Record<string, unknown>;
			const model = agent.model;
			if (model !== undefined && (typeof model !== "string" || !model.trim())) {
				throw new Error(`Invalid ${path}: agents.${name}.model must be a non-empty exact model id`);
			}
			if (agent.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(agent.thinkingLevel as string)) {
				throw new Error(`Invalid ${path}: agents.${name}.thinkingLevel must be off, minimal, low, medium, high, or xhigh`);
			}
			// `finalizeAfterTurns` was used by early user configs to mean the finalize trigger. Preserve it as a
			// compatibility alias for maxTurns, while the new `finalizeTurns` controls the small answer-only window.
			if (agent.finalizeAfterTurns !== undefined) {
				if (typeof agent.finalizeAfterTurns !== "number" || !Number.isFinite(agent.finalizeAfterTurns) || agent.finalizeAfterTurns < 1) {
					throw new Error(`Invalid ${path}: agents.${name}.finalizeAfterTurns must be a positive number`);
				}
				if (agent.maxTurns === undefined) agent.maxTurns = agent.finalizeAfterTurns;
				delete agent.finalizeAfterTurns;
			}
			for (const key of ["maxTurns", "finalizeTurns", "contextMaxBytes"] as const) {
				if (agent[key] !== undefined && (typeof agent[key] !== "number" || !Number.isFinite(agent[key]) || agent[key] < 1)) {
					throw new Error(`Invalid ${path}: agents.${name}.${key} must be a positive number`);
				}
			}
			if (agent.driver !== undefined || agent.remote !== undefined) {
				throw new Error(`Invalid ${path}: agents.${name}.driver/remote are no longer supported by Pi Advisor; use runtime.provider/runtime.target from a separate runtime provider package`);
			}
			if (agent.runtime !== undefined) {
				if (!agent.runtime || typeof agent.runtime !== "object" || Array.isArray(agent.runtime)) {
					throw new Error(`Invalid ${path}: agents.${name}.runtime must be an object`);
				}
				const runtime = agent.runtime as Record<string, unknown>;
				if (typeof runtime.provider !== "string" || !runtime.provider.trim()) {
					throw new Error(`Invalid ${path}: agents.${name}.runtime.provider must be a non-empty string`);
				}
				if (runtime.target !== undefined && (typeof runtime.target !== "string" || !runtime.target.trim())) {
					throw new Error(`Invalid ${path}: agents.${name}.runtime.target must be a non-empty string when provided`);
				}
				for (const key of Object.keys(runtime)) {
					if (key !== "provider" && key !== "target") throw new Error(`Invalid ${path}: agents.${name}.runtime.${key} is not supported`);
				}
			}
			if (agent.onlyInModes !== undefined) {
				if (!Array.isArray(agent.onlyInModes) || agent.onlyInModes.length === 0
					|| !agent.onlyInModes.every((m) => typeof m === "string" && (SUBAGENT_MODES as readonly string[]).includes(m))) {
					throw new Error(`Invalid ${path}: agents.${name}.onlyInModes must be a non-empty array of ${SUBAGENT_MODES.join(", ")}`);
				}
			}
		}
		config.agents = agents as SubagentUserConfig["agents"];
	}
	if (root.modes !== undefined) {
		if (!root.modes || typeof root.modes !== "object" || Array.isArray(root.modes)) {
			throw new Error(`Invalid ${path}: modes must be an object`);
		}
		const modes: Partial<Record<SubagentMode, ModeUserConfig>> = {};
		for (const [mode, rawRoutes] of Object.entries(root.modes as Record<string, unknown>)) {
			if (!(SUBAGENT_MODES as readonly string[]).includes(mode)) {
				throw new Error(`Invalid ${path}: modes.${mode} is not a known tier (${SUBAGENT_MODES.join(", ")})`);
			}
			if (!rawRoutes || typeof rawRoutes !== "object" || Array.isArray(rawRoutes)) {
				throw new Error(`Invalid ${path}: modes.${mode} must be an object`);
			}
			const routes: ModeUserConfig = {};
			for (const [role, rawRoute] of Object.entries(rawRoutes as Record<string, unknown>)) {
				if (!rawRoute || typeof rawRoute !== "object" || Array.isArray(rawRoute)) {
					throw new Error(`Invalid ${path}: modes.${mode}.${role} must be an object`);
				}
				const route = rawRoute as Record<string, unknown>;
				if (typeof route.model !== "string" || !route.model.trim()) {
					throw new Error(`Invalid ${path}: modes.${mode}.${role}.model must be a non-empty exact model id`);
				}
				if (typeof route.thinkingLevel !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(route.thinkingLevel)) {
					throw new Error(`Invalid ${path}: modes.${mode}.${role}.thinkingLevel must be off, minimal, low, medium, high, or xhigh`);
				}
				if (route.maxTurns !== undefined && (typeof route.maxTurns !== "number" || !Number.isFinite(route.maxTurns) || route.maxTurns < 1)) {
					throw new Error(`Invalid ${path}: modes.${mode}.${role}.maxTurns must be a positive number`);
				}
				for (const key of Object.keys(route)) {
					if (key !== "model" && key !== "thinkingLevel" && key !== "maxTurns") {
						throw new Error(`Invalid ${path}: modes.${mode}.${role}.${key} is not supported`);
					}
				}
				routes[role] = route as unknown as ModeRouteConfig;
			}
			modes[mode as SubagentMode] = routes;
		}
		config.modes = modes;
	}
	if (root.mode !== undefined) {
		const validModes = [...SUBAGENT_MODES, "off"];
		if (typeof root.mode !== "string" || !validModes.includes(root.mode)) {
			throw new Error(`Invalid ${path}: mode must be one of ${validModes.join(", ")}`);
		}
		config.mode = root.mode as SubagentMode | "off";
	}
	if (root.autoActivate !== undefined) {
		if (typeof root.autoActivate !== "boolean") throw new Error(`Invalid ${path}: autoActivate must be a boolean`);
		config.autoActivate = root.autoActivate;
	}
	if (root.advisorGuidance !== undefined) {
		if (typeof root.advisorGuidance !== "boolean") throw new Error(`Invalid ${path}: advisorGuidance must be a boolean`);
		config.advisorGuidance = root.advisorGuidance;
	}
	if (root.artifactsDir !== undefined) {
		if (typeof root.artifactsDir !== "string" || !root.artifactsDir.trim()) throw new Error(`Invalid ${path}: artifactsDir must be a non-empty string`);
		config.artifactsDir = root.artifactsDir;
	}
	validateNonNegativeNumber(root.retentionDays, path, "retentionDays");
	validateNonNegativeNumber(root.maxRuns, path, "maxRuns");
	if (root.retentionDays !== undefined) config.retentionDays = root.retentionDays as number;
	if (root.maxRuns !== undefined) config.maxRuns = root.maxRuns as number;
	if (root.modelFilter !== undefined) config.modelFilter = validateModelFilter(root.modelFilter, path);
	if (root.tiers !== undefined) config.tiers = validateTiers(root.tiers, path);
	if (root.parentModel !== undefined) {
		if (typeof root.parentModel !== "string" || !root.parentModel.trim()) throw new Error(`Invalid ${path}: parentModel must be a non-empty string`);
		config.parentModel = root.parentModel;
	}
	return config;
}

/** Validate `modelFilter`: a non-empty string or a non-empty array of non-empty strings. */
function validateModelFilter(value: unknown, path: string): string | string[] {
	if (typeof value === "string") {
		if (!value.trim()) throw new Error(`Invalid ${path}: modelFilter must be a non-empty string`);
		return value;
	}
	if (Array.isArray(value) && value.length > 0 && value.every((keyword) => typeof keyword === "string" && keyword.trim())) {
		return value as string[];
	}
	throw new Error(`Invalid ${path}: modelFilter must be a non-empty string or array of non-empty strings`);
}

/** Validate `tiers`: an array of `{ pattern: non-empty string, tier: strong|mid|fast }`. */
function validateTiers(value: unknown, path: string): TierRule[] {
	if (!Array.isArray(value)) throw new Error(`Invalid ${path}: tiers must be an array`);
	return value.map((rule) => {
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`Invalid ${path}: tiers entries must be objects`);
		const { pattern, tier } = rule as Record<string, unknown>;
		if (typeof pattern !== "string" || !pattern.trim()) throw new Error(`Invalid ${path}: tiers[].pattern must be a non-empty string`);
		if (typeof tier !== "string" || !(MODEL_TIERS as readonly string[]).includes(tier)) {
			throw new Error(`Invalid ${path}: tiers[].tier must be one of ${MODEL_TIERS.join(", ")}`);
		}
		return { pattern, tier } as TierRule;
	});
}

/** Serialize in-process updates and atomically replace the canonical file, preserving unrelated user fields. */
const configWrites = new Map<string, Promise<void>>();
async function archiveLegacyConfig(agentDir: string): Promise<void> {
	const legacyPath = join(agentDir, LEGACY_CONFIG_FILE);
	const backupPath = `${legacyPath}.bak`;
	try {
		await stat(backupPath);
		return;
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
	await rename(legacyPath, backupPath);
}

function updateConfigFile(agentDir: string, update: (root: Record<string, unknown>) => void): Promise<void> {
	const path = join(agentDir, ADVISOR_CONFIG_FILE);
	const pending = (configWrites.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
		const current = await readRawConfigFile(agentDir);
		const root = current.raw ? parseRawConfig(current.raw, current.path) : {};
		update(root);
		await mkdir(agentDir, { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
		if (current.source === "legacy") await archiveLegacyConfig(agentDir);
	});
	configWrites.set(path, pending);
	void pending.finally(() => { if (configWrites.get(path) === pending) configWrites.delete(path); }).catch(() => {});
	return pending;
}

/** Persist only the preference. Existing sessions retain their own resolved snapshot. */
export async function persistProfile(name: string, agentDir = getAgentDir()): Promise<void> {
	await updateConfigFile(agentDir, (root) => {
		resolveProfile(parsePiAdvisorConfig({ ...root, profile: name }), name);
		root.profile = name;
	});
}

/** Persist a profile and tier together so the combined `/mode profile <name> <tier>` switch is atomic. */
export async function persistProfileMode(name: string, mode: SubagentMode | "off", agentDir = getAgentDir()): Promise<void> {
	await updateConfigFile(agentDir, (root) => {
		resolveProfile(parsePiAdvisorConfig({ ...root, profile: name, mode }), name);
		root.profile = name;
		root.mode = mode;
	});
}

export async function persistMode(mode: SubagentMode | "off", agentDir = getAgentDir()): Promise<void> {
	await updateConfigFile(agentDir, (root) => { root.mode = mode; });
}

/** Set or clear the legacy diagnostic filter without rewriting profile definitions. */
export async function persistModelFilter(filter: string | string[] | undefined, agentDir = getAgentDir()): Promise<void> {
	await updateConfigFile(agentDir, (root) => {
		if (filter === undefined) delete root.modelFilter;
		else root.modelFilter = filter;
	});
}

/** Append the parent-facing consultation policy once per assembled prompt. */
export function appendAdvisorGuidance(systemPrompt: string): string {
	return systemPrompt.includes(ADVISOR_GUIDANCE) ? systemPrompt : `${systemPrompt}\n\n${ADVISOR_GUIDANCE}`;
}

/**
 * The LLM-callable tools this extension registers. Activation gates exactly these off the model's tool set while
 * Pi Advisor is `off`; the `/mode`, `/subagents`, and `/advisor` commands stay available so the user can turn it on.
 */
export const KIT_TOOL_NAMES = ["advisor", "search", "subagent", "subagent_result", "subagent_send"] as const;

const RELOAD_ACTIVATION_STATE = Symbol.for("pi-advisor.reload-activation");

function reloadActivationStore(): Map<string, boolean> {
	const root = globalThis as typeof globalThis & { [key: symbol]: unknown };
	const existing = root[RELOAD_ACTIVATION_STATE];
	if (existing instanceof Map) return existing as Map<string, boolean>;
	const created = new Map<string, boolean>();
	root[RELOAD_ACTIVATION_STATE] = created;
	return created;
}

function activationSessionKey(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
	return ctx.sessionManager.getSessionFile() ?? `cwd:${ctx.cwd}`;
}

export function rememberReloadActivation(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	enabled: boolean,
): void {
	reloadActivationStore().set(activationSessionKey(ctx), enabled);
}

export function consumeReloadActivation(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): boolean | undefined {
	const store = reloadActivationStore();
	const key = activationSessionKey(ctx);
	const enabled = store.get(key);
	store.delete(key);
	return enabled;
}

/** Cross-session activation is opt-in. A persisted mode is only the preferred tier by default. */
export function isActivated(config: Pick<SubagentUserConfig, "mode" | "autoActivate">): boolean {
	return config.autoActivate === true && config.mode !== undefined && config.mode !== "off";
}

/**
 * Add or remove the kit's subagent tools from the model's active tool set, preserving every other tool. This is
 * how the kit ships deactivated: until `/mode low|medium|high|ultra` turns it on, the model never sees these tools.
 * Defensive about the host surface — `getActiveTools`/`setActiveTools` are absent in some non-interactive modes.
 */
export function applyToolActivation(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
	enabled: boolean,
): void {
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
	const active = new Set(pi.getActiveTools());
	const before = new Set(active);
	for (const name of KIT_TOOL_NAMES) {
		if (enabled) active.add(name);
		else active.delete(name);
	}
	// Only rewrite the active set when it actually changed, so we never clobber concurrently-registered tools needlessly.
	if (active.size !== before.size || [...active].some((name) => !before.has(name))) pi.setActiveTools([...active]);
}

/** Build a parent-agent request that invokes Advisor with the current working-tree diff. */
export function advisorCommandPrompt(question: string): string | undefined {
	const task = question.trim();
	if (!task) return undefined;
	return `Call the advisor tool with exactly these inputs:\n- task: ${JSON.stringify(task)}\n- includeDiff: true\nTell me you are consulting Advisor before the tool call, then summarize its verdict.`;
}

/** Project validated Advisor schema output into fields consumed by the result renderer. */
export function advisorReportFromOutput(output: unknown): AdvisorReportView | undefined {
	if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
	const report = output as Record<string, unknown>;
	if (typeof report.verdict !== "string" || !ADVISOR_VERDICTS.has(report.verdict)) return undefined;
	if (typeof report.confidence !== "string" || !ADVISOR_CONFIDENCE.has(report.confidence)) return undefined;
	if (typeof report.report_markdown !== "string") return undefined;
	return { verdict: report.verdict, confidence: report.confidence, reportMarkdown: report.report_markdown };
}

/** Resolve an explicitly selected run root without weakening Context Builder's per-cwd file boundary. */
export async function resolveAgentRunCwd(cwd: string, root: string | undefined): Promise<string> {
	if (!root?.trim()) return cwd;
	const candidate = resolve(cwd, root);
	const resolvedRoot = await realpath(candidate);
	const stats = await stat(resolvedRoot);
	if (!stats.isDirectory()) throw new Error(`Subagent root is not a directory: ${root}`);
	return resolvedRoot;
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

const INHERITED_CONVERSATION_LIMIT = 512_000;

function inheritedContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const value = block as Record<string, unknown>;
			if (value.type === "text" && typeof value.text === "string") return value.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Materialize a persisted Pi branch as user/assistant text. Tool traces and thinking stay out. */
export function inheritedConversationPacket(forkFrom: NonNullable<ContextInput["forkFrom"]>): string {
	const session = SessionManager.open(forkFrom.sessionFile);
	if (forkFrom.entryId) session.branch(forkFrom.entryId);
	const lines = session.buildSessionContext().messages.flatMap((message) => {
		const raw = message as unknown as Record<string, unknown>;
		if (raw.role === "user" || raw.role === "assistant") {
			const text = inheritedContentText(raw.content);
			if (!text) return [];
			return [`### ${raw.role}\n\n${text}`];
		}
		if ((raw.role === "compactionSummary" || raw.role === "branchSummary") && typeof raw.summary === "string") {
			return [`### ${String(raw.role)}\n\n${raw.summary}`];
		}
		return [];
	});
	const packet = `## Inherited parent conversation\n\n${lines.join("\n\n")}`;
	if (Buffer.byteLength(packet) <= INHERITED_CONVERSATION_LIMIT) return packet;
	return `${Buffer.from(packet).subarray(0, INHERITED_CONVERSATION_LIMIT).toString("utf8")}\n\n[Inherited conversation truncated by host]`;
}

/** Render one resolved routing row for `/mode`, flagging degraded rows with an explanation. */
export function formatRoutingRow(row: ResolvedRoleRouting): string {
	const source = row.manualModel ? " (manual override)" : "";
	const base = `${row.role} → ${row.modelId} · thinking ${row.thinkingLevel}${source}`;
	return row.degraded ? `${base} ⚠ ${row.degradedReason ?? row.reason}` : base;
}

/** Compact parent route for `/mode`. Turn budgets, pool size, and "model unchanged" stay out of the status line. */
export function formatParentRoute(config: Pick<SubagentUserConfig, "parentModel" | "modes">, mode: SubagentMode): string {
	if (config.parentModel) return `parent → ${config.parentModel} · thinking ${effectiveModeRoute(config, mode, "agent")!.thinkingLevel} (manual override)`;
	const entry = effectiveModeRoute(config, mode, "agent")!;
	return `parent → ${entry.model} · thinking ${entry.thinkingLevel}`;
}

/**
 * Apply the parent-session half of a mode switch. The Pi extension API exposes `setModel`/`setThinkingLevel`,
 * so `/mode` retunes the parent orchestrator too. Returns a one-line report of what changed.
 */
async function applyParentMode(
	pi: Pick<ExtensionAPI, "setModel" | "setThinkingLevel">,
	mode: SubagentMode,
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	config: Pick<SubagentUserConfig, "parentModel" | "modelFilter" | "tiers" | "modes">,
): Promise<string> {
	const entry = effectiveModeRoute(config, mode, "agent")!;
	pi.setThinkingLevel(entry.thinkingLevel);
	// A `parentModel` config override pins the exact model for the parent in both modes (thinking still mode-driven).
	if (config.parentModel) {
		const matches = findRegistryModels(ctx.modelRegistry, config.parentModel);
		const label = `${config.parentModel} (manual override)`;
		if (matches.length === 0) return `parent → thinking ${entry.thinkingLevel} ⚠ parentModel ${config.parentModel} not available in the registry`;
		if (matches.length > 1) {
			return `parent → thinking ${entry.thinkingLevel} ⚠ parentModel ${config.parentModel} is ambiguous: ${matches.map((model) => `${model.provider}/${model.id}`).join(", ")}`;
		}
		const target = matches[0];
		if (ctx.model && sameModel(target, ctx.model)) return `parent → ${label} · thinking ${entry.thinkingLevel}`;
		const ok = await pi.setModel(target);
		return ok
			? `parent → ${label} · thinking ${entry.thinkingLevel}`
			: `parent → thinking ${entry.thinkingLevel} ⚠ model switch to ${label} unavailable: no API key`;
	}
	const matches = findRegistryModels(ctx.modelRegistry, entry.model);
	if (matches.length !== 1) return `parent → thinking ${entry.thinkingLevel} ⚠ configured model ${entry.model} is ${matches.length === 0 ? "unavailable" : "ambiguous"}`;
	const target = matches[0];
	if (!ctx.model || !sameModel(target, ctx.model)) {
		const ok = await pi.setModel(target);
		return ok
			? `parent → ${entry.model} · thinking ${entry.thinkingLevel}`
			: `parent → thinking ${entry.thinkingLevel} ⚠ model switch to ${entry.model} unavailable: no API key`;
	}
	return `parent → ${entry.model} · thinking ${entry.thinkingLevel}`;
}

/** Validate the selected tier before changing either parent state or the persisted preference. */
export async function validateProfileSelection(
	config: SubagentUserConfig,
	mode: SubagentMode,
	registry: Pick<ExtensionContext["modelRegistry"], "getAvailable">,
	providers: ReadonlyMap<string, RuntimeDriverProvider>,
) {
	const requireModel = (target: string | undefined, role: string) => {
		if (!target) throw new Error(`Profile ${config.profile}: missing explicit ${role} model for ${mode}`);
		const matches = findRegistryModels(registry, target);
		if (matches.length !== 1) throw new Error(`Profile ${config.profile}: ${role} model ${target} is ${matches.length ? "ambiguous" : "unavailable"}`);
		return matches[0];
	};
	const parent = requireModel(config.parentModel ?? config.modes?.[mode]?.agent?.model, "parent");
	for (const role of new Set<string>([...builtInAgentNames, ...Object.keys(config.agents), ...Object.keys(config.modes?.[mode] ?? {}).filter((name) => name !== "agent")])) {
		const agent = effectiveAgentConfig(config.agents[role], mode);
		const target = agent?.model ?? config.modes?.[mode]?.[role]?.model;
		if (agent?.runtime) {
			const provider = providers.get(agent.runtime.provider);
			if (!provider) throw new Error(`Runtime provider ${JSON.stringify(agent.runtime.provider)} is not installed or enabled`);
			validateRuntimeDriverProvider(provider);
			if ((builtInAgentNames as readonly string[]).includes(role)) {
				assertRuntimeProviderSupports(provider, await loadBuiltInAgent(role as BuiltInAgentName));
			}
			if (provider.capabilities.modelResolution === "host") requireModel(target, role);
		} else {
			requireModel(target, role);
		}
	}
	return parent;
}

/** Find exact registry models by `provider/id` or bare id/name, preserving ambiguity for the caller. */
function findRegistryModels(registry: Pick<ExtensionContext["modelRegistry"], "getAvailable">, target: string) {
	const available = registry.getAvailable();
	const slash = target.indexOf("/");
	if (slash > 0) {
		const provider = target.slice(0, slash);
		const id = target.slice(slash + 1);
		return available.filter((model) => model.provider === provider && model.id === id);
	}
	return available.filter((model) => model.id === target || model.name === target);
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
	signal?: AbortSignal,
): Promise<"allow" | "deny"> {
	if (!hasUI) return "deny";
	const approved = await ui.confirm("Subagent permission request", `${event.tool}: ${event.question}`, signal ? { signal } : undefined);
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
	/** One-line note for notable runtime routing, such as a remote driver. */
	degradedNote?: string;
	status: SubagentStatus;
	usage: UsageSnapshot;
	/** Latest explicit progress text from the child. */
	progress?: string;
	/** Major-progress notes surfaced by the subagent (and blocked-permission notices). */
	milestones: string[];
	/** Rolling window of recent low-level activity lines. */
	activity: string[];
	filesRead: string[];
	filesModified: string[];
	messages: SubagentTranscriptMessage[];
	items: SubagentTranscriptItem[];
	filesReadMore?: string;
	filesModifiedMore?: string;
	artifactsDir?: string;
	verdict?: string;
	confidence?: string;
	/** Set when the run landed on its soft turn budget; its answer is a partial the parent can extend. */
	stoppedBy?: SubagentResult["stoppedBy"];
	error?: string;
	finalText?: string;
	/** Presentation ownership: foreground stays on the tool card; background owns the overview. */
	background: boolean;
	acknowledged: boolean;
	startedAt: number;
}

/** One-line note shown when a run landed on its soft turn budget, so the parent knows it can extend it. */
export const TURN_BUDGET_NOTE = "⏳ turn budget reached — partial answer; extend with subagent_send";

interface TrackedRun {
	handle: SubagentHandle;
	profile: SubagentProfile;
	details: RunDetails;
	artifactsDir: string;
	finalize: Promise<SubagentResult>;
	pendingMessages: string[];
	continuing: boolean;
	invocationActive: boolean;
	ctx: ExtensionContext;
	stopUpdates?: () => void;
	runtimeProvider?: RuntimeDriverProvider;
}

const ACTIVITY_LIMIT = 6;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageSnapshot, model?: string): string {
	const parts: string[] = [];
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
			return undefined;
		default:
			return undefined;
	}
}

function resolveModel(profile: SubagentProfile, usage: UsageSnapshot, ctx: ExtensionContext): string | undefined {
	if (profile.model) {
		if (typeof profile.model !== "string") return profile.model.id;
		return profile.model;
	}
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
let overviewExpanded = false;

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
	const visible = selectAmbientRuns([...activeRuns.values()]);
	const headline = ambientHeadline(visible);
	if (!headline) {
		ctx.ui.setWidget("subagent-overview", undefined);
		return;
	}
	const arrow = overviewExpanded ? "▾" : "▸";
	const alt = process.platform === "darwin" ? "⌥" : "Alt";
	const lines: string[] = [`${headline} ${arrow} · ${alt}+↑/↓ inspect`];
	for (const details of overviewExpanded ? visible : []) {
		const latest = compactActivity(details);
		const trimmedLatest = latest.length > 64 ? `${latest.slice(0, 63)}…` : latest;
		lines.push(
			[
				`${overviewIcon(details.status)} ${displayAgentName(details.agent)}`,
				statusWord(details.status),
			]
				.filter(Boolean)
				.join(" · ") + (trimmedLatest ? ` — ${trimmedLatest}` : ""),
		);
		if (overviewExpanded) {
			for (const milestone of details.milestones.slice(-3)) lines.push(`  ● ${milestone}`);
		}
	}
	ctx.ui.setWidget("subagent-overview", lines);
}

function workspaceRunView(run: TrackedRun): WorkspaceRunView {
	return {
		id: run.handle.id,
		agent: run.details.agent,
		status: run.details.status,
		model: run.details.model,
		task: run.details.task,
		usage: run.details.usage,
		progress: run.details.progress,
		milestones: run.details.milestones,
		activity: run.details.activity,
		filesRead: run.details.filesRead,
		filesModified: run.details.filesModified,
		messages: run.details.messages,
		items: run.details.items,
		finalText: run.details.finalText,
		error: run.details.error,
		pendingMessages: run.pendingMessages.length,
		artifactsDir: run.details.artifactsDir ?? run.artifactsDir,
		degradedNote: run.details.degradedNote,
		stoppedBy: run.details.stoppedBy,
		resultReady: !run.invocationActive && run.details.background && TERMINAL_STATUSES.has(run.details.status) && !run.details.acknowledged,
	};
}

function findTrackedRun(trackedRuns: Map<string, TrackedRun>, id?: string): TrackedRun | undefined {
	const runs = [...trackedRuns.values()];
	if (id) {
		const exact = trackedRuns.get(id);
		if (exact) return exact;
		const prefixMatches = runs.filter((run) => run.handle.id.startsWith(id));
		if (prefixMatches.length === 1) return prefixMatches[0];
		return undefined;
	}
	return [...runs].reverse().find((run) => !TERMINAL_STATUSES.has(run.handle.status)) ?? runs[runs.length - 1];
}

/** Fold a terminal result into the streamed details, capping disclosure for parent-facing surfaces. */
function applyResult(details: RunDetails, result: SubagentResult): void {
	details.status = result.status;
	details.usage = result.usage;
	details.stoppedBy = result.stoppedBy;
	details.artifactsDir = result.artifacts?.dir;
	const read = capDisclosure(result.disclosure.filesRead, result.artifacts?.dir);
	const modified = capDisclosure(result.disclosure.filesModified, result.artifacts?.dir);
	details.filesRead = read.list;
	details.filesReadMore = read.more;
	details.filesModified = modified.list;
	details.filesModifiedMore = modified.more;
	const advisorReport = advisorReportFromOutput(result.output);
	if (advisorReport) {
		details.verdict = advisorReport.verdict;
		details.confidence = advisorReport.confidence;
		details.finalText = advisorReport.reportMarkdown;
	} else {
		details.finalText = result.output !== undefined && typeof result.output !== "string"
			? JSON.stringify(result.output, null, 2)
			: result.text;
	}
	if (result.messages) details.messages = result.messages;
	if (result.items) details.items = result.items;
	if (result.error) details.error = `${result.error.kind}: ${result.error.message}`;
}

/** Map internal RunDetails to the viewer's decoupled ViewerRun shape. */
function toViewerRun(details: RunDetails): ViewerRun {
	return {
		id: details.id,
		agent: details.agent,
		task: details.task,
		model: details.model,
		status: details.status,
		usage: details.usage,
		milestones: details.milestones,
		activity: details.activity,
		filesRead: details.filesRead,
		filesModified: details.filesModified,
		filesReadMore: details.filesReadMore,
		filesModifiedMore: details.filesModifiedMore,
		artifactsDir: details.artifactsDir,
		error: details.error,
		finalText: details.finalText,
		verdict: details.verdict,
		confidence: details.confidence,
		background: details.background,
		acknowledged: details.acknowledged,
		startedAt: details.startedAt,
	};
}

/** Build the completed-run summary text shared by the foreground path and subagent_result. */
export function completedSummary(profileName: string, result: SubagentResult, details: RunDetails): string {
	const lines: string[] = [];
	if (result.stoppedBy === "turn_budget") {
		lines.push(TURN_BUDGET_NOTE);
		lines.push(`id: ${details.id}`);
	}
	if (result.status !== "completed") {
		lines.push(`${profileName} · ${result.status}`);
		if (result.error) lines.push(`error(${result.error.kind}): ${result.error.message}`);
	} else if (details.verdict) {
		lines.push(`${profileName} · ${details.verdict}${details.confidence ? ` · confidence:${details.confidence}` : ""}`);
	}
	if (details.filesModified.length > 0) {
		lines.push(`modified: ${details.filesModified.join(", ")}${details.filesModifiedMore ? ` ${details.filesModifiedMore}` : ""}`);
	}
	if (result.disclosure.truncated.length > 0) {
		lines.push(`truncated: ${result.disclosure.truncated.join(", ")}`);
	}
	if (details.finalText) {
		if (lines.length > 0) lines.push("");
		lines.push(details.finalText);
	}
	return lines.join("\n");
}

/** Compact call line; per-role tools pass their fixed role name, the generic tool reads it from args. */
function renderCallFor(fixedAgent?: string) {
	// Accept any tool's args shape; only the generic tool carries an `agent` field, and `task` is common.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (args: any, theme: Theme) => {
		const agentName = displayAgentName(fixedAgent ?? (typeof args?.agent === "string" ? args.agent : undefined) ?? "...");
		const preview = firstTaskLine(typeof args?.task === "string" ? args.task : "", 70);
		const text =
			theme.fg("toolTitle", theme.bold(agentName)) +
			(preview ? `\n${theme.fg("dim", preview)}` : "");
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
		const agent = displayAgentName(details.agent);
		let line =
			`${statusIcon(details.status, theme)} ${theme.fg("toolTitle", theme.bold(agent))} ` +
			theme.fg("muted", firstTaskLine(details.task, 48) || statusWord(details.status));
		if (details.verdict) line += ` ${theme.fg(details.verdict === "blocked" ? "error" : "accent", details.verdict)}`;
		if (details.confidence) line += ` ${theme.fg("dim", details.confidence)}`;
		if (details.stoppedBy === "turn_budget") line += `\n${theme.fg("muted", TURN_BUDGET_NOTE)}`;
		return line;
	};

	if (isPartial) {
		const activity = compactActivity(details);
		const lines = [titleLine().split("\n")[0]!, theme.fg("dim", activity)];
		return {
			render: (width: number) => lines.map((line) => truncateToWidth(line, Math.max(0, width), "…")),
			invalidate() {},
		};
	}

	if (!expanded) {
		let text = titleLine();
		if (details.error) {
			text += `\n${theme.fg("error", firstTaskLine(details.error, 96))}`;
		} else if (details.finalText) {
			const first = details.finalText.trim().split("\n").find((line) => line.trim()) ?? "";
			if (first) text += `\n${theme.fg("toolOutput", firstTaskLine(first, 96))}`;
		} else {
			text += `\n${theme.fg("dim", compactActivity(details))}`;
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
	const managers = new Map<string, {
		manager: SubagentManager;
		artifactsDir: string;
		resolverOptions: ModelResolverOptions;
		registryRef: { current: ModelRegistry };
	}>();
	const trackedRuns = new Map<string, TrackedRun>();
	let sessionEpoch = 0;
	let viewerOpen = false;

	/** Open the interactive subagent runs viewer popup; a no-op outside a UI host or while already open. */
	const openViewer = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || viewerOpen) return;
		viewerOpen = true;
		try {
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				return new SubagentViewer(
					() => [...trackedRuns.values()].map((tracked) => toViewerRun(tracked.details)),
					theme,
					{
						onClose: () => done(undefined),
						onAbort: (id) => {
							const tracked = trackedRuns.get(id);
							if (tracked) void tracked.handle.abort();
						},
						onInspect: (id) => { workspaceController?.selectRun(id); },
						onStateChange: () => tui.requestRender(),
					},
					() => Math.max(8, Math.floor(tui.terminal.rows * 0.7)),
					(text, width) => new Markdown(text, 0, 0, getMarkdownTheme()).render(width),
				);
			}, { overlay: true, overlayOptions: { width: "85%", anchor: "center" } });
		} finally {
			viewerOpen = false;
		}
	};

	let workspaceController: SubagentWorkspaceController | undefined;
	let sessionActivated = false;
	let sessionConfig: SubagentUserConfig | undefined;
	// Named configurations are session snapshots. Legacy files retain their existing live-read behavior.
	const getSessionConfig = async (): Promise<SubagentUserConfig> => {
		if (sessionConfig?.profile) return sessionConfig;
		const config = await loadSubagentConfig();
		if (config.profile) sessionConfig = config;
		return config;
	};
	let routingChangeInProgress = false;
	const withRoutingChange = (handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>) => async (args: string, ctx: ExtensionCommandContext) => {
		if (routingChangeInProgress) {
			if (ctx.hasUI) ctx.ui.notify("A profile or mode switch is already in progress", "error");
			else throw new Error("A profile or mode switch is already in progress");
			return;
		}
		routingChangeInProgress = true;
		try {
			await handler(args, ctx);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Subagent configuration error: ${error instanceof Error ? error.message : String(error)}`, "error");
			else throw error;
		} finally {
			routingChangeInProgress = false;
		}
	};
	let runtimeProviders = new Map<string, RuntimeDriverProvider>();
	let runtimeProviderDiscoveryError: Error | undefined;
	const providerRegistry = { get: (providerId: string) => runtimeProviders.get(providerId) };

	const discoverProviders = (): void => {
		try {
			const discovered = pi.events ? discoverRuntimeProviders(pi.events) : new Map<string, RuntimeDriverProvider>();
			for (const [id, provider] of runtimeProviders) {
				if (discovered.has(id) && discovered.get(id) !== provider) throw new Error(`Duplicate runtime provider: ${id}`);
				if (!discovered.has(id)) discovered.set(id, provider);
			}
			runtimeProviders = discovered;
			runtimeProviderDiscoveryError = undefined;
		} catch (error) {
			runtimeProviderDiscoveryError = error instanceof Error ? error : new Error(String(error));
		}
	};

	const commitProfileRouting = async (
		next: SubagentUserConfig,
		ctx: ExtensionContext,
		persist: () => Promise<void>,
		retune: boolean,
	): Promise<void> => {
		if (ctx.isIdle && !ctx.isIdle()) throw new Error("Wait for the parent agent to finish before switching profile or mode");
		discoverProviders();
		if (runtimeProviderDiscoveryError) throw runtimeProviderDiscoveryError;
		const mode = next.mode && next.mode !== "off" ? next.mode : DEFAULT_MODE;
		const target = await validateProfileSelection(next, mode, ctx.modelRegistry, runtimeProviders);
		const previousModel = ctx.model;
		const previousThinking = pi.getThinkingLevel();
		let parentChanged = false;
		try {
			if (retune) {
				if (!previousModel || !sameModel(target, previousModel)) {
					if (!await pi.setModel(target)) throw new Error(`Cannot switch parent to ${target.provider}/${target.id}: authentication unavailable`);
					parentChanged = true;
				}
				pi.setThinkingLevel(effectiveModeRoute(next, mode, "agent")!.thinkingLevel);
			}
			await persist();
		} catch (error) {
			if (retune) {
				if (parentChanged && previousModel && !await pi.setModel(previousModel)) {
					throw new Error(`Profile switch failed and parent rollback failed; select the previous model manually. Cause: ${error instanceof Error ? error.message : String(error)}`);
				}
				pi.setThinkingLevel(previousThinking);
			}
			throw error;
		}
		sessionConfig = next;
	};

	// Discover once after every extension factory has had a chance to install its event listener.
	queueMicrotask(discoverProviders);
	// If a provider extension loads after the kit, accept its direct registration without requiring a reload.
	const unregisterRuntimeProviderRegistration = pi.events?.on(RUNTIME_PROVIDER_REGISTER_EVENT, (data) => {
		try {
			const provider = data as RuntimeDriverProvider;
			validateRuntimeDriverProvider(provider);
			const existing = runtimeProviders.get(provider.id);
			if (existing && existing !== provider) throw new Error(`Duplicate runtime provider: ${provider.id}`);
			runtimeProviders.set(provider.id, provider);
			runtimeProviderDiscoveryError = undefined;
		} catch (error) {
			runtimeProviderDiscoveryError = error instanceof Error ? error : new Error(String(error));
		}
	});
	let previousEditorFactory: ReturnType<ExtensionUIContext["getEditorComponent"]>;
	let activeSessionCtx: ExtensionContext | undefined;

	const requestWorkspaceRender = () => workspaceController?.requestRender();
	const acknowledgeRun = (tracked: TrackedRun, details = tracked.details): boolean => {
		if (tracked.details !== details || tracked.invocationActive || !TERMINAL_STATUSES.has(details.status)) return false;
		details.acknowledged = true;
		activeRuns.delete(details.id);
		renderOverview(tracked.ctx);
		requestWorkspaceRender();
		return true;
	};
	const installWorkspaceUi = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		activeSessionCtx = ctx;
		workspaceController?.dispose();
		sessionEpoch++;
		for (const tracked of trackedRuns.values()) tracked.stopUpdates?.();
		trackedRuns.clear();
		activeRuns.clear();
		workspaceController = new SubagentWorkspaceController({
			runs: () => [...trackedRuns.values()].map(workspaceRunView),
			onAcknowledge: (id) => {
				const tracked = trackedRuns.get(id);
				if (tracked) acknowledgeRun(tracked);
			},
			onTargetChange: (run) => {
				ctx.ui.setStatus("subagent-target", run ? ctx.ui.theme.fg("accent", `view:${run.agent}`) : undefined);
			},
		});
		previousEditorFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => createSubagentSwitchEditor(
			tui,
			editorTheme,
			keybindings,
			workspaceController!,
			() => ctx.ui.theme,
			previousEditorFactory?.(tui, editorTheme, keybindings),
		));
	};

	pi.on("session_start", (_event, ctx) => installWorkspaceUi(ctx));

	const createChildModelRuntime = async (registry: ModelRegistry): Promise<ModelRuntime> => {
		const runtime = await ModelRuntime.create({ refreshOnCreate: false });
		for (const providerId of registry.getRegisteredProviderIds()) {
			const native = registry.getRegisteredNativeProvider(providerId);
			if (native) {
				runtime.registerNativeProvider(native);
			} else {
				const config = registry.getRegisteredProviderConfig(providerId);
				if (!config) throw new Error(`Registered provider ${providerId} has no public provider definition`);
				runtime.registerProvider(providerId, config);
			}
			try {
				const apiKey = await registry.getApiKeyForProvider(providerId);
				if (apiKey) await runtime.setRuntimeApiKey(providerId, apiKey);
			} catch {
				// Default auth.json / OAuth file credentials are still available after refresh.
			}
		}
		await runtime.refresh({ allowNetwork: false });
		return runtime;
	};

	const getManager = (ctx: ExtensionContext, config: SubagentUserConfig, runCwd = ctx.cwd): { manager: SubagentManager; artifactsDir: string } => {
		const existing = managers.get(runCwd);
		if (existing) {
			Object.assign(existing.resolverOptions, {
				registry: ctx.modelRegistry,
				parentModel: ctx.model,
			});
			existing.registryRef.current = ctx.modelRegistry;
			return existing;
		}
		const artifactsOverride = config.artifactsDir
			? (isAbsolute(config.artifactsDir) ? config.artifactsDir : resolve(ctx.cwd, config.artifactsDir))
			: undefined;
		const artifactsDir = resolveArtifactsDir(runCwd, artifactsOverride);
		const resolverOptions: ModelResolverOptions = {
			registry: ctx.modelRegistry,
			parentModel: ctx.model,
		};
		const resolveModelFn = createModelResolver(resolverOptions);
		const registryRef = { current: ctx.modelRegistry };
		const createRuntime = () => createChildModelRuntime(registryRef.current);
		const localDriver = createPiSdkDriver({
			cwd: runCwd,
			createModelRuntime: createRuntime,
			modelRegistry: ctx.modelRegistry,
			resolveModel: resolveModelFn,
		});
		if (runtimeProviderDiscoveryError) throw runtimeProviderDiscoveryError;
		const createDriver: RuntimeDriverFactory = createRuntimeProviderDispatcher({ providers: providerRegistry, fallback: localDriver, resolveModel: resolveModelFn });
		const providerConcurrencyKey = (profile: SubagentProfile, task: string, options: SpawnOptions): string | undefined => {
			const metadata = options.metadata;
			const runtime = runtimeProviderRunMetadata({ metadata });
			if (!runtime) return undefined;
			const provider = runtimeProviders.get(runtime.selection.provider);
			if (!provider) return undefined;
			const request: DriverRequest = {
				id: "queue",
				cwd: runCwd,
				profile,
				task,
				prompt: task,
				...(options.context ? { context: options.context } : {}),
				...(metadata ? { metadata } : {}),
			};
			return resolveRuntimeProviderConcurrencyKey(provider, runtime.selection, request);
		};
		const manager = new SubagentManager({
			cwd: runCwd,
			modelRegistry: ctx.modelRegistry,
			resolveModel: resolveModelFn,
			artifactsDir,
			maxConcurrentPerKey: 1,
			resolveConcurrencyKey: providerConcurrencyKey,
			createDriver,
		});
		const entry = { manager, artifactsDir, resolverOptions, registryRef };
		managers.set(runCwd, entry);
		// Lazy retention: fire-and-forget prune of this project's bucket; never fail a spawn on cleanup errors.
		void pruneSubagentRuns(artifactsDir, {
			retentionDays: config.retentionDays ?? 14,
			maxRuns: config.maxRuns ?? 200,
		}).catch(() => {});
		return entry;
	};

	pi.on("session_shutdown", async (event) => {
		sessionEpoch++;
		for (const tracked of trackedRuns.values()) {
			tracked.pendingMessages.length = 0;
			tracked.stopUpdates?.();
		}
		activeSessionCtx?.ui.setWidget("subagent-overview", undefined);
		if (event.reason === "reload" && activeSessionCtx) {
			rememberReloadActivation(activeSessionCtx, sessionActivated);
		}
		unregisterRuntimeProviderRegistration?.();
		if (previousEditorFactory) activeSessionCtx?.ui.setEditorComponent(previousEditorFactory);
		else activeSessionCtx?.ui.setEditorComponent(undefined);
		previousEditorFactory = undefined;
		workspaceController?.dispose();
		workspaceController = undefined;
		activeSessionCtx?.ui.setStatus("subagent-target", undefined);
		activeSessionCtx = undefined;
		const currentManagers = [...managers.values()];
		managers.clear();
		await Promise.all(currentManagers.map((entry) => entry.manager.abortAll()));
		trackedRuns.clear();
		activeRuns.clear();
	});

	// The kit ships deactivated: at session start, hide the subagent tools from the model unless a prior
	// `/mode low|medium|high|ultra` persisted an active tier. All tools are registered by now (extensions load before
	// session_start fires), so filtering our names out of the active set never drops another extension's tools.
	pi.on("session_start", async (event, ctx) => {
		try {
			discoverProviders();
			sessionConfig = undefined;
			const config = await getSessionConfig();
			const carriedActivation = event.reason === "reload"
				? consumeReloadActivation(ctx)
				: undefined;
			sessionActivated = carriedActivation ?? isActivated(config);
			if (sessionActivated && config.profile) {
				await commitProfileRouting(config, ctx, async () => {}, true);
			}
			applyToolActivation(pi, sessionActivated);
		} catch (error) {
			sessionActivated = false;
			applyToolActivation(pi, false);
			if (ctx.hasUI) ctx.ui.notify(`Subagent configuration error: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	// Advisor consultation guidance now lives in the dedicated `advisor` tool description, so it no longer needs to
	// be injected into the parent system prompt. The `advisorGuidance` config key is still accepted for
	// backwards compatibility (see loadSubagentConfig) but has no effect.

	/** One presentation owner and one subscription per invocation, including queued continuations. */
	const trackInvocation = (
		tracked: TrackedRun,
		run: () => Promise<SubagentResult>,
		onUpdate?: (update: { content: { type: "text"; text: string }[]; details: RunDetails }) => void,
	): Promise<SubagentResult> => {
		const { handle, details, ctx } = tracked;
		const epoch = sessionEpoch;
		const current = () => epoch === sessionEpoch && tracked.details === details;
		const prompts = new AbortController();
		tracked.invocationActive = true;
		activeRuns.set(handle.id, details);
		const refresh = () => {
			if (!current()) return;
			renderOverview(ctx);
				requestWorkspaceRender();
		};
		const emit = () => {
			if (!current()) return;
			details.usage = handle.usage;
			if (!tracked.runtimeProvider) details.model = resolveModel(handle.profile, handle.usage, ctx);
			refresh();
			if (!details.background) onUpdate?.({ content: [{ type: "text", text: compactActivity(details) }], details });
		};
		const unsubscribe = handle.subscribe((event: SubagentEvent) => {
			if (!current()) return;
			// Terminal events precede artifact persistence. Only the result promise commits the terminal UI state.
			if (!TERMINAL_STATUSES.has(handle.status)) details.status = handle.status;
			if (event.type === "transcript") {
				const next = [...details.items];
				const index = next.findIndex((item) => item.id === event.item.id);
				if (index >= 0) {
					const previous = next[index]!;
					next[index] = previous.kind === "tool" && event.item.kind === "tool"
						? { ...previous, ...event.item, args: event.item.args ?? previous.args, summary: event.item.summary || previous.summary }
						: event.item;
				} else next.push(event.item);
				details.items = next;
			} else if (event.type === "message") details.messages.push(event.message);
			else if (event.type === "progress") {
				details.progress = event.text;
				details.milestones.push(event.text);
			} else if (event.type === "file_read" && !details.filesRead.includes(event.path)) details.filesRead.push(event.path);
			else if (event.type === "file_write" && !details.filesModified.includes(event.path)) details.filesModified.push(event.path);
			else if (event.type === "permission_blocked") details.milestones.push(`⛔ ${event.tool}: ${event.reason}`);
			else if (event.type === "escalation") {
				void escalationDecision(ctx.ui, ctx.hasUI, event, prompts.signal).catch(() => "deny" as const).then((decision) => {
					if (!current() || prompts.signal.aborted) return;
					handle.resolveEscalation(event.id, decision);
					details.status = handle.status;
					details.milestones.push(`${decision === "allow" ? "✅ allowed" : "⛔ denied"} escalation: ${event.tool}`);
					emit();
				});
			} else if (event.type === "failed") details.error = event.error;
			const line = activityLine(event);
			if (line !== undefined) {
				details.activity.push(line);
				if (details.activity.length > ACTIVITY_LIMIT) details.activity.shift();
			}
			emit();
		});
		const stop = () => { unsubscribe(); prompts.abort(); };
		tracked.stopUpdates = stop;
		// Publish finalize before a driver can synchronously emit or a result waiter can observe this invocation.
		const finalize = Promise.resolve().then(run).catch((error): SubagentResult => ({
			status: "failed", text: "", usage: handle.usage,
			error: { kind: "model", message: error instanceof Error ? error.message : String(error) },
			disclosure: { filesRead: [...details.filesRead], filesModified: [...details.filesModified], commandsRun: [], contextSources: [], truncated: [] },
		})).then((result) => {
			if (current()) applyResult(details, result);
			return result;
		}).finally(() => {
			stop();
			if (!current()) return;
			tracked.stopUpdates = undefined;
			tracked.invocationActive = false;
			details.acknowledged = !details.background;
			if (!details.background) activeRuns.delete(handle.id);
			refresh();
		});
		tracked.finalize = finalize;
		refresh();
		return finalize;
	};

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
		const runtime = runtimeProviderRunMetadata({ metadata: spawnOptions.metadata });
		const runtimeProvider = runtime ? runtimeProviders.get(runtime.selection.provider) : undefined;
		const handle = manager.spawn(profile, task, spawnOptions);
		const details: RunDetails = {
			id: handle.id,
			agent: profile.name,
			task,
			model: runtime?.description?.model ?? resolveModel(handle.profile, handle.usage, ctx),
			status: handle.status,
			usage: handle.usage,
			milestones: [],
			activity: [],
			filesRead: [],
			filesModified: [],
			messages: [],
			items: [],
			background,
			startedAt: Date.now(),
			acknowledged: false,
			...(runtime ? { degradedNote: `external:${runtime.selection.provider} → ${runtime.description?.label ?? runtime.selection.target ?? "default"}` } : {}),
		};
		const tracked: TrackedRun = {
			handle,
			profile,
			details,
			artifactsDir: join(artifactsBucket, handle.id),
			finalize: handle.wait(),
			pendingMessages: [],
			continuing: false,
			invocationActive: false,
			ctx,
			...(runtimeProvider ? { runtimeProvider } : {}),
		};
		trackedRuns.set(handle.id, tracked);
		trackInvocation(tracked, () => handle.wait(), onUpdate);
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
		if (routingChangeInProgress) throw new Error("A profile or mode switch is in progress; retry after it completes");
		const config = await getSessionConfig();
		const alternateRoot = !!params.root?.trim();
		if (alternateRoot && profile.name !== "search") throw new Error("An alternate root is supported only by the read-only search role");
		const runCwd = await resolveAgentRunCwd(ctx.cwd, params.root);
		const { manager, artifactsDir } = getManager(ctx, config, runCwd);
		// `off` is an activation state, not a routing tier; if a tool is somehow invoked while deactivated, fall
		// back to the default tier's routing rather than indexing the table with a nonexistent mode.
		const mode = config.mode && config.mode !== "off" ? config.mode : DEFAULT_MODE;
		// A per-role override may be gated to specific tiers via `onlyInModes`; outside those tiers it does not apply,
		// so the role falls back to the shipped mode table.
		const agentConfig = effectiveAgentConfig(config.agents[profile.name], mode);
		const runtime = agentConfig?.runtime;
		if (runtime && runtimeProviderDiscoveryError) throw runtimeProviderDiscoveryError;
		const runtimeProvider = runtime ? runtimeProviders.get(runtime.provider) : undefined;
		if (runtimeProvider) validateRuntimeDriverProvider(runtimeProvider);
		if (runtime && !runtimeProvider) {
			throw new Error(`Runtime provider ${JSON.stringify(runtime.provider)} is not installed or enabled. Install or enable a Pi package that registers this provider.`);
		}

		const inheritConversation = params.inheritConversation === true;
		const profileFork = profile.contextMode === "fork";
		const needsSession = inheritConversation || profileFork;
		const sessionFile = needsSession ? ctx.sessionManager.getSessionFile() : undefined;
		if (needsSession && !sessionFile) {
			throw new Error(`${profile.name} requires a persisted parent session to inherit the conversation`);
		}
		const leafId = sessionFile ? ctx.sessionManager.getLeafId() : undefined;
		const forkFrom = sessionFile ? { sessionFile, ...(leafId ? { entryId: leafId } : {}) } : undefined;
		const nativeFork = profileFork && !inheritConversation && !!forkFrom && (!runtimeProvider || runtimeProvider.capabilities.contextModes.includes("fork"));
		const inheritedText = (inheritConversation || (profileFork && !nativeFork)) && forkFrom
			? inheritedConversationPacket(forkFrom)
			: undefined;
		const contextFiles = alternateRoot && !params.files?.length ? ["."] : params.files;
		let context = contextForSubagent(
			contextFiles,
			params.includeDiff,
			nativeFork ? forkFrom : undefined,
		);
		if (inheritedText) {
			if (context) context.text = [...(context.text ?? []), inheritedText];
			else context = { text: [inheritedText] };
		}

		// Mode routing uses only the exact model declared by configuration; there is no automatic selection.
		// Provider-owned models skip the local registry; host-model providers keep the normal exact-model path.
		const overrides: Partial<SubagentProfile> = {};
		const configuredModel = agentConfig?.model;
		const hostResolvesModel = !runtimeProvider || runtimeProvider.capabilities.modelResolution === "host";
		const modeEntry = effectiveModeRoute(config, mode, profile.name);
		if (config.profile && hostResolvesModel && !configuredModel && !config.modes?.[mode]?.[profile.name]?.model) {
			throw new Error(`Profile ${config.profile}: missing explicit ${profile.name} model for ${mode}; role-card and shipped models are not inherited`);
		}
		if (modeEntry) {
			overrides.thinkingLevel = agentConfig?.thinkingLevel ?? modeEntry.thinkingLevel;
			if (modeEntry.maxTurns !== undefined) overrides.maxTurns = modeEntry.maxTurns;
			if (hostResolvesModel && configuredModel) {
				// A manual per-role (optionally tier-gated) override beats the mode table.
				overrides.model = configuredModel;
			} else if (hostResolvesModel) {
				const matches = findRegistryModels(ctx.modelRegistry, modeEntry.model);
				if (matches.length !== 1) throw new Error(`${profile.name} requires one exact configured model: ${modeEntry.model}`);
				overrides.model = matches[0];
			}
		} else if (configuredModel && hostResolvesModel) {
			overrides.model = configuredModel;
		}
		if (agentConfig?.thinkingLevel) overrides.thinkingLevel = agentConfig.thinkingLevel;
		if (inheritConversation) overrides.contextMode = "selected";
		else if (profileFork) overrides.contextMode = nativeFork ? "fork" : "selected";
		if (params.writeScope?.length) {
			overrides.permission = {
				...profile.permission,
				write: { allow: params.writeScope, ...(profile.permission?.write?.deny ? { deny: profile.permission.write.deny } : {}) },
			};
		}
		if (agentConfig?.maxTurns !== undefined) overrides.maxTurns = agentConfig.maxTurns;
		if (agentConfig?.finalizeTurns !== undefined) overrides.finalizeTurns = agentConfig.finalizeTurns;
		if (agentConfig?.contextMaxBytes !== undefined) overrides.contextMaxBytes = agentConfig.contextMaxBytes;
		if (typeof params.maxTurns === "number") overrides.maxTurns = params.maxTurns;
		const effectiveProfile = { ...profile, ...overrides };
		if (runtimeProvider) assertRuntimeProviderSupports(runtimeProvider, effectiveProfile);
		let runtimeDescription;
		if (runtimeProvider?.describeTarget) {
			try {
				runtimeDescription = await runtimeProvider.describeTarget(runtime!);
			} catch {
				runtimeDescription = { label: runtime?.target ?? "default", note: "target description unavailable" };
			}
		}

		const background = params.background === true;
		const spawnOptions: SpawnOptions = {
			...(context ? { context } : {}),
			...(signal && !background ? { signal } : {}),
			...(Object.keys(overrides).length ? { overrides } : {}),
			...((runtime || config.profile) ? { metadata: runtime
				? mergeRuntimeProviderMetadata(config.profile ? { configProfile: config.profile, mode } : undefined, runtime, runtimeDescription)
				: { configProfile: config.profile, mode } } : {}),
		};

		const tracked = startRun(ctx, profile, params.task, spawnOptions, artifactsDir, manager, onUpdate, background);

		if (background) {
			const text = `${profile.name} started · id: ${tracked.handle.id}`;
			return { content: [{ type: "text" as const, text }], details: tracked.details, isError: false };
		}

		const result = await tracked.finalize;
		return {
			content: [{ type: "text" as const, text: completedSummary(profile.name, result, tracked.details) }],
			details: tracked.details,
			isError: result.status !== "completed",
		};
	};

	const continueRun = (
		tracked: TrackedRun,
		message: string,
		background: boolean,
		onUpdate?: (update: { content: { type: "text"; text: string }[]; details: RunDetails }) => void,
	): Promise<SubagentResult> => {
		if (!message.trim()) throw new Error("Follow-up message cannot be empty");
		if (tracked.invocationActive || tracked.handle.status !== "completed") throw new Error("Run is not ready to continue");
		if (tracked.runtimeProvider && !tracked.runtimeProvider.capabilities.resume) throw new Error(`Runtime provider ${tracked.runtimeProvider.id} does not support resume`);
		// Never mutate an earlier invocation's result card or a waiter that captured its details.
		tracked.details = {
			...tracked.details, status: "running", background, acknowledged: false,
			progress: undefined, finalText: undefined, verdict: undefined, confidence: undefined,
			error: undefined, stoppedBy: undefined, activity: [],
			messages: [...tracked.details.messages], items: [...tracked.details.items], milestones: [...tracked.details.milestones],
			filesRead: [...tracked.details.filesRead], filesModified: [...tracked.details.filesModified],
		};
		return trackInvocation(tracked, () => tracked.handle.resume(message), onUpdate);
	};

	const drainWorkspaceQueue = async (tracked: TrackedRun): Promise<void> => {
		if (tracked.continuing || tracked.pendingMessages.length === 0) return;
		const epoch = sessionEpoch;
		tracked.continuing = true;
		try {
			while (epoch === sessionEpoch && tracked.pendingMessages.length > 0) {
				if (tracked.handle.status !== "completed") {
					tracked.pendingMessages.length = 0;
					break;
				}
				const message = tracked.pendingMessages.shift()!;
				await continueRun(tracked, message, true);
			}
		} catch (error) {
			tracked.details.error = error instanceof Error ? error.message : String(error);
			tracked.pendingMessages.length = 0;
		} finally {
			tracked.continuing = false;
			if (epoch === sessionEpoch) requestWorkspaceRender();
		}
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
			`Run a custom role card from a profile .md path. Prefer the dedicated ${roleToolSpecs.map((spec) => spec.name).join(", ")} tools for those roles.`,
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
			"Fetch a background subagent run by id. Pass wait: true to block until it finishes.",
		parameters: resultParameters,
		async execute(_toolCallId, params) {
			const tracked = trackedRuns.get(params.id);
			if (!tracked) {
				return { content: [{ type: "text", text: `No subagent run with id ${params.id}` }], details: undefined, isError: true };
			}
			const terminal = !tracked.invocationActive && TERMINAL_STATUSES.has(tracked.details.status);
			if (params.wait || terminal) {
				const details = tracked.details;
				const epoch = sessionEpoch;
				const result = await tracked.finalize;
				if (epoch === sessionEpoch) acknowledgeRun(tracked, details);
				return {
					content: [{ type: "text", text: completedSummary(tracked.profile.name, result, details) }],
					details,
					isError: result.status !== "completed",
				};
			}
			const details = tracked.details;
			const text = `${details.agent} · ${statusWord(details.status)} · id: ${tracked.handle.id}`;
			return { content: [{ type: "text", text }], details, isError: false };
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Subagent Send",
		description:
			"Send a follow-up to an existing run: steers if still running, continues if completed.",
		parameters: sendParameters,
		async execute(_toolCallId, params, _signal, onUpdate) {
			const tracked = trackedRuns.get(params.id);
			if (!tracked) {
				return { content: [{ type: "text", text: `No subagent run with id ${params.id}` }], details: undefined, isError: true };
			}
			if (!params.message.trim()) return { content: [{ type: "text", text: "Follow-up message cannot be empty" }], details: undefined, isError: true };
			const status = tracked.handle.status;
			if (tracked.invocationActive && TERMINAL_STATUSES.has(status)) {
				return { content: [{ type: "text", text: "Run is starting or finishing; wait for its current invocation before sending another message." }], details: undefined, isError: true };
			}
			if (!TERMINAL_STATUSES.has(status)) {
				if (tracked.runtimeProvider && !tracked.runtimeProvider.capabilities.steer) {
					if (tracked.runtimeProvider.capabilities.followUp) {
						tracked.handle.followUp(params.message);
						tracked.details.milestones.push(`↪ queued follow-up: ${params.message.split("\n")[0]?.slice(0, 60) ?? ""}`);
						requestWorkspaceRender();
						const text = `${tracked.details.agent} queued · id: ${tracked.handle.id}`;
						return { content: [{ type: "text", text }], details: tracked.details, isError: false };
					}
					if (!tracked.runtimeProvider.capabilities.resume) {
						return { content: [{ type: "text", text: `Runtime provider ${tracked.runtimeProvider.id} does not support steering, follow-up, or resume.` }], details: tracked.details, isError: true };
					}
					tracked.pendingMessages.push(params.message);
					tracked.details.milestones.push(`↪ queued until current turn finishes: ${params.message.split("\n")[0]?.slice(0, 60) ?? ""}`);
					void tracked.finalize.then(() => drainWorkspaceQueue(tracked));
					requestWorkspaceRender();
					const text = `${tracked.details.agent} queued · id: ${tracked.handle.id}`;
					return { content: [{ type: "text", text }], details: tracked.details, isError: false };
				}
				tracked.handle.steer(params.message);
				tracked.details.milestones.push(`↪ steered: ${params.message.split("\n")[0]?.slice(0, 60) ?? ""}`);
				requestWorkspaceRender();
				const text = `${tracked.details.agent} steered · id: ${tracked.handle.id}`;
				return { content: [{ type: "text", text }], details: tracked.details, isError: false };
			}
			if (status !== "completed") {
				return { content: [{ type: "text", text: `Run ${params.id} ended as ${status} and cannot be continued.` }], details: tracked.details, isError: true };
			}
			const finalize = continueRun(tracked, params.message, params.wait === false, onUpdate);
			const details = tracked.details;
			if (params.wait === false) {
				const text = `${details.agent} continuing · id: ${tracked.handle.id}`;
				return { content: [{ type: "text", text }], details, isError: false };
			}
			const result = await finalize;
			return {
				content: [{ type: "text", text: completedSummary(tracked.profile.name, result, details) }],
				details,
				isError: result.status !== "completed",
			};
		},
		renderCall: renderCallFor("send"),
		renderResult: renderRunResult,
	});

	const notifySubagentsOff = (ctx: Pick<ExtensionContext, "hasUI" | "ui">): void => {
		if (ctx.hasUI) ctx.ui.notify("Subagents are off — run /mode low|medium|high|ultra first.", "error");
	};

	pi.registerCommand("subagent", {
		description: "Deterministically run a subagent: /subagent <advisor|search|profile.md> <task>",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/u);
			if (!match) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /subagent <advisor|search|profile.md> <task>", "error");
				return;
			}
			// Commands remain registered while off, but must not bypass session activation.
			if (!sessionActivated) {
				notifySubagentsOff(ctx);
				return;
			}
			const [, rawAgent, task] = match;
			const builtInCandidate = rawAgent.toLowerCase();
			const agent = isBuiltIn(builtInCandidate) ? builtInCandidate : rawAgent;
			try {
				const profile = isBuiltIn(agent) ? await loadBuiltInAgent(agent) : await loadProfileFile(agent);
				const result = await runAgentTool(ctx, ctx.signal, undefined, profile, {
					task,
					...(agent === "advisor" ? { includeDiff: true } : {}),
				});
				const text = result.content.find((part) => part.type === "text")?.text ?? "Subagent finished without displayable output.";
				if (ctx.hasUI) ctx.ui.notify(text, result.isError ? "error" : "info");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("subagents", {
		description: "Switch workspace (`main`, `focus [id]`), inspect runs (`runs`, `view [id]`), acknowledge results (`ack|dismiss [id]`), diagnose tools, control the overview, or abort a run",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "tools") {
				const registered = new Set(pi.getAllTools().map((tool) => tool.name));
				const active = new Set(pi.getActiveTools());
				const lines = KIT_TOOL_NAMES.map((name) =>
					`${registered.has(name) ? "registered" : "missing"} · ${active.has(name) ? "active" : "inactive"} · ${name}`
				);
				const missing = KIT_TOOL_NAMES.filter((name) => !registered.has(name));
				if (missing.length > 0) {
					lines.push("Missing tools were filtered before activation, usually by Pi's startup --tools allowlist.");
				}
				if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), missing.length > 0 ? "error" : "info");
				return;
			}
			if (parts[0] === "ack" || parts[0] === "dismiss") {
				const id = parts[1] ?? workspaceController?.activeRun()?.id;
				const tracked = id ? findTrackedRun(trackedRuns, id) : undefined;
				const message = !tracked
					? (id ? `No unique subagent run with id ${id}` : "Usage: /subagents ack <id> (or inspect a run first)")
					: acknowledgeRun(tracked) ? `Acknowledged result ${tracked.handle.id}` : "Run is still active; its result cannot be acknowledged yet";
				if (ctx.hasUI) ctx.ui.notify(message, !tracked || tracked.invocationActive ? "error" : "info");
				return;
			}
			if (parts[0] === "main") {
				workspaceController?.selectMain();
				return;
			}
			if (parts[0] === "focus" || parts[0] === "switch") {
				const id = parts[1];
				const tracked = id ? findTrackedRun(trackedRuns, id) : findTrackedRun(trackedRuns);
				if (!tracked || !workspaceController?.selectRun(tracked.handle.id)) {
					if (ctx.hasUI) ctx.ui.notify(id ? `No subagent run with id ${id}` : "No subagent runs yet.", "error");
				}
				return;
			}
			if (parts[0] === "runs" || (parts.length === 0 && ctx.hasUI)) {
				await openViewer(ctx);
				return;
			}
			if (parts[0] === "view" || parts[0] === "open") {
				const id = parts[1];
				const tracked = id ? findTrackedRun(trackedRuns, id) : findTrackedRun(trackedRuns);
				if (!tracked || !workspaceController?.selectRun(tracked.handle.id)) {
					if (ctx.hasUI) ctx.ui.notify(id ? `No subagent run with id ${id}` : "No subagent runs yet.", "error");
				}
				return;
			}
			if (parts[0] === "toggle" || parts[0] === "expand" || parts[0] === "collapse") {
				overviewExpanded = parts[0] === "toggle" ? !overviewExpanded : parts[0] === "expand";
				renderOverview(ctx);
				if (ctx.hasUI) ctx.ui.notify(`Subagent overview ${overviewExpanded ? "expanded" : "collapsed"}`, "info");
				return;
			}
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
				? [
					"Alt+↑/↓ switches Main/specialist · Esc returns to Main · /subagents focus [id]",
					...([...trackedRuns.values()].map((tracked) => {
						const run = tracked.handle;
						const usage = run.usage;
						const model = resolveModel(run.profile, usage, ctx) ?? "";
						return (
							`${run.id}  ${run.profile.name}  ${run.status}  ` +
							`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}  $${usage.cost.toFixed(4)}` +
							(model ? `  ${model}` : "") +
							`\n  ${tracked.artifactsDir}`
						);
					})),
				]
				: ["No subagent runs yet."];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("mode", {
		description: "Switch profile (/mode profile [name] [tier]), effort tier (low|medium|high|ultra), or off; print routing. New sessions stay off unless autoActivate is true.",
		getArgumentCompletions: (prefix) => {
			const values = [...SUBAGENT_MODES, "off", "profile", "filter"];
			const matches = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return matches.length ? matches : null;
		},
		handler: withRoutingChange(async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			let config = await getSessionConfig();
			let parentWarning: string | undefined;

			if (parts[0]?.toLowerCase() === "profile") {
				if (parts.length > 3) throw new Error("Usage: /mode profile [name] [low|medium|high|ultra|off]");
				const requestedMode = parts[2]?.toLowerCase();
				const acceptedModes = [...SUBAGENT_MODES, "off"];
				if (requestedMode && !acceptedModes.includes(requestedMode)) {
					throw new Error("Usage: /mode profile [name] [low|medium|high|ultra|off]");
				}
				const declaration = await loadPiAdvisorConfig();
				const names = Object.keys(declaration.profiles ?? {});
				let name: string | undefined = parts[1];
				if (!name) {
					if (!ctx.hasUI || names.length === 0) {
						const text = `profile: ${config.profile ?? "legacy"}\n${names.length ? `Available: ${names.join(", ")}` : "No profiles defined. Add profiles to pi-advisor.json."}`;
						if (ctx.hasUI) ctx.ui.notify(text, "info");
						else pi.sendMessage({ customType: "subagent-profile", content: text, display: true });
						return;
					}
					name = await ctx.ui.select(`Profile (current: ${config.profile ?? "legacy"})`, names);
					if (!name) return;
				}
				const selected = resolveProfile(declaration, name);
				const combinedMode = requestedMode as SubagentMode | "off" | undefined;
				// With an optional tier, profile selection and activation are one atomic user action.
				const next = {
					...config,
					profile: name,
					agents: selected.agents,
					modes: selected.modes,
					parentModel: selected.parentModel,
					...(combinedMode ? { mode: combinedMode } : {}),
				};
				const activate = combinedMode ? combinedMode !== "off" : sessionActivated;
				await commitProfileRouting(
					next,
					ctx,
					() => combinedMode ? persistProfileMode(name!, combinedMode) : persistProfile(name!),
					activate,
				);
				config = next;
				if (combinedMode) {
					sessionActivated = activate;
					applyToolActivation(pi, activate);
				}
				if (ctx.hasUI) ctx.ui.notify("Profile switched. Existing runs keep their original routing; future requests may send this conversation to the newly selected provider. Use /new for a separate conversation.", "warning");
			// `/mode filter <keyword>` preserves the legacy registry-pool diagnostic; `/mode filter off` clears it.
			} else if (parts[0]?.toLowerCase() === "filter") {
				const keyword = parts.slice(1).join(" ").trim();
				if (!keyword) {
					if (ctx.hasUI) ctx.ui.notify("Usage: /mode filter <keyword> | /mode filter off", "error");
					return;
				}
				if (keyword.toLowerCase() === "off") {
					await persistModelFilter(undefined);
					config = { ...config, modelFilter: undefined };
				} else {
					await persistModelFilter(keyword);
					config = { ...config, modelFilter: keyword };
				}
			} else {
				const arg = parts[0]?.toLowerCase() ?? "";
				const acceptedModes = [...SUBAGENT_MODES, "off"];
				if (parts.length > 1 || (arg && !acceptedModes.includes(arg))) {
					if (ctx.hasUI) ctx.ui.notify(`Usage: /mode [${acceptedModes.join("|")}] | /mode profile [name] [${acceptedModes.join("|")}] | /mode filter <keyword>|off`, "error");
					return;
				}
				if (arg === "off") {
					// Deactivate: persist off and hide the subagent tools from the model. The parent session is left as-is.
					await persistMode("off");
					config = { ...config, mode: "off" };
					sessionActivated = false;
					applyToolActivation(pi, false);
				} else if ((SUBAGENT_MODES as readonly string[]).includes(arg)) {
					const mode = arg as SubagentMode;
					const next: SubagentUserConfig = { ...config, mode };
					if (config.profile) {
						await commitProfileRouting(next, ctx, () => persistMode(mode), true);
					} else {
						await persistMode(mode);
						const applied = await applyParentMode(pi, mode, ctx, next);
						if (applied.includes("⚠")) parentWarning = applied;
					}
					config = next;
					sessionActivated = true;
					applyToolActivation(pi, true);
				}
			}

			if (config.profile) sessionConfig = config;
			const activated = sessionActivated;
			const mode = config.mode && config.mode !== "off" ? config.mode : DEFAULT_MODE;
			// Resolve each role's override for this tier, so a tier-gated model pin appears only where it applies.
			const effectiveOverrides: Record<string, { model?: string; thinkingLevel?: NonNullable<SubagentProfile["thinkingLevel"]> }> = {};
			const externalRows = new Map<string, string>();
			for (const [role, agent] of Object.entries(config.agents)) {
				const eff = effectiveAgentConfig(agent, mode);
				if (!eff) continue;
				if (eff.model || eff.thinkingLevel) effectiveOverrides[role] = {
					...(eff.model ? { model: eff.model } : {}),
					...(eff.thinkingLevel ? { thinkingLevel: eff.thinkingLevel } : {}),
				};
				if (eff.runtime) {
					const provider = runtimeProviders.get(eff.runtime.provider);
					if (!provider) {
						externalRows.set(role, `${role} → ${eff.runtime.target ?? "default"} · external:${eff.runtime.provider} ⚠ provider not installed or enabled`);
					} else {
						try {
							const description = provider.describeTarget ? await provider.describeTarget(eff.runtime) : undefined;
							const target = description?.label ?? eff.runtime.target ?? "default";
							const model = description?.model ? ` · ${description.model}` : "";
							externalRows.set(role, `${role} → ${target}${model} · external:${provider.id}`);
						} catch (error) {
							externalRows.set(role, `${role} → ${eff.runtime.target ?? "default"} · external:${provider.id} ⚠ ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				}
			}
			const configuredMode = config.modes?.[mode];
			const modeEntries: Record<string, ModeRouteConfig> = {};
			for (const [role, entry] of Object.entries(configuredMode ?? {})) {
				if (role !== "agent" && entry) modeEntries[role] = entry;
			}
			const rows = buildRoutingTable(mode, {
				registry: ctx.modelRegistry,
				parentModel: ctx.model,
				manualOverrides: effectiveOverrides,
				modeEntries,
				modelFilter: config.modelFilter,
				userTiers: config.tiers,
			});
			const pool = filterPoolSize({ registry: ctx.modelRegistry, modelFilter: config.modelFilter });
			const poolLine = pool.keywords.length ? `filter: ${pool.keywords.join(", ")} (${pool.matched}/${pool.total})` : undefined;
			const headerLine = activated
				? `mode ${mode}`
				: `mode off — /mode low|medium|high|ultra to activate`;
			const lines = [
				config.profile ? `profile ${config.profile} · ${headerLine}` : headerLine,
				...(poolLine ? [poolLine] : []),
				formatParentRoute(config, mode),
				...rows.map((row) => externalRows.get(row.role) ?? formatRoutingRow(row)),
				...(parentWarning ? [parentWarning] : []),
			];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		}),
	});

	pi.registerCommand("advisor", {
		description: "Ask Advisor for a read-only second opinion with the current diff",
		handler: async (args, ctx) => {
			const prompt = advisorCommandPrompt(args);
			if (!prompt) {
				ctx.ui.notify("Usage: /advisor <question>", "error");
				return;
			}
			// Advisor's tool is hidden while the kit is deactivated; nudge the user to activate it first.
			if (!sessionActivated) {
				notifySubagentsOff(ctx);
				return;
			}
			pi.sendUserMessage(prompt);
		},
	});

	pi.registerShortcut("alt+s", {
		description: "Open subagent runs viewer",
		handler: (ctx) => openViewer(ctx),
	});
	pi.registerShortcut("alt+a", {
		description: "Acknowledge the inspected specialist result",
		handler: async () => workspaceController?.acknowledgeResult(),
	});
	pi.registerShortcut("alt+i", {
		description: "Toggle specialist inspector details",
		handler: () => workspaceController?.toggleInspector(),
	});
}
