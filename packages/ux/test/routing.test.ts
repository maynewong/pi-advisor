import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	buildRoutingTable,
	effectiveTier,
	MODE_ROUTING_TABLE,
	modelFamily,
	resolveAlias,
	resolveRoleRouting,
	SUBAGENT_MODES,
} from "../src/index.ts";
import subagentExtension, { loadSubagentConfig, persistMode } from "../extensions/subagent.ts";

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
		// Retuned the parent session.
		expect(setThinkingCalls).toEqual(["low"]);
		expect(setModelCalls.length).toBe(1);
	});

	test("/mode rejects an unknown mode argument", async () => {
		const { command } = loadModeCommand();
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (text: string) => notices.push(text) }, modelRegistry: registryOf(fableParent), model: fableParent };
		await command.handler("turbo", ctx as never);
		expect(notices[0]).toMatch(/Usage: \/mode/);
	});
});
