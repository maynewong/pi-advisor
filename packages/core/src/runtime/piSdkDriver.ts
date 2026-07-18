import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { dirname } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	SessionManager,
	type AgentSessionEvent,
	type AuthStorage,
	type ExtensionFactory,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { ModelSpec, SubagentProfile, UsageSnapshot } from "../types.ts";
import { evaluatePermission } from "../permission/evaluatePermission.ts";
import { PermissionEscalations } from "../permission/PermissionEscalations.ts";
import type { ContextInput } from "../types.ts";
import type { DriverRequest, RuntimeDriverFactory } from "./driver.ts";
import { describeToolCall, driverErrorFromMessages, resolveActiveTools, successfulFileEvent, thoughtPreview } from "./piSdkDriverSupport.ts";

interface PiSdkDriverOptions {
	cwd: string;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	resolveModel?: (spec: ModelSpec, profile: SubagentProfile) => Promise<Model<any>>;
}

function assistantText(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	}
	return "";
}

function resolveRegistryModel(spec: string, registry: ModelRegistry | undefined): Model<any> | undefined {
	const slash = spec.indexOf("/");
	if (slash < 1) return undefined;
	return registry?.find(spec.slice(0, slash), spec.slice(slash + 1));
}

function usageFromMessages(messages: AgentMessage[]): UsageSnapshot {
	const usage: UsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		usage.turns += 1;
		usage.input += assistant.usage.input;
		usage.output += assistant.usage.output;
		usage.cacheRead += assistant.usage.cacheRead;
		usage.cacheWrite += assistant.usage.cacheWrite;
		usage.cost += assistant.usage.cost.total;
		usage.contextTokens = assistant.usage.totalTokens;
		usage.model = assistant.model;
	}
	return usage;
}

function preview(value: unknown, limit = 500): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return (text ?? "").slice(0, limit);
}

export function createChildSessionManager(cwd: string, forkFrom: NonNullable<ContextInput["forkFrom"]>): SessionManager {
	const session = SessionManager.forkFrom(forkFrom.sessionFile, cwd, dirname(forkFrom.sessionFile));
	if (forkFrom.entryId) session.branch(forkFrom.entryId);
	return session;
}

export function createPiSdkDriver(options: PiSdkDriverOptions): RuntimeDriverFactory {
	return async (request: DriverRequest, emit) => {
		let submitted: unknown;
		let turns = 0;
		const pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>();
		let lastThought: string | undefined;
		const escalations = new PermissionEscalations(emit);
		const permissionExtension: ExtensionFactory = (pi) => {
			pi.on("tool_call", async (event) => {
				const args = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
				const decision = evaluatePermission(request.profile.permission, event.toolName, args, request.cwd);
				if (decision.allowed) return;
				const reason = decision.reason ?? "Blocked by subagent permission policy";
				if (request.profile.permission?.onViolation === "escalate") {
					const supervisor = await escalations.request(event.toolName, reason, request.profile.permission.escalationTimeoutMs ?? 30_000);
					if (supervisor === "allow") return;
				}
				emit({ type: "permission_blocked", tool: event.toolName, reason });
				return { block: true, reason };
			});
		};
		const output = request.profile.output;
		const customTools = output?.kind === "schema"
			? [defineTool({
				name: output.toolName ?? "submit_result",
				label: "Submit Result",
				description: "Submit the final result matching the required output schema.",
				parameters: output.schema,
				async execute(_id, params) {
					submitted = params;
					return { content: [{ type: "text", text: "Result accepted." }], details: null, terminate: true };
				},
			})]
			: undefined;
		let model: Model<any> | undefined;
		if (request.profile.model && typeof request.profile.model !== "string") model = request.profile.model;
		else if (typeof request.profile.model === "string") {
			model = options.resolveModel
				? await options.resolveModel(request.profile.model, request.profile)
				: resolveRegistryModel(request.profile.model, options.modelRegistry);
			if (!model) throw new Error(`Unable to resolve model: ${request.profile.model}`);
		}
		const resourceLoader = new DefaultResourceLoader({
			cwd: request.cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noContextFiles: true,
			noSkills: true,
			noPromptTemplates: true,
			systemPrompt: request.profile.systemPrompt,
			appendSystemPrompt: output?.kind === "schema"
				? [`Before finishing, call ${output.toolName ?? "submit_result"} with the final structured result.`]
				: [],
			additionalSkillPaths: request.profile.skills ?? [],
			extensionFactories: [permissionExtension],
		});
		await resourceLoader.reload();
		const sessionManager = request.profile.contextMode === "fork" && request.context?.forkFrom
			? createChildSessionManager(request.cwd, request.context.forkFrom)
			: SessionManager.inMemory(request.cwd);
		const activeTools = resolveActiveTools(request.profile);
		const created = await createAgentSession({
			cwd: request.cwd,
			...(options.authStorage ? { authStorage: options.authStorage } : {}),
			...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {}),
			...(model ? { model } : {}),
			...(request.profile.thinkingLevel ? { thinkingLevel: request.profile.thinkingLevel } : {}),
			...(activeTools ? { tools: activeTools } : {}),
			...(customTools ? { customTools } : {}),
			resourceLoader,
			sessionManager,
		});
		const { session } = created;
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "turn_start") {
				turns += 1;
				emit({ type: "turn", index: turns });
				if (request.profile.maxTurns && turns > request.profile.maxTurns) void session.abort();
			}
			if (event.type === "tool_execution_start") {
				const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
				emit({ type: "tool_call", name: event.toolName, argsPreview: preview(event.args), summary: describeToolCall(event.toolName, args) });
				pendingTools.set(event.toolCallId, { name: event.toolName, args });
			}
			if (event.type === "tool_execution_end") {
				const pending = pendingTools.get(event.toolCallId);
				pendingTools.delete(event.toolCallId);
				if (pending) {
					const fileEvent = successfulFileEvent(pending.name, pending.args, event.isError);
					if (fileEvent) emit(fileEvent);
				}
				emit({ type: "tool_result", name: event.toolName, ok: !event.isError, summary: preview(event.result) });
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				for (const part of event.message.content) {
					const text = part.type === "thinking" ? part.thinking : part.type === "text" ? part.text : undefined;
					if (text === undefined) continue;
					const thought = thoughtPreview(text);
					if (thought === undefined || thought === lastThought) continue;
					lastThought = thought;
					emit({ type: "thought", text: thought });
				}
			}
		});
		return {
			async run() {
				let promptError: unknown;
				try {
					await session.prompt(request.prompt);
				} catch (error) {
					promptError = error;
				}
				const error = request.profile.maxTurns && turns > request.profile.maxTurns
					? { kind: "max_turns" as const, message: `Subagent exceeded maxTurns ${request.profile.maxTurns}` }
					: promptError
						? { kind: "model" as const, message: promptError instanceof Error ? promptError.message : String(promptError) }
						: driverErrorFromMessages(session.messages);
				return {
					text: assistantText(session.messages),
					...(error ? { error } : {}),
					...(submitted !== undefined ? { submitted } : {}),
					usage: usageFromMessages(session.messages),
					transcript: JSON.stringify(session.messages, null, 2),
					...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
				};
			},
			abort: () => session.abort(),
			steer: (message) => session.steer(message),
			followUp: (message) => session.followUp(message),
			resolveEscalation: (id, decision) => escalations.resolve(id, decision),
			dispose() {
				escalations.denyAll();
				unsubscribe();
				session.dispose();
			},
		};
	};
}
