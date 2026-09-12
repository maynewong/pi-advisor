import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { itemsFromAgentMessages, liveToolItem, upsertTranscriptItem } from "../src/runtime/transcript.ts";
import {
	assertAdvisorReadOnly,
	describeToolCall,
	driverErrorFromMessages,
	hardTurnCeiling,
	lookupConfiguredModel,
	resolveActiveTools,
	successfulFileEvent,
	thoughtPreview,
	turnBudgetAction,
	WRAP_UP_INSTRUCTION,
	wrapUpInstruction,
} from "../src/runtime/piSdkDriverSupport.ts";
import type { SubagentProfile } from "../src/types.ts";

function assistant(stopReason: "stop" | "error" | "aborted", errorMessage?: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-completions",
		provider: "test",
		model: "scripted",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	} as AgentMessage;
}

describe("piSdkDriver projections", () => {
	test("maps an assistant stream error to a model failure", () => {
		expect(driverErrorFromMessages([assistant("error", "No API key")])).toEqual({ kind: "model", message: "No API key" });
	});

	test("activates the schema output tool alongside explicit or default tools", () => {
		const schema = { kind: "schema", schema: { type: "object" }, toolName: "submit_result" } as const;
		const explicit: SubagentProfile = { name: "worker", description: "works", systemPrompt: "work", tools: ["read"], output: schema };
		const defaults: SubagentProfile = { name: "worker", description: "works", systemPrompt: "work", output: schema };

		expect(resolveActiveTools(explicit)).toEqual(["read", "submit_result"]);
		expect(resolveActiveTools(defaults)).toEqual(["read", "bash", "edit", "write", "submit_result"]);
	});

	test("resolves a provider/id string from ModelRuntime when no explicit resolver is provided", () => {
		const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
		expect(lookupConfiguredModel("openai-codex/gpt-5.6-sol", undefined, {
			getModel: (provider, id) => provider === "openai-codex" && id === "gpt-5.6-sol" ? model as never : undefined,
		})).toEqual(model);
		expect(lookupConfiguredModel("openai-codex/missing", undefined, { getModel: () => undefined })).toBeUndefined();
		expect(lookupConfiguredModel("gpt-5.6-sol", undefined, { getModel: () => model as never })).toBeUndefined();
	});

	test("rejects advisor profiles that expose mutating tools or SDK defaults", () => {
		const safe: SubagentProfile = { name: "advisor", description: "reasons", systemPrompt: "analyze", tools: ["read", "grep"] };
		const unsafe: SubagentProfile = { ...safe, tools: ["read", "bash"] };
		const unsafePlan: SubagentProfile = { ...safe, name: "advisor", tools: ["read", "write"] };
		const implicitDefaults: SubagentProfile = { name: "advisor", description: "reasons", systemPrompt: "analyze" };

		expect(() => assertAdvisorReadOnly(safe)).not.toThrow();
		expect(() => assertAdvisorReadOnly(unsafe)).toThrow(/read-only.*bash/i);
		expect(() => assertAdvisorReadOnly(unsafePlan)).toThrow(/read-only.*write/i);
		expect(() => assertAdvisorReadOnly(implicitDefaults)).toThrow(/explicit tool allowlist/i);
	});

	test("reports file access only after successful tool completion", () => {
		expect(successfulFileEvent("write", { path: "denied/hack.txt" }, true)).toBeUndefined();
		expect(successfulFileEvent("write", { path: "allowed/ok.txt" }, false)).toEqual({ type: "file_write", path: "allowed/ok.txt" });
		expect(successfulFileEvent("read", { path: "notes.txt" }, false)).toEqual({ type: "file_read", path: "notes.txt" });
	});

	test("describes tool calls in short human-readable terms", () => {
		expect(describeToolCall("read", { path: "src/index.ts" })).toBe("Reading src/index.ts");
		expect(describeToolCall("grep", { pattern: "TODO", path: "src" })).toBe('Searching "TODO" in src');
		expect(describeToolCall("grep", { pattern: "TODO" })).toBe('Searching "TODO"');
		expect(describeToolCall("find", { pattern: "*.ts" })).toBe("Finding *.ts");
		expect(describeToolCall("ls", {})).toBe("Listing .");
		expect(describeToolCall("ls", { path: "src" })).toBe("Listing src");
		expect(describeToolCall("bash", { command: "npm test" })).toBe("Running: npm test");
		expect(describeToolCall("edit", { path: "a.ts" })).toBe("Editing a.ts");
		expect(describeToolCall("write", { path: "a.ts" })).toBe("Writing a.ts");
		expect(describeToolCall("mystery_tool", { path: "a.ts" })).toBe("mystery_tool");
	});

	test("truncates long tool call descriptions to roughly 80 characters", () => {
		const longPath = `src/${"a".repeat(120)}.ts`;
		const description = describeToolCall("read", { path: longPath });
		expect(description.length).toBeLessThanOrEqual(80);
		expect(description.endsWith("...")).toBe(true);
	});

	test("does not throw on missing or non-string tool args", () => {
		expect(describeToolCall("read", {})).toBe("Reading file");
		expect(describeToolCall("bash", { command: 42 })).toBe("Running: ");
		expect(describeToolCall("grep", {})).toBe('Searching ""');
	});

	test("computes the hard turn ceiling as investigation budget plus a small finalize window", () => {
		expect(hardTurnCeiling(8)).toBe(10);
		expect(hardTurnCeiling(5, 3)).toBe(8);
		expect(hardTurnCeiling(1)).toBe(3);
	});

	test("decides the soft-budget action: continue, wrap up once, then hard stop", () => {
		// No budget configured: always continue.
		expect(turnBudgetAction(100, undefined, false)).toBe("continue");
		// Within the soft budget.
		expect(turnBudgetAction(8, 8, false)).toBe("continue");
		// First turn past the soft budget injects the wrap-up (once).
		expect(turnBudgetAction(9, 8, false)).toBe("wrap_up");
		expect(turnBudgetAction(9, 8, true)).toBe("continue");
		// Past the finalize window, the runtime stops and preserves a partial result.
		expect(turnBudgetAction(11, 8, true)).toBe("hard_stop");
		expect(turnBudgetAction(12, 8, true, 3)).toBe("hard_stop");
	});

	test("extends the wrap-up instruction for schema profiles to land via the output tool", () => {
		expect(wrapUpInstruction(undefined)).toBe(WRAP_UP_INSTRUCTION);
		expect(wrapUpInstruction({ kind: "text" })).toBe(WRAP_UP_INSTRUCTION);
		const schema = wrapUpInstruction({ kind: "schema", schema: { type: "object" }, toolName: "submit_result" });
		expect(schema).toContain(WRAP_UP_INSTRUCTION);
		expect(schema).toMatch(/call submit_result/i);
	});

	test("condenses thinking or text blocks to a single short line", () => {
		expect(thoughtPreview("  \n\n  ")).toBeUndefined();
		expect(thoughtPreview("")).toBeUndefined();
		expect(thoughtPreview("## Plan\nFirst check the config file")).toBe("Plan");
		expect(thoughtPreview("Checking the routing logic next")).toBe("Checking the routing logic next");
		const long = "x".repeat(150);
		const preview = thoughtPreview(long);
		expect(preview?.length).toBeLessThanOrEqual(100);
		expect(preview?.endsWith("...")).toBe(true);
	});
});

describe("structured transcript items", () => {
	test("splits assistant thinking, text, and tool calls while pairing results by callId", () => {
		const items = itemsFromAgentMessages([
			{ role: "user", content: "Review PR #2", timestamp: 1 } as AgentMessage,
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Compare the public API" },
					{ type: "text", text: "## Preliminary" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
				],
				timestamp: 2,
			} as AgentMessage,
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "export function a() {}" }],
				isError: false,
				timestamp: 3,
			} as AgentMessage,
		]);
		expect(items.map((item) => item.kind)).toEqual(["user", "thinking", "assistant", "tool"]);
		const tool = items.find((item) => item.kind === "tool");
		expect(tool).toMatchObject({ callId: "call-1", name: "read", status: "completed", resultText: "export function a() {}" });
	});

	test("live tool items reconcile by callId instead of duplicating the same read", () => {
		const items = [liveToolItem({ callId: "call-1", name: "read", args: { path: "a.ts" }, status: "running" })];
		upsertTranscriptItem(items, liveToolItem({ callId: "call-1", name: "read", args: { path: "a.ts" }, status: "completed", resultText: "ok" }));
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ status: "completed", resultText: "ok" });
	});
});
