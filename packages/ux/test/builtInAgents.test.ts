import { access, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { builtInAgentNames, createModelResolver, getBuiltInAgentPath, loadBuiltInAgent, advisorReportSchema } from "../src/index.ts";
import { buildContextPacket } from "@maynewong/pi-advisor-core";
import subagentExtension, {
	appendAdvisorGuidance,
	completedSummary,
	contextForSubagent,
	escalationDecision,
	inheritedConversationPacket,
	loadSubagentConfig,
	advisorCommandPrompt,
	advisorReportFromOutput,
	rememberReloadActivation,
	consumeReloadActivation,
	resolveAgentRunCwd,
	resolveArtifactsDir,
	roleToolSpecs,
	TURN_BUDGET_NOTE,
} from "../extensions/subagent.ts";
import type { SubagentResult } from "@maynewong/pi-advisor-core";
import type { SubagentProfile } from "@maynewong/pi-advisor-core";

const anyProfile = { name: "any" } as SubagentProfile;

/** Minimal fake extension host that records the tools, commands, and lifecycle hooks the extension registers. */
function captureRegistrations() {
	const tools = new Map<string, { parameters: { required?: string[]; properties?: Record<string, unknown> }; description: string; label: string }>();
	const commands = new Set<string>();
	const commandDefs = new Map<string, { handler: (...args: never[]) => unknown }>();
	const events = new Set<string>();
	const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
	const pi = {
		on: (event: string, handler: (...args: never[]) => unknown) => {
			events.add(event);
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (def: { name: string } & Record<string, unknown>) => { tools.set(def.name, def as never); },
		registerCommand: (name: string, def: { handler: (...args: never[]) => unknown }) => { commands.add(name); commandDefs.set(name, def); },
		registerShortcut: () => {},
		sendUserMessage: () => {},
	};
	subagentExtension(pi as never);
	return { tools, commands, commandDefs, events, handlers };
}

describe("built-in agents", () => {
	test("ships loadable markdown profiles for every declared role", async () => {
		const profiles = await Promise.all(builtInAgentNames.map(async (name) => {
			await access(getBuiltInAgentPath(name));
			return loadBuiltInAgent(name);
		}));

		expect(profiles.map((profile) => profile.name)).toEqual(builtInAgentNames);
		expect(profiles.every((profile) => profile.systemPrompt.length > 0)).toBe(true);
	});

	test("uses role-specific context budgets rather than model-window-derived budgets", async () => {
		await expect(loadBuiltInAgent("search")).resolves.toMatchObject({ contextMaxBytes: 64_000 });
		await expect(loadBuiltInAgent("advisor")).resolves.toMatchObject({ contextMaxBytes: 256_000 });
	});

	test("no longer ships a separate advisor-plan role", () => {
		expect(builtInAgentNames).not.toContain("advisor-plan");
	});

	test("keeps every shipped role read-only", async () => {
		const profiles = await Promise.all(builtInAgentNames.map((name) => loadBuiltInAgent(name)));
		expect(profiles.every((profile) => !profile.tools?.includes("edit") && !profile.tools?.includes("write"))).toBe(true);
	});

	test("configures advisor for high-effort read-only second opinions with the shared schema", async () => {
		const advisor = await loadBuiltInAgent("advisor");

		expect(advisor).toMatchObject({
			thinkingLevel: "high",
			tools: ["read", "grep", "find", "ls"],
			contextMode: "selected",
			contextMaxBytes: 256_000,
		});
		expect(advisor.output).toEqual({ kind: "schema", schema: advisorReportSchema });
		expect(advisor.output).toMatchObject({
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
			expect(advisor.systemPrompt).toContain(`## ${section}`);
		}
	});

	test("folds plan-review and adversarial-diff guidance into the single advisor card", async () => {
		const advisor = await loadBuiltInAgent("advisor");
		expect(advisor.systemPrompt).toMatch(/parent conversation is inherited/i);
		expect(advisor.systemPrompt).toMatch(/adversarial maintainer/i);
	});

	test("adds the current working tree diff to selected context on request", () => {
		expect(contextForSubagent(["src/a.ts"], true)).toEqual({ files: ["src/a.ts"], diff: { base: "HEAD" } });
		expect(contextForSubagent(undefined, false, { sessionFile: "/sessions/parent.jsonl", entryId: "leaf" })).toEqual({
			forkFrom: { sessionFile: "/sessions/parent.jsonl", entryId: "leaf" },
		});
		expect(contextForSubagent(undefined, false)).toBeUndefined();
	});

	test("runs read-only repository search from an explicit alternate root", async () => {
		const parentCwd = await mkdtemp(join(tmpdir(), "subagent-parent-"));
		const repository = await mkdtemp(join(tmpdir(), "subagent-repository-"));
		await writeFile(join(repository, "README.md"), "target repository\n");

		const runCwd = await resolveAgentRunCwd(parentCwd, repository);
		const packet = await buildContextPacket({ files: ["."] }, { cwd: runCwd });

		expect(runCwd).toBe(await realpath(repository));
		expect(packet.text).toContain("## Directory scope: .");
		expect(packet.sources).toEqual(["directory:."]);
	});

	test("exposes an alternate repository root only on the read-only search tool", () => {
		const { tools } = captureRegistrations();
		expect(tools.get("search")?.parameters.properties).toHaveProperty("root");
		expect(tools.get("advisor")?.parameters.properties).not.toHaveProperty("root");
		expect(tools.has("review")).toBe(false);
	});

	test("materializes the selected parent branch as user/assistant text without tool traces", async () => {
		const directory = await mkdtemp(join(tmpdir(), "subagent-inherited-context-"));
		const sessionFile = join(directory, "parent.jsonl");
		const header = { type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: directory };
		const first = { type: "message", id: "first", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "review the API" } };
		const reply = {
			type: "message", id: "reply", parentId: "first", timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "secret scratchpad" },
					{ type: "text", text: "I propose three states" },
					{ type: "toolCall", name: "read", arguments: { path: "src/secret.ts" } },
				],
				api: "test", provider: "test", model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now(),
			},
		};
		const tool = {
			type: "message", id: "tool", parentId: "reply", timestamp: new Date().toISOString(),
			message: { role: "toolResult", toolName: "read", content: "secret file body", isError: false },
		};
		await writeFile(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(first)}\n${JSON.stringify(reply)}\n${JSON.stringify(tool)}\n`);

		const packet = inheritedConversationPacket({ sessionFile, entryId: "tool" });
		expect(packet).toContain("### user");
		expect(packet).toContain("review the API");
		expect(packet).toContain("I propose three states");
		expect(packet).not.toContain("secret scratchpad");
		expect(packet).not.toContain("src/secret.ts");
		expect(packet).not.toContain("secret file body");
		expect(packet).not.toContain("toolCall");
		expect(packet).not.toContain("### tool");
	});

	test("extracts advisor routing fields and markdown from structured output", () => {
		expect(advisorReportFromOutput({ verdict: "blocked", confidence: "high", report_markdown: "## Verdict\nblocked" })).toEqual({
			verdict: "blocked",
			confidence: "high",
			reportMarkdown: "## Verdict\nblocked",
		});
		expect(advisorReportFromOutput({ verdict: "unknown" })).toBeUndefined();
	});

	test("builds the explicit dedicated advisor request and parent trigger guidance", () => {
		expect(advisorCommandPrompt("challenge this plan")).toContain("Call the advisor tool");
		expect(advisorCommandPrompt("challenge this plan")).not.toContain('agent: "advisor"');
		expect(advisorCommandPrompt("challenge this plan")).toContain("includeDiff: true");
		expect(advisorCommandPrompt("   ")).toBeUndefined();
		const prompt = appendAdvisorGuidance("base prompt");
		expect(prompt).toContain("base prompt");
		expect(prompt).toContain("auth, billing, permissions, data migration, or a public API contract");
		expect(prompt).toContain("Never use advisor for typo fixes");
	});

	test("hands the current activation state across an in-process reload exactly once", () => {
		const ctx = {
			cwd: "/repo",
			sessionManager: { getSessionFile: () => "/sessions/current.jsonl" },
		};
		rememberReloadActivation(ctx as never, true);
		expect(consumeReloadActivation(ctx as never)).toBe(true);
		expect(consumeReloadActivation(ctx as never)).toBeUndefined();

		const other = {
			cwd: "/other",
			sessionManager: { getSessionFile: () => "/sessions/other.jsonl" },
		};
		rememberReloadActivation(other as never, false);
		expect(consumeReloadActivation(ctx as never)).toBeUndefined();
		expect(consumeReloadActivation(other as never)).toBe(false);
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

	test("rejects legacy aliases instead of silently falling back", async () => {
		const parentRouter = { provider: "router", id: "auto", name: "Auto" } as never;
		const registry = { getAvailable: () => [] } as never;
		const resolve = createModelResolver({ registry, parentModel: parentRouter });

		await expect(resolve("strong-reasoning", anyProfile)).rejects.toThrow(/exact authenticated model id/i);
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

	test("loads optional per-agent model, thinking, and context-budget overrides from user config", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-advisor-config-"));
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { model: "gpt-5.5", contextMaxBytes: 512_000 }, search: { thinkingLevel: "high" } } }));

		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: { advisor: { model: "gpt-5.5", contextMaxBytes: 512_000 }, search: { thinkingLevel: "high" } } });
	});

	test("loads a generic external runtime selection and rejects provider-private fields", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-advisor-runtime-config-"));
		const runtime = { provider: "claude-channel", target: "fable-advisor" };
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { runtime, onlyInModes: ["high"] } } }));
		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: { advisor: { runtime, onlyInModes: ["high"] } } });

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { runtime: { provider: "claude-channel", sshTarget: "workbox" } } } }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/runtime\.sshTarget is not supported/i);
	});

	test("rejects removed inline remote runtime configuration", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-advisor-removed-remote-config-"));
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { driver: "remote-herdr", remote: { sshTarget: "workbox" } } } }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/use runtime\.provider\/runtime\.target/i);
	});

	test("rejects invalid per-agent model and thinking configuration", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-advisor-invalid-config-"));
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { model: 55 } } }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/invalid.*agents.*model/i);

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { thinkingLevel: "extreme" } } }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/thinkingLevel/i);

		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { contextMaxBytes: 0 } } }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow(/contextMaxBytes must be a positive number/i);
	});

	test("parses the optional advisorGuidance, artifactsDir, and retention keys", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-advisor-extra-config-"));
		await writeFile(join(dir, "pi-advisor.json"), JSON.stringify({ advisorGuidance: false, artifactsDir: "./runs", retentionDays: 7, maxRuns: 50 }));

		await expect(loadSubagentConfig(dir)).resolves.toEqual({ agents: {}, advisorGuidance: false, artifactsDir: "./runs", retentionDays: 7, maxRuns: 50 });
	});

	test("rejects a non-boolean advisorGuidance and a negative retentionDays", async () => {
		const badGuidance = await mkdtemp(join(tmpdir(), "pi-advisor-bad-guidance-"));
		await writeFile(join(badGuidance, "pi-advisor.json"), JSON.stringify({ advisorGuidance: "yes" }));
		await expect(loadSubagentConfig(badGuidance)).rejects.toThrow(/advisorGuidance must be a boolean/i);

		const badRetention = await mkdtemp(join(tmpdir(), "pi-advisor-bad-retention-"));
		await writeFile(join(badRetention, "pi-advisor.json"), JSON.stringify({ retentionDays: -3 }));
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

describe("dedicated per-role tools", () => {
	test("exposes a dedicated tool for advisor and search but not worker or review", () => {
		expect(roleToolSpecs.map((spec) => spec.name)).toEqual(["advisor", "search"]);
		expect(roleToolSpecs.map((spec) => spec.name)).not.toContain("worker");
		expect(roleToolSpecs.map((spec) => spec.name)).not.toContain("review");
	});

	test("registers advisor/search alongside the generic and send tools, with no dedicated worker or review tool", () => {
		const { tools, commands } = captureRegistrations();
		expect([...tools.keys()].sort()).toEqual(["advisor", "search", "subagent", "subagent_result", "subagent_send"].sort());
		expect(tools.has("worker")).toBe(false);
		expect(commands.has("subagents")).toBe(true);
		expect(commands.has("mode")).toBe(true);
		expect(commands.has("advisor")).toBe(true);
	});

	test("registers workspace lifecycle and interactive input routing hooks", () => {
		const registrations = captureRegistrations();
		expect(registrations.events.has("session_start")).toBe(true);
		expect(registrations.events.has("session_shutdown")).toBe(true);
		expect(registrations.events.has("input")).toBe(false);
	});

	test("no longer injects advisor guidance into the parent system prompt", () => {
		// Guidance now lives in the dedicated advisor tool description, so the before_agent_start hook is gone.
		expect(captureRegistrations().events.has("before_agent_start")).toBe(false);
	});

	test("carries the advisor consultation policy in the dedicated tool description", () => {
		const advisor = captureRegistrations().tools.get("advisor")!;
		expect(advisor.description).toContain("auth, billing, permissions");
		expect(advisor.description).toMatch(/adversarial review/i);
		expect(advisor.description).toMatch(/do not use for typos/i);
	});

	test("keeps primary-path reconnaissance in the parent and delegates breadth to search", async () => {
		const search = captureRegistrations().tools.get("search")!;
		expect(search.description).toMatch(/after the parent has inspected the primary path/i);
		expect(search.description).toMatch(/cross-repository/i);
		expect(search.description).toMatch(/files it may edit/i);
		expect(search.description).not.toMatch(/use BEFORE grepping/i);
		const taskSchema = search.parameters.properties?.task as { description?: string } | undefined;
		expect(taskSchema?.description).toMatch(/parent already inspected/i);

		const profile = await loadBuiltInAgent("search");
		expect(profile.systemPrompt).toContain("## Findings");
		expect(profile.systemPrompt).toContain("## Searched Scope");
		expect(profile.systemPrompt).toContain("## Conclusions");
		expect(profile.systemPrompt).toContain("## Unknowns");
		expect(profile.systemPrompt).toMatch(/do not re-read/i);
	});

	test("registers deterministic slash commands without intercepting ordinary input", () => {
		const registrations = captureRegistrations();
		expect(registrations.commands.has("subagent")).toBe(true);
		expect(registrations.events.has("input")).toBe(false);
	});

	test("blocks the explicit slash trigger while the session is deactivated", async () => {
		const registrations = captureRegistrations();
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (text: string) => notices.push(text) } };

		await registrations.commandDefs.get("subagent")?.handler("search find this symbol" as never, ctx as never);
		expect(notices.at(-1)).toMatch(/Subagents are off/i);
	});

	test("keeps the generic tool available for project-local profile cards", () => {
		const { tools } = captureRegistrations();
		expect(tools.get("subagent")!.description).toMatch(/profile/i);
	});

	test("defaults advisor to include the working-tree diff, opting out on explicit false", () => {
		const advisor = roleToolSpecs.find((spec) => spec.name === "advisor")!;
		expect(advisor.toRunParams({ task: "t" }).includeDiff).toBe(true);
		expect(advisor.toRunParams({ task: "t", includeDiff: false }).includeDiff).toBe(false);
	});

	test("gives search a lean read-only schema with alternate root but neither includeDiff nor writeScope", () => {
		const search = captureRegistrations().tools.get("search")!;
		expect(Object.keys(search.parameters.properties ?? {})).toEqual(["task", "root", "files", "background"]);
	});
});

describe("soft turn-budget landing", () => {
	const baseDetails = {
		id: "r1", agent: "search", task: "t", status: "completed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 9 },
		milestones: [] as string[], activity: [] as string[], filesRead: [] as string[], filesModified: [] as string[],
	};
	const details = (extra: Record<string, unknown> = {}) => ({ ...baseDetails, ...extra }) as never;

	test("adds the extend-with-subagent_send note to the summary only on a budget landing", () => {
		const landed: SubagentResult = { status: "completed", text: "partial", stoppedBy: "turn_budget", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 9 }, disclosure: { filesRead: [], filesModified: [], commandsRun: [], contextSources: [], truncated: [] } };
		const clean: SubagentResult = { ...landed, stoppedBy: undefined };

		expect(completedSummary("search", landed, details())).toContain(TURN_BUDGET_NOTE);
		expect(completedSummary("search", landed, details({ finalText: "partial" }))).toContain("id: r1");
		expect(completedSummary("search", clean, details({ finalText: "partial" }))).not.toContain(TURN_BUDGET_NOTE);
	});

	test("returns the answer without dashboard chrome on a clean completion", () => {
		const result: SubagentResult = { status: "completed", text: "## Findings\nok", usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.12, turns: 2 }, disclosure: { filesRead: ["a.ts"], filesModified: [], commandsRun: [], contextSources: [], truncated: [] } };
		const summary = completedSummary("search", result, details({ filesRead: ["a.ts"], finalText: "## Findings\nok" }));
		expect(summary).toBe("## Findings\nok");
		expect(summary).not.toMatch(/cost:|artifacts:|read:/);
	});

	test("keeps advisor verdict chips and write/truncation exceptions", () => {
		const result: SubagentResult = {
			status: "completed", text: "## Verdict\nblocked", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			disclosure: { filesRead: [], filesModified: ["src/a.ts"], commandsRun: [], contextSources: [], truncated: ["diff:HEAD"] },
		};
		const summary = completedSummary("advisor", result, details({
			agent: "advisor", verdict: "blocked", confidence: "high",
			filesModified: ["src/a.ts"], finalText: "## Verdict\nblocked",
		}));
		expect(summary).toContain("advisor · blocked · confidence:high");
		expect(summary).toContain("modified: src/a.ts");
		expect(summary).toContain("truncated: diff:HEAD");
		expect(summary).toContain("## Verdict\nblocked");
		expect(summary).not.toMatch(/cost:|artifacts:|read:/);
	});
});
