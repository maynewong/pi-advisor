/**
 * Exposes bundled role cards without coupling the runtime to presentation or
 * product-specific defaults. Hosts may load these profiles or replace them.
 */
import { fileURLToPath } from "node:url";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { loadProfileFile, type ModelSpec, type SubagentProfile } from "pi-subagent-core";

export const builtInAgentNames = ["oracle", "worker", "search", "reviewer"] as const;
export type BuiltInAgentName = typeof builtInAgentNames[number];

export const STRONG_REASONING_ALIAS = "strong-reasoning";

/** Single source of truth for the Oracle output contract, shared by the schema, validation, and role cards. */
export const oracleVerdicts = ["safe_to_proceed", "proceed_with_changes", "blocked", "need_more_information"] as const;
export const oracleConfidenceLevels = ["low", "medium", "high"] as const;
export type OracleVerdict = typeof oracleVerdicts[number];
export type OracleConfidence = typeof oracleConfidenceLevels[number];

/** The Oracle structured-output schema. Core never learns about Oracle; the host applies this contract. */
export const oracleReportSchema: TSchema = Type.Object(
	{
		verdict: Type.Unsafe<OracleVerdict>({ type: "string", enum: [...oracleVerdicts] }),
		confidence: Type.Unsafe<OracleConfidence>({ type: "string", enum: [...oracleConfidenceLevels] }),
		report_markdown: Type.String(),
	},
	{ additionalProperties: false },
);

/** Names of built-in agents whose structured output is governed by the shared Oracle schema. */
const ORACLE_AGENTS = new Set<string>(["oracle"]);

/** Return the installed markdown path for a bundled role card. */
export function getBuiltInAgentPath(name: BuiltInAgentName): string {
	return fileURLToPath(new URL(`../agents/${name}.md`, import.meta.url));
}

/** Load a bundled role card through the core profile parser, applying the shared Oracle output contract. */
export async function loadBuiltInAgent(name: BuiltInAgentName): Promise<SubagentProfile> {
	const profile = await loadProfileFile(getBuiltInAgentPath(name));
	if (ORACLE_AGENTS.has(profile.name)) {
		return { ...profile, output: { kind: "schema", schema: oracleReportSchema } };
	}
	return profile;
}

type RegistryModel = ReturnType<ModelRegistry["getAvailable"]>[number];

export interface ModelResolverOptions {
	registry: Pick<ModelRegistry, "getAvailable">;
	parentModel?: RegistryModel;
}

function matchRegistry(registry: Pick<ModelRegistry, "getAvailable">, target: string): RegistryModel[] {
	const available = registry.getAvailable();
	const slash = target.indexOf("/");
	if (slash > 0) {
		const provider = target.slice(0, slash);
		const id = target.slice(slash + 1);
		return available.filter((model) => model.provider === provider && model.id === id);
	}
	return available.filter((model) => model.id === target || model.name === target);
}

/**
 * Build the alias-aware model resolver used by core's `SubagentManager({ resolveModel })` injection point.
 * A string spec is resolved against the authenticated model registry. The `strong-reasoning` alias falls back
 * to the parent model when no authenticated model matches; every other unresolved or ambiguous target throws.
 * Per-agent user overrides are supplied by the host as the spec (see the extension), so they flow through here too.
 */
export function createModelResolver(options: ModelResolverOptions): (spec: ModelSpec, profile: SubagentProfile) => Promise<RegistryModel> {
	return async (spec) => {
		if (typeof spec !== "string") return spec as RegistryModel;
		const matches = matchRegistry(options.registry, spec);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			throw new Error(`Model selection for "${spec}" is ambiguous: ${matches.map((model) => `${model.provider}/${model.id}`).join(", ")}`);
		}
		if (spec === STRONG_REASONING_ALIAS && options.parentModel) return options.parentModel;
		throw new Error(`Model selection target "${spec}" is not available`);
	};
}
