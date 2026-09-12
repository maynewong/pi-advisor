/** Verify that a cwd-cached manager resolves exact custom-profile model ids consistently. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const managerState = vi.hoisted(() => ({ resolvedModels: [] as unknown[], nextId: 0 }));

vi.mock("@maynewong/pi-advisor-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@maynewong/pi-advisor-core")>();
	class TestSubagentManager {
		constructor(private readonly options: { resolveModel: (spec: unknown, profile: unknown) => Promise<unknown> }) {}

		spawn(profile: Record<string, unknown>, _task: string, spawnOptions: { overrides?: Record<string, unknown> } = {}) {
			const effective = { ...profile, ...spawnOptions.overrides };
			const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
			const resolved = this.options.resolveModel(effective.model, effective).then((model) => managerState.resolvedModels.push(model));
			return {
				id: `test-${managerState.nextId++}`,
				profile: effective,
				usage,
				status: "completed",
				subscribe: () => () => {},
				wait: async () => {
					await resolved;
					return {
						status: "completed",
						text: "done",
						usage,
						disclosure: { filesRead: [], filesModified: [], commandsRun: [], contextSources: [], truncated: [] },
					};
				},
			};
		}

		async abortAll() {}
	}

	return { ...actual, SubagentManager: TestSubagentManager, pruneSubagentRuns: async () => {} };
});

import subagentExtension from "../extensions/subagent.ts";

describe("dynamic cached-manager routing", () => {
	let agentDir: string;
	let profilePath: string;
	const originalEnv = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "pi-advisor-dynamic-routing-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		profilePath = join(agentDir, "custom.md");
		await writeFile(profilePath, "---\nname: custom\ndescription: Custom exact-model role\nmodel: gpt-5.5\n---\nRun the task.\n");
		managerState.resolvedModels.length = 0;
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalEnv;
	});

	test("keeps exact custom-profile routing stable through the same cached manager", async () => {
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const pi = {
			on: () => {},
			registerTool: (definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(definition.name, definition),
			registerCommand: () => {},
			registerShortcut: () => {},
			sendUserMessage: () => {},
		};
		subagentExtension(pi as never);
		const registryModels = [
			{ provider: "openai", id: "gpt-5.5", name: "GPT 5.5", reasoning: true, contextWindow: 128000, cost: { input: 15, output: 60 } },
			{ provider: "zhipu", id: "glm-4.6", name: "GLM 4.6", reasoning: true, contextWindow: 128000, cost: { input: 3, output: 6 } },
		] as never;
		const ctx = {
			cwd: agentDir,
			hasUI: false,
			ui: { setWidget: () => {} },
			modelRegistry: { getAvailable: () => registryModels, authStorage: {} },
			model: registryModels[0],
			sessionManager: { getSessionFile: () => undefined, getLeafId: () => undefined },
		};
		const execute = tools.get("subagent")!.execute;

		await writeFile(join(agentDir, "pi-advisor.json"), JSON.stringify({ modelFilter: "openai" }));
		await execute("call-1", { agent: profilePath, task: "first" }, undefined, undefined, ctx);
		await writeFile(join(agentDir, "pi-advisor.json"), JSON.stringify({ modelFilter: "zhipu" }));
		await execute("call-2", { agent: profilePath, task: "second" }, undefined, undefined, ctx);
		await writeFile(join(agentDir, "pi-advisor.json"), JSON.stringify({ tiers: [{ pattern: "gpt", tier: "mid" }, { pattern: "glm", tier: "strong" }] }));
		await execute("call-3", { agent: profilePath, task: "third" }, undefined, undefined, ctx);
		await writeFile(join(agentDir, "pi-advisor.json"), JSON.stringify({ tiers: [{ pattern: "gpt", tier: "strong" }, { pattern: "glm", tier: "mid" }] }));
		await execute("call-4", { agent: profilePath, task: "fourth" }, undefined, undefined, ctx);

		expect(managerState.resolvedModels).toEqual([registryModels[0], registryModels[0], registryModels[0], registryModels[0]]);
	});
});
