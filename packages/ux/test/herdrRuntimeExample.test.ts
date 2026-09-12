import { access, readFile, stat } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import type { DriverRequest } from "pi-advisor-core";
import { createHerdrCliAdapter } from "../examples/runtime-providers/herdr/adapter.ts";
import { herdrResult, herdrTextResult, type HerdrCli } from "../examples/runtime-providers/herdr/cli.ts";
import { parseHerdrAdvisorConfig } from "../examples/runtime-providers/herdr/config.ts";
import {
	createHerdrAdvisorProvider,
	exampleHerdrTargets,
	grokAdvisorRules,
	type HerdrAdapter,
	type HerdrAdvisorTarget,
	type HerdrAdvisorTargetId,
} from "../examples/runtime-providers/herdr/provider.ts";

const CODEX_TARGET: HerdrAdvisorTarget = {
	id: "codex-astra-low",
	label: "Codex · Herdr pane",
	mode: "local-pane",
	agent: "codex",
	model: "gpt-6-astra",
	reasoningEffort: "low",
};

const PROVIDER_TARGETS = [...exampleHerdrTargets, CODEX_TARGET];

function response(report: string): string {
	return JSON.stringify({
		verdict: "proceed_with_changes",
		confidence: "high",
		report_markdown: report,
	});
}

function request(): DriverRequest {
	return {
		id: "run-1",
		cwd: "/repo",
		task: "Review the rollout",
		prompt: "Review the rollout\n\n# Context packet\n\ndiff",
		context: { diff: { base: "HEAD" } },
		profile: {
			name: "advisor",
			description: "Advisor",
			systemPrompt: "Challenge the plan using evidence.",
			contextMode: "selected",
			output: { kind: "schema", schema: {} as never },
		},
	};
}

function ok(result: unknown) {
	return { stdout: JSON.stringify({ id: "cli", result }), stderr: "", code: 0 };
}

describe("Herdr Runtime Provider example", () => {
	test("loads provider-owned Codex model and effort from config", () => {
		expect(parseHerdrAdvisorConfig({
			targets: {
				"grok-4.6-high": { agent: "grok", model: "grok-4.6", reasoningEffort: "high" },
				"codex-astra-low": { agent: "codex", model: "gpt-6-astra", reasoningEffort: "low" },
				"codex-next-high": { agent: "codex", model: "gpt-next-codex", reasoningEffort: "high", label: "Next Codex" },
			},
		})).toEqual([
			{ id: "grok-4.6-high", label: "Grok · grok-4.6 · high", mode: "local-pane", agent: "grok", model: "grok-4.6", reasoningEffort: "high" },
			{ id: "codex-astra-low", label: "Codex · gpt-6-astra · low", mode: "local-pane", agent: "codex", model: "gpt-6-astra", reasoningEffort: "low" },
			{ id: "codex-next-high", label: "Next Codex", mode: "local-pane", agent: "codex", model: "gpt-next-codex", reasoningEffort: "high" },
		]);
		expect(() => parseHerdrAdvisorConfig({ targets: { codex: { agent: "codex", model: "gpt-6-astra" } } })).toThrow(/requires reasoningEffort/i);
		expect(() => parseHerdrAdvisorConfig({ targets: { grok: { agent: "grok", model: "grok-4.6" } } })).toThrow(/requires reasoningEffort/i);
	});

	test.each<HerdrAdvisorTargetId>(["grok-4.6-high", "codex-astra-low", "claude-code-remote"])("dispatches and resumes target %s", async (targetId) => {
		const prompts: string[] = [];
		let contextPath: string | undefined;
		const abort = vi.fn(async () => {});
		const close = vi.fn(async () => {});
		const adapter: HerdrAdapter = {
			async open({ target, runId, cwd, rules }) {
				expect(target.id).toBe(targetId);
				expect(runId).toBe("run-1");
				expect(cwd).toBe("/repo");
				expect(rules).toBe(grokAdvisorRules(request().profile.systemPrompt));
				return {
					async ask({ prompt, onActivity }) {
						prompts.push(prompt);
						onActivity("waiting for external advisor");
						return response(`## Verdict\n${prompts.length}`);
					},
					abort,
					close,
				};
			},
		};
		const provider = createHerdrAdvisorProvider({ adapter, targets: PROVIDER_TARGETS });
		const emit = vi.fn();
		const driver = await provider.create({ provider: provider.id, target: targetId }, request(), {
			emit,
			now: Date.now,
			sleep: async () => {},
		});

		await expect(driver.run()).resolves.toMatchObject({
			text: "## Verdict\n1",
			submitted: { verdict: "proceed_with_changes", confidence: "high" },
		});
		await expect(driver.resume?.("Check the migration path too")).resolves.toMatchObject({ text: "## Verdict\n2" });
		if (targetId !== "claude-code-remote") {
			expect(prompts[0]).toContain("Review the rollout");
			expect(prompts[0]).toContain("Optional context packet (4 bytes; working-tree diff):");
			expect(prompts[0]).not.toContain("# Context packet");
			expect(prompts[0]).not.toContain("\n\ndiff");
			contextPath = prompts[0].match(/Optional context packet \([^\n]+\): (.+)/u)?.[1];
			expect(contextPath).toBeTruthy();
			expect(await readFile(contextPath!, "utf8")).toBe("diff\n");
			expect((await stat(contextPath!)).mode & 0o777).toBe(0o600);
		} else {
			expect(prompts[0]).toBe(request().prompt);
		}
		expect(prompts[0]).not.toContain("Challenge the plan using evidence.");
		expect(prompts[1]).toBe("Check the migration path too");
		expect(emit).toHaveBeenCalledWith({ type: "progress", text: "waiting for external advisor" });

		await driver.abort();
		await driver.dispose?.();
		if (contextPath) await expect(access(contextPath)).rejects.toThrow();
		expect(abort).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	test("keeps a 100KB context packet out of the local pane prompt", async () => {
		const largeContext = "x".repeat(100_000);
		const largeRequest: DriverRequest = {
			...request(),
			prompt: `${request().task}\n\n# Context packet\n\n${largeContext}`,
		};
		let panePrompt = "";
		const provider = createHerdrAdvisorProvider({
			adapter: {
				async open() {
					return {
						async ask({ prompt }) {
							panePrompt = prompt;
							return response("## Verdict\nlean");
						},
						abort: async () => {},
					};
				},
			},
		});
		const driver = await provider.create({ provider: provider.id, target: "grok-4.6-high" }, largeRequest, {
			emit: () => {}, now: Date.now, sleep: async () => {},
		});

		await driver.run();
		expect(Buffer.byteLength(panePrompt, "utf8")).toBeLessThan(512);
		expect(panePrompt).not.toContain("x".repeat(100));
		const contextPath = panePrompt.match(/Optional context packet \([^\n]+\): (.+)/u)?.[1];
		expect(contextPath).toBeTruthy();
		expect((await readFile(contextPath!, "utf8")).trim()).toBe(largeContext);
		await driver.dispose?.();
		await expect(access(contextPath!)).rejects.toThrow();
	});

	test("describes local Grok and Codex targets and rejects unknown targets", async () => {
		const provider = createHerdrAdvisorProvider({ adapter: { async open() { throw new Error("unused"); } }, targets: PROVIDER_TARGETS });
		expect(await provider.describeTarget?.({ provider: provider.id, target: "grok-4.6-high" })).toMatchObject({ model: "grok-4.6", location: "local" });
		expect(await provider.describeTarget?.({ provider: provider.id, target: "codex-astra-low" })).toMatchObject({ model: "gpt-6-astra", location: "local" });
		expect(await provider.describeTarget?.({ provider: provider.id, target: "claude-code-remote" })).toMatchObject({ model: "claude-code", location: "remote" });
		expect(() => provider.describeTarget?.({ provider: provider.id, target: "unknown" })).toThrow(/unknown herdr advisor target/i);
	});

	test("extracts Advisor JSON from a noisy Grok transcript", async () => {
		const provider = createHerdrAdvisorProvider({
			adapter: {
				async open() {
					return {
						ask: async () => [
							"grok-4.6 thinking...",
							"here is the review {\"noise\":true}",
							response("## Verdict\nfrom pane"),
							"idle",
						].join("\n"),
						abort: async () => {},
					};
				},
			},
		});
		const driver = await provider.create({ provider: provider.id, target: "grok-4.6-high" }, request(), {
			emit: () => {},
			now: Date.now,
			sleep: async () => {},
		});
		await expect(driver.run()).resolves.toMatchObject({
			text: "## Verdict\nfrom pane",
			submitted: { verdict: "proceed_with_changes", confidence: "high" },
		});
		await driver.dispose?.();
	});

	test.each([true, false])("resume selects the latest report with fenced follow-up=%s", async (fenced) => {
		let turn = 0;
		const first = `\`\`\`json\n${response("first report")}\n\`\`\``;
		const latest = fenced ? `\`\`\`json\n${response("latest report")}\n\`\`\`` : response("latest report");
		const provider = createHerdrAdvisorProvider({
			targets: PROVIDER_TARGETS,
			adapter: { async open() {
				return {
					ask: async () => ++turn === 1 ? first : `${first}\n${latest}\n\`\`\`json\n{"noise":true}\n\`\`\``,
					abort: async () => {},
				};
			} },
		});
		const driver = await provider.create({ provider: provider.id, target: CODEX_TARGET.id }, request(), {
			emit: () => {}, now: Date.now, sleep: async () => {},
		});
		try {
			await expect(driver.run()).resolves.toMatchObject({ text: "first report" });
			await expect(driver.resume?.("Review again")).resolves.toMatchObject({ text: "latest report" });
		} finally {
			await driver.dispose?.();
		}
	});

	test("repairs JSON hard-wrapped by Grok's inline terminal renderer", async () => {
		const provider = createHerdrAdvisorProvider({
			adapter: {
				async open() {
					return {
						ask: async () => [
							'    {"verdict":"proceed_with_changes","conf   7:49 PM',
							'│   idence":"high","report_markdown":"## Ver',
							'│   dict\\nwrapped result"}',
						].join("\n"),
						abort: async () => {},
					};
				},
			},
		});
		const driver = await provider.create({ provider: provider.id, target: "grok-4.6-high" }, request(), {
			emit: () => {}, now: Date.now, sleep: async () => {},
		});
		await expect(driver.run()).resolves.toMatchObject({
			text: "## Verdict\nwrapped result",
			submitted: { verdict: "proceed_with_changes", confidence: "high" },
		});
		await driver.dispose?.();
	});

	test("falls back to plain text when Grok does not return JSON", async () => {
		const provider = createHerdrAdvisorProvider({
			adapter: {
				async open() {
					return { ask: async () => "not json", abort: async () => {} };
				},
			},
		});
		const driver = await provider.create({ provider: provider.id, target: "grok-4.6-high" }, request(), {
			emit: () => {},
			now: Date.now,
			sleep: async () => {},
		});
		await expect(driver.run()).resolves.toMatchObject({
			text: "not json",
			submitted: {
				verdict: "need_more_information",
				confidence: "low",
				report_markdown: "not json",
			},
		});
		await driver.dispose?.();
	});
});

describe("Herdr CLI local-pane adapter", () => {
	test("splits a pane, installs rules once, and submits each prompt unchanged as one argv", async () => {
		const calls: string[][] = [];
		const packet = request().prompt;
		let shellInitializationInterrupted = false;
		let prompted = false;
		const cli: HerdrCli = {
			async run(args) {
				calls.push(args);
				if (args[0] === "pane" && args[1] === "list") return ok({ panes: [] });
				if (args[0] === "pane" && args[1] === "current") return ok({ pane: { pane_id: "w1:p1" } });
				if (args[0] === "pane" && args[1] === "split") return ok({ pane: { pane_id: "w1:p2" } });
				if (args[0] === "pane" && args[1] === "rename") return ok({ pane: { pane_id: "w1:p2", label: args[3] } });
				if (args[0] === "pane" && args[1] === "close") return ok({ type: "ok" });
				if (args[0] === "pane" && args[1] === "process-info") {
					return ok({ process_info: {
						shell_pid: 100,
						foreground_process_group_id: shellInitializationInterrupted ? 100 : 101,
					} });
				}
				if (args[0] === "pane" && args[1] === "send-keys") {
					shellInitializationInterrupted = true;
					return ok({ type: "ok" });
				}
				if (args[0] === "agent" && args[1] === "start") return ok({ agent: { name: "grok-4.6-high", agent: "grok", agent_status: "idle", pane_id: "w1:p2" } });
				if (args[0] === "agent" && args[1] === "get") return ok({ agent: { name: "grok-4.6-high", agent: "grok", agent_status: "idle", pane_id: "w1:p2" } });
				if (args[0] === "agent" && args[1] === "prompt") {
					prompted = true;
					return ok({ agent: { name: "grok-4.6-high", agent_status: "idle" } });
				}
				if (args[0] === "pane" && args[1] === "read") {
					return { stdout: prompted ? `noise\n${response("## Verdict\ncli")}\nWorked for 2s\n` : "initial transcript\n", stderr: "", code: 0 };
				}
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const adapter = createHerdrCliAdapter({
			cli,
			requireHerdrEnv: false,
			createRunSuffix: () => "a1b2c3d4",
			shellReadyPollMs: 0,
			shellInitGraceMs: 0,
			shellSettleMs: 0,
			resultPollMs: 0,
		});
		const conversation = await adapter.open({
			target: { id: "grok-4.6-high", label: "Grok · grok-4.6 · high", mode: "local-pane", agent: "grok", model: "grok-4.6", reasoningEffort: "high" },
			runId: "run-1",
			cwd: "/repo",
			rules: "Stay read-only.\n\nReturn one JSON object.\tNo shell mutation.\u0007",
		});
		const raw = await conversation.ask({
			prompt: packet,
			signal: new AbortController().signal,
			onActivity: () => {},
		});
		expect(raw).toContain(response("## Verdict\ncli"));
		expect(calls.some((args) => args[0] === "pane" && args[1] === "list")).toBe(false);
		expect(calls).toContainEqual(["pane", "rename", "w1:p2", "grok-advisor-a1b2c3d4"]);
		expect(calls.find((args) => args[0] === "pane" && args[1] === "split")).toEqual([
			"pane", "split", "--pane", "w1:p1", "--direction", "right", "--ratio", "0.42", "--cwd", "/repo", "--no-focus",
		]);
		const processInfoCalls = calls.filter((args) => args[0] === "pane" && args[1] === "process-info");
		expect(processInfoCalls).toHaveLength(2);
		expect(processInfoCalls[0]).toEqual(["pane", "process-info", "--pane", "w1:p2"]);
		expect(calls).toContainEqual(["pane", "send-keys", "w1:p2", "ctrl+c"]);
		const startCalls = calls.filter((args) => args[0] === "agent" && args[1] === "start");
		expect(startCalls).toHaveLength(1);
		const start = startCalls[0];
		expect(start).toEqual([
			"agent", "start", "grok-advisor-a1b2c3d4", "--kind", "grok", "--pane", "w1:p2", "--timeout", "90000", "--",
			"-m", "grok-4.6", "--reasoning-effort", "high", "--permission-mode", "plan", "--deny", "Edit(**)", "--deny", "Write(**)", "--deny", "Bash(**)",
			"--rules", "Stay read-only. Return one JSON object. No shell mutation.",
			"--minimal",
		]);
		expect(start?.every((arg) => !/[\u0000-\u001f\u007f]/u.test(arg))).toBe(true);
		expect(start?.join(" ").length).toBeLessThan(500);
		const prompt = calls.find((args) => args[0] === "agent" && args[1] === "prompt");
		expect(prompt?.[2]).toBe("grok-advisor-a1b2c3d4");
		expect(prompt?.[3]).toBe(packet);
		expect(prompt?.[3]).not.toContain("# Advisor rules");
		expect(prompt?.[3]).toContain("# Context packet");
		expect(prompt?.slice(4)).toEqual([]);
		expect(calls).toContainEqual(["pane", "read", "w1:p2", "--source", "recent-unwrapped", "--lines", "1000"]);
		await conversation.close?.();
		expect(calls).toContainEqual(["pane", "close", "w1:p2"]);
	});

	test("starts a read-only Codex pane and detects completed initial and resumed turns", async () => {
		const calls: string[][] = [];
		const delays: number[] = [];
		let submittedTurns = 0;
		let resultRead = 0;
		const cli: HerdrCli = {
			async run(args) {
				calls.push(args);
				if (args[0] === "pane" && args[1] === "current") return ok({ pane: { pane_id: "w1:p1" } });
				if (args[0] === "pane" && args[1] === "split") return ok({ pane: { pane_id: "w1:p2" } });
				if (args[0] === "pane" && args[1] === "rename") return ok({ pane: { pane_id: "w1:p2", label: args[3] } });
				if (args[0] === "pane" && args[1] === "process-info") return ok({ process_info: { shell_pid: 100, foreground_process_group_id: 100 } });
				if (args[0] === "agent" && args[1] === "start") return ok({ agent: { name: args[2], agent: "codex", agent_status: "idle", pane_id: "w1:p2" } });
				if (args[0] === "agent" && args[1] === "get") {
					return ok({ agent: {
						name: args[2],
						agent: "codex",
						agent_status: "idle",
						pane_id: "w1:p2",
					} });
				}
				if (args[0] === "agent" && args[1] === "prompt") {
					submittedTurns += 1;
					return ok({ agent: { name: args[2], agent: "codex", agent_status: "idle", pane_id: "w1:p2" } });
				}
				if (args[0] === "pane" && args[1] === "read") {
					if (submittedTurns === 0) return { stdout: "initial transcript\n", stderr: "", code: 0 };
					resultRead += 1;
					const results = Array.from(
						{ length: submittedTurns },
						(_, index) => response(`## Verdict\ncodex ${index + 1}`),
					).join("\n");
					return { stdout: `${results}\nanimated chrome ${resultRead}\n`, stderr: "", code: 0 };
				}
				if (args[0] === "pane" && args[1] === "close") return ok({ type: "ok" });
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const conversation = await createHerdrCliAdapter({
			cli,
			codexCli: { async run(args) {
				expect(args).toEqual([
					"--disable", "apps", "--disable", "browser_use", "--disable", "computer_use", "--disable", "plugins",
					"mcp", "list", "--json",
				]);
				return { stdout: JSON.stringify([{ name: "external", enabled: true }, { name: "already_off", enabled: false }]), stderr: "", code: 0 };
			} },
			requireHerdrEnv: false,
			createRunSuffix: () => "c0de0001",
			sleep: async (ms) => { delays.push(ms); },
			resultPollMs: 0,
			completionStableReads: 2,
		}).open({
			target: CODEX_TARGET,
			runId: "run-codex",
			cwd: "/repo",
			rules: "Stay read-only.\nReturn one JSON object.",
		});

		await expect(conversation.ask({
			prompt: "review",
			signal: new AbortController().signal,
			onActivity: () => {},
		})).resolves.toContain(response("## Verdict\ncodex 1"));
		await expect(conversation.ask({
			prompt: "review again",
			signal: new AbortController().signal,
			onActivity: () => {},
		})).resolves.toContain(response("## Verdict\ncodex 2"));
		expect(delays[0]).toBe(3_000);
		expect(calls.filter((args) => args[0] === "pane" && args[1] === "process-info")).toHaveLength(2);
		expect(calls).toContainEqual([
			"agent", "start", "codex-advisor-c0de0001", "--kind", "codex", "--pane", "w1:p2", "--timeout", "90000", "--",
			"-m", "gpt-6-astra", "-c", "model_reasoning_effort=\"low\"",
			"-c", "projects.\"/repo\".trust_level=\"trusted\"",
			"--sandbox", "read-only", "--ask-for-approval", "never",
			"--disable", "apps", "--disable", "browser_use", "--disable", "computer_use", "--disable", "plugins",
			"-c", "mcp_servers.external.enabled=false", "-c", "mcp_servers.already_off.enabled=false",
			"--no-alt-screen", "-c", "developer_instructions=\"Stay read-only. Return one JSON object.\"",
		]);
		expect(calls).toContainEqual([
			"agent", "prompt", "codex-advisor-c0de0001", "review",
		]);
		expect(calls).toContainEqual([
			"agent", "prompt", "codex-advisor-c0de0001", "review again",
		]);
		// Each turn has one baseline read and two reads with the same complete JSON.
		// The surrounding transcript changes, proving completion ignores animated
		// chrome and does not depend on Herdr observing a working lifecycle state.
		// The resumed turn also retains the first result in its baseline.
		expect(calls.filter((args) => args[0] === "pane" && args[1] === "read")).toHaveLength(6);
		await conversation.close?.();
		expect(calls).toContainEqual(["pane", "close", "w1:p2"]);
	});

	test.each([
		{ stdout: "", stderr: "inventory failed", code: 1 },
		{ stdout: "not json", stderr: "", code: 0 },
		{ stdout: "{}", stderr: "", code: 0 },
		{ stdout: '[{"name":"unsafe.name"}]', stderr: "", code: 0 },
	])("does not create a pane when MCP inventory cannot be disabled: %j", async (result) => {
		const run = vi.fn();
		const adapter = createHerdrCliAdapter({
			cli: { run },
			codexCli: { async run() { return result; } },
			requireHerdrEnv: false,
		});
		await expect(adapter.open({ target: CODEX_TARGET, runId: "failed", cwd: "/repo" })).rejects.toThrow();
		expect(run).not.toHaveBeenCalled();
	});

	test("waits for a completed transcript to stabilize before returning", async () => {
		let prompted = false;
		let completedReads = 0;
		const partial = '{"verdict":"safe_to_proceed"\nWorked for 1s';
		const final = `${response("## Verdict\nfully rendered")}\nWorked for 1s`;
		const cli: HerdrCli = {
			async run(args) {
				if (args[0] === "pane" && args[1] === "current") return ok({ pane: { pane_id: "w1:p1" } });
				if (args[0] === "pane" && args[1] === "split") return ok({ pane: { pane_id: "w1:p2" } });
				if (args[0] === "pane" && args[1] === "rename") return ok({ pane: { pane_id: "w1:p2", label: args[3] } });
				if (args[0] === "pane" && args[1] === "process-info") return ok({ process_info: { shell_pid: 100, foreground_process_group_id: 100 } });
				if (args[0] === "agent" && args[1] === "start") return ok({ agent: { name: args[2], agent: "grok", agent_status: "idle", pane_id: "w1:p2" } });
				if (args[0] === "agent" && args[1] === "get") return ok({ agent: { name: args[2], agent: "grok", agent_status: "idle", pane_id: "w1:p2" } });
				if (args[0] === "agent" && args[1] === "prompt") { prompted = true; return ok({ agent: { agent_status: "idle" } }); }
				if (args[0] === "pane" && args[1] === "read") {
					if (!prompted) return { stdout: "initial conversation", stderr: "", code: 0 };
					completedReads += 1;
					return { stdout: completedReads === 1 ? partial : final, stderr: "", code: 0 };
				}
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const conversation = await createHerdrCliAdapter({
			cli,
			requireHerdrEnv: false,
			resultPollMs: 0,
			completionStableReads: 2,
			createRunSuffix: () => "stable001",
			shellSettleMs: 0,
		}).open({
			target: { id: "grok-4.6-high", label: "Grok · grok-4.6 · high", mode: "local-pane", agent: "grok", model: "grok-4.6", reasoningEffort: "high" },
			runId: "run-stable",
			cwd: "/repo",
			rules: "Current advisor rules.",
		});

		await expect(conversation.ask({
			prompt: "review",
			signal: new AbortController().signal,
			onActivity: () => {},
		})).resolves.toBe(final);
		expect(completedReads).toBe(3);
	});

	test("creates a distinct random-named pane and agent for every open", async () => {
		const calls: string[][] = [];
		let splitIndex = 0;
		const cli: HerdrCli = {
			async run(args) {
				calls.push(args);
				if (args[0] === "pane" && args[1] === "current") return ok({ pane: { pane_id: "w1:p1" } });
				if (args[0] === "pane" && args[1] === "split") {
					splitIndex += 1;
					return ok({ pane: { pane_id: `w1:p${splitIndex + 1}` } });
				}
				if (args[0] === "pane" && args[1] === "rename") return ok({ pane: { pane_id: args[2], label: args[3] } });
				if (args[0] === "pane" && args[1] === "process-info") return ok({ process_info: { shell_pid: 100, foreground_process_group_id: 100 } });
				if (args[0] === "agent" && args[1] === "start") return ok({ agent: { name: args[2], agent: "grok", agent_status: "idle", pane_id: args[6] } });
				if (args[0] === "pane" && args[1] === "close") return ok({ type: "ok" });
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const adapter = createHerdrCliAdapter({ cli, requireHerdrEnv: false, shellSettleMs: 0 });
		const target = { id: "grok-4.6-high", label: "Grok · grok-4.6 · high", mode: "local-pane", agent: "grok", model: "grok-4.6", reasoningEffort: "high" } as const;
		const first = await adapter.open({ target, runId: "run-1", cwd: "/repo", rules: "Current advisor rules." });
		const second = await adapter.open({ target, runId: "run-2", cwd: "/repo", rules: "Current advisor rules." });

		expect(calls.some((args) => args[0] === "pane" && args[1] === "list")).toBe(false);
		const names = calls.filter((args) => args[0] === "pane" && args[1] === "rename").map((args) => args[3]!);
		expect(names).toHaveLength(2);
		expect(names[0]).toMatch(/^grok-advisor-[0-9a-f]{12}$/u);
		expect(names[1]).toMatch(/^grok-advisor-[0-9a-f]{12}$/u);
		expect(names[0]).not.toBe(names[1]);
		expect(calls.filter((args) => args[0] === "agent" && args[1] === "start").map((args) => args[2])).toEqual(names);
		await first.close?.();
		await second.close?.();
		expect(calls).toContainEqual(["pane", "close", "w1:p2"]);
		expect(calls).toContainEqual(["pane", "close", "w1:p3"]);
	});

	test("rejects unimplemented remote targets instead of guessing Herdr commands", async () => {
		const adapter = createHerdrCliAdapter({
			cli: { async run() { throw new Error("should not spawn herdr"); } },
			requireHerdrEnv: false,
		});
		await expect(adapter.open({
			target: { id: "claude-code-remote", label: "Claude Code · Herdr remote", mode: "remote", agent: "claude-code" },
			runId: "run-3",
			cwd: "/repo",
		})).rejects.toThrow(/not implemented/i);
	});
});

describe("Herdr CLI JSON helper", () => {
	test("returns plain transcript text without trying to parse it as JSON", async () => {
		await expect(herdrTextResult({
			async run() { return { stdout: "# Advisor rules\nplain transcript\n", stderr: "", code: 0 }; },
		}, ["agent", "read", "grok-4.6-high"])).resolves.toBe("# Advisor rules\nplain transcript\n");
		await expect(herdrTextResult({
			async run() { return { stdout: "", stderr: JSON.stringify({ error: { message: "agent not found" } }), code: 1 }; },
		}, ["agent", "read", "missing"])).rejects.toThrow(/agent not found/i);
	});

	test("unwraps result and surfaces Herdr error objects", async () => {
		await expect(herdrResult({
			async run() { return ok({ pane: { pane_id: "w1:p1" } }); },
		}, ["pane", "current"])).resolves.toEqual({ pane: { pane_id: "w1:p1" } });
		await expect(herdrResult({
			async run() { return { stdout: "", stderr: JSON.stringify({ id: "cli", error: { code: "pane_not_found", message: "pane not found" } }), code: 1 }; },
		}, ["pane", "get", "missing"])).rejects.toThrow(/pane not found/i);
	});
});
