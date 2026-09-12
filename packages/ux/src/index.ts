/**
 * Exposes bundled role cards without coupling the runtime to presentation or
 * product-specific defaults. Hosts may load these profiles or replace them.
 */
import { fileURLToPath } from "node:url";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { loadProfileFile, type ModelSpec, type SubagentProfile } from "pi-advisor-core";

export * from "./presentation.ts";
export * from "./routing.ts";
export * from "./workspace.ts";

export const builtInAgentNames = ["advisor", "search"] as const;
export type BuiltInAgentName = typeof builtInAgentNames[number];

/** Single source of truth for the Advisor output contract, shared by the schema, validation, and role cards. */
export const advisorVerdicts = ["safe_to_proceed", "proceed_with_changes", "blocked", "need_more_information"] as const;
export const advisorConfidenceLevels = ["low", "medium", "high"] as const;
export type AdvisorVerdict = typeof advisorVerdicts[number];
export type AdvisorConfidence = typeof advisorConfidenceLevels[number];

/** The Advisor structured-output schema. Core never learns about Advisor; the host applies this contract. */
export const advisorReportSchema: TSchema = Type.Object(
	{
		verdict: Type.Unsafe<AdvisorVerdict>({ type: "string", enum: [...advisorVerdicts] }),
		confidence: Type.Unsafe<AdvisorConfidence>({ type: "string", enum: [...advisorConfidenceLevels] }),
		report_markdown: Type.String(),
	},
	{ additionalProperties: false },
);

/** Names of built-in agents whose structured output is governed by the shared Advisor schema. */
const ADVISOR_AGENTS = new Set<string>(["advisor"]);

/** Return the installed markdown path for a bundled role card. */
export function getBuiltInAgentPath(name: BuiltInAgentName): string {
	return fileURLToPath(new URL(`../agents/${name}.md`, import.meta.url));
}

/** Load a bundled role card through the core profile parser, applying the shared Advisor output contract. */
export async function loadBuiltInAgent(name: BuiltInAgentName): Promise<SubagentProfile> {
	const profile = await loadProfileFile(getBuiltInAgentPath(name));
	if (ADVISOR_AGENTS.has(profile.name)) {
		return { ...profile, output: { kind: "schema", schema: advisorReportSchema } };
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
 * Build the exact model resolver used by core's `SubagentManager({ resolveModel })` injection point.
 * A concrete model id (bare or `provider/model-id`) is matched exactly against the authenticated registry.
 * Model targets are exact authenticated ids. Automatic aliases, fallback selection, and model-pool routing are
 * intentionally unsupported; an unresolved target fails before a subagent starts.
 */
export function createModelResolver(options: ModelResolverOptions): (spec: ModelSpec, profile: SubagentProfile) => Promise<RegistryModel> {
	return async (spec) => {
		if (typeof spec !== "string") return spec as RegistryModel;
		const matches = matchRegistry(options.registry, spec);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			throw new Error(`Model selection for "${spec}" is ambiguous: ${matches.map((model) => `${model.provider}/${model.id}`).join(", ")}`);
		}
		throw new Error(`Model selection target "${spec}" is not available; configure one exact authenticated model id`);
	};
}
