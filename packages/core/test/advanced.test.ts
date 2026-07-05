import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { PermissionEscalations } from "../src/permission/PermissionEscalations.ts";
import { SubagentManager } from "../src/runtime/SubagentManager.ts";
import { createChildSessionManager } from "../src/runtime/piSdkDriver.ts";
import type { RuntimeDriverFactory } from "../src/runtime/driver.ts";
import type { SubagentProfile } from "../src/types.ts";

const PROFILE: SubagentProfile = { name: "worker", description: "works", systemPrompt: "work" };

describe("fork context", () => {
	test("creates an independent child session at the requested branch entry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "subagent-fork-"));
		const source = join(dir, "source.jsonl");
		await writeFile(source, [
			JSON.stringify({ type: "session", version: 3, id: "source", timestamp: new Date().toISOString(), cwd: dir }),
			JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "context" }], timestamp: Date.now() } }),
		].join("\n") + "\n");

		const child = createChildSessionManager(dir, { sessionFile: source, entryId: "entry-1" });
		expect(child.getSessionFile()).not.toBe(source);
		expect(child.getLeafId()).toBe("entry-1");
	});
});

describe("permission escalation", () => {
	test("resolves a pending decision from the supervisor", async () => {
		const emitted = vi.fn();
		const escalations = new PermissionEscalations(emitted);
		const pending = escalations.request("bash", "Command is not allowlisted", 1000);
		const id = emitted.mock.calls[0][0].id as string;
		expect(escalations.resolve(id, "allow")).toBe(true);
		await expect(pending).resolves.toBe("allow");
	});

	test("fails closed after the escalation timeout", async () => {
		vi.useFakeTimers();
		try {
			const escalations = new PermissionEscalations(() => {});
			const pending = escalations.request("write", "outside scope", 10);
			await vi.advanceTimersByTimeAsync(10);
			await expect(pending).resolves.toBe("deny");
		} finally {
			vi.useRealTimers();
		}
	});

	test("handle forwards supervisor decisions to the active driver", async () => {
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const resolveEscalation = vi.fn((_id: string, decision: "allow" | "deny") => {
			if (decision === "allow") release();
			return true;
		});
		const factory: RuntimeDriverFactory = async (_request, emit) => ({
			async run() {
				emit({ type: "escalation", id: "permission-1", tool: "bash", question: "Allow bash?" });
				await waiting;
				return { text: "allowed" };
			},
			async abort() {},
			resolveEscalation,
		});
		const handle = new SubagentManager({ cwd: "/repo", createDriver: factory }).spawn(PROFILE, "task");
		await vi.waitFor(() => expect(handle.status).toBe("waiting_permission"));
		expect(handle.resolveEscalation("permission-1", "allow")).toBe(true);
		expect((await handle.wait()).status).toBe("completed");
	});
});

describe("nested spawning", () => {
	test("derives depth from the parent handle and enforces maxDepth", async () => {
		const manager = new SubagentManager({ cwd: "/repo", maxDepth: 2, createDriver: async () => ({ run: async () => ({ text: "ok" }), async abort() {} }) });
		const parent = manager.spawn(PROFILE, "parent");
		const child = manager.spawnChild(parent.id, PROFILE, "child");
		expect(() => manager.spawnChild(child.id, PROFILE, "grandchild")).toThrow("max depth");
		await Promise.all([parent.wait(), child.wait()]);
	});
});
