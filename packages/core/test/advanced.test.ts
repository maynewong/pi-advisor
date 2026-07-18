import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

describe("resuming a completed run", () => {
	const usage = (turns: number) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns });

	function resumableFactory(): RuntimeDriverFactory {
		return async (_request, emit) => ({
			async run() {
				emit({ type: "file_read", path: "a.ts" });
				return { text: "first answer", usage: usage(1) };
			},
			async resume(message: string) {
				emit({ type: "file_read", path: "b.ts" });
				return { text: `follow-up: ${message}`, usage: usage(3) };
			},
			async abort() {},
		});
	}

	test("continues the conversation on the retained session and returns a new result", async () => {
		const manager = new SubagentManager({ cwd: "/repo", createDriver: resumableFactory() });
		const handle = manager.spawn(PROFILE, "task");
		const first = await handle.wait();
		expect(first).toMatchObject({ status: "completed", text: "first answer" });

		const second = await handle.resume("dig deeper");
		expect(second).toMatchObject({ status: "completed", text: "follow-up: dig deeper" });
		// Disclosure accumulates across the original run and the resumed turn.
		expect(second.disclosure.filesRead).toEqual(["a.ts", "b.ts"]);
		expect(handle.status).toBe("completed");
		expect(handle.usage.turns).toBe(3);
	});

	test("supports repeated follow-ups via the manager id-based entrypoint", async () => {
		const manager = new SubagentManager({ cwd: "/repo", createDriver: resumableFactory() });
		const handle = manager.spawn(PROFILE, "task");
		await handle.wait();
		await expect(manager.resume(handle.id, "one")).resolves.toMatchObject({ text: "follow-up: one" });
		await expect(manager.resume(handle.id, "two")).resolves.toMatchObject({ text: "follow-up: two" });
	});

	test("rewrites the artifacts result and appends resumed events", async () => {
		const artifactsDir = await mkdtemp(join(tmpdir(), "subagent-resume-"));
		const manager = new SubagentManager({ cwd: "/repo", artifactsDir, createDriver: resumableFactory() });
		const handle = manager.spawn(PROFILE, "task");
		await handle.wait();
		const second = await handle.resume("again");
		expect(JSON.parse(await readFile(second.artifacts!.result!, "utf8"))).toMatchObject({ text: "follow-up: again" });
		const events = (await readFile(second.artifacts!.events!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; path?: string });
		expect(events.filter((event) => event.type === "completed")).toHaveLength(2);
		expect(events.filter((event) => event.type === "file_read").map((event) => event.path)).toEqual(["a.ts", "b.ts"]);
	});

	test("surfaces a resumed-turn failure as data and closes the conversation", async () => {
		const factory: RuntimeDriverFactory = async () => ({
			async run() { return { text: "ok", usage: usage(1) }; },
			async resume() { return { text: "", error: { kind: "model", message: "provider exploded" }, usage: usage(2) }; },
			async abort() {},
		});
		const manager = new SubagentManager({ cwd: "/repo", createDriver: factory });
		const handle = manager.spawn(PROFILE, "task");
		await handle.wait();
		const failed = await handle.resume("push");
		expect(failed).toMatchObject({ status: "failed", error: { kind: "model", message: "provider exploded" } });
		// A failed follow-up is no longer resumable.
		await expect(manager.resume(handle.id, "retry")).rejects.toThrow(/not resumable/i);
	});

	test("does not retain a run that ended in a non-completed state", async () => {
		const factory: RuntimeDriverFactory = async () => ({ run: async () => ({ text: "", error: { kind: "model", message: "no key" } }), async abort() {} });
		const manager = new SubagentManager({ cwd: "/repo", createDriver: factory });
		const handle = manager.spawn(PROFILE, "task");
		await handle.wait();
		expect(() => handle.resume("continue")).toThrow(/cannot be resumed/i);
	});
});

describe("steering a running run", () => {
	test("forwards a mid-run message to the active driver", async () => {
		const steer = vi.fn();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const factory: RuntimeDriverFactory = async () => ({
			async run() { await gate; return { text: "done" }; },
			async abort() {},
			steer: (message: string) => { steer(message); release(); },
		});
		const handle = new SubagentManager({ cwd: "/repo", createDriver: factory }).spawn(PROFILE, "task");
		await vi.waitFor(() => expect(handle.status).toBe("running"));
		handle.steer("change direction");
		expect(steer).toHaveBeenCalledWith("change direction");
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
