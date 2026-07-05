import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import {
	driverErrorFromMessages,
	resolveActiveTools,
	successfulFileEvent,
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

	test("reports file access only after successful tool completion", () => {
		expect(successfulFileEvent("write", { path: "denied/hack.txt" }, true)).toBeUndefined();
		expect(successfulFileEvent("write", { path: "allowed/ok.txt" }, false)).toEqual({ type: "file_write", path: "allowed/ok.txt" });
		expect(successfulFileEvent("read", { path: "notes.txt" }, false)).toEqual({ type: "file_read", path: "notes.txt" });
	});
});
