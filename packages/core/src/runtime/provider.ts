import type { Model } from "@earendil-works/pi-ai";
import type { ModelSpec, SubagentProfile, SubagentResult } from "../types.ts";
import type { DriverEvent, DriverRequest, RuntimeDriver, RuntimeDriverFactory } from "./driver.ts";

export const RUNTIME_PROVIDER_API_VERSION = 1 as const;
export const RUNTIME_PROVIDER_DISCOVERY_EVENT = "pi-advisor:runtime-provider-discovery" as const;
export const RUNTIME_PROVIDER_REGISTER_EVENT = "pi-advisor:runtime-provider-register" as const;
export const RUNTIME_PROVIDER_METADATA_KEY = "pi-advisor:runtime-provider" as const;

export interface RuntimeSelection {
	/** Stable third-party provider id, for example `claude-channel`. */
	provider: string;
	/** Provider-owned logical target alias. It must not contain credentials or transport details. */
	target?: string;
}

export interface RuntimeProviderCapabilities {
	resume: boolean;
	steer: boolean;
	followUp: boolean;
	contextModes: Array<"fresh" | "selected" | "fork">;
	modelResolution: "host" | "provider";
	policyEnforcement: "native" | "adapter" | "unsupported";
	structuredOutput: boolean;
}

export interface RuntimeProviderHost {
	emit(event: DriverEvent): void;
	now(): number;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RuntimeTargetDescription {
	label: string;
	model?: string;
	location?: "local" | "remote" | "unknown";
	note?: string;
}

export interface RuntimeProviderHelp {
	homepage?: string;
	command?: string;
}

export interface RuntimeDriverProvider {
	id: string;
	apiVersion: typeof RUNTIME_PROVIDER_API_VERSION;
	displayName: string;
	capabilities: RuntimeProviderCapabilities;
	help?: RuntimeProviderHelp;
	create(selection: RuntimeSelection, request: DriverRequest, host: RuntimeProviderHost): Promise<RuntimeDriver>;
	concurrencyKey?(selection: RuntimeSelection, request: DriverRequest): string | undefined;
	describeTarget?(selection: RuntimeSelection): Promise<RuntimeTargetDescription> | RuntimeTargetDescription;
}

export interface RuntimeProviderDiscovery {
	apiVersion: typeof RUNTIME_PROVIDER_API_VERSION;
	/** Registration must happen synchronously while the discovery event is being handled. */
	register(provider: RuntimeDriverProvider): void;
}

export interface RuntimeProviderEventBus {
	emit(channel: string, data: unknown): void;
}

export interface RuntimeProviderRegistrationEventBus extends RuntimeProviderEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Register through both mechanisms so provider-first and kit-first extension load orders are supported. */
export function registerRuntimeProvider(events: RuntimeProviderEventBus, provider: RuntimeDriverProvider): void {
	validateRuntimeDriverProvider(provider);
	if ("on" in events && typeof (events as RuntimeProviderRegistrationEventBus).on === "function") {
		(events as RuntimeProviderRegistrationEventBus).on(RUNTIME_PROVIDER_DISCOVERY_EVENT, (data) => {
			const discovery = data as Partial<RuntimeProviderDiscovery>;
			if (discovery.apiVersion === RUNTIME_PROVIDER_API_VERSION && typeof discovery.register === "function") discovery.register(provider);
		});
	}
	events.emit(RUNTIME_PROVIDER_REGISTER_EVENT, provider);
}

export interface RuntimeProviderRunMetadata {
	selection: RuntimeSelection;
	description?: RuntimeTargetDescription;
}

export function validateRuntimeSelection(selection: RuntimeSelection): void {
	if (!selection || typeof selection !== "object") throw new RuntimeProviderError("Runtime selection must be an object");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(selection.provider)) {
		throw new RuntimeProviderError(`Invalid runtime provider id: ${JSON.stringify(selection.provider)}`);
	}
	if (selection.target !== undefined && (typeof selection.target !== "string" || !selection.target.trim())) {
		throw new RuntimeProviderError("Runtime target must be a non-empty string when provided");
	}
}

export type RuntimeProviderMap = ReadonlyMap<string, RuntimeDriverProvider>;
export interface RuntimeProviderRegistry {
	get(providerId: string): RuntimeDriverProvider | undefined;
}

export class RuntimeProviderError extends Error {
	constructor(
		message: string,
		readonly kind: NonNullable<SubagentResult["error"]>["kind"] = "protocol",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "RuntimeProviderError";
	}
}

export function validateRuntimeDriverProvider(provider: RuntimeDriverProvider): void {
	if (!provider || typeof provider !== "object") throw new RuntimeProviderError("Runtime provider registration must be an object");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(provider.id)) {
		throw new RuntimeProviderError(`Invalid runtime provider id: ${JSON.stringify(provider.id)}`);
	}
	if (provider.apiVersion !== RUNTIME_PROVIDER_API_VERSION) {
		throw new RuntimeProviderError(`Runtime provider ${provider.id} uses unsupported API version ${String(provider.apiVersion)}`);
	}
	if (!provider.displayName?.trim()) throw new RuntimeProviderError(`Runtime provider ${provider.id} requires a displayName`);
	if (typeof provider.create !== "function") throw new RuntimeProviderError(`Runtime provider ${provider.id} requires create()`);
	const capabilities = provider.capabilities;
	if (!capabilities || typeof capabilities !== "object") throw new RuntimeProviderError(`Runtime provider ${provider.id} requires capabilities`);
	for (const key of ["resume", "steer", "followUp", "structuredOutput"] as const) {
		if (typeof capabilities[key] !== "boolean") throw new RuntimeProviderError(`Runtime provider ${provider.id} capability ${key} must be boolean`);
	}
	if (!Array.isArray(capabilities.contextModes) || capabilities.contextModes.length === 0
		|| !capabilities.contextModes.every((mode) => ["fresh", "selected", "fork"].includes(mode))) {
		throw new RuntimeProviderError(`Runtime provider ${provider.id} requires at least one valid context mode`);
	}
	if (!(["host", "provider"] as const).includes(capabilities.modelResolution)) {
		throw new RuntimeProviderError(`Runtime provider ${provider.id} has invalid modelResolution`);
	}
	if (!(["native", "adapter", "unsupported"] as const).includes(capabilities.policyEnforcement)) {
		throw new RuntimeProviderError(`Runtime provider ${provider.id} has invalid policyEnforcement`);
	}
}

/** Discover all providers currently listening on Pi's extension event bus. */
export function discoverRuntimeProviders(events: RuntimeProviderEventBus): Map<string, RuntimeDriverProvider> {
	const providers = new Map<string, RuntimeDriverProvider>();
	let closed = false;
	let failure: Error | undefined;
	const discovery: RuntimeProviderDiscovery = {
		apiVersion: RUNTIME_PROVIDER_API_VERSION,
		register(provider) {
			if (closed) return;
			try {
				validateRuntimeDriverProvider(provider);
				if (providers.has(provider.id)) throw new RuntimeProviderError(`Duplicate runtime provider: ${provider.id}`);
				providers.set(provider.id, provider);
			} catch (error) {
				failure ??= error instanceof Error ? error : new Error(String(error));
			}
		},
	};
	events.emit(RUNTIME_PROVIDER_DISCOVERY_EVENT, discovery);
	closed = true;
	if (failure) throw failure;
	return providers;
}

export function runtimeProviderMetadata(selection: RuntimeSelection, description?: RuntimeTargetDescription): Record<string, unknown> {
	validateRuntimeSelection(selection);
	return { [RUNTIME_PROVIDER_METADATA_KEY]: { selection, ...(description ? { description } : {}) } satisfies RuntimeProviderRunMetadata };
}

export function mergeRuntimeProviderMetadata(
	metadata: Record<string, unknown> | undefined,
	selection: RuntimeSelection,
	description?: RuntimeTargetDescription,
): Record<string, unknown> {
	return { ...(metadata ?? {}), ...runtimeProviderMetadata(selection, description) };
}

export function runtimeProviderRunMetadata(request: Pick<DriverRequest, "metadata">): RuntimeProviderRunMetadata | undefined {
	const value = request.metadata?.[RUNTIME_PROVIDER_METADATA_KEY];
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const metadata = value as Partial<RuntimeProviderRunMetadata>;
	if (!metadata.selection || typeof metadata.selection.provider !== "string" || !metadata.selection.provider.trim()) return undefined;
	return metadata as RuntimeProviderRunMetadata;
}

export function assertRuntimeProviderSupports(provider: RuntimeDriverProvider, profile: SubagentProfile): void {
	validateRuntimeDriverProvider(provider);
	const mode = profile.contextMode ?? "fresh";
	if (!provider.capabilities.contextModes.includes(mode)) {
		throw new RuntimeProviderError(`Runtime provider ${provider.id} does not support context mode ${mode}`);
	}
	if (profile.output?.kind === "schema" && !provider.capabilities.structuredOutput) {
		throw new RuntimeProviderError(`Runtime provider ${provider.id} does not support structured output`);
	}
	if (profile.name === "advisor" && provider.capabilities.policyEnforcement === "unsupported") {
		throw new RuntimeProviderError(`Runtime provider ${provider.id} cannot enforce Advisor's read-only policy`);
	}
}

export function resolveRuntimeProviderConcurrencyKey(
	provider: RuntimeDriverProvider,
	selection: RuntimeSelection,
	request: DriverRequest,
): string | undefined {
	const key = provider.concurrencyKey?.(selection, request);
	if (key === undefined) return undefined;
	if (typeof key !== "string" || !key.trim()) throw new RuntimeProviderError(`Runtime provider ${provider.id} returned an invalid concurrency key`);
	return key;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!Number.isFinite(ms) || ms < 0) return Promise.reject(new RangeError("sleep duration must be a non-negative finite number"));
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Aborted"));
		}, { once: true });
	});
}

function wrapDriver(provider: RuntimeDriverProvider, driver: RuntimeDriver): RuntimeDriver {
	if (!driver || typeof driver !== "object" || typeof driver.run !== "function" || typeof driver.abort !== "function") {
		throw new RuntimeProviderError(`Runtime provider ${provider.id} returned an invalid driver`);
	}
	for (const method of ["resume", "steer", "followUp"] as const) {
		if (provider.capabilities[method] && typeof driver[method] !== "function") {
			throw new RuntimeProviderError(`Runtime provider ${provider.id} declares ${method} support but its driver does not implement ${method}()`);
		}
	}
	return {
		run: () => driver.run(),
		abort: () => driver.abort(),
		...(provider.capabilities.resume && driver.resume ? { resume: (message: string) => driver.resume!(message) } : {}),
		...(provider.capabilities.steer && driver.steer ? { steer: (message: string) => driver.steer!(message) } : {}),
		...(provider.capabilities.followUp && driver.followUp ? { followUp: (message: string) => driver.followUp!(message) } : {}),
		...(driver.resolveEscalation ? { resolveEscalation: (id, decision) => driver.resolveEscalation!(id, decision) } : {}),
		...(driver.dispose ? { dispose: () => driver.dispose!() } : {}),
	};
}

export interface RuntimeProviderDispatcherOptions {
	providers: RuntimeProviderRegistry | (() => RuntimeProviderRegistry);
	fallback: RuntimeDriverFactory;
	selectionFor?: (request: DriverRequest) => RuntimeSelection | undefined;
	resolveModel?: (spec: ModelSpec, profile: SubagentProfile) => Promise<Model<any>>;
	now?: () => number;
	sleep?: RuntimeProviderHost["sleep"];
}

/** Build a driver factory that dispatches provider-tagged requests while preserving the local fallback. */
export function createRuntimeProviderDispatcher(options: RuntimeProviderDispatcherOptions): RuntimeDriverFactory {
	return async (request, emit) => {
		const selection = options.selectionFor?.(request) ?? runtimeProviderRunMetadata(request)?.selection;
		if (!selection) return options.fallback(request, emit);
		validateRuntimeSelection(selection);
		const providers = typeof options.providers === "function" ? options.providers() : options.providers;
		const provider = providers.get(selection.provider);
		if (!provider) {
			throw new RuntimeProviderError(
				`Runtime provider "${selection.provider}" is not installed or enabled. Install or enable a Pi package that registers this provider.`,
				"tool",
			);
		}
		assertRuntimeProviderSupports(provider, request.profile);
		let providerRequest = request;
		if (provider.capabilities.modelResolution === "host" && request.profile.model) {
			if (typeof request.profile.model === "string") {
				if (!options.resolveModel) throw new RuntimeProviderError(`Runtime provider ${provider.id} requires host model resolution, but the host did not configure a resolver`);
				const model = await options.resolveModel(request.profile.model, request.profile);
				providerRequest = { ...request, profile: { ...request.profile, model } };
			}
		}
		let driver: RuntimeDriver;
		try {
			driver = await provider.create(selection, providerRequest, {
				emit,
				now: options.now ?? Date.now,
				sleep: options.sleep ?? sleep,
			});
		} catch (error) {
			if (error instanceof RuntimeProviderError) throw error;
			throw new RuntimeProviderError(
				`Runtime provider ${provider.id} failed to create target ${JSON.stringify(selection.target ?? "default")}: ${error instanceof Error ? error.message : String(error)}`,
				"tool",
				{ cause: error },
			);
		}
		return wrapDriver(provider, driver);
	};
}
