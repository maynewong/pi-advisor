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
	type ExtensionFactory,
	type ModelRegistry,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ModelSpec, SubagentProfile, UsageSnapshot } from "../types.ts";
import { evaluatePermission } from "../permission/evaluatePermission.ts";
import { PermissionEscalations } from "../permission/PermissionEscalations.ts";
import type { ContextInput } from "../types.ts";
import type { DriverRequest, DriverRunResult, RuntimeDriverFactory } from "./driver.ts";
import { describeToolCall, driverErrorFromMessages, lookupConfiguredModel, resolveActiveTools, successfulFileEvent, thoughtPreview, turnBudgetAction, wrapUpInstruction } from "./piSdkDriverSupport.ts";
import { itemsFromAgentMessage, itemsFromAgentMessages, legacyMessagesFromItems, liveToolItem, resultTextFromUnknown } from "./transcript.ts";

interface PiSdkDriverOptions {
	cwd: string;
	modelRuntime?: ModelRuntime;
	createModelRuntime?: () => Promise<ModelRuntime>;
	modelRegistry?: ModelRegistry;
	resolveModel?: (spec: ModelSpec, profile: SubagentProfile) => Promise<Model<any>>;
}

function assistantText(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
		// A hard stop often leaves a final tool-calling assistant message with no text. Preserve the most recent
		// non-empty answer/progress instead of throwing all useful work away.
		if (text) return text;
	}
	return "";
}

function rescuedPartialText(messages: AgentMessage[], lastThought: string | undefined): string {
	const text = assistantText(messages);
	if (text) return text;
	return [
		"Subagent reached its finalize limit before producing a complete answer.",
		lastThought ? `Last recorded progress: ${lastThought}` : "No assistant summary was produced; inspect the run transcript for tool results and progress.",
	].join("\n\n");
}

function addAssistantUsage(usage: UsageSnapshot, assistant: AssistantMessage): void {
	usage.turns += 1;
	usage.input += assistant.usage.input;
	usage.output += assistant.usage.output;
	usage.cacheRead += assistant.usage.cacheRead;
	usage.cacheWrite += assistant.usage.cacheWrite;
	usage.cost += assistant.usage.cost.total;
	usage.contextTokens = assistant.usage.totalTokens;
	usage.model = assistant.model;
}

function usageFromMessages(messages: AgentMessage[]): UsageSnapshot {
	const usage: UsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const message of messages) {
		if (message.role === "assistant") addAssistantUsage(usage, message as AssistantMessage);
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
		const liveUsage: UsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		// Per prompt-leg soft-budget state, reset before each run/resume turn so every resumed leg gets a fresh budget.
		let legTurns = 0;
		let wrapUpInjected = false;
		let hardStopped = false;
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
		const modelRuntime = options.createModelRuntime
			? await options.createModelRuntime()
			: options.modelRuntime;
		let model: Model<any> | undefined;
		if (request.profile.model && typeof request.profile.model !== "string") model = request.profile.model;
		else if (typeof request.profile.model === "string") {
			model = options.resolveModel
				? await options.resolveModel(request.profile.model, request.profile)
				: lookupConfiguredModel<Model<any>>(request.profile.model, options.modelRegistry, modelRuntime);
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
			...(modelRuntime ? { modelRuntime } : {}),
			...(model ? { model } : {}),
			...(request.profile.thinkingLevel ? { thinkingLevel: request.profile.thinkingLevel } : {}),
			...(activeTools ? { tools: activeTools } : {}),
			...(customTools ? { customTools } : {}),
			resourceLoader,
			sessionManager,
		});
		const { session } = created;
		// A forked child may already contain the full parent branch. Surface that history immediately so hosts can
		// render a real child conversation while the run is active, not only after the terminal result is collected.
		for (const item of itemsFromAgentMessages(session.messages)) {
			emit({ type: "transcript", item });
			emit({ type: "message", message: legacyMessagesFromItems([item])[0]! });
		}
		const originalTools = [...session.agent.state.tools];
		const enterFinalizeMode = () => {
			const outputTool = output?.kind === "schema" ? (output.toolName ?? "submit_result") : undefined;
			session.agent.state.tools = outputTool
				? session.agent.state.tools.filter((tool) => tool.name === outputTool)
				: [];
		};
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "turn_start") {
				turns += 1;
				legTurns += 1;
				emit({ type: "turn", index: turns });
				// At the investigation budget, remove tools and enter a short finalize-only window. If the model still
				// refuses to answer, abort that window but preserve the best partial as a completed budget landing.
				const action = turnBudgetAction(legTurns, request.profile.maxTurns, wrapUpInjected, request.profile.finalizeTurns);
				if (action === "hard_stop") {
					hardStopped = true;
					void session.abort();
				} else if (action === "wrap_up") {
					wrapUpInjected = true;
					enterFinalizeMode();
					void session.steer(wrapUpInstruction(output));
				}
			}
			if (event.type === "tool_execution_start") {
				const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
				emit({ type: "tool_call", name: event.toolName, argsPreview: preview(event.args), summary: describeToolCall(event.toolName, args), callId: event.toolCallId, args });
				emit({ type: "transcript", item: liveToolItem({ callId: event.toolCallId, name: event.toolName, args, status: "running" }) });
				pendingTools.set(event.toolCallId, { name: event.toolName, args });
			}
			if (event.type === "tool_execution_end") {
				const pending = pendingTools.get(event.toolCallId);
				pendingTools.delete(event.toolCallId);
				if (pending) {
					const fileEvent = successfulFileEvent(pending.name, pending.args, event.isError);
					if (fileEvent) emit(fileEvent);
				}
				const resultText = resultTextFromUnknown(event.result);
				emit({ type: "tool_result", name: event.toolName, ok: !event.isError, summary: preview(event.result), callId: event.toolCallId, details: event.result });
				emit({ type: "transcript", item: liveToolItem({ callId: event.toolCallId, name: event.toolName, args: pending?.args, status: event.isError ? "failed" : "completed", resultText, details: event.result }) });
			}
			if (event.type === "message_end") {
				for (const item of itemsFromAgentMessage(event.message, { includeTools: false })) {
					emit({ type: "transcript", item });
					emit({ type: "message", message: legacyMessagesFromItems([item])[0]! });
				}
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				addAssistantUsage(liveUsage, event.message as AssistantMessage);
				emit({ type: "usage", usage: { ...liveUsage } });
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
		// Reduce the current session state into a driver result; shared by the initial run and any resume turn.
		const collect = (promptError: unknown): DriverRunResult => {
			// Both a normal finalize response and a finalize-ceiling abort land as completed partial results.
			const runtimeError = promptError
				? { kind: "model" as const, message: promptError instanceof Error ? promptError.message : String(promptError) }
				: driverErrorFromMessages(session.messages);
			const budgetLanded = wrapUpInjected || hardStopped;
			return {
				text: budgetLanded ? rescuedPartialText(session.messages, lastThought) : assistantText(session.messages),
				// A finalize-ceiling abort is a completed partial, not a total failure. Preserve genuine provider errors.
				...(runtimeError && !hardStopped ? { error: runtimeError } : {}),
				...(budgetLanded ? { stoppedBy: "turn_budget" as const } : {}),
				...(submitted !== undefined ? { submitted } : {}),
				usage: usageFromMessages(session.messages),
				transcript: JSON.stringify(session.messages, null, 2),
				items: itemsFromAgentMessages(session.messages),
				messages: legacyMessagesFromItems(itemsFromAgentMessages(session.messages)),
				...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
			};
		};
		const promptTurn = async (message: string): Promise<DriverRunResult> => {
			// Each leg (initial run or a resume) gets a fresh soft budget.
			legTurns = 0;
			wrapUpInjected = false;
			hardStopped = false;
			lastThought = undefined;
			session.agent.state.tools = originalTools;
			let promptError: unknown;
			try {
				await session.prompt(message);
			} catch (error) {
				promptError = error;
			}
			return collect(promptError);
		};
		return {
			run: () => promptTurn(request.prompt),
			resume: (message) => promptTurn(message),
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
