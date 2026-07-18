import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { builtInAgentNames, createModelResolver, getBuiltInAgentPath, loadBuiltInAgent, oracleReportSchema } from "../src/index.ts";
import {
	appendOracleGuidance,
	contextForSubagent,
	escalationDecision,
	loadSubagentConfig,
	oracleCommandPrompt,
	oracleReportFromOutput,
	resolveArtifactsDir,
} from "../extensions/subagent.ts";
import type { SubagentProfile } from "pi-subagent-core";

const anyProfile = { name: "any" } as SubagentProfile;

describe("built-in agents", () => {
	test("ships loadable markdown profiles for every declared role", async () => {
		const profiles = await Promise.all(builtInAgentNames.map(async (name) => {
			await access(getBuiltInAgentPath(name));
			return loadBuiltInAgent(name);
		}));

		expect(profiles.map((profile) => profile.name)).toEqual(builtInAgentNames);
		expect(profiles.every((profile) => profile.systemPrompt.length > 0)).toBe(true);
	});

	test("no longer ships a separate oracle-plan role", () => {
		expect(builtInAgentNames).not.toContain("oracle-plan");
	});

	test("keeps mutation capability exclusive to the worker role", async () => {
		const profiles = await Promise.all(builtInAgentNames.map((name) => loadBuiltInAgent(name)));
		const worker = profiles.find((profile) => profile.name === "worker");
		const readOnly = profiles.filter((profile) => profile.name !== "worker");

		expect(worker?.tools).toEqual(expect.arrayContaining(["edit", "write"]));
		expect(readOnly.every((profile) => !profile.tools?.includes("edit") && !profile.tools?.includes("write"))).toBe(true);
	});

	test("worker relies on the cwd boundary and declares no write allowlist", async () => {
		const worker = await loadBuiltInAgent("worker");
		expect(worker.permission?.write).toBeUndefined();
		expect(worker.permission?.bash).toMatchObject({ mode: "denylist" });
	});

	test("configures oracle for high-effort read-only second opinions with the shared schema", async () => {
		const oracle = await loadBuiltInAgent("oracle");

		expect(oracle).toMatchObject({
			model: "strong-reasoning",
			thinkingLevel: "high",
			tools: ["read", "grep", "find", "ls"],
			contextMode: "selected",
		});
		expect(oracle.output).toEqual({ kind: "schema", schema: oracleReportSchema });
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

	test("folds plan-review guidance into the single oracle card", async () => {
		const oracle = await loadBuiltInAgent("oracle");
		expect(oracle.systemPrompt).toMatch(/parent conversation inherited/i);
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

	test("resolves an agent model override by a unique bare model id", async () => {
		const parent = { id: "parent", name: "Parent" } as never;
		const strong = { provider: "gateway", id: "gpt-5.5", name: "GPT 5.5" } as never;
		const registry = { getAvailable: () => [strong] } as never;
		const resolve = createModelResolver({ registry, parentModel: parent });

		await expect(resolve("gpt-5.5", anyProfile)).resolves.toBe(strong);
	});

	test("resolves a provider-qualified model id", async () => {
		const a = { provider: "gateway-a", id: "gpt-5.5", name: "GPT 5.5" } as never;
		const b = { provider: "gateway-b", id: "gpt-5.5", name: "GPT 5.5" } as never;
		const registry = { getAvailable: () => [a, b] } as never;
		const resolve = createModelResolver({ registry });

		await expect(resolve("gateway-b/gpt-5.5", anyProfile)).resolves.toBe(b);
	});

	test("rejects an ambiguous model target instead of silently choosing a provider", async () => {
		const models = [
			{ provider: "gateway-a", id: "gpt-5.5", name: "GPT 5.5" },
			{ provider: "gateway-b", id: "gpt-5.5", name: "GPT 5.5" },
		] as never;
		const registry = { getAvailable: () => models } as never;
		const resolve = createModelResolver({ registry });

		await expect(resolve("gpt-5.5", anyProfile)).rejects.toThrow(/ambiguous.*gateway-a\/gpt-5\.5.*gateway-b\/gpt-5\.5/i);
	});

	test("falls back to the parent model for the strong-reasoning alias when nothing matches", async () => {
		const parentRouter = { provider: "router", id: "auto", name: "Auto" } as never;
		const registry = { getAvailable: () => [] } as never;
		const resolve = createModelResolver({ registry, parentModel: parentRouter });

		await expect(resolve("strong-reasoning", anyProfile)).resolves.toBe(parentRouter);
	});

	test("does not fall back when a concrete target is unavailable", async () => {
		const parentRouter = { provider: "router", id: "auto", name: "Auto" } as never;
		const registry = { getAvailable: () => [] } as never;
		const resolve = createModelResolver({ registry, parentModel: parentRouter });

		await expect(resolve("gpt-5.5", anyProfile)).rejects.toThrow(/gpt-5\.5.*not available/i);
	});

	test("passes a concrete model object through untouched", async () => {
		const concrete = { provider: "gateway", id: "gpt-5.5", name: "GPT 5.5" } as never;
		const registry = { getAvailable: () => [] } as never;
		const resolve = createModelResolver({ registry });

		await expect(resolve(concrete, anyProfile)).resolves.toBe(concrete);
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

	test("parses the optional oracleGuidance, artifactsDir, and retention keys", async () => {
		const dir = await mkdtemp(join(tmpdir(), "subagent-kit-extra-config-"));
		await writeFile(join(dir, "subagent-kit.json"), JSON.stringify({ oracleGuidance: false, artifactsDir: "./runs", retentionDays: 7, maxRuns: 50 }));

		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: {}, oracleGuidance: false, artifactsDir: "./runs", retentionDays: 7, maxRuns: 50 });
	});

	test("rejects a non-boolean oracleGuidance and a negative retentionDays", async () => {
		const badGuidance = await mkdtemp(join(tmpdir(), "subagent-kit-bad-guidance-"));
		await writeFile(join(badGuidance, "subagent-kit.json"), JSON.stringify({ oracleGuidance: "yes" }));
		await expect(loadSubagentConfig(badGuidance)).rejects.toThrow(/oracleGuidance must be a boolean/i);

		const badRetention = await mkdtemp(join(tmpdir(), "subagent-kit-bad-retention-"));
		await writeFile(join(badRetention, "subagent-kit.json"), JSON.stringify({ retentionDays: -3 }));
		await expect(loadSubagentConfig(badRetention)).rejects.toThrow(/retentionDays must be a non-negative number/i);
	});

	test("resolves the global per-project artifacts bucket and honors an override", () => {
		const bucket = resolveArtifactsDir("/Users/me/code/project");
		expect(bucket).toMatch(/subagent-runs[\\/][A-Za-z0-9-]+-[0-9a-f]{8}$/);

		expect(resolveArtifactsDir("/repo", "/abs/runs")).toBe("/abs/runs");
		expect(resolveArtifactsDir("/repo", "runs")).toBe("/repo/runs");
	});

	test("asks the host to confirm an escalation and fails closed without a UI", async () => {
		const allowUi = { confirm: async () => true };
		const denyUi = { confirm: async () => false };
		const never = { confirm: async () => { throw new Error("should not prompt"); } };

		await expect(escalationDecision(allowUi, true, { tool: "bash", question: "run it?" })).resolves.toBe("allow");
		await expect(escalationDecision(denyUi, true, { tool: "bash", question: "run it?" })).resolves.toBe("deny");
		await expect(escalationDecision(never, false, { tool: "bash", question: "run it?" })).resolves.toBe("deny");
	});
});
