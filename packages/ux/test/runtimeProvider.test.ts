import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createEventBus, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	registerRuntimeProvider,
	type DriverRequest,
	type RuntimeDriverProvider,
	type RuntimeSelection,
} from "pi-advisor-core";
import subagentExtension from "../extensions/subagent.ts";

function model(id: string) {
	return {
		provider: "openai",
		id,
		name: id,
		reasoning: true,
		contextWindow: 128000,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	} as never;
}

function provider(overrides: Partial<RuntimeDriverProvider> = {}): RuntimeDriverProvider {
	return {
		id: "example-runtime",
		apiVersion: 1,
		displayName: "Example Runtime",
		capabilities: {
			resume: false,
			steer: false,
			followUp: false,
			contextModes: ["fresh", "selected"],
			modelResolution: "provider",
			policyEnforcement: "adapter",
			structuredOutput: true,
		},
		async create(_selection, request, host) {
			host.emit({ type: "progress", text: "external submitted" });
			return {
				async run() {
					return {
						text: "## Verdict\nsafe",
						submitted: { verdict: "safe_to_proceed", confidence: "high", report_markdown: "## Verdict\nsafe" },
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, model: "external-model" },
					};
				},
				async abort() {},
			};
		},
		...overrides,
	};
}

function host(events: ReturnType<typeof createEventBus>) {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<any> }>();
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	let activeTools: string[] = [];
	const pi = {
		events,
		on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<any> }) { tools.set(definition.name, definition); },
		registerCommand: () => {},
		registerShortcut: () => {},
		sendUserMessage: () => {},
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => { activeTools = names; },
	};
	subagentExtension(pi as never);
	return { tools, handlers };
}

describe("UX runtime provider integration", () => {
	let agentDir: string;
	const originalEnv = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "pi-advisor-provider-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalEnv;
	});

	test("dispatches a configured role through a discovered provider", async () => {
		const events = createEventBus();
		let seenSelection: RuntimeSelection | undefined;
		let seenRequest: DriverRequest | undefined;
		registerRuntimeProvider(events, provider({
			async create(selection, request, host) {
				seenSelection = selection;
				seenRequest = request;
				host.emit({ type: "progress", text: "external submitted" });
				return {
					run: async () => ({
						text: "## Verdict\nsafe",
						submitted: { verdict: "safe_to_proceed", confidence: "high", report_markdown: "## Verdict\nsafe" },
					}),
					abort: async () => {},
				};
			},
		}));
		const { tools } = host(events);
		await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		await writeFile(join(agentDir, "pi-advisor.json"), JSON.stringify({
			mode: "high",
			agents: { advisor: { runtime: { provider: "example-runtime", target: "advisor-one" } } },
		}));
		const gpt = model("gpt-5.6-sol");
		const ctx = {
			cwd: agentDir,
			hasUI: false,
			mode: "print",
			ui: { setWidget: () => {} },
			modelRegistry: { getAvailable: () => [gpt], authStorage: {} },
			model: gpt,
			sessionManager: { getSessionFile: () => undefined, getLeafId: () => undefined },
		};
		const result = await tools.get("advisor")!.execute("call", { task: "review", includeDiff: false }, undefined, undefined, ctx);
		expect(result.isError).toBe(false);
		expect(seenSelection).toEqual({ provider: "example-runtime", target: "advisor-one" });
		expect(seenRequest?.prompt).toContain("review");
		expect(seenRequest?.profile.model).toBeUndefined();
	});

	test.each([false, true])("keeps live UI ownership compact (background=%s)", async (background) => {
		const events = createEventBus();
		registerRuntimeProvider(events, provider({
			async create(_selection, _request, host) {
				return {
					async run() {
						for (const name of ["first", "second", "third"]) {
							host.emit({ type: "tool_call", name: "read", argsPreview: name, summary: `Reading ${name}` });
						}
						return { text: "safe", submitted: { verdict: "safe_to_proceed", confidence: "high", report_markdown: "safe" } };
					},
					async abort() {},
				};
			},
		}));
		const { tools } = host(events);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await writeFile(join(agentDir, "pi-advisor.json"), JSON.stringify({
			mode: "high", agents: { advisor: { runtime: { provider: "example-runtime" } } },
		}));
		const ui = { setWidget: vi.fn(), setStatus: vi.fn(), setWorkingMessage: vi.fn(), notify: vi.fn() };
		const gpt = model("test-model");
		const ctx = {
			cwd: agentDir, hasUI: true, mode: "rpc", ui,
			modelRegistry: { getAvailable: () => [gpt], authStorage: {} }, model: gpt,
			sessionManager: { getSessionFile: () => undefined, getLeafId: () => undefined },
		};
		const rendered: string[][] = [];
		const tool = tools.get("advisor")!;
		const paint = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const onUpdate = (update: any) => {
			const component = (tool as unknown as ToolDefinition).renderResult!(update, { expanded: false, isPartial: true }, paint as never, {} as never);
			rendered.push(component.render(32));
		};
		const result = await tool.execute("call", { task: "Review a very long task title that should never wrap the running card", includeDiff: false, background }, undefined, onUpdate, ctx);
		if (background) await tools.get("subagent_result")!.execute("result", { id: result.details.id, wait: true });
		expect(ui.setStatus).not.toHaveBeenCalled();
		expect(ui.setWorkingMessage).not.toHaveBeenCalled();
		const widgets = ui.setWidget.mock.calls.filter(([key, lines]) => key === "subagent-overview" && lines !== undefined);
		if (background) {
			expect(rendered).toEqual([]);
			expect(widgets.length).toBeGreaterThan(0);
			expect(widgets.every(([, lines]) => lines.length === 1)).toBe(true);
		} else {
			expect(widgets).toEqual([]);
			expect(rendered.length).toBeGreaterThan(0);
			expect(rendered.every((lines) => lines.length === 2 && lines.every((line) => visibleWidth(line) <= 32))).toBe(true);
			expect(rendered.at(-1)?.join("\n")).not.toContain("Reading first");
		}
	});

	test("keeps resume live, generation isolation, and explicit acknowledgement", async () => {
		const events = createEventBus();
		let emitResume: ((event: { type: "progress"; text: string }) => void) | undefined;
		let finishResume: ((value: { text: string; submitted: { verdict: string; confidence: string; report_markdown: string } }) => void) | undefined;
		registerRuntimeProvider(events, provider({
			capabilities: { ...provider().capabilities, resume: true },
			async create(_selection, _request, host) {
				return {
					async run() {
						host.emit({ type: "progress", text: "first look" });
						return { text: "first", submitted: { verdict: "need_more_information", confidence: "low", report_markdown: "first" } };
					},
					async resume() {
						emitResume = host.emit;
						return await new Promise((resolve) => { finishResume = resolve; });
					},
					async abort() {},
				};
			},
		}));
		const { tools, handlers } = host(events);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await writeFile(join(agentDir, "pi-advisor.json"), JSON.stringify({
			mode: "high", agents: { advisor: { runtime: { provider: "example-runtime" } } },
		}));
		const ui = { setWidget: vi.fn(), setStatus: vi.fn(), setWorkingMessage: vi.fn(), notify: vi.fn() };
		const gpt = model("test-model");
		const ctx = {
			cwd: agentDir, hasUI: true, mode: "rpc", ui,
			modelRegistry: { getAvailable: () => [gpt], authStorage: {} }, model: gpt,
			sessionManager: { getSessionFile: () => undefined, getLeafId: () => undefined },
		};
		const widgets = () => ui.setWidget.mock.calls
			.filter(([key, lines]) => key === "subagent-overview" && Array.isArray(lines))
			.map(([, lines]) => (lines as string[]).join("\n"));
		const started = await tools.get("advisor")!.execute("call", { task: "review", includeDiff: false, background: true }, undefined, undefined, ctx);
		const id = started.details.id as string;
		await vi.waitFor(() => {
			expect(started.details.status).toBe("completed");
			expect(widgets().some((text) => text.includes("result ready"))).toBe(true);
		});

		const live: string[] = [];
		const continuing = await tools.get("subagent_send")!.execute("resume", { id, message: "look again", wait: false }, undefined, (update: any) => live.push(update.content[0].text), ctx);
		expect(continuing.details).not.toBe(started.details);
		expect(started.details.finalText).toBe("first");
		expect(continuing.details.finalText).toBeUndefined();
		expect(continuing.details.progress).toBeUndefined();
		await vi.waitFor(() => expect(emitResume).toBeDefined());
		emitResume!({ type: "progress", text: "second look" });
		await vi.waitFor(() => expect(continuing.details.progress).toBe("second look"));
		expect(live).toEqual([]);
		expect(widgets().some((text) => /◐ 1 specialist/.test(text))).toBe(true);

		finishResume!({ text: "second", submitted: { verdict: "safe_to_proceed", confidence: "high", report_markdown: "second" } });
		await vi.waitFor(() => {
			expect(continuing.details.status).toBe("completed");
			expect(continuing.details.finalText).toBe("second");
			expect(widgets().some((text) => text.includes("result ready"))).toBe(true);
		});
		expect(started.details.finalText).toBe("first");
		expect(started.details.acknowledged).toBe(false);

		const fetched = await tools.get("subagent_result")!.execute("ack", { id, wait: true });
		expect(fetched.details).toBe(continuing.details);
		expect(fetched.details.acknowledged).toBe(true);
		expect(ui.setWidget.mock.calls.filter(([key]) => key === "subagent-overview").at(-1)?.[1]).toBeUndefined();

		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
	});

	test("adapts inherited conversation into selected context for providers without native fork", async () => {
		const events = createEventBus();
		let seenRequest: DriverRequest | undefined;
		registerRuntimeProvider(events, provider({
			async create(_selection, request) {
				seenRequest = request;
				return {
					run: async () => ({ text: "## Verdict\nsafe", submitted: { verdict: "safe_to_proceed", confidence: "high", report_markdown: "## Verdict\nsafe" } }),
					abort: async () => {},
				};
			},
		}));
		const { tools } = host(events);
		await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		await writeFile(join(agentDir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { runtime: { provider: "example-runtime" } } } }));
		const sessionFile = join(agentDir, "parent.jsonl");
		const header = { type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: agentDir };
		const message = { type: "message", id: "leaf", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "inherit this decision" } };
		await writeFile(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
		const gpt = model("gpt-5.6-sol");
		const ctx = {
			cwd: agentDir,
			hasUI: false,
			mode: "print",
			ui: { setWidget: () => {} },
			modelRegistry: { getAvailable: () => [gpt], authStorage: {} },
			model: gpt,
			sessionManager: { getSessionFile: () => sessionFile, getLeafId: () => "leaf" },
		};
		const result = await tools.get("advisor")!.execute("call", { task: "review", includeDiff: false, inheritConversation: true }, undefined, undefined, ctx);
		expect(result.isError).toBe(false);
		expect(seenRequest?.profile.contextMode).toBe("selected");
		expect(seenRequest?.context?.forkFrom).toBeUndefined();
		expect(seenRequest?.prompt).toContain("Inherited parent conversation");
		expect(seenRequest?.prompt).toContain("inherit this decision");
	});

	test("resolves the normal routed model for host-model providers", async () => {
		const events = createEventBus();
		let seenModel: unknown;
		registerRuntimeProvider(events, provider({
			capabilities: { ...provider().capabilities, modelResolution: "host" },
			async create(_selection, request) {
				seenModel = request.profile.model;
				return {
					run: async () => ({ text: "## Verdict\nsafe", submitted: { verdict: "safe_to_proceed", confidence: "high", report_markdown: "## Verdict\nsafe" } }),
					abort: async () => {},
				};
			},
		}));
		const { tools } = host(events);
		await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		await writeFile(join(agentDir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { runtime: { provider: "example-runtime" } } } }));
		const gpt = model("gpt-5.6-sol");
		const ctx = {
			cwd: agentDir,
			hasUI: false,
			mode: "print",
			ui: { setWidget: () => {} },
			modelRegistry: { getAvailable: () => [gpt], authStorage: {} },
			model: gpt,
			sessionManager: { getSessionFile: () => undefined, getLeafId: () => undefined },
		};
		await tools.get("advisor")!.execute("call", { task: "review", includeDiff: false }, undefined, undefined, ctx);
		expect(seenModel).toBe(gpt);
	});

	test("reports a missing provider before dispatch", async () => {
		const { tools } = host(createEventBus());
		await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		await writeFile(join(agentDir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { runtime: { provider: "missing", target: "advisor" } } } }));
		const gpt = model("gpt-5.6-sol");
		const ctx = {
			cwd: agentDir,
			hasUI: false,
			mode: "print",
			ui: { setWidget: () => {} },
			modelRegistry: { getAvailable: () => [gpt], authStorage: {} },
			model: gpt,
			sessionManager: { getSessionFile: () => undefined, getLeafId: () => undefined },
		};
		await expect(tools.get("advisor")!.execute("call", { task: "review", includeDiff: false }, undefined, undefined, ctx)).rejects.toThrow(/not installed or enabled/i);
	});

	test("accepts a provider registered after the kit extension loads", async () => {
		const events = createEventBus();
		const { tools } = host(events);
		await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		registerRuntimeProvider(events, provider());
		await writeFile(join(agentDir, "pi-advisor.json"), JSON.stringify({ agents: { advisor: { runtime: { provider: "example-runtime" } } } }));
		const gpt = model("gpt-5.6-sol");
		const ctx = {
			cwd: agentDir,
			hasUI: false,
			mode: "print",
			ui: { setWidget: () => {} },
			modelRegistry: { getAvailable: () => [gpt], authStorage: {} },
			model: gpt,
			sessionManager: { getSessionFile: () => undefined, getLeafId: () => undefined },
		};
		await expect(tools.get("advisor")!.execute("call", { task: "review", includeDiff: false }, undefined, undefined, ctx)).resolves.toMatchObject({ isError: false });
	});
});
