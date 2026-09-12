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
	rampSweCapability,
	resolveAlias,
	resolveRoleRouting,
	SUBAGENT_MODES,
} from "../src/index.ts";
import subagentExtension, {
	applyToolActivation,
	effectiveAgentConfig,
	effectiveModeRoute,
	isActivated,
	KIT_TOOL_NAMES,
	loadSubagentConfig,
	persistMode,
	persistModelFilter,
} from "../extensions/subagent.ts";

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
const glm52 = model({ provider: "example-ai", id: "glm-5.3", reasoning: true, contextWindow: 1_000_000, input: 0, output: 0 });
const deepseekPro = model({ provider: "example-ai", id: "deepseek-v4-pro", reasoning: true, contextWindow: 1_000_000, input: 0, output: 0 });

describe("mode routing table", () => {
	test("uses the four explicit modes and exact role models", () => {
		expect(SUBAGENT_MODES).toEqual(["low", "medium", "high", "ultra"]);
		expect(MODE_ROUTING_TABLE.advisor.low).toMatchObject({ model: "gpt-5.6-sol", thinkingLevel: "high", maxTurns: 16 });
		expect(MODE_ROUTING_TABLE.advisor.high).toMatchObject({ model: "gpt-5.6-sol", thinkingLevel: "high", maxTurns: 16 });
		expect(MODE_ROUTING_TABLE.advisor.ultra).toMatchObject({ model: "gpt-5.6-sol", thinkingLevel: "xhigh", maxTurns: 24 });
		expect(MODE_ROUTING_TABLE.search.medium).toMatchObject({ model: "gpt-5.6-terra", thinkingLevel: "low", maxTurns: 12 });
		expect(MODE_ROUTING_TABLE.search.ultra).toMatchObject({ maxTurns: 24 });
	});

	test("keeps only the shipped read-only roles in the routing table", () => {
		expect(Object.keys(MODE_ROUTING_TABLE)).toEqual(["advisor", "search"]);
	});

	test("uses explicit parent models and effort per mode", () => {
		expect(PARENT_MODE_ENTRY.low).toEqual({ model: "glm-5.3", thinkingLevel: "medium" });
		expect(PARENT_MODE_ENTRY.medium).toEqual({ model: "gpt-5.6-sol", thinkingLevel: "medium" });
		expect(PARENT_MODE_ENTRY.high).toEqual({ model: "gpt-5.6-sol", thinkingLevel: "xhigh" });
		expect(PARENT_MODE_ENTRY.ultra).toEqual({ model: "gpt-5.6-sol", thinkingLevel: "xhigh" });
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

	test("balanced orders tied mid-tier models by Ramp SWE capability instead of registry order", () => {
		const outcome = resolveAlias("balanced", { registry: registryOf(deepseekPro, glm52), parentModel: gpt5 });
		expect(outcome.modelId).toBe("example-ai/glm-5.3");
		expect(outcome.reason).toMatch(/mid-tier/i);
	});

	test("Ramp SWE capability matching uses the longest model-id match", () => {
		expect(rampSweCapability(model({ provider: "example-codex", id: "gpt-5.4-mini" }))).toBe(59.5);
		expect(rampSweCapability(model({ provider: "example-codex", id: "gpt-5.4" }))).toBe(73.4);
	});

	test("balanced excludes an unqualified free model from its median-cost fallback", () => {
		const outcome = resolveAlias("balanced", { registry: registryOf(gpt5, localFree), parentModel: fableParent });
		expect(outcome.modelId).toBe("openai/gpt-5.5");
		expect(outcome.degraded).toBe(false);
	});

	test("automatic routing always excludes local providers", () => {
		const blocked = resolveAlias("fast-search", { registry: registryOf(localFree), parentModel: fableParent });
		expect(blocked.modelId).toBe("anthropic/claude-fable");
		expect(blocked.degradedReason).toMatch(/no allowed models available/i);
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
		expect(freeOnly.modelId).toBe("openai/gpt-5.5");
		expect(freeOnly.degraded).toBe(true);
		expect(freeOnly.degradedReason).toMatch(/no allowed models available/i);
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

	test("a modelFilter that matches nothing fails closed instead of widening to the whole pool", () => {
		const outcome = resolveAlias("balanced", { registry: registryOf(gpt5, glm, haiku), parentModel: gpt5, modelFilter: "nonesuch" });
		expect(outcome.modelId).toBeUndefined();
		expect(outcome.model).toBeUndefined();
		expect(outcome.degraded).toBe(true);
		expect(outcome.degradedReason).toMatch(/fail-closed/i);
	});
});

describe("resolved routing table", () => {
	test("lets a manual agents.<role>.model override beat the mode table", () => {
		const row = resolveRoleRouting("advisor", "medium", {
			registry: registryOf(fableParent, gpt5),
			parentModel: fableParent,
			manualOverrides: { advisor: { model: "openrouter/custom-strong" } },
		});
		expect(row.manualModel).toBe("openrouter/custom-strong");
		expect(row.modelId).toBe("openrouter/custom-strong");
		expect(row.degraded).toBe(false);
	});

	test("shows a thinking-only override without replacing the mode model", () => {
		const explicit = model({ provider: "openai", id: "gpt-5.6-terra", reasoning: true });
		const row = resolveRoleRouting("search", "medium", {
			registry: registryOf(explicit),
			parentModel: gpt5,
			manualOverrides: { search: { thinkingLevel: "high" } },
		});
		expect(row.modelId).toBe("openai/gpt-5.6-terra");
		expect(row.thinkingLevel).toBe("high");
		expect(row.manualModel).toBeUndefined();
	});

	test("builds a full row per role and flags unavailable explicit models", () => {
		const rows = buildRoutingTable("low", { registry: registryOf(fableParent), parentModel: fableParent });
		expect(rows.map((r) => r.role)).toEqual(["advisor", "search"]);
		const advisor = rows.find((r) => r.role === "advisor")!;
		expect(advisor.thinkingLevel).toBe("high");
		expect(advisor.degraded).toBe(true);
	});
});

describe("mode config + /mode command", () => {
	let dir: string;
	const originalEnv = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-advisor-mode-"));
		process.env.PI_CODING_AGENT_DIR = dir;
	});
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalEnv;
	});

	test("validates the mode field", async () => {
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ mode: "medium" }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: {}, mode: "medium" });

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ mode: "ultra" }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: {}, mode: "ultra" });

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ mode: "turbo" }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/mode must be one of low, medium/i);
	});

	test("loads and validates complete per-tier routing from JSON", async () => {
		const modes = {
			low: {
				agent: { model: "xai/grok-4.6", thinkingLevel: "high" },
				advisor: { model: "openai-codex/gpt-5.6-sol", thinkingLevel: "high", maxTurns: 20 },
			},
			medium: {
				agent: { model: "openai-codex/gpt-5.6-sol", thinkingLevel: "high" },
				advisor: { model: "openai-codex/gpt-5.6-sol", thinkingLevel: "xhigh" },
			},
		} as const;
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ modes }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: {}, modes });
		expect(effectiveModeRoute({ modes }, "low", "agent")).toMatchObject(modes.low.agent);
		expect(effectiveModeRoute({ modes }, "medium", "advisor")).toMatchObject(modes.medium.advisor);

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ modes: { turbo: {} } }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/not a known tier/i);
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ modes: { low: { agent: { model: "xai/grok-4.6" } } } }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/thinkingLevel must be/i);
	});

	test("validates modelFilter and tiers config", async () => {
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ modelFilter: "openrouter", tiers: [{ pattern: "terra", tier: "fast" }] }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: {}, modelFilter: "openrouter", tiers: [{ pattern: "terra", tier: "fast" }] });

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ modelFilter: "" }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/modelFilter must be a non-empty string/i);

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ tiers: [{ pattern: "x", tier: "blazing" }] }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/tiers\[\].tier must be one of strong, mid, fast/i);

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ tiers: [{ tier: "fast" }] }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/tiers\[\].pattern must be a non-empty string/i);
	});

	test("validates activation and per-role budget settings", async () => {
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ mode: "medium", autoActivate: true, agents: { advisor: { maxTurns: 8, finalizeTurns: 2 } } }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ mode: "medium", autoActivate: true, agents: { advisor: { maxTurns: 8, finalizeTurns: 2 } } });

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { finalizeAfterTurns: 6 } } }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: { advisor: { maxTurns: 6 } } });

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ autoActivate: "yes" }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/autoActivate must be a boolean/i);
	});

	test("validates agents.<role>.onlyInModes as a non-empty array of known tiers", async () => {
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { model: "x/y", onlyInModes: ["high", "ultra"] } } }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: { advisor: { model: "x/y", onlyInModes: ["high", "ultra"] } } });

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { model: "x/y", onlyInModes: [] } } }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/onlyInModes must be a non-empty array/i);

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { model: "x/y", onlyInModes: ["turbo"] } } }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/onlyInModes must be a non-empty array of low, medium, high, ultra/i);
	});

	test("validates the parentModel override as a non-empty string", async () => {
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ parentModel: "openrouter/openai/gpt-5.5" }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: {}, parentModel: "openrouter/openai/gpt-5.5" });

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ parentModel: 5 }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/parentModel must be a non-empty string/i);
	});

	test("persistModelFilter sets and clears the filter while preserving other fields", async () => {
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: {}, mode: "low" }));
		await persistModelFilter("openrouter", dir);
		expect(JSON.parse(await readFile(join(dir, "pi-advisor.json"), "utf8"))).toEqual({ agents: {}, mode: "low", modelFilter: "openrouter" });
		await persistModelFilter(undefined, dir);
		expect(JSON.parse(await readFile(join(dir, "pi-advisor.json"), "utf8"))).toEqual({ agents: {}, mode: "low" });
	});

	test("persistMode writes the mode while preserving other fields", async () => {
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { model: "x/y" } }, retentionDays: 7 }));
		await persistMode("low", dir);
		const written = JSON.parse(await readFile(join(dir, "pi-advisor.json"), "utf8"));
		expect(written).toEqual({ agents: { advisor: { model: "x/y" } }, retentionDays: 7, mode: "low" });
	});

	test("persists to the canonical config file when none exists", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "pi-advisor-fresh-"));
		await persistMode("medium", fresh);
		await expect(access(join(fresh, "pi-advisor.json"))).resolves.toBeUndefined();
	});

	test("loads a legacy config and migrates its complete contents on the next write", async () => {
		const legacyPath = join(dir, "subagent-kit.json");
		const original = { agents: { advisor: { model: "x/y" } }, retentionDays: 7, unknown: { preserved: true } };
		await writeFile(legacyPath, JSON.stringify(original));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: { advisor: { model: "x/y" } }, retentionDays: 7 });

		await persistMode("low", dir);
		expect(JSON.parse(await readFile(join(dir, "pi-advisor.json"), "utf8"))).toEqual({ ...original, mode: "low" });
		await expect(access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(JSON.parse(await readFile(`${legacyPath}.bak`, "utf8"))).toEqual(original);
	});

	test("prefers the canonical config when both names exist", async () => {
		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ mode: "low" }));
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ mode: "high" }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: {}, mode: "high" });
	});

	function loadModeCommand() {
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const setModelCalls: unknown[] = [];
		const setThinkingCalls: string[] = [];
		// A live active-tool set the fake host mutates via get/setActiveTools, seeded with the kit's tools + a bystander.
		let activeTools = [...KIT_TOOL_NAMES, "read"];
		const pi = {
			on: () => {},
			registerTool: () => {},
			registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, opts),
			registerShortcut: () => {},
			sendUserMessage: () => {},
			setModel: async (m: unknown) => { setModelCalls.push(m); return true; },
			setThinkingLevel: (level: string) => { setThinkingCalls.push(level); },
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => { activeTools = names; },
		};
		subagentExtension(pi as never);
		return { command: commands.get("mode")!, setModelCalls, setThinkingCalls, activeTools: () => activeTools };
	}

	test("/mode uses JSON-declared parent and role routes", async () => {
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({
			modes: {
				low: {
					agent: { model: "xai/grok-4.6", thinkingLevel: "high" },
					advisor: { model: "openai-codex/gpt-5.6-sol", thinkingLevel: "xhigh" },
				},
			},
		}));
		const { command, setModelCalls, setThinkingCalls } = loadModeCommand();
		const notices: string[] = [];
		const grok = model({ provider: "xai", id: "grok-4.6", reasoning: true });
		const sol = model({ provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true });
		const ctx = {
			hasUI: true,
			ui: { notify: (text: string) => notices.push(text) },
			modelRegistry: registryOf(grok, sol),
			model: sol,
		};
		await command.handler("low", ctx as never);
		expect(setThinkingCalls).toEqual(["high"]);
		expect(setModelCalls).toEqual([grok]);
		expect(notices[0]).toContain("advisor → openai-codex/gpt-5.6-sol · thinking xhigh");
	});

	test("/mode prints the resolved table and persists the mode, retuning the parent session", async () => {
		const { command, setModelCalls, setThinkingCalls } = loadModeCommand();
		const notices: string[] = [];
		const ctx = {
			hasUI: true,
			ui: { notify: (text: string) => notices.push(text) },
			modelRegistry: registryOf(
				fableParent,
				gpt5,
				glm,
				haiku,
				model({ provider: "openai", id: "gpt-5.6-sol", reasoning: true }),
				model({ provider: "openai", id: "gpt-5.6-terra", reasoning: true }),
				model({ provider: "zhipu", id: "glm-5.3", reasoning: true }),
			),
			model: fableParent,
		};

		await command.handler("low", ctx as never);

		// Persisted.
		const written = JSON.parse(await readFile(join(dir, "pi-advisor.json"), "utf8"));
		expect(written.mode).toBe("low");
		// Printed a resolved table.
		expect(notices[0]).toContain("mode low");
		expect(notices[0]).toContain("advisor → openai/gpt-5.6-sol");
		expect(notices[0]).toContain("search → openai/gpt-5.6-terra");
		expect(notices[0]).not.toMatch(/pool:|turns|model unchanged|Config:/);
		// Retuned the parent session. Low mode runs the parent on a mid-tier model at medium thinking (Amp parity).
		expect(setThinkingCalls).toEqual(["medium"]);
		expect(setModelCalls.length).toBe(1);
	});

	test("isActivated requires explicit cross-session autoActivate", () => {
		expect(isActivated({})).toBe(false);
		expect(isActivated({ mode: "off", autoActivate: true })).toBe(false);
		expect(isActivated({ mode: "low" })).toBe(false);
		expect(isActivated({ mode: "high", autoActivate: true })).toBe(true);
	});

	test("activates only kit tools while preserving bystanders", () => {
		let active = ["read", "write"];
		const pi = { getActiveTools: () => active, setActiveTools: (n: string[]) => { active = n; } };
		applyToolActivation(pi as never, true);
		for (const name of KIT_TOOL_NAMES) expect(active).toContain(name);
		expect(active).not.toContain("review");
		expect(active).toContain("read");
		applyToolActivation(pi as never, false);
		for (const name of KIT_TOOL_NAMES) expect(active).not.toContain(name);
		expect(active).toEqual(["read", "write"]);
		// Absent host hooks (e.g. print mode): must not throw.
		expect(() => applyToolActivation({} as never, true)).not.toThrow();
	});

	test("/mode off deactivates the kit: persists off and hides the subagent tools from the model", async () => {
		const { command, activeTools } = loadModeCommand();
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (t: string) => notices.push(t) }, modelRegistry: registryOf(fableParent, gpt5), model: fableParent };

		await command.handler("off", ctx as never);
		expect(JSON.parse(await readFile(join(dir, "pi-advisor.json"), "utf8")).mode).toBe("off");
		for (const name of KIT_TOOL_NAMES) expect(activeTools()).not.toContain(name);
		expect(activeTools()).toContain("read");
		expect(notices[0]).toContain("mode off");
	});

	test("/mode high activates, exposes the subagent tools, and retunes the parent to high thinking", async () => {
		const { command, setThinkingCalls, activeTools } = loadModeCommand();
		// Start from a deactivated set to prove activation re-adds the tools.
		await command.handler("off", { hasUI: true, ui: { notify: () => {} }, modelRegistry: registryOf(gpt5, haiku), model: gpt5 } as never);
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (t: string) => notices.push(t) }, modelRegistry: registryOf(gpt5, haiku), model: gpt5 };

		await command.handler("high", ctx as never);
		expect(JSON.parse(await readFile(join(dir, "pi-advisor.json"), "utf8")).mode).toBe("high");
		for (const name of KIT_TOOL_NAMES) expect(activeTools()).toContain(name);
		expect(activeTools()).not.toContain("review");
		expect(notices[0]).toContain("mode high");
		expect(setThinkingCalls.at(-1)).toBe("xhigh");
	});

	test("/mode ultra activates, persists, and applies xhigh parent reasoning", async () => {
		const { command, setThinkingCalls, activeTools } = loadModeCommand();
		const notices: string[] = [];
		const sol = model({ provider: "openai", id: "gpt-5.6-sol", reasoning: true });
		const terra = model({ provider: "openai", id: "gpt-5.6-terra", reasoning: true });
		const ctx = {
			hasUI: true,
			ui: { notify: (text: string) => notices.push(text) },
			modelRegistry: registryOf(sol, terra),
			model: sol,
		};

		await command.handler("ultra", ctx as never);

		expect(JSON.parse(await readFile(join(dir, "pi-advisor.json"), "utf8")).mode).toBe("ultra");
		for (const name of KIT_TOOL_NAMES) expect(activeTools()).toContain(name);
		expect(notices[0]).toContain("mode ultra");
		expect(notices[0]).toContain("advisor → openai/gpt-5.6-sol · thinking xhigh");
		expect(setThinkingCalls.at(-1)).toBe("xhigh");
	});

	test("effectiveAgentConfig gates a tier-scoped override to its tiers, and applies an ungated one everywhere", () => {
		const highOnly = { model: "x/high", onlyInModes: ["high" as const] };
		expect(effectiveAgentConfig(highOnly, "high")).toBe(highOnly);
		expect(effectiveAgentConfig(highOnly, "low")).toBeUndefined();
		expect(effectiveAgentConfig(highOnly, "medium")).toBeUndefined();
		const ungated = { model: "x/y" };
		expect(effectiveAgentConfig(ungated, "low")).toBe(ungated);
		expect(effectiveAgentConfig(undefined, "high")).toBeUndefined();
	});

	test("a tier-gated model override surfaces in the /mode table only in its tier", async () => {
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({
			agents: { advisor: { model: "gpt-5.5", onlyInModes: ["high"] } },
		}));
		const { command } = loadModeCommand();
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (t: string) => notices.push(t) }, modelRegistry: registryOf(gpt5, haiku), model: gpt5 };

		await command.handler("high", ctx as never);
		expect(notices[0]).toContain("advisor → gpt-5.5");
		expect(notices[0]).toContain("(manual override)");

		notices.length = 0;
		await command.handler("low", ctx as never);
		expect(notices[0]).toContain("advisor → gpt-5.6-sol");
	});

	test("/mode with no argument while off shows a deactivated header and previews the default tier", async () => {
		const { command } = loadModeCommand();
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (t: string) => notices.push(t) }, modelRegistry: registryOf(fableParent, gpt5, haiku), model: fableParent };
		await command.handler("", ctx as never);
		expect(notices[0]).toMatch(/mode off/);
		expect(notices[0]).toContain("parent →");
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
		expect(JSON.parse(await readFile(join(dir, "pi-advisor.json"), "utf8")).modelFilter).toBe("openrouter");
		// The legacy filter is still persisted; `/mode` only mentions it when a keyword is active.
		expect(notices[0]).toContain("filter: openrouter (2/3)");
		expect(notices[0]).toContain("search → gpt-5.6-terra");

		notices.length = 0;
		await command.handler("filter off", ctx as never);
		expect(JSON.parse(await readFile(join(dir, "pi-advisor.json"), "utf8")).modelFilter).toBeUndefined();
		expect(notices[0]).not.toMatch(/filter:|pool:/);
	});

	test("/mode applies the parentModel override in both modes with the manual-override marker", async () => {
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ parentModel: "openrouter/openai/gpt-5.5" }));
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
		expect(notices[0]).toContain("parent → openrouter/openai/gpt-5.5 · thinking medium (manual override)");
	});

	test("/mode medium keeps the parent when it already matches the configured model", async () => {
		const { command, setModelCalls } = loadModeCommand();
		const notices: string[] = [];
		const configured = model({ provider: "openai", id: "gpt-5.6-sol", reasoning: true });
		const ctx = {
			hasUI: true,
			ui: { notify: (text: string) => notices.push(text) },
			modelRegistry: registryOf(configured, gpt5, haiku),
			model: configured,
		};

		await command.handler("medium", ctx as never);
		expect(setModelCalls).toEqual([]);
		expect(notices[0]).toContain("parent → gpt-5.6-sol");
		expect(notices[0]).not.toContain("model unchanged");
	});

	test("/mode rejects an ambiguous bare parentModel override", async () => {
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ parentModel: "gpt-5.5" }));
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
		expect(notices[0]).toMatch(/⚠ parentModel gpt-5\.5 is ambiguous.*openai\/gpt-5\.5.*gateway-b\/gpt-5\.5/i);
	});
});
