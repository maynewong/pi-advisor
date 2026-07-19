import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import {
	assertOracleReadOnly,
	describeToolCall,
	driverErrorFromMessages,
	hardTurnCeiling,
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

	test("rejects oracle profiles that expose mutating tools or SDK defaults", () => {
		const safe: SubagentProfile = { name: "oracle", description: "reasons", systemPrompt: "analyze", tools: ["read", "grep"] };
		const unsafe: SubagentProfile = { ...safe, tools: ["read", "bash"] };
		const unsafePlan: SubagentProfile = { ...safe, name: "oracle", tools: ["read", "write"] };
		const implicitDefaults: SubagentProfile = { name: "oracle", description: "reasons", systemPrompt: "analyze" };

		expect(() => assertOracleReadOnly(safe)).not.toThrow();
		expect(() => assertOracleReadOnly(unsafe)).toThrow(/read-only.*bash/i);
		expect(() => assertOracleReadOnly(unsafePlan)).toThrow(/read-only.*write/i);
		expect(() => assertOracleReadOnly(implicitDefaults)).toThrow(/explicit tool allowlist/i);
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

	test("computes the hard turn ceiling as 3x the soft budget, rounded up", () => {
		expect(hardTurnCeiling(8)).toBe(24);
		expect(hardTurnCeiling(5)).toBe(15);
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
		// Past the hard ceiling (3x) the runaway backstop hard-stops even after wrap-up.
		expect(turnBudgetAction(25, 8, true)).toBe("hard_stop");
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
