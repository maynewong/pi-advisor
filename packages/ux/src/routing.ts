/**
 * Two-mode routing table and the auto model resolver ("auto plugin").
 *
 * A mode entry per role is `{ model alias, thinkingLevel, optional maxTurns }`.
 * Aliases (`strong-reasoning`, `fast-search`, `balanced`) are resolved against the
 * live model registry using objective metadata (cost, context window, reasoning
 * support) plus a small, editable knowledge table of id-substring priors. Every
 * resolution yields a structured `ResolutionOutcome` so the host can surface it and
 * never degrades silently. This module is UX-only; Core keeps the neutral
 * `resolveModel` hook and learns nothing about modes or aliases.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "pi-subagent-core";

/** Model shape as it comes off the authenticated registry (id, provider, cost, contextWindow, reasoning). */
type RegistryModel = ReturnType<ModelRegistry["getAvailable"]>[number];
/** Reuse Core's thinking-level union without importing the underlying provider package. */
type ThinkingLevel = NonNullable<SubagentProfile["thinkingLevel"]>;

export type SubagentMode = "low" | "medium";
export const SUBAGENT_MODES = ["low", "medium"] as const;
export const DEFAULT_MODE: SubagentMode = "medium";

export type ModelAlias = "strong-reasoning" | "fast-search" | "balanced";
export const STRONG_REASONING_ALIAS: ModelAlias = "strong-reasoning";
export const FAST_SEARCH_ALIAS: ModelAlias = "fast-search";
export const BALANCED_ALIAS: ModelAlias = "balanced";
export const MODEL_ALIASES = [STRONG_REASONING_ALIAS, FAST_SEARCH_ALIAS, BALANCED_ALIAS] as const;

export function isModelAlias(spec: string): spec is ModelAlias {
	return (MODEL_ALIASES as readonly string[]).includes(spec);
}

export type ModelTier = "strong" | "mid" | "fast";

/**
 * Coarse tier priors keyed on lowercased model-id substrings. First match wins, so
 * fast/cheap markers are listed before family names (e.g. `gpt-5-mini` is fast, not
 * strong). This is a heuristic prior, not a registry — edit freely.
 */
export interface TierRule {
	pattern: string;
	tier: ModelTier;
}
export const MODEL_TIER_PRIORS: TierRule[] = [
	// Cheap/fast markers win over family names.
	{ pattern: "-air", tier: "fast" },
	{ pattern: "flash", tier: "fast" },
	{ pattern: "mini", tier: "fast" },
	{ pattern: "nano", tier: "fast" },
	{ pattern: "haiku", tier: "fast" },
	{ pattern: "-lite", tier: "fast" },
	{ pattern: "-8b", tier: "fast" },
	// Strong reasoners.
	{ pattern: "gpt-5", tier: "strong" },
	{ pattern: "o1", tier: "strong" },
	{ pattern: "o3", tier: "strong" },
	{ pattern: "o4", tier: "strong" },
	{ pattern: "opus", tier: "strong" },
	{ pattern: "fable", tier: "strong" },
	// Mid tier.
	{ pattern: "glm", tier: "mid" },
	{ pattern: "deepseek-v3", tier: "mid" },
	{ pattern: "deepseek", tier: "mid" },
	{ pattern: "qwen-max", tier: "mid" },
	{ pattern: "qwen", tier: "mid" },
	{ pattern: "sonnet", tier: "mid" },
	{ pattern: "gemini", tier: "mid" },
	{ pattern: "gpt-4", tier: "mid" },
	{ pattern: "grok", tier: "mid" },
];

/**
 * Canonical model-family priors, used to prefer a heterogeneous second opinion.
 * First match wins; falls back to the provider id when nothing matches.
 */
export interface FamilyRule {
	pattern: string;
	family: string;
}
export const MODEL_FAMILY_PRIORS: FamilyRule[] = [
	{ pattern: "opus", family: "anthropic" },
	{ pattern: "sonnet", family: "anthropic" },
	{ pattern: "haiku", family: "anthropic" },
	{ pattern: "claude", family: "anthropic" },
	{ pattern: "fable", family: "anthropic" },
	{ pattern: "gpt", family: "openai" },
	{ pattern: "o1", family: "openai" },
	{ pattern: "o3", family: "openai" },
	{ pattern: "o4", family: "openai" },
	{ pattern: "gemini", family: "google" },
	{ pattern: "glm", family: "zhipu" },
	{ pattern: "deepseek", family: "deepseek" },
	{ pattern: "qwen", family: "qwen" },
	{ pattern: "llama", family: "meta" },
	{ pattern: "mistral", family: "mistral" },
	{ pattern: "grok", family: "xai" },
];

/** Metadata fallbacks (per-million-token dollar cost) used only when no id prior matches. */
export const STRONG_COST_FLOOR = 5;
export const FAST_COST_CEILING = 1;

function priorTier(id: string): ModelTier | undefined {
	const lower = id.toLowerCase();
	for (const rule of MODEL_TIER_PRIORS) if (lower.includes(rule.pattern)) return rule.tier;
	return undefined;
}

function avgCost(model: RegistryModel): number {
	return (model.cost.input + model.cost.output) / 2;
}

/** Coarse tier from objective metadata, for models the prior table does not name. */
function metadataTier(model: RegistryModel): ModelTier {
	const cost = avgCost(model);
	if (model.reasoning && cost >= STRONG_COST_FLOOR) return "strong";
	if (cost <= FAST_COST_CEILING) return "fast";
	return "mid";
}

/** Effective tier: id prior first (heuristic), metadata second (objective). */
export function effectiveTier(model: RegistryModel): ModelTier {
	return priorTier(model.id) ?? metadataTier(model);
}

function tierRank(tier: ModelTier): number {
	return tier === "strong" ? 3 : tier === "mid" ? 2 : 1;
}

/** Canonical family for heterogeneity checks; falls back to the provider id. */
export function modelFamily(model: RegistryModel): string {
	const lower = model.id.toLowerCase();
	for (const rule of MODEL_FAMILY_PRIORS) if (lower.includes(rule.pattern)) return rule.family;
	return model.provider;
}

export function sameModel(a: RegistryModel, b: RegistryModel): boolean {
	return a.provider === b.provider && a.id === b.id;
}

/** Higher is stronger: tier dominates, reasoning support next, cost/context break ties. */
function strongScore(model: RegistryModel): number {
	return tierRank(effectiveTier(model)) * 1000 + (model.reasoning ? 200 : 0) + avgCost(model) + model.contextWindow / 1e9;
}

function costScore(model: RegistryModel): number {
	return model.cost.input + model.cost.output;
}

function pickBy(models: RegistryModel[], score: (model: RegistryModel) => number): RegistryModel {
	return models.reduce((best, model) => (score(model) > score(best) ? model : best));
}

/** Structured resolution result. Silent degradation is forbidden, so every outcome carries `degraded`. */
export interface ResolutionOutcome {
	alias: ModelAlias;
	model: RegistryModel | undefined;
	modelId?: string;
	reason: string;
	degraded: boolean;
	degradedReason?: string;
}

export interface AliasResolveOptions {
	registry: Pick<ModelRegistry, "getAvailable">;
	parentModel?: RegistryModel;
}

function modelId(model: RegistryModel): string {
	return `${model.provider}/${model.id}`;
}

function parentFallback(alias: ModelAlias, parent: RegistryModel | undefined, degradedReason: string): ResolutionOutcome {
	return {
		alias,
		model: parent,
		modelId: parent ? modelId(parent) : undefined,
		reason: "no candidate model available",
		degraded: true,
		degradedReason,
	};
}

function resolveStrong(options: AliasResolveOptions): ResolutionOutcome {
	const { parentModel } = options;
	const available = options.registry.getAvailable();
	if (available.length === 0) return parentFallback(STRONG_REASONING_ALIAS, parentModel, "no models available; using the parent model");

	const parentFam = parentModel ? modelFamily(parentModel) : undefined;
	const hetero = parentFam ? available.filter((model) => modelFamily(model) !== parentFam) : available;
	const best = pickBy(hetero.length ? hetero : available, strongScore);

	if (parentModel && sameModel(best, parentModel)) {
		return {
			alias: STRONG_REASONING_ALIAS,
			model: parentModel,
			modelId: modelId(parentModel),
			reason: "strongest available model is the parent model",
			degraded: true,
			degradedReason: "same model as parent, no stronger/heterogeneous model available; oracle runs with half its value (independent context only)",
		};
	}
	const heterogeneous = parentFam !== undefined && modelFamily(best) !== parentFam;
	return {
		alias: STRONG_REASONING_ALIAS,
		model: best,
		modelId: modelId(best),
		degraded: false,
		reason: heterogeneous
			? "strongest model from a different family than the parent (heterogeneous second opinion)"
			: "strongest available model (no heterogeneous option in the pool)",
	};
}

function resolveCheapest(alias: ModelAlias, candidates: RegistryModel[], options: AliasResolveOptions, reason: string): ResolutionOutcome {
	const cheapest = candidates.reduce((best, model) => {
		const delta = costScore(model) - costScore(best);
		if (delta < 0) return model;
		if (delta === 0 && model.contextWindow < best.contextWindow) return model;
		return best;
	});
	const { parentModel } = options;
	const hasAlternative = parentModel ? candidates.some((model) => !sameModel(model, parentModel)) : true;
	if (parentModel && sameModel(cheapest, parentModel) && !hasAlternative) {
		return {
			alias,
			model: parentModel,
			modelId: modelId(parentModel),
			reason: "only the parent model is available",
			degraded: true,
			degradedReason: "only the parent model is available; cannot route to a cheaper/mid-tier model",
		};
	}
	return { alias, model: cheapest, modelId: modelId(cheapest), degraded: false, reason };
}

function resolveFast(options: AliasResolveOptions): ResolutionOutcome {
	const available = options.registry.getAvailable();
	if (available.length === 0) return parentFallback(FAST_SEARCH_ALIAS, options.parentModel, "no models available; using the parent model");
	return resolveCheapest(FAST_SEARCH_ALIAS, available, options, "cheapest available model (fastest suitable for search)");
}

function resolveBalanced(options: AliasResolveOptions): ResolutionOutcome {
	const available = options.registry.getAvailable();
	if (available.length === 0) return parentFallback(BALANCED_ALIAS, options.parentModel, "no models available; using the parent model");
	const mids = available.filter((model) => effectiveTier(model) === "mid");
	if (mids.length > 0) {
		// A real mid-tier model exists: take the most capable one, tie-broken toward the cheaper.
		const pick = pickBy(mids, (model) => strongScore(model) - costScore(model) / 1e6);
		const { parentModel } = options;
		const hasAlternative = parentModel ? available.some((model) => !sameModel(model, parentModel)) : true;
		if (parentModel && sameModel(pick, parentModel) && !hasAlternative) {
			return {
				alias: BALANCED_ALIAS,
				model: parentModel,
				modelId: modelId(parentModel),
				reason: "only the parent model is available",
				degraded: true,
				degradedReason: "only the parent model is available; cannot route to a distinct mid-tier model",
			};
		}
		return { alias: BALANCED_ALIAS, model: pick, modelId: modelId(pick), degraded: false, reason: "mid-tier model" };
	}
	// No explicit mid tier: fall to the pool's median cost as a balanced default.
	const sorted = [...available].sort((a, b) => costScore(a) - costScore(b));
	const median = sorted[Math.floor((sorted.length - 1) / 2)];
	return resolveCheapest(BALANCED_ALIAS, [median], options, "median-cost model (no mid-tier model in the pool)");
}

/** Resolve one alias to a concrete model plus a structured, displayable outcome. */
export function resolveAlias(alias: ModelAlias, options: AliasResolveOptions): ResolutionOutcome {
	switch (alias) {
		case "strong-reasoning":
			return resolveStrong(options);
		case "fast-search":
			return resolveFast(options);
		case "balanced":
			return resolveBalanced(options);
	}
}

/** A per-role, per-mode entry: which alias, how hard it thinks, and an optional turn budget. */
export interface RoleModeEntry {
	model: ModelAlias;
	thinkingLevel: ThinkingLevel;
	maxTurns?: number;
}

/**
 * The two-mode routing table.
 *
 * Non-negotiables baked in here:
 * - Oracle never degrades: `strong-reasoning` + `high` in BOTH modes.
 * - Search always routes to the cheapest/fastest suitable model (`fast-search`) in both modes.
 * - Reviewer uses `balanced`; low lowers its thinking, medium raises it.
 * - Effort stays real even on a shallow pool: when aliases collapse to one model, the
 *   modes still differ via thinkingLevel and turn budgets.
 *
 * Turn budgets are now SOFT (see core's soft-landing design): reaching `maxTurns` no longer kills a
 * run — the child is asked to wrap up and submit its best partial, which the parent can extend via
 * subagent_send. Because a landed run is graceful rather than wasted, the budgets are loosened to
 * generous "background insurance" values that normal work rarely reaches. Oracle carries a generous
 * budget of its own (16) purely as that insurance: it is a few-turn, heavy-thinking role, so the budget
 * must never be a daily constraint — only a backstop that still lets it land a low-confidence,
 * need_more_information partial rather than run unbounded.
 */
export const MODE_ROUTING_TABLE: Record<string, Record<SubagentMode, RoleModeEntry>> = {
	oracle: {
		low: { model: "strong-reasoning", thinkingLevel: "high", maxTurns: 16 },
		medium: { model: "strong-reasoning", thinkingLevel: "high", maxTurns: 16 },
	},
	search: {
		low: { model: "fast-search", thinkingLevel: "minimal", maxTurns: 8 },
		medium: { model: "fast-search", thinkingLevel: "low", maxTurns: 12 },
	},
	reviewer: {
		low: { model: "balanced", thinkingLevel: "low", maxTurns: 8 },
		medium: { model: "balanced", thinkingLevel: "medium", maxTurns: 12 },
	},
	worker: {
		low: { model: "balanced", thinkingLevel: "low", maxTurns: 12 },
		medium: { model: "balanced", thinkingLevel: "medium", maxTurns: 16 },
	},
};

/** Roles that have a routing-table entry, in display order. */
export const ROUTING_ROLES = Object.keys(MODE_ROUTING_TABLE);

/**
 * The parent-session entry. Because the Pi extension API exposes `setModel`/`setThinkingLevel`,
 * `/mode` also retunes the parent orchestrator: a mid-tier model at a mode-appropriate thinking level.
 */
export const PARENT_MODE_ENTRY: Record<SubagentMode, { model: ModelAlias; thinkingLevel: ThinkingLevel }> = {
	low: { model: "balanced", thinkingLevel: "low" },
	medium: { model: "balanced", thinkingLevel: "medium" },
};

/** One fully resolved routing row, ready to display or apply. */
export interface ResolvedRoleRouting {
	role: string;
	mode: SubagentMode;
	alias: ModelAlias;
	/** A manual `agents.<role>.model` override, if present — it beats the alias. */
	manualModel?: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	maxTurns?: number;
	degraded: boolean;
	reason: string;
	degradedReason?: string;
}

export interface RoutingTableOptions extends AliasResolveOptions {
	/** Per-role manual model overrides from `subagent-kit.json` (`agents.<role>.model`). */
	manualOverrides?: Record<string, { model?: string }>;
}

/** Resolve a single role for a mode, honoring a manual per-role model override. */
export function resolveRoleRouting(role: string, mode: SubagentMode, options: RoutingTableOptions): ResolvedRoleRouting {
	const entry = MODE_ROUTING_TABLE[role][mode];
	const manualModel = options.manualOverrides?.[role]?.model;
	if (manualModel) {
		return {
			role,
			mode,
			alias: entry.model,
			manualModel,
			modelId: manualModel,
			thinkingLevel: entry.thinkingLevel,
			maxTurns: entry.maxTurns,
			degraded: false,
			reason: `manual override (agents.${role}.model)`,
		};
	}
	const outcome = resolveAlias(entry.model, options);
	return {
		role,
		mode,
		alias: entry.model,
		modelId: outcome.modelId ?? "(unresolved)",
		thinkingLevel: entry.thinkingLevel,
		maxTurns: entry.maxTurns,
		degraded: outcome.degraded,
		reason: outcome.reason,
		degradedReason: outcome.degradedReason,
	};
}

/** Resolve every role for a mode: the table `/mode` prints and the extension applies. */
export function buildRoutingTable(mode: SubagentMode, options: RoutingTableOptions): ResolvedRoleRouting[] {
	return ROUTING_ROLES.map((role) => resolveRoleRouting(role, mode, options));
}
