import { describe, expect, test, vi } from "vitest";
import {
	RUNTIME_PROVIDER_DISCOVERY_EVENT,
	RUNTIME_PROVIDER_REGISTER_EVENT,
	RuntimeProviderError,
	assertRuntimeProviderSupports,
	createRuntimeProviderDispatcher,
	discoverRuntimeProviders,
	mergeRuntimeProviderMetadata,
	registerRuntimeProvider,
	resolveRuntimeProviderConcurrencyKey,
	type DriverRequest,
	type RuntimeDriverProvider,
	type RuntimeProviderDiscovery,
} from "../src/index.ts";
import type { SubagentProfile } from "../src/types.ts";

const profile: SubagentProfile = {
	name: "search",
	description: "Search",
	systemPrompt: "Search.",
	model: "provider/model",
	contextMode: "selected",
	output: { kind: "text" },
};

function request(overrides: Partial<DriverRequest> = {}): DriverRequest {
	return {
		id: "run-1",
		cwd: "/repo",
		profile,
		task: "find it",
		prompt: "find it\n\n# Context packet\n\nsource",
		...overrides,
	};
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
			structuredOutput: false,
		},
		async create() {
			return { run: async () => ({ text: "external result" }), abort: async () => {} };
		},
		...overrides,
	};
}

function eventBus(...providers: RuntimeDriverProvider[]) {
	return {
		emit(channel: string, data: unknown) {
			expect(channel).toBe(RUNTIME_PROVIDER_DISCOVERY_EVENT);
			const discovery = data as RuntimeProviderDiscovery;
			for (const item of providers) discovery.register(item);
		},
	};
}

describe("runtime provider SPI", () => {
	test("discovers providers synchronously and rejects duplicate ids", () => {
		const registered = provider();
		expect(discoverRuntimeProviders(eventBus(registered)).get(registered.id)).toBe(registered);
		expect(() => discoverRuntimeProviders(eventBus(registered, provider()))).toThrow(/duplicate runtime provider/i);
	});

	test("register helper supports discovery and emits direct registration for late providers", () => {
		const handlers = new Map<string, (data: unknown) => void>();
		const emitted: Array<[string, unknown]> = [];
		const events = {
			on(channel: string, handler: (data: unknown) => void) { handlers.set(channel, handler); return () => handlers.delete(channel); },
			emit(channel: string, data: unknown) { emitted.push([channel, data]); handlers.get(channel)?.(data); },
		};
		const registered = provider();
		registerRuntimeProvider(events, registered);
		expect(emitted).toContainEqual([RUNTIME_PROVIDER_REGISTER_EVENT, registered]);
		const discovered: RuntimeDriverProvider[] = [];
		events.emit(RUNTIME_PROVIDER_DISCOVERY_EVENT, { apiVersion: 1, register: (item: RuntimeDriverProvider) => discovered.push(item) });
		expect(discovered).toEqual([registered]);
	});

	test("dispatches selected runs and preserves the materialized context packet", async () => {
		let seen: DriverRequest | undefined;
		const emit = vi.fn();
		const registered = provider({
			async create(_selection, current, host) {
				seen = current;
				host.emit({ type: "progress", text: "submitted" });
				return { run: async () => ({ text: "external result" }), abort: async () => {} };
			},
		});
		const fallback = vi.fn(async () => ({ run: async () => ({ text: "local" }), abort: async () => {} }));
		const factory = createRuntimeProviderDispatcher({ providers: new Map([[registered.id, registered]]), fallback });
		const current = request({ metadata: mergeRuntimeProviderMetadata(undefined, { provider: registered.id, target: "remote-search" }) });
		const driver = await factory(current, emit);

		await expect(driver.run()).resolves.toEqual({ text: "external result" });
		expect(seen?.prompt).toBe(current.prompt);
		expect(seen?.context).toBe(current.context);
		expect(emit).toHaveBeenCalledWith({ type: "progress", text: "submitted" });
		expect(fallback).not.toHaveBeenCalled();
	});

	test("uses the local fallback when no runtime is selected", async () => {
		const fallback = vi.fn(async () => ({ run: async () => ({ text: "local" }), abort: async () => {} }));
		const factory = createRuntimeProviderDispatcher({ providers: new Map(), fallback });
		await factory(request(), () => {});
		expect(fallback).toHaveBeenCalledOnce();
	});

	test("returns a clear missing-provider error", async () => {
		const factory = createRuntimeProviderDispatcher({
			providers: new Map(),
			fallback: async () => ({ run: async () => ({ text: "local" }), abort: async () => {} }),
		});
		const promise = factory(request({ metadata: mergeRuntimeProviderMetadata(undefined, { provider: "missing" }) }), () => {});
		await expect(promise).rejects.toMatchObject({ kind: "tool" });
		await expect(promise).rejects.toThrow(/not installed or enabled/i);
	});

	test("validates context, structured output, and Advisor policy capabilities", () => {
		expect(() => assertRuntimeProviderSupports(provider(), { ...profile, contextMode: "fork" })).toThrow(/context mode fork/i);
		expect(() => assertRuntimeProviderSupports(provider(), { ...profile, output: { kind: "schema", schema: {} as never } })).toThrow(/structured output/i);
		expect(() => assertRuntimeProviderSupports(provider({ capabilities: { ...provider().capabilities, policyEnforcement: "unsupported" } }), { ...profile, name: "advisor" })).toThrow(/read-only policy/i);
	});

	test("resolves host models only for host-model providers", async () => {
		const concrete = { provider: "host", id: "resolved" } as never;
		const resolveModel = vi.fn(async () => concrete);
		let seenModel: unknown;
		const registered = provider({
			capabilities: { ...provider().capabilities, modelResolution: "host" },
			async create(_selection, current) {
				seenModel = current.profile.model;
				return { run: async () => ({ text: "ok" }), abort: async () => {} };
			},
		});
		const factory = createRuntimeProviderDispatcher({
			providers: new Map([[registered.id, registered]]),
			fallback: async () => ({ run: async () => ({ text: "local" }), abort: async () => {} }),
			resolveModel,
		});
		await factory(request({ metadata: mergeRuntimeProviderMetadata(undefined, { provider: registered.id }) }), () => {});
		expect(resolveModel).toHaveBeenCalledWith("provider/model", expect.objectContaining({ name: "search" }));
		expect(seenModel).toBe(concrete);
	});

	test("masks undeclared optional methods and verifies declared methods", async () => {
		const undeclared = provider({
			async create() {
				return { run: async () => ({ text: "ok" }), abort: async () => {}, steer: async () => {} };
			},
		});
		const factory = createRuntimeProviderDispatcher({
			providers: new Map([[undeclared.id, undeclared]]),
			fallback: async () => ({ run: async () => ({ text: "local" }), abort: async () => {} }),
		});
		const driver = await factory(request({ metadata: mergeRuntimeProviderMetadata(undefined, { provider: undeclared.id }) }), () => {});
		expect(driver.steer).toBeUndefined();

		const invalid = provider({ capabilities: { ...provider().capabilities, resume: true } });
		const invalidFactory = createRuntimeProviderDispatcher({
			providers: new Map([[invalid.id, invalid]]),
			fallback: async () => ({ run: async () => ({ text: "local" }), abort: async () => {} }),
		});
		await expect(invalidFactory(request({ metadata: mergeRuntimeProviderMetadata(undefined, { provider: invalid.id }) }), () => {})).rejects.toThrow(/declares resume support/i);
	});

	test("delegates and validates provider concurrency keys", () => {
		const registered = provider({ concurrencyKey: (selection) => `example:${selection.target}` });
		expect(resolveRuntimeProviderConcurrencyKey(registered, { provider: registered.id, target: "one" }, request())).toBe("example:one");
		const invalid = provider({ concurrencyKey: () => "" });
		expect(() => resolveRuntimeProviderConcurrencyKey(invalid, { provider: invalid.id }, request())).toThrow(/invalid concurrency key/i);
	});

	test("uses live provider maps so late registrations are dispatchable", async () => {
		const providers = new Map<string, RuntimeDriverProvider>();
		const factory = createRuntimeProviderDispatcher({
			providers: () => providers,
			fallback: async () => ({ run: async () => ({ text: "local" }), abort: async () => {} }),
		});
		const registered = provider();
		providers.set(registered.id, registered);
		const driver = await factory(request({ metadata: mergeRuntimeProviderMetadata(undefined, { provider: registered.id }) }), () => {});
		await expect(driver.run()).resolves.toEqual({ text: "external result" });
	});

	test("rejects invalid provider descriptors during discovery", () => {
		const invalid = provider({ id: "bad provider" });
		expect(() => discoverRuntimeProviders(eventBus(invalid))).toThrow(/invalid runtime provider id/i);
	});

	test("preserves provider error classification", async () => {
		const registered = provider({
			async create() {
				throw new RuntimeProviderError("target unavailable", "tool");
			},
		});
		const factory = createRuntimeProviderDispatcher({
			providers: new Map([[registered.id, registered]]),
			fallback: async () => ({ run: async () => ({ text: "local" }), abort: async () => {} }),
		});
		await expect(factory(request({ metadata: mergeRuntimeProviderMetadata(undefined, { provider: registered.id }) }), () => {})).rejects.toMatchObject({ kind: "tool" });
	});
});
