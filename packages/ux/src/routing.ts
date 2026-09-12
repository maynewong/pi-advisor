/**
 * Four-tier explicit model table (low|medium|high|ultra).
 *
 * A mode entry per role is `{ model, thinkingLevel, optional maxTurns }`. Models are exact ids
 * declared before startup; this module never selects, ranks, or falls back between models.
 */
import { createRequire } from "node:module";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "pi-advisor-core";

/** Model shape as it comes off the authenticated registry (id, provider, cost, contextWindow, reasoning). */
type RegistryModel = ReturnType<ModelRegistry["getAvailable"]>[number];
/** Reuse Core's thinking-level union without importing the underlying provider package. */
type ThinkingLevel = NonNullable<SubagentProfile["thinkingLevel"]>;

export type SubagentMode = "low" | "medium" | "high" | "ultra";
export const SUBAGENT_MODES = ["low", "medium", "high", "ultra"] as const;
/**
 * The effort tier applied when the kit is activated without an explicit tier, and the tier previewed by
 * `/mode` while the kit is off. Activation itself is a separate axis (see the host's `off` state): the kit
 * ships deactivated, so no subagent tools are exposed to the model until `/mode low|medium|high|ultra` turns them on.
 */
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
export const MODEL_TIERS = ["strong", "mid", "fast"] as const;

export interface RampSweScore {
	/** Canonical model-id substring, copied from pi-model-auto's Ramp SWE-Bench table. */
	key: string;
	/** SWE-Bench resolve rate, 0–100. Higher is more capable. */
	resolveRate: number;
}

/**
 * Capability priors from pi-model-auto's Ramp SWE-Bench table, sorted from high to low.
 *
 * Alias routing uses these numbers as the primary capability axis when a model id matches. This avoids
 * registry-order tie breaks such as `deepseek-v4-pro` beating a stronger `glm-5.3` simply because both
 * were classified as mid-tier $0 reasoning models with the same context window. Manual
 * `agents.<role>.model` overrides still bypass this table entirely.
 */
export const RAMP_SWE_SCORES: RampSweScore[] = [
	{ key: "gpt-5.5", resolveRate: 83.5 },
	{ key: "claude-opus-4-7", resolveRate: 83.5 },
	{ key: "gpt-5.6-sol", resolveRate: 82.3 },
	{ key: "grok-4.5", resolveRate: 81 },
	{ key: "glm-5.3", resolveRate: 81 },
	{ key: "kimi-k2.7-code", resolveRate: 79.7 },
	{ key: "claude-opus-4-6", resolveRate: 79.7 },
	{ key: "claude-opus-4-8", resolveRate: 78.5 },
	{ key: "gpt-5.6-terra", resolveRate: 75.9 },
	{ key: "gemini-3.1-pro", resolveRate: 74.7 },
	{ key: "claude-sonnet-5", resolveRate: 74.7 },
	{ key: "gpt-5.6-luna", resolveRate: 73.4 },
	{ key: "gpt-5.4", resolveRate: 73.4 },
	{ key: "kimi-k2.6", resolveRate: 73.4 },
	{ key: "claude-sonnet-4-6", resolveRate: 72.2 },
	{ key: "glm-5.1", resolveRate: 70.9 },
	{ key: "qwen3.6-plus", resolveRate: 65.8 },
	{ key: "deepseek-v4-pro", resolveRate: 65.8 },
	{ key: "qwen3.7-plus", resolveRate: 62 },
	{ key: "gpt-5.4-mini", resolveRate: 59.5 },
	{ key: "gpt-5.4-nano", resolveRate: 49.4 },
	{ key: "claude-4-5-haiku", resolveRate: 49.4 },
	{ key: "gpt-4.1", resolveRate: 15.2 },
];

function normalizedModelId(model: RegistryModel): string {
	return model.id.toLowerCase().trim().replace(/\s*\((?:xhigh|high|medium|low|minimal|max)\)\s*$/i, "");
}

/** Return a model's Ramp SWE-Bench capability when its id matches a known canonical key. */
export function rampSweCapability(model: RegistryModel): number | undefined {
	const normalized = normalizedModelId(model);
	return RAMP_SWE_SCORES
		.map((score) => ({ ...score, matchLength: normalized.includes(score.key) ? score.key.length : 0 }))
		.filter((score) => score.matchLength > 0)
		.sort((a, b) => b.matchLength - a.matchLength || b.resolveRate - a.resolveRate)[0]?.resolveRate;
}

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
	{ pattern: "highspeed", tier: "fast" },
	{ pattern: "turbo", tier: "fast" },
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
	{ pattern: "kimi", tier: "mid" },
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
	{ pattern: "kimi", family: "moonshot" },
	{ pattern: "llama", family: "meta" },
	{ pattern: "mistral", family: "mistral" },
	{ pattern: "grok", family: "xai" },
];

/** Metadata fallbacks (per-million-token dollar cost) used only when no id prior matches. */
export const STRONG_COST_FLOOR = 5;
export const FAST_COST_CEILING = 1;

/**
 * Prior tier from id substrings. User rules (from config `tiers`) are PREPENDED so they win, then the
 * built-in table; first match wins within the combined, order-preserved list. Returns undefined when
 * nothing matches, which is what distinguishes a prior-qualified model from a metadata-only guess.
 */
function priorTier(id: string, userTiers?: TierRule[]): ModelTier | undefined {
	const lower = id.toLowerCase();
	const rules = userTiers?.length ? [...userTiers, ...MODEL_TIER_PRIORS] : MODEL_TIER_PRIORS;
	for (const rule of rules) if (lower.includes(rule.pattern.toLowerCase())) return rule.tier;
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

/** True when a model's tier comes from an id prior (built-in or user), not from a metadata guess. */
function hasPriorTier(model: RegistryModel, userTiers?: TierRule[]): boolean {
	return priorTier(model.id, userTiers) !== undefined;
}

/**
 * Free-model guard. A $0-cost model whose tier is only a metadata fallback (no id prior matched) is NOT
 * a qualified pick — free is not a qualification. Such models must never win a scored alias over a
 * prior-matched model, so scores subtract a dominating penalty for them (relative order among themselves
 * is preserved, so a pool of only free/unknown models still resolves to one).
 */
function isUnqualifiedFree(model: RegistryModel, userTiers?: TierRule[]): boolean {
	return avgCost(model) === 0 && !hasPriorTier(model, userTiers);
}
const FREE_UNQUALIFIED_PENALTY = 1e7;

/** Effective tier: id prior first (heuristic, user rules included), metadata second (objective). */
export function effectiveTier(model: RegistryModel, userTiers?: TierRule[]): ModelTier {
	return priorTier(model.id, userTiers) ?? metadataTier(model);
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

/**
 * Capability-first score. Ramp SWE-Bench resolve rate wins when known; coarse tier is only a fallback for
 * unmeasured models. This keeps default routing ordered by capability unless the user pins a concrete
 * `agents.<role>.model` override.
 */
function capabilityScore(model: RegistryModel, userTiers?: TierRule[]): number {
	const guard = isUnqualifiedFree(model, userTiers) ? FREE_UNQUALIFIED_PENALTY : 0;
	const capability = rampSweCapability(model) ?? tierRank(effectiveTier(model, userTiers)) * 25;
	return capability * 1000 + tierRank(effectiveTier(model, userTiers)) * 10 + (model.reasoning ? 5 : 0) + model.contextWindow / 1e9 + avgCost(model) / 1e6 - guard;
}

function costScore(model: RegistryModel): number {
	return model.cost.input + model.cost.output;
}

function pickBy(models: RegistryModel[], score: (model: RegistryModel) => number): RegistryModel {
	return models.reduce((best, model) => (score(model) > score(best) ? model : best));
}

/** Normalize the case-insensitive keyword filter (string or list) into a lowercased, non-empty keyword array. */
function normalizeFilter(filter: string | string[] | undefined): string[] {
	if (filter === undefined) return [];
	const list = Array.isArray(filter) ? filter : [filter];
	return list.map((keyword) => keyword.trim().toLowerCase()).filter((keyword) => keyword.length > 0);
}

/** Substring-match a model against the keyword filter over provider, id, and `provider/id`. */
function matchesFilter(model: RegistryModel, keywords: string[]): boolean {
	const haystacks = [model.provider.toLowerCase(), model.id.toLowerCase(), `${model.provider}/${model.id}`.toLowerCase()];
	return keywords.some((keyword) => haystacks.some((hay) => hay.includes(keyword)));
}

/** Conservative local-provider detection. Local runtimes are opt-in because starting them can consume large
 * amounts of RAM/VRAM and may be surprising even when their registry price is `$0`. */
export function isLocalModel(model: RegistryModel): boolean {
	const provider = model.provider.toLowerCase();
	return ["omlx", "ollama", "lmstudio", "local", "mlx"].some((part) => provider === part || provider.includes(part));
}

/**
 * Build the alias candidate pool. Local providers are excluded by default, and an explicit modelFilter is
 * fail-closed: zero matches produce an empty pool rather than silently widening back to every model.
 */
function candidatePool(options: AliasResolveOptions): { pool: RegistryModel[]; filterDegraded?: string } {
	const registered = options.registry.getAvailable();
	const available = registered.filter((model) => !isLocalModel(model));
	const keywords = normalizeFilter(options.modelFilter);
	if (keywords.length === 0) return { pool: available };
	const filtered = available.filter((model) => matchesFilter(model, keywords));
	if (filtered.length === 0) return { pool: [], filterDegraded: "modelFilter matched no allowed models (fail-closed)" };
	return { pool: filtered };
}

/** Count models in the registry that match the filter (for `/mode` pool sizing); mirrors {@link candidatePool}. */
export function filterPoolSize(options: AliasResolveOptions): { matched: number; total: number; keywords: string[] } {
	const registered = options.registry.getAvailable();
	const available = registered.filter((model) => !isLocalModel(model));
	const keywords = normalizeFilter(options.modelFilter);
	if (keywords.length === 0) return { matched: available.length, total: available.length, keywords };
	return { matched: available.filter((model) => matchesFilter(model, keywords)).length, total: available.length, keywords };
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
	/** Case-insensitive keyword(s); only matching models (provider/id/`provider/id`) form the candidate pool. */
	modelFilter?: string | string[];
	/** User tier rules from config, PREPENDED to the built-in priors (first match wins). */
	userTiers?: TierRule[];
}

function modelId(model: RegistryModel): string {
	return `${model.provider}/${model.id}`;
}

function parentFallback(alias: ModelAlias, parent: RegistryModel | undefined, degradedReason: string, allowParent = true): ResolutionOutcome {
	const fallback = allowParent ? parent : undefined;
	return {
		alias,
		model: fallback,
		modelId: fallback ? modelId(fallback) : undefined,
		reason: "no candidate model available",
		degraded: true,
		degradedReason,
	};
}

function resolveStrong(pool: RegistryModel[], options: AliasResolveOptions): ResolutionOutcome {
	const { parentModel, userTiers } = options;
	if (pool.length === 0) return parentFallback(STRONG_REASONING_ALIAS, parentModel, "no models available; using the parent model");

	// Free is not a qualification: an unqualified $0 model is never eligible while any qualified model exists,
	// even as the sole heterogeneous option — so it cannot win strong-reasoning over a prior-matched model.
	const qualified = pool.filter((model) => !isUnqualifiedFree(model, userTiers));
	const available = qualified.length ? qualified : pool;

	const parentFam = parentModel ? modelFamily(parentModel) : undefined;
	const hetero = parentFam ? available.filter((model) => modelFamily(model) !== parentFam) : available;
	const best = pickBy(hetero.length ? hetero : available, (model) => capabilityScore(model, userTiers));

	if (parentModel && sameModel(best, parentModel)) {
		return {
			alias: STRONG_REASONING_ALIAS,
			model: parentModel,
			modelId: modelId(parentModel),
			reason: "strongest available model is the parent model",
			degraded: true,
			degradedReason: "same model as parent, no stronger/heterogeneous model available; advisor runs with half its value (independent context only)",
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

/** Resolve the strongest qualified model without Advisor's heterogeneous-family preference. */
export function resolveStrongestOverall(options: AliasResolveOptions): ResolutionOutcome {
	const { pool, filterDegraded } = candidatePool(options);
	if (pool.length === 0) {
		return foldFilterDegraded(
			parentFallback(STRONG_REASONING_ALIAS, options.parentModel, "no allowed models available", !filterDegraded),
			filterDegraded,
		);
	}
	const qualified = pool.filter((model) => !isUnqualifiedFree(model, options.userTiers));
	const candidates = qualified.length ? qualified : pool;
	const best = pickBy(candidates, (model) => capabilityScore(model, options.userTiers));
	return foldFilterDegraded({
		alias: STRONG_REASONING_ALIAS,
		model: best,
		modelId: modelId(best),
		degraded: qualified.length === 0,
		reason: options.parentModel && sameModel(best, options.parentModel)
			? "strongest overall model is already the parent model"
			: "strongest overall model",
		...(qualified.length === 0 ? { degradedReason: "only unqualified free/local models are available" } : {}),
	}, filterDegraded);
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

/**
 * Fast-search selection is TIER-first, cost-second. Order:
 *   1. cheapest NON-ZERO-cost fast-tier model (a real, priced fast model always wins);
 *   2. no fast tier → cheapest non-zero-cost mid-tier model;
 *   3. still nothing priced at fast/mid → cheapest non-zero-cost model of any tier;
 *   4. last resort → cheapest zero-cost/unknown model, marked degraded (quality unknown).
 * A nonzero-cost fast model is always preferred over any zero-cost/local model — free is not a qualification.
 */
function resolveFast(pool: RegistryModel[], options: AliasResolveOptions): ResolutionOutcome {
	const { userTiers } = options;
	const available = pool;
	if (available.length === 0) return parentFallback(FAST_SEARCH_ALIAS, options.parentModel, "no allowed models available; using the parent model");
	const priced = available.filter((model) => costScore(model) > 0);
	const fast = priced.filter((model) => effectiveTier(model, userTiers) === "fast");
	if (fast.length > 0) return resolveCheapest(FAST_SEARCH_ALIAS, fast, options, "cheapest fast-tier model (fastest suitable for search)");
	const mid = priced.filter((model) => effectiveTier(model, userTiers) === "mid");
	if (mid.length > 0) return resolveCheapest(FAST_SEARCH_ALIAS, mid, options, "no fast-tier model in the pool; cheapest mid-tier model");
	if (priced.length > 0) return resolveCheapest(FAST_SEARCH_ALIAS, priced, options, "no fast/mid-tier model in the pool; cheapest priced model");
	// Only free/local models remain: pick the cheapest but flag it — a $0 local model's quality is unknown.
	const outcome = resolveCheapest(FAST_SEARCH_ALIAS, available, options, "only free/local models available");
	return { ...outcome, degraded: true, degradedReason: "only free/local models available for fast-search — quality unknown" };
}

function resolveBalanced(pool: RegistryModel[], options: AliasResolveOptions): ResolutionOutcome {
	const { userTiers } = options;
	if (pool.length === 0) return parentFallback(BALANCED_ALIAS, options.parentModel, "no allowed models available; using the parent model");
	const qualified = pool.filter((model) => !isUnqualifiedFree(model, userTiers));
	const available = qualified.length ? qualified : pool;
	const mids = available.filter((model) => effectiveTier(model, userTiers) === "mid");
	if (mids.length > 0) {
		// A real mid-tier model exists: take the most capable one, tie-broken toward the cheaper.
		const pick = pickBy(mids, (model) => capabilityScore(model, userTiers) - costScore(model) / 1e6);
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
	const outcome = resolveCheapest(BALANCED_ALIAS, [median], options, "median-cost model (no mid-tier model in the pool)");
	return qualified.length
		? outcome
		: { ...outcome, degraded: true, degradedReason: "only unqualified free/local models are available for balanced routing" };
}

/** Fold an active filter's degradation into an otherwise-resolved outcome (an empty filter match is never silent). */
function foldFilterDegraded(outcome: ResolutionOutcome, filterDegraded: string | undefined): ResolutionOutcome {
	if (!filterDegraded) return outcome;
	return {
		...outcome,
		degraded: true,
		degradedReason: outcome.degraded && outcome.degradedReason ? `${filterDegraded}; ${outcome.degradedReason}` : filterDegraded,
	};
}

/** Resolve one alias to a concrete model plus a structured, displayable outcome. */
export function resolveAlias(alias: ModelAlias, options: AliasResolveOptions): ResolutionOutcome {
	const { pool, filterDegraded } = candidatePool(options);
	if (pool.length === 0 && filterDegraded) {
		return {
			alias,
			model: undefined,
			reason: "no candidate model available",
			degraded: true,
			degradedReason: filterDegraded,
		};
	}
	const resolve = () => {
		switch (alias) {
			case "strong-reasoning":
				return resolveStrong(pool, options);
			case "fast-search":
				return resolveFast(pool, options);
			case "balanced":
				return resolveBalanced(pool, options);
		}
	};
	return foldFilterDegraded(resolve(), filterDegraded);
}

/** A per-role, per-mode entry: exact model, reasoning effort, and optional turn budget. */
export interface RoleModeEntry {
	/** Exact model id. Model selection is configuration-only. */
	model: string;
	thinkingLevel: ThinkingLevel;
	maxTurns?: number;
}

/**
 * The four-tier routing table (low | medium | high | ultra). (Activation is separate: the kit ships off; a tier is
 * chosen with `/mode low|medium|high|ultra`.)
 *
 * Every entry is an exact authenticated model id. Per-role user configuration remains an optional
 * override; omitting it leaves this table in control of mode-dependent routing.
 *
 * Turn budgets are now SOFT (see core's soft-landing design): reaching `maxTurns` no longer kills a
 * run — the child is asked to wrap up and submit its best partial, which the parent can extend via
 * subagent_send. Because a landed run is graceful rather than wasted, the budgets are loosened to
 * generous "background insurance" values that normal work rarely reaches. Advisor carries a generous
 * budget of its own (16) purely as that insurance: it is a few-turn, heavy-thinking role, so the budget
 * must never be a daily constraint — only a backstop that still lets it land a low-confidence,
 * need_more_information partial rather than run unbounded.
 */
interface RoutingConfigFile {
	modes: Record<SubagentMode, Record<string, RoleModeEntry>>;
}

// Routing values live in JSON rather than TypeScript. User `pi-advisor.json` entries override these
// packaged compatibility defaults tier by tier.
const require = createRequire(import.meta.url);
const DEFAULT_ROUTING_CONFIG = require("../default-routing.json") as RoutingConfigFile;

export const ROUTING_ROLES = ["advisor", "search"] as const;

export const MODE_ROUTING_TABLE: Record<string, Record<SubagentMode, RoleModeEntry>> = Object.fromEntries(
	ROUTING_ROLES.map((role) => [
		role,
		Object.fromEntries(SUBAGENT_MODES.map((mode) => [mode, DEFAULT_ROUTING_CONFIG.modes[mode][role]])),
	]),
) as Record<string, Record<SubagentMode, RoleModeEntry>>;

/** Parent-session routes loaded from the packaged JSON compatibility defaults. */
export const PARENT_MODE_ENTRY: Record<SubagentMode, { model: string; thinkingLevel: ThinkingLevel }> = Object.fromEntries(
	SUBAGENT_MODES.map((mode) => [mode, DEFAULT_ROUTING_CONFIG.modes[mode].agent]),
) as Record<SubagentMode, { model: string; thinkingLevel: ThinkingLevel }>;

/** One fully resolved routing row, ready to display or apply. */
export interface ResolvedRoleRouting {
	role: string;
	mode: SubagentMode;
	model: string;
	/** A manual `agents.<role>.model` override, if present — it beats the mode table. */
	manualModel?: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	maxTurns?: number;
	degraded: boolean;
	reason: string;
	degradedReason?: string;
}

export interface RoutingTableOptions extends AliasResolveOptions {
	/** Per-role manual overrides from `pi-advisor.json`. */
	manualOverrides?: Record<string, { model?: string; thinkingLevel?: ThinkingLevel }>;
	/** Per-mode role entries declared in `pi-advisor.json`; these replace model/effort hardcoding for configured tiers. */
	modeEntries?: Record<string, RoleModeEntry>;
}

/** Resolve a single role for a mode, honoring per-mode config and a manual per-role override. */
export function resolveRoleRouting(role: string, mode: SubagentMode, options: RoutingTableOptions): ResolvedRoleRouting {
	const builtInEntry = MODE_ROUTING_TABLE[role]?.[mode];
	const entry = { ...builtInEntry, ...options.modeEntries?.[role] } as RoleModeEntry;
	const manualOverride = options.manualOverrides?.[role];
	const manualModel = manualOverride?.model;
	const thinkingLevel = manualOverride?.thinkingLevel ?? entry.thinkingLevel;
	if (manualModel) {
		return {
			role,
			mode,
			model: entry.model,
			manualModel,
			modelId: manualModel,
			thinkingLevel,
			maxTurns: entry.maxTurns,
			degraded: false,
			reason: `manual override (agents.${role}.model)`,
		};
	}
	const matches = options.registry.getAvailable().filter((model) => model.id === entry.model || model.name === entry.model || `${model.provider}/${model.id}` === entry.model);
	return {
		role,
		mode,
		model: entry.model,
		modelId: matches.length === 1 ? `${matches[0].provider}/${matches[0].id}` : entry.model,
		thinkingLevel,
		maxTurns: entry.maxTurns,
		degraded: matches.length !== 1,
		reason: matches.length === 1 ? "explicit configured model" : "configured model is unavailable or ambiguous",
		...(matches.length !== 1 ? { degradedReason: "configure an exact authenticated model id before starting the project" } : {}),
	};
}

/** Resolve every role for a mode: the table `/mode` prints and the extension applies. */
export function buildRoutingTable(mode: SubagentMode, options: RoutingTableOptions): ResolvedRoleRouting[] {
	const roles = [...new Set([...ROUTING_ROLES, ...Object.keys(options.modeEntries ?? {})])];
	return roles.map((role) => resolveRoleRouting(role, mode, options));
}
