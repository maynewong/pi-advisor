import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createEventBus, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerRuntimeProvider, type DriverRequest, type RuntimeDriverProvider } from "@maynewong/pi-advisor-core";
import subagentExtension, {
	KIT_TOOL_NAMES,
	effectiveModeRoute,
	loadSubagentConfig,
	parsePiAdvisorConfig,
	persistMode,
	persistModelFilter,
	persistProfile,
	persistProfileMode,
	resolveProfile,
	type RoutingProfileConfig,
} from "../extensions/subagent.ts";

function profile(provider: string): RoutingProfileConfig {
	return {
		parentModel: `${provider}/main`,
		agents: {
			advisor: { model: `${provider}/reasoner`, thinkingLevel: "high", maxTurns: 8 },
			search: { model: `${provider}/fast`, thinkingLevel: "low" },
		},
	};
}

function declaration() {
	return { profile: "personal", mode: "medium", profiles: { personal: profile("personal"), company: profile("company") } };
}

function models(provider: string) {
	return ["main", "reasoner", "fast"].map((id) => ({
		provider, id, name: id, reasoning: true, contextWindow: 128000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
}

function host(agentDir: string, events = createEventBus()) {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	let active = ["read", ...KIT_TOOL_NAMES];
	let thinking = "medium";
	const notices: string[] = [];
	const ctx = {
		cwd: agentDir, mode: "print", hasUI: true,
		model: models("personal")[0],
		modelRegistry: { getAvailable: () => [...models("personal"), ...models("company")], authStorage: {} },
		sessionManager: { getSessionFile: () => undefined, getLeafId: () => undefined },
		isIdle: () => true,
		ui: { notify: (text: string) => notices.push(text), select: vi.fn(), setWidget: () => {} },
	};
	const pi = {
		events,
		on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut: () => {},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		getThinkingLevel: () => thinking,
		setThinkingLevel: vi.fn((value: string) => { thinking = value; }),
		setModel: vi.fn(async (model: any) => { ctx.model = model; return true; }),
	};
	subagentExtension(pi as unknown as ExtensionAPI);
	return {
		ctx, pi, notices, tools, active: () => active,
		command: (args: string) => commands.get("mode")!.handler(args, ctx as unknown as ExtensionCommandContext),
		start: async () => { for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx); },
		shutdown: async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); },
	};
}

describe("named routing profiles", () => {
	let dir: string;
	let file: string;
	const original = process.env.PI_CODING_AGENT_DIR;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "subagent-profiles-"));
		file = join(dir, "pi-advisor.json");
		process.env.PI_CODING_AGENT_DIR = dir;
	});
	afterEach(async () => {
		if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = original;
		await rm(dir, { recursive: true, force: true });
	});
	const save = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value));

	test("resolves isolated profiles and supports existing per-tier JSON routes", () => {
		const raw = declaration();
		raw.profiles.company.modes = {
			high: {
				agent: { model: "company/main", thinkingLevel: "xhigh" },
				advisor: { model: "company/reasoner", thinkingLevel: "xhigh", maxTurns: 20 },
			},
		};
		const config = parsePiAdvisorConfig(raw);
		const personal = resolveProfile(config);
		const company = resolveProfile(config, "company");
		expect(personal.parentModel).toBe("personal/main");
		expect(company.parentModel).toBe("company/main");
		expect(effectiveModeRoute(company, "high", "advisor")).toMatchObject({ model: "company/reasoner", thinkingLevel: "xhigh", maxTurns: 20 });
		company.agents.advisor.model = "changed/model";
		expect(resolveProfile(config, "company").agents.advisor.model).toBe("company/reasoner");
		expect(raw.profiles.company.agents.advisor.model).toBe("company/reasoner");
		expect(() => resolveProfile(config, "missing")).toThrow(/Unknown profile/);
		expect(() => resolveProfile(config, "toString")).toThrow(/Unknown profile/);
	});

	test.each([
		[{ profiles: {} }, /non-empty object/],
		[{ profile: "personal" }, /requires profiles/],
		[{ ...declaration(), profile: "missing" }, /existing profiles entry/],
		[{ ...declaration(), agents: {} }, /routing sources cannot be mixed/],
		[{ ...declaration(), modes: {} }, /routing sources cannot be mixed/],
		[{ ...declaration(), parentModel: "old/main" }, /routing sources cannot be mixed/],
		[{ ...declaration(), profiles: { personal: { ...profile("personal"), authFile: "secret" } } }, /authFile is not supported/],
	])("rejects malformed or conflicting declarations %#", (value, error) => {
		expect(() => parsePiAdvisorConfig(value)).toThrow(error);
	});

	test("rejects incomplete routes, including gaps caused by onlyInModes", () => {
		const raw = declaration();
		delete raw.profiles.company.agents.search;
		expect(() => parsePiAdvisorConfig(raw)).toThrow(/company.*missing search route for low/);
		raw.profiles.company = profile("company");
		raw.profiles.company.agents.advisor.onlyInModes = ["high"];
		expect(() => parsePiAdvisorConfig(raw)).toThrow(/missing advisor route for low/);
		raw.profiles.company.modes = {
			low: { advisor: { model: "company/fast", thinkingLevel: "low" } },
			medium: { advisor: { model: "company/reasoner", thinkingLevel: "medium" } },
			ultra: { advisor: { model: "company/reasoner", thinkingLevel: "xhigh" } },
		};
		expect(() => parsePiAdvisorConfig(raw)).not.toThrow();
		delete raw.profiles.company.parentModel;
		expect(() => parsePiAdvisorConfig(raw)).toThrow(/missing parent route for low/);
	});

	test("requires provider-qualified models in all profiles, including inactive ones", () => {
		const raw = declaration();
		raw.profiles.company.agents.advisor.model = "reasoner";
		expect(() => parsePiAdvisorConfig(raw)).toThrow(/company.*provider\/model-id/);
	});

	test("loads old flat declarations without migration", async () => {
		await save(file, { parentModel: "main", agents: { advisor: { model: "reasoner" } } });
		expect(await loadSubagentConfig(dir)).toEqual({ parentModel: "main", agents: { advisor: { model: "reasoner" } } });
	});

	test("persists only the selected preference and serializes mode/filter updates", async () => {
		const raw = { ...declaration(), extra: { preserve: true } };
		await save(file, raw);
		await Promise.all([persistProfile("company", dir), persistMode("high", dir), persistModelFilter("company", dir)]);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...raw, profile: "company", mode: "high", modelFilter: "company" });
		await persistProfileMode("personal", "low", dir);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...raw, profile: "personal", mode: "low", modelFilter: "company" });
		const previous = await readFile(file, "utf8");
		await expect(persistProfile("missing", dir)).rejects.toThrow();
		expect(await readFile(file, "utf8")).toBe(previous);
	});

	test("switches while off without activating or changing the parent; activation then retunes", async () => {
		await save(file, declaration());
		const h = host(dir);
		await h.start();
		expect(h.active()).toEqual(["read"]);
		await h.command("profile company");
		expect(h.pi.setModel).not.toHaveBeenCalled();
		expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(h.active()).toEqual(["read"]);
		expect(h.notices.at(-1)).toContain("profile company · mode off");
		expect(h.notices.join("\n")).toContain("send this conversation");
		await h.command("high");
		expect(h.ctx.model.provider).toBe("company");
		expect(h.pi.getThinkingLevel()).toBe("xhigh");
		expect(h.active()).toContain("advisor");
		await h.command("off");
		expect(JSON.parse(await readFile(file, "utf8")).profile).toBe("company");
		expect(h.ctx.model.provider).toBe("company");
	});

	test("switches profile and activates ultra in one command", async () => {
		await save(file, declaration());
		const h = host(dir);
		await h.start();
		await h.command("profile company ultra");
		expect(h.ctx.model.provider).toBe("company");
		expect(h.pi.getThinkingLevel()).toBe("xhigh");
		expect(h.active()).toContain("advisor");
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ profile: "company", mode: "ultra" });
		expect(h.notices.at(-1)).toContain("profile company · mode ultra");
	});

	test("combined profile off switch stays deactivated and leaves the parent unchanged", async () => {
		await save(file, declaration());
		const h = host(dir);
		await h.start();
		await h.command("profile company off");
		expect(h.ctx.model.provider).toBe("personal");
		expect(h.active()).toEqual(["read"]);
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ profile: "company", mode: "off" });
		expect(h.notices.at(-1)).toContain("profile company · mode off");
	});

	test("active switching keeps the session tier and does not leak across sessions", async () => {
		await save(file, declaration());
		const first = host(dir);
		const second = host(dir);
		await first.start();
		await second.start();
		await first.command("high");
		await first.command("profile company");
		expect(first.ctx.model.provider).toBe("company");
		expect(first.pi.getThinkingLevel()).toBe("xhigh");
		await second.command("");
		expect(second.notices.at(-1)).toContain("profile personal");
		expect(second.notices.at(-1)).toContain("personal/reasoner");
		const third = host(dir);
		await third.start();
		await third.command("");
		expect(third.notices.at(-1)).toContain("profile company · mode off");
	});

	test("autoActivate validates and retunes the parent before exposing tools", async () => {
		await save(file, { ...declaration(), profile: "company", autoActivate: true });
		const h = host(dir);
		await h.start();
		expect(h.ctx.model.provider).toBe("company");
		expect(h.active()).toContain("advisor");
		const unavailable = host(dir);
		unavailable.ctx.modelRegistry.getAvailable = () => models("personal");
		await unavailable.start();
		expect(unavailable.active()).toEqual(["read"]);
		expect(unavailable.notices.at(-1)).toContain("unavailable");
	});

	test("picker cancellation leaves the preference untouched", async () => {
		await save(file, declaration());
		const h = host(dir);
		h.ctx.ui.select.mockResolvedValue(undefined);
		await h.command("profile");
		expect(h.ctx.ui.select).toHaveBeenCalledWith("Profile (current: personal)", ["personal", "company"]);
		expect(JSON.parse(await readFile(file, "utf8")).profile).toBe("personal");
	});

	test("unavailable or ambiguous models fail before parent, tools, or preference changes", async () => {
		await save(file, declaration());
		const h = host(dir);
		await h.start();
		await h.command("medium");
		h.ctx.modelRegistry.getAvailable = () => models("personal");
		await h.command("profile company");
		expect(h.notices.at(-1)).toContain("unavailable");
		expect(h.pi.setModel).not.toHaveBeenCalled();
		expect(JSON.parse(await readFile(file, "utf8")).profile).toBe("personal");
		h.ctx.modelRegistry.getAvailable = () => [...models("personal"), ...models("company"), ...models("company")];
		await h.command("profile company");
		expect(h.notices.at(-1)).toContain("ambiguous");
		await h.command("");
		expect(h.notices.at(-1)).toContain("profile personal · mode medium");
	});

	test("failed setModel and busy parent leave the selection unchanged", async () => {
		await save(file, declaration());
		const h = host(dir);
		await h.command("medium");
		h.pi.setModel.mockResolvedValueOnce(false);
		await h.command("profile company");
		expect(h.notices.at(-1)).toContain("authentication unavailable");
		expect(JSON.parse(await readFile(file, "utf8")).profile).toBe("personal");
		h.ctx.isIdle = () => false;
		await h.command("profile company");
		expect(h.notices.at(-1)).toContain("Wait for the parent");
	});

	test("a persistence failure rolls back parent model and reasoning", async () => {
		await save(file, declaration());
		const h = host(dir);
		await h.command("high");
		h.pi.setModel.mockImplementationOnce(async (model) => {
			h.ctx.model = model;
			await writeFile(file, "invalid json");
			return true;
		});
		await h.command("profile company");
		expect(h.notices.at(-1)).toContain("configuration error");
		expect(h.ctx.model.provider).toBe("personal");
		expect(h.pi.getThinkingLevel()).toBe("xhigh");
		await h.command("");
		expect(h.notices.at(-1)).toContain("profile personal · mode high");
	});

	test("missing runtime providers fail before committing a profile", async () => {
		const raw = declaration();
		raw.profiles.company.agents.advisor = { runtime: { provider: "missing", target: "company" } };
		await save(file, raw);
		const h = host(dir);
		await h.command("profile company");
		expect(h.notices.at(-1)).toContain('Runtime provider "missing"');
		expect(JSON.parse(await readFile(file, "utf8")).profile).toBe("personal");
	});

	test("running and resumed subagents keep their runtime target; new runs use the new profile", async () => {
		const events = createEventBus();
		const requests: DriverRequest[] = [];
		const resumed: string[] = [];
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const output = { text: "safe", submitted: { verdict: "safe_to_proceed", confidence: "high", report_markdown: "safe" } };
		const provider: RuntimeDriverProvider = {
			id: "subscription-runtime", apiVersion: 1, displayName: "Subscription runtime",
			capabilities: { resume: true, steer: false, followUp: false, contextModes: ["fresh", "selected"], modelResolution: "provider", policyEnforcement: "adapter", structuredOutput: true },
			async create(selection, request) {
				requests.push(request);
				return {
					run: async () => { if (selection.target === "personal") await blocked; return output; },
					resume: async () => { resumed.push(selection.target!); return output; },
					abort: async () => {},
				};
			},
		};
		registerRuntimeProvider(events, provider);
		const raw = declaration();
		for (const name of ["personal", "company"] as const) {
			raw.profiles[name].agents.advisor = { runtime: { provider: provider.id, target: name } };
		}
		await save(file, raw);
		const h = host(dir, events);
		await h.start();
		await h.command("medium");
		const first = await h.tools.get("advisor")!.execute("one", { task: "Check", includeDiff: false, background: true }, undefined, undefined, h.ctx);
		await h.command("profile company");
		release!();
		await h.tools.get("subagent_result")!.execute("result", { id: first.details.id, wait: true }, undefined, undefined, h.ctx);
		await h.tools.get("subagent_send")!.execute("follow-up", { id: first.details.id, message: "Check again", wait: true }, undefined, undefined, h.ctx);
		await h.tools.get("advisor")!.execute("two", { task: "New check", includeDiff: false }, undefined, undefined, h.ctx);
		expect(resumed).toEqual(["personal"]);
		expect(requests.map((request) => request.metadata?.configProfile)).toEqual(["personal", "company"]);
		expect(requests.map((request) => request.metadata?.mode)).toEqual(["medium", "medium"]);
		await h.shutdown();
	});
});
