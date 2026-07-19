import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	buildRoutingTable,
	effectiveTier,
	MODE_ROUTING_TABLE,
	modelFamily,
	PARENT_MODE_ENTRY,
	resolveAlias,
	resolveRoleRouting,
	SUBAGENT_MODES,
} from "../src/index.ts";
import subagentExtension, { loadSubagentConfig, persistMode, persistModelFilter } from "../extensions/subagent.ts";

/** Build a fake registry model with just the fields the resolver reads; everything else is filler. */
function model(partial: Partial<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; input: number; output: number }>): never {
	const { input = 1, output = 1, ...rest } = partial;
	return {
		api: "openai-responses",
		baseUrl: "",
		input: ["text"],
		maxTokens: 8192,
		reasoning: false,
		contextWindow: 128000,
		name: rest.id ?? "model",
		cost: { input, output, cacheRead: 0, cacheWrite: 0 },
		...rest,
	} as never;
}

function registryOf(...models: unknown[]): never {
	return { getAvailable: () => models } as never;
}

// A representative multi-provider pool: a strong OpenAI reasoner, a mid GLM, a fast Claude Haiku.
const gpt5 = model({ provider: "openai", id: "gpt-5.5", reasoning: true, input: 15, output: 60 });
const glm = model({ provider: "zhipu", id: "glm-4.6", reasoning: true, input: 3, output: 6 });
const haiku = model({ provider: "anthropic", id: "claude-3-5-haiku", input: 0.8, output: 4 });
const fableParent = model({ provider: "anthropic", id: "claude-fable", reasoning: true, input: 15, output: 75 });
// A free 4-bit local model with an id no built-in prior names: $0 cost, big context, reasoning — attractive to
// raw-cheapest logic and to metadata-only tiering, but unqualified (its tier is a metadata guess, not a prior).
const localFree = model({ provider: "omlx", id: "local-oss-4bit", reasoning: true, contextWindow: 262144, input: 0, output: 0 });
// A cloud router slice used for keyword-filter tests.
const openrouterStrong = model({ provider: "openrouter", id: "openai/gpt-5.5", reasoning: true, input: 12, output: 48 });
const openrouterFast = model({ provider: "openrouter", id: "openai/gpt-5.5-mini", input: 0.4, output: 1.6 });

describe("mode routing table", () => {
	test("keeps oracle at strong-reasoning + high thinking in BOTH modes (never degrades)", () => {
		for (const mode of SUBAGENT_MODES) {
			expect(MODE_ROUTING_TABLE.oracle[mode]).toMatchObject({ model: "strong-reasoning", thinkingLevel: "high" });
		}
	});

	test("keeps search on fast-search in both modes but varies effort via thinking + budget", () => {
		expect(MODE_ROUTING_TABLE.search.low.model).toBe("fast-search");
		expect(MODE_ROUTING_TABLE.search.medium.model).toBe("fast-search");
		// Effort stays real even when both modes route to the same model.
		expect(MODE_ROUTING_TABLE.search.low).toMatchObject({ thinkingLevel: "minimal", maxTurns: 8 });
		expect(MODE_ROUTING_TABLE.search.medium).toMatchObject({ thinkingLevel: "low", maxTurns: 12 });
	});

	test("uses balanced for reviewer, lowering its thinking in low mode and raising it in medium", () => {
		expect(MODE_ROUTING_TABLE.reviewer.low).toMatchObject({ model: "balanced", thinkingLevel: "low" });
		expect(MODE_ROUTING_TABLE.reviewer.medium).toMatchObject({ model: "balanced", thinkingLevel: "medium" });
	});

	test("carries loosened soft turn budgets, including a generous background budget for oracle", () => {
		// Budgets are soft (a landed run wraps up rather than failing), so they are loosened.
		expect(MODE_ROUTING_TABLE.reviewer.low.maxTurns).toBe(8);
		expect(MODE_ROUTING_TABLE.reviewer.medium.maxTurns).toBe(12);
		expect(MODE_ROUTING_TABLE.worker.low.maxTurns).toBe(12);
		expect(MODE_ROUTING_TABLE.worker.medium.maxTurns).toBe(16);
		// Oracle is few-turn/heavy-thinking: its budget is background insurance only, never a daily constraint.
		expect(MODE_ROUTING_TABLE.oracle.low.maxTurns).toBe(16);
		expect(MODE_ROUTING_TABLE.oracle.medium.maxTurns).toBe(16);
	});

	test("mirrors Amp's parent tiers: low on a mid-tier model, medium on the strong model, both at medium thinking", () => {
		expect(PARENT_MODE_ENTRY.low).toEqual({ model: "balanced", thinkingLevel: "medium" });
		expect(PARENT_MODE_ENTRY.medium).toEqual({ model: "strong-reasoning", thinkingLevel: "medium" });
	});
});

describe("tier and family heuristics", () => {
	test("classifies known families by id substrings, with fast markers winning over family names", () => {
		expect(effectiveTier(gpt5)).toBe("strong");
		expect(effectiveTier(model({ provider: "openai", id: "gpt-5-mini", input: 0.5, output: 2 }))).toBe("fast");
		expect(effectiveTier(glm)).toBe("mid");
		expect(effectiveTier(haiku)).toBe("fast");
		expect(modelFamily(gpt5)).toBe("openai");
		expect(modelFamily(fableParent)).toBe("anthropic");
	});
});

describe("auto model resolver", () => {
	test("strong-reasoning prefers the strongest model from a different family than the parent", () => {
		const outcome = resolveAlias("strong-reasoning", { registry: registryOf(fableParent, gpt5, haiku), parentModel: fableParent });
		expect(outcome.modelId).toBe("openai/gpt-5.5");
		expect(outcome.degraded).toBe(false);
		expect(outcome.reason).toMatch(/heterogeneous/i);
	});

	test("strong-reasoning falls back to the parent and flags degraded on a single-model pool", () => {
		const outcome = resolveAlias("strong-reasoning", { registry: registryOf(fableParent), parentModel: fableParent });
		expect(outcome.model).toBe(fableParent);
		expect(outcome.degraded).toBe(true);
		expect(outcome.degradedReason).toMatch(/half its value \(independent context only\)/i);
	});

	test("fast-search picks the cheapest available model", () => {
		const outcome = resolveAlias("fast-search", { registry: registryOf(gpt5, glm, haiku), parentModel: gpt5 });
		expect(outcome.modelId).toBe("anthropic/claude-3-5-haiku");
		expect(outcome.degraded).toBe(false);
	});

	test("balanced picks a mid-tier model", () => {
		const outcome = resolveAlias("balanced", { registry: registryOf(gpt5, glm, haiku), parentModel: gpt5 });
		expect(outcome.modelId).toBe("zhipu/glm-4.6");
		expect(outcome.degraded).toBe(false);
	});

	test("balanced excludes an unqualified free model from its median-cost fallback", () => {
		const outcome = resolveAlias("balanced", { registry: registryOf(gpt5, localFree), parentModel: fableParent });
		expect(outcome.modelId).toBe("openai/gpt-5.5");
		expect(outcome.degraded).toBe(false);
	});

	test("fast-search prefers a nonzero-cost fast model over a $0 local model (free is not a qualification)", () => {
		// The $0 local model is the raw-cheapest; fast-search must still pick the priced fast-tier Haiku.
		const outcome = resolveAlias("fast-search", { registry: registryOf(gpt5, haiku, localFree), parentModel: gpt5 });
		expect(outcome.modelId).toBe("anthropic/claude-3-5-haiku");
		expect(outcome.degraded).toBe(false);
	});

	test("fast-search falls back to a mid-tier model when no fast tier exists, then flags a free-only pool as degraded", () => {
		// No fast tier: fall to the cheapest priced mid-tier model.
		const midOnly = resolveAlias("fast-search", { registry: registryOf(gpt5, glm), parentModel: gpt5 });
		expect(midOnly.modelId).toBe("zhipu/glm-4.6");
		expect(midOnly.degraded).toBe(false);
		// Only free/local models: pick one but mark the outcome degraded (quality unknown).
		const freeOnly = resolveAlias("fast-search", { registry: registryOf(localFree), parentModel: gpt5 });
		expect(freeOnly.modelId).toBe("omlx/local-oss-4bit");
		expect(freeOnly.degraded).toBe(true);
		expect(freeOnly.degradedReason).toMatch(/only free\/local models available for fast-search/i);
	});

	test("a $0 metadata-only model never beats a prior-matched model for strong-reasoning", () => {
		// localFree is $0 with a big reasoning context but has no id prior; the prior-matched Haiku must win.
		const outcome = resolveAlias("strong-reasoning", { registry: registryOf(haiku, localFree), parentModel: fableParent });
		expect(outcome.modelId).toBe("anthropic/claude-3-5-haiku");
	});

	test("a user tier rule reclassifies a model and wins over the built-in table", () => {
		// glm is 'mid' by the built-in table; a user rule promotes it to 'strong'.
		const userTiers = [{ pattern: "glm", tier: "strong" as const }];
		expect(effectiveTier(glm, userTiers)).toBe("strong");
		const outcome = resolveAlias("strong-reasoning", { registry: registryOf(glm, haiku), parentModel: fableParent, userTiers });
		expect(outcome.modelId).toBe("zhipu/glm-4.6");
	});

	test("modelFilter narrows the candidate pool to matching models", () => {
		// Only the OpenRouter models pass the filter, so the free local model and Claude are excluded.
		const outcome = resolveAlias("fast-search", { registry: registryOf(openrouterStrong, openrouterFast, haiku, localFree), parentModel: fableParent, modelFilter: "openrouter" });
		expect(outcome.modelId).toBe("openrouter/openai/gpt-5.5-mini");
		expect(outcome.degraded).toBe(false);
	});

	test("a modelFilter that matches nothing falls back to the whole pool and marks the outcome degraded", () => {
		const outcome = resolveAlias("balanced", { registry: registryOf(gpt5, glm, haiku), parentModel: gpt5, modelFilter: "nonesuch" });
		expect(outcome.modelId).toBe("zhipu/glm-4.6");
		expect(outcome.degraded).toBe(true);
		expect(outcome.degradedReason).toMatch(/modelFilter matched no models/i);
	});
});

describe("resolved routing table", () => {
	test("lets a manual agents.<role>.model override beat the alias", () => {
		const row = resolveRoleRouting("oracle", "medium", {
			registry: registryOf(fableParent, gpt5),
			parentModel: fableParent,
			manualOverrides: { oracle: { model: "openrouter/custom-strong" } },
		});
		expect(row.manualModel).toBe("openrouter/custom-strong");
		expect(row.modelId).toBe("openrouter/custom-strong");
		expect(row.degraded).toBe(false);
	});

	test("builds a full row per role and flags degraded rows on a shallow pool", () => {
		const rows = buildRoutingTable("low", { registry: registryOf(fableParent), parentModel: fableParent });
		expect(rows.map((r) => r.role)).toEqual(["oracle", "search", "reviewer", "worker"]);
		const oracle = rows.find((r) => r.role === "oracle")!;
		expect(oracle.thinkingLevel).toBe("high");
		expect(oracle.degraded).toBe(true);
	});
});

describe("mode config + /mode command", () => {
	let dir: string;
	const originalEnv = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "subagent-kit-mode-"));
		process.env.PI_CODING_AGENT_DIR = dir;
	});
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalEnv;
	});

	test("validates the mode field", async () => {
		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ mode: "medium" }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: {}, mode: "medium" });

		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ mode: "turbo" }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/mode must be one of low, medium/i);
	});

	test("validates modelFilter and tiers config", async () => {
		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ modelFilter: "openrouter", tiers: [{ pattern: "terra", tier: "fast" }] }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: {}, modelFilter: "openrouter", tiers: [{ pattern: "terra", tier: "fast" }] });

		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ modelFilter: "" }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/modelFilter must be a non-empty string/i);

		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ tiers: [{ pattern: "x", tier: "blazing" }] }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/tiers\[\].tier must be one of strong, mid, fast/i);

		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ tiers: [{ tier: "fast" }] }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/tiers\[\].pattern must be a non-empty string/i);
	});

	test("validates the parentModel override as a non-empty string", async () => {
		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ parentModel: "openrouter/openai/gpt-5.5" }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: {}, parentModel: "openrouter/openai/gpt-5.5" });

		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ parentModel: 5 }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/parentModel must be a non-empty string/i);
	});

	test("persistModelFilter sets and clears the filter while preserving other fields", async () => {
		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ agents: {}, mode: "low" }));
		await persistModelFilter("openrouter", dir);
		expect(JSON.parse(await readFile(join(dir, "subagent-kit.json"), "utf8"))).toEqual({ agents: {}, mode: "low", modelFilter: "openrouter" });
		await persistModelFilter(undefined, dir);
		expect(JSON.parse(await readFile(join(dir, "subagent-kit.json"), "utf8"))).toEqual({ agents: {}, mode: "low" });
	});

	test("persistMode writes the mode while preserving other fields", async () => {
		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ agents: { oracle: { model: "x/y" } }, retentionDays: 7 }));
		await persistMode("low", dir);
		const written = JSON.parse(await readFile(join(dir, "subagent-kit.json"), "utf8"));
		expect(written).toEqual({ agents: { oracle: { model: "x/y" } }, retentionDays: 7, mode: "low" });
	});

	test("persistMode creates the file when none exists", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "subagent-kit-fresh-"));
		await persistMode("medium", fresh);
		await expect(access(join(fresh, "subagent-kit.json"))).resolves.toBeUndefined();
	});

	function loadModeCommand() {
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const setModelCalls: unknown[] = [];
		const setThinkingCalls: string[] = [];
		const pi = {
			on: () => {},
			registerTool: () => {},
			registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, opts),
			sendUserMessage: () => {},
			setModel: async (m: unknown) => { setModelCalls.push(m); return true; },
			setThinkingLevel: (level: string) => { setThinkingCalls.push(level); },
		};
		subagentExtension(pi as never);
		return { command: commands.get("mode")!, setModelCalls, setThinkingCalls };
	}

	test("/mode prints the resolved table and persists the mode, retuning the parent session", async () => {
		const { command, setModelCalls, setThinkingCalls } = loadModeCommand();
		const notices: string[] = [];
		const ctx = {
			hasUI: true,
			ui: { notify: (text: string) => notices.push(text) },
			modelRegistry: registryOf(fableParent, gpt5, glm, haiku),
			model: fableParent,
		};

		await command.handler("low", ctx as never);

		// Persisted.
		const written = JSON.parse(await readFile(join(dir, "subagent-kit.json"), "utf8"));
		expect(written.mode).toBe("low");
		// Printed a resolved table.
		expect(notices[0]).toContain("Subagent mode: low");
		expect(notices[0]).toContain("oracle → openai/gpt-5.5");
		expect(notices[0]).toContain("search → anthropic/claude-3-5-haiku");
		// Retuned the parent session. Low mode runs the parent on a mid-tier model at medium thinking (Amp parity).
		expect(setThinkingCalls).toEqual(["medium"]);
		expect(setModelCalls.length).toBe(1);
	});

	test("/mode rejects an unknown mode argument", async () => {
		const { command } = loadModeCommand();
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (text: string) => notices.push(text) }, modelRegistry: registryOf(fableParent), model: fableParent };
		await command.handler("turbo", ctx as never);
		expect(notices[0]).toMatch(/Usage: \/mode/);
	});

	test("/mode filter <kw> persists the filter and reports the narrowed pool; filter off clears it", async () => {
		const { command } = loadModeCommand();
		const notices: string[] = [];
		const ctx = {
			hasUI: true,
			ui: { notify: (text: string) => notices.push(text) },
			modelRegistry: registryOf(openrouterStrong, openrouterFast, haiku, localFree),
			model: fableParent,
		};

		await command.handler("filter openrouter", ctx as never);
		// Persisted the filter.
		expect(JSON.parse(await readFile(join(dir, "subagent-kit.json"), "utf8")).modelFilter).toBe("openrouter");
		// Reported the narrowed pool and routed search within it (OpenRouter mini, not the $0 local model).
		expect(notices[0]).toContain("pool: 2 of 4 models (filter: openrouter)");
		expect(notices[0]).toContain("search → openrouter/openai/gpt-5.5-mini");

		notices.length = 0;
		await command.handler("filter off", ctx as never);
		expect(JSON.parse(await readFile(join(dir, "subagent-kit.json"), "utf8")).modelFilter).toBeUndefined();
		expect(notices[0]).toContain("pool: 4 models (no filter)");
	});

	test("/mode applies the parentModel override in both modes with the manual-override marker", async () => {
		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ parentModel: "openrouter/openai/gpt-5.5" }));
		const { command, setModelCalls, setThinkingCalls } = loadModeCommand();
		const notices: string[] = [];
		const ctx = {
			hasUI: true,
			ui: { notify: (text: string) => notices.push(text) },
			modelRegistry: registryOf(fableParent, openrouterStrong, glm, haiku),
			model: fableParent,
		};

		await command.handler("medium", ctx as never);
		expect(setThinkingCalls).toEqual(["medium"]);
		// Parent switched to the pinned model, shown as a manual override rather than the strong alias pick.
		expect(setModelCalls).toEqual([openrouterStrong]);
		expect(notices[0]).toContain("openrouter/openai/gpt-5.5 (manual override)");
	});

	test("/mode medium keeps the parent when it is already the strongest model overall", async () => {
		const { command, setModelCalls } = loadModeCommand();
		const notices: string[] = [];
		const ctx = {
			hasUI: true,
			ui: { notify: (text: string) => notices.push(text) },
			modelRegistry: registryOf(gpt5, haiku),
			model: gpt5,
		};

		await command.handler("medium", ctx as never);
		expect(setModelCalls).toEqual([]);
		expect(notices[0]).toContain("parent → openai/gpt-5.5");
		expect(notices[0]).toContain("model unchanged");
	});

	test("/mode rejects an ambiguous bare parentModel override", async () => {
		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ parentModel: "gpt-5.5" }));
		const { command, setModelCalls } = loadModeCommand();
		const notices: string[] = [];
		const duplicate = model({ provider: "gateway-b", id: "gpt-5.5", reasoning: true, input: 10, output: 40 });
		const ctx = {
			hasUI: true,
			ui: { notify: (text: string) => notices.push(text) },
			modelRegistry: registryOf(gpt5, duplicate),
			model: fableParent,
		};

		await command.handler("medium", ctx as never);
		expect(setModelCalls).toEqual([]);
		expect(notices[0]).toMatch(/parentModel gpt-5\.5 is ambiguous.*openai\/gpt-5\.5.*gateway-b\/gpt-5\.5/i);
	});
});
