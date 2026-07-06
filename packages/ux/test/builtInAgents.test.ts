import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { builtInAgentNames, getBuiltInAgentPath, loadBuiltInAgent } from "../src/index.ts";
import {
	appendOracleGuidance,
	contextForSubagent,
	loadSubagentConfig,
	oracleCommandPrompt,
	oracleReportFromOutput,
	resolveProfileModel,
} from "../extensions/subagent.ts";

describe("built-in agents", () => {
	test("ships loadable markdown profiles for every declared role", async () => {
		const profiles = await Promise.all(builtInAgentNames.map(async (name) => {
			await access(getBuiltInAgentPath(name));
			return loadBuiltInAgent(name);
		}));

		expect(profiles.map((profile) => profile.name)).toEqual(builtInAgentNames);
		expect(profiles.every((profile) => profile.systemPrompt.length > 0)).toBe(true);
	});

	test("keeps mutation capability exclusive to the worker role", async () => {
		const profiles = await Promise.all(builtInAgentNames.map((name) => loadBuiltInAgent(name)));
		const worker = profiles.find((profile) => profile.name === "worker");
		const readOnly = profiles.filter((profile) => profile.name !== "worker");

		expect(worker?.tools).toEqual(expect.arrayContaining(["edit", "write"]));
		expect(readOnly.every((profile) => !profile.tools?.includes("edit") && !profile.tools?.includes("write"))).toBe(true);
	});

	test("configures oracle for high-effort read-only second opinions", async () => {
		const oracle = await loadBuiltInAgent("oracle");

		expect(oracle).toMatchObject({
			model: "strong-reasoning",
			thinkingLevel: "high",
			tools: ["read", "grep", "find", "ls"],
		});
		expect(oracle.output).toMatchObject({
			kind: "schema",
			schema: {
				required: ["verdict", "confidence", "report_markdown"],
				properties: {
					verdict: { enum: ["safe_to_proceed", "proceed_with_changes", "blocked", "need_more_information"] },
					confidence: { enum: ["low", "medium", "high"] },
					report_markdown: { type: "string" },
				},
			},
		});
		for (const section of ["Verdict", "Confidence", "Key Findings", "Assumptions", "Recommended Plan", "Verification Plan", "Escalation Questions"]) {
			expect(oracle.systemPrompt).toContain(`## ${section}`);
		}
	});

	test("ships a fork-context oracle role for plan reviews", async () => {
		const profile = await loadBuiltInAgent("oracle-plan");

		expect(profile).toMatchObject({
			name: "oracle-plan",
			contextMode: "fork",
			thinkingLevel: "high",
			tools: ["read", "grep", "find", "ls"],
		});
	});

	test("adds the current working tree diff to selected context on request", () => {
		expect(contextForSubagent(["src/a.ts"], true)).toEqual({ files: ["src/a.ts"], diff: { base: "HEAD" } });
		expect(contextForSubagent(undefined, false, { sessionFile: "/sessions/parent.jsonl", entryId: "leaf" })).toEqual({
			forkFrom: { sessionFile: "/sessions/parent.jsonl", entryId: "leaf" },
		});
		expect(contextForSubagent(undefined, false)).toBeUndefined();
	});

	test("extracts oracle routing fields and markdown from structured output", () => {
		expect(oracleReportFromOutput({ verdict: "blocked", confidence: "high", report_markdown: "## Verdict\nblocked" })).toEqual({
			verdict: "blocked",
			confidence: "high",
			reportMarkdown: "## Verdict\nblocked",
		});
		expect(oracleReportFromOutput({ verdict: "unknown" })).toBeUndefined();
	});

	test("builds the explicit oracle command request and parent trigger guidance", () => {
		expect(oracleCommandPrompt("challenge this plan")).toContain('agent: "oracle"');
		expect(oracleCommandPrompt("challenge this plan")).toContain("includeDiff: true");
		expect(oracleCommandPrompt("   ")).toBeUndefined();
		const prompt = appendOracleGuidance("base prompt");
		expect(prompt).toContain("base prompt");
		expect(prompt).toContain("auth, billing, permissions, data migration, or a public API contract");
		expect(prompt).toContain("Never use oracle for typo fixes");
	});

	test("resolves an agent model override by a unique bare model id", () => {
		const parent = { id: "parent", name: "Parent" } as never;
		const strong = { provider: "gateway", id: "gpt-5.5", name: "GPT 5.5" } as never;
		const registry = { getAvailable: () => [strong] } as never;

		expect(resolveProfileModel("strong-reasoning", registry, parent, "gpt-5.5")).toEqual({
			model: strong,
		});
	});

	test("gives a per-agent model override precedence over a concrete role-card model", () => {
		const roleCardModel = { provider: "default", id: "standard", name: "Standard" } as never;
		const configured = { provider: "gateway", id: "gpt-5.5", name: "GPT 5.5" } as never;
		const registry = { getAvailable: () => [configured] } as never;

		expect(resolveProfileModel(roleCardModel, registry, undefined, "gpt-5.5")).toEqual({ model: configured });
	});

	test("rejects an ambiguous agent model override instead of silently choosing a provider", () => {
		const models = [
			{ provider: "gateway-a", id: "gpt-5.5", name: "GPT 5.5" },
			{ provider: "gateway-b", id: "gpt-5.5", name: "GPT 5.5" },
		] as never;
		const registry = { getAvailable: () => models } as never;

		expect(() => resolveProfileModel("strong-reasoning", registry, undefined, "gpt-5.5"))
			.toThrow(/ambiguous.*gateway-a\/gpt-5\.5.*gateway-b\/gpt-5\.5/i);
	});

	test("preserves parent-model fallback when the user has not configured an alias", () => {
		const parentRouter = { provider: "router", id: "auto", name: "Auto" } as never;
		const registry = { getAvailable: () => [] } as never;

		expect(resolveProfileModel("strong-reasoning", registry, parentRouter)).toEqual({ model: parentRouter });
	});

	test("does not fall back when a configured alias target is unavailable", () => {
		const parentRouter = { provider: "router", id: "auto", name: "Auto" } as never;
		const registry = { getAvailable: () => [] } as never;

		expect(() => resolveProfileModel("strong-reasoning", registry, parentRouter, "gpt-5.5"))
			.toThrow(/strong-reasoning.*gpt-5\.5.*not available/i);
	});

	test("loads per-agent model overrides from the user-level subagent-kit config", async () => {
		const dir = await mkdtemp(join(tmpdir(), "subagent-kit-config-"));
		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ agents: { oracle: { model: "gpt-5.5" } } }));

		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: { oracle: { model: "gpt-5.5" } } });
	});

	test("rejects invalid per-agent model configuration", async () => {
		const dir = await mkdtemp(join(tmpdir(), "subagent-kit-invalid-config-"));
		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ agents: { oracle: { model: 55 } } }));

		await expect(loadSubagentConfig(dir)).rejects.toThrow(/invalid.*agents.*model/i);
	});
});
