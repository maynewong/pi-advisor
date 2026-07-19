import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { SubagentManager } from "../src/runtime/SubagentManager.ts";
import type { DriverEvent, RuntimeDriver, RuntimeDriverFactory } from "../src/runtime/driver.ts";
import type { SubagentProfile } from "../src/types.ts";

const PROFILE: SubagentProfile = {
	name: "scout",
	description: "Finds facts",
	systemPrompt: "Inspect and report.",
	tools: ["read", "grep"],
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("SubagentManager", () => {
	test("runs a child and exposes projected events, usage, and disclosure", async () => {
		const factory: RuntimeDriverFactory = async (_request, emit) => ({
			async run() {
				emit({ type: "turn", index: 1 });
				emit({ type: "file_read", path: "src/a.ts" });
				emit({ type: "progress", text: "inspecting" });
				return { text: "found it", usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 } };
			},
			async abort() {},
		});
		const manager = new SubagentManager({ cwd: "/repo", createDriver: factory });
		const handle = manager.spawn(PROFILE, "Find the bug");
		const events: DriverEvent[] = [];
		const unsubscribe = handle.subscribe((event) => events.push(event));
		const result = await handle.wait();
		unsubscribe();

		expect(result).toMatchObject({ status: "completed", text: "found it", disclosure: { filesRead: ["src/a.ts"] } });
		expect(handle.status).toBe("completed");
		expect(handle.usage.turns).toBe(1);
		expect(events.map((event) => event.type)).toEqual(["started", "turn", "file_read", "progress", "completed"]);
		expect(manager.get(handle.id)).toBe(handle);
	});

	test("updates handle usage while the child is still running", async () => {
		const finish = deferred<{ text: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number } }>();
		const liveUsage = { input: 1200, output: 300, cacheRead: 50, cacheWrite: 0, cost: 0.0123, turns: 1 };
		const factory: RuntimeDriverFactory = async (_request, emit) => ({
			async run() {
				emit({ type: "usage", usage: liveUsage });
				return finish.promise;
			},
			async abort() {},
		});
		const handle = new SubagentManager({ cwd: "/repo", createDriver: factory }).spawn(PROFILE, "Track live cost");

		await vi.waitFor(() => expect(handle.usage).toEqual(liveUsage));
		expect(handle.status).toBe("running");
		finish.resolve({ text: "done", usage: liveUsage });
		await handle.wait();
	});

	test("queues children above the concurrency limit", async () => {
		const first = deferred<{ text: string }>();
		const second = deferred<{ text: string }>();
		let created = 0;
		const factory: RuntimeDriverFactory = async () => {
			const current = created++;
			return { run: () => current === 0 ? first.promise : second.promise, async abort() {} } as RuntimeDriver;
		};
		const manager = new SubagentManager({ cwd: "/repo", maxConcurrent: 1, createDriver: factory });
		const one = manager.spawn(PROFILE, "one");
		const two = manager.spawn(PROFILE, "two");
		await vi.waitFor(() => expect(one.status).toBe("running"));
		expect(two.status).toBe("queued");
		first.resolve({ text: "one" });
		await one.wait();
		await vi.waitFor(() => expect(two.status).toBe("running"));
		second.resolve({ text: "two" });
		expect((await two.wait()).status).toBe("completed");
	});

	test("limits concurrency independently per resolved credential key", async () => {
		const releases = new Map<string, ReturnType<typeof deferred<{ text: string }>>>();
		const started: string[] = [];
		const factory: RuntimeDriverFactory = async (request) => ({
			run() {
				started.push(request.task);
				const gate = deferred<{ text: string }>();
				releases.set(request.task, gate);
				return gate.promise;
			},
			async abort() {},
		});
		const manager = new SubagentManager({
			cwd: "/repo",
			maxConcurrent: 3,
			maxConcurrentPerKey: 1,
			resolveConcurrencyKey: (profile) => String(profile.model),
			createDriver: factory,
		});
		const one = manager.spawn({ ...PROFILE, model: "credential-a" }, "one");
		const two = manager.spawn({ ...PROFILE, model: "credential-a" }, "two");
		const three = manager.spawn({ ...PROFILE, model: "credential-b" }, "three");
		await vi.waitFor(() => expect(started).toEqual(["one", "three"]));
		expect(two.status).toBe("queued");
		releases.get("one")!.resolve({ text: "one" });
		await one.wait();
		await vi.waitFor(() => expect(started).toEqual(["one", "three", "two"]));
		releases.get("two")!.resolve({ text: "two" });
		releases.get("three")!.resolve({ text: "three" });
		await Promise.all([two.wait(), three.wait()]);
	});

	test("times out and resolves wait with an error result", async () => {
		const abort = vi.fn(async () => {});
		const factory: RuntimeDriverFactory = async () => ({ run: () => new Promise(() => {}), abort });
		const manager = new SubagentManager({ cwd: "/repo", createDriver: factory });
		const handle = manager.spawn({ ...PROFILE, timeoutMs: 10 }, "hang");
		const result = await handle.wait();
		expect(result).toMatchObject({ status: "timeout", error: { kind: "timeout" } });
		expect(abort).toHaveBeenCalledOnce();
	});

	test("aborts a running child even when the driver run never settles", async () => {
		const abort = vi.fn(async () => {});
		const factory: RuntimeDriverFactory = async () => ({ run: () => new Promise(() => {}), abort });
		const manager = new SubagentManager({ cwd: "/repo", createDriver: factory });
		const handle = manager.spawn(PROFILE, "hang");
		await vi.waitFor(() => expect(handle.status).toBe("running"));
		await handle.abort();
		await expect(handle.wait()).resolves.toMatchObject({ status: "aborted", error: { kind: "aborted" } });
		expect(abort).toHaveBeenCalledOnce();
	});

	test("writes optional events and result artifacts", async () => {
		const artifactsDir = await mkdtemp(join(tmpdir(), "subagent-artifacts-"));
		const factory: RuntimeDriverFactory = async () => ({ run: async () => ({ text: "ok" }), async abort() {} });
		const manager = new SubagentManager({ cwd: "/repo", artifactsDir, createDriver: factory });
		const result = await manager.spawn(PROFILE, "artifact task").wait();
		expect(result.artifacts?.events).toBeTruthy();
		expect(JSON.parse(await readFile(result.artifacts!.result!, "utf8"))).toMatchObject({ status: "completed", text: "ok" });
	});

	test("preserves driver failures and writes their transcript artifact", async () => {
		const artifactsDir = await mkdtemp(join(tmpdir(), "subagent-model-failure-"));
		const factory: RuntimeDriverFactory = async () => ({
			run: async () => ({
				text: "",
				transcript: "model failure transcript",
				error: { kind: "model", message: "No API key" },
			}),
			async abort() {},
		});
		const manager = new SubagentManager({ cwd: "/repo", artifactsDir, createDriver: factory });
		const result = await manager.spawn(PROFILE, "artifact failure").wait();

		expect(result).toMatchObject({ status: "failed", error: { kind: "model", message: "No API key" } });
		expect(result.artifacts?.transcript).toBeTruthy();
		expect(await readFile(result.artifacts!.transcript!, "utf8")).toBe("model failure transcript");
	});

	test("preserves the hard-ceiling max_turns as a distinct failure kind", async () => {
		const factory: RuntimeDriverFactory = async () => ({
			run: async () => ({ text: "", error: { kind: "max_turns", message: "Subagent exceeded the hard turn ceiling 6 (soft budget 2)" } }),
			async abort() {},
		});
		const result = await new SubagentManager({ cwd: "/repo", createDriver: factory }).spawn(PROFILE, "bounded task").wait();
		expect(result).toMatchObject({ status: "failed", error: { kind: "max_turns" } });
	});

	test("lands a soft-budget wrap-up as a completed partial carrying stoppedBy", async () => {
		const factory: RuntimeDriverFactory = async () => ({
			run: async () => ({ text: "best partial answer", stoppedBy: "turn_budget", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 9 } }),
			async abort() {},
		});
		const result = await new SubagentManager({ cwd: "/repo", createDriver: factory }).spawn({ ...PROFILE, maxTurns: 8 }, "bounded task").wait();
		expect(result).toMatchObject({ status: "completed", text: "best partial answer", stoppedBy: "turn_budget" });
		expect(result.error).toBeUndefined();
	});

	test("persists the soft-landing flag into the result artifact", async () => {
		const artifactsDir = await mkdtemp(join(tmpdir(), "subagent-budget-"));
		const factory: RuntimeDriverFactory = async () => ({ run: async () => ({ text: "partial", stoppedBy: "turn_budget" }), async abort() {} });
		const manager = new SubagentManager({ cwd: "/repo", artifactsDir, createDriver: factory });
		const result = await manager.spawn({ ...PROFILE, maxTurns: 4 }, "budget task").wait();
		expect(JSON.parse(await readFile(result.artifacts!.result!, "utf8"))).toMatchObject({ status: "completed", stoppedBy: "turn_budget" });
	});

	test("resolves a failed result when the artifacts directory is unusable", async () => {
		const dir = await mkdtemp(join(tmpdir(), "subagent-artifacts-fail-"));
		const blocker = join(dir, "file");
		await writeFile(blocker, "not a directory");
		const manager = new SubagentManager({ cwd: "/repo", artifactsDir: blocker, createDriver: async () => ({ run: async () => ({ text: "ok" }), async abort() {} }) });
		await expect(manager.spawn(PROFILE, "artifact task").wait()).resolves.toMatchObject({ status: "failed" });
	});

	test("converts driver creation failures into failed results", async () => {
		const manager = new SubagentManager({ cwd: "/repo", createDriver: async () => { throw new Error("model unavailable"); } });
		await expect(manager.spawn(PROFILE, "fail").wait()).resolves.toMatchObject({ status: "failed", error: { kind: "model", message: "model unavailable" } });
	});

	test("fails fast when an oracle override adds a dangerous tool", () => {
		const manager = new SubagentManager({ cwd: "/repo", createDriver: async () => ({ run: async () => ({ text: "ok" }), async abort() {} }) });
		const oracle = { ...PROFILE, name: "oracle" };

		expect(() => manager.spawn(oracle, "review", { overrides: { tools: ["read", "write"] } })).toThrow(/read-only.*write/i);
		expect(() => manager.spawn(oracle, "review", { overrides: { name: "worker", tools: ["read", "bash"] } })).toThrow(/read-only.*bash/i);
		expect(() => manager.spawn(oracle, "review", { overrides: { tools: ["read", "edit"] } })).toThrow(/read-only.*edit/i);
	});

	test("runs in a provisioned workspace and cleans it according to policy", async () => {
		const cleanup = vi.fn(async () => {});
		const prepare = vi.fn(async (id: string) => ({ cwd: `/isolated/${id}`, cleanup }));
		const manager = new SubagentManager({
			cwd: "/repo",
			workspaceProvider: { prepare },
			createDriver: async (request) => ({
				async run() {
					expect(request.cwd).toContain("/isolated/");
					return { text: "isolated" };
				},
				async abort() {},
			}),
		});
		const result = await manager.spawn(PROFILE, "work", { workspace: { mode: "worktree", retain: false } }).wait();
		expect(prepare).toHaveBeenCalledWith(expect.any(String), { mode: "worktree", retain: false }, "/repo");
		expect(cleanup).toHaveBeenCalledOnce();
		expect(result.workspace?.path).toContain("/isolated/");
	});

	test("abortAll waits until every handle reaches an aborted terminal state", async () => {
		const manager = new SubagentManager({ cwd: "/repo", maxConcurrent: 1, createDriver: async () => ({ run: () => new Promise(() => {}), async abort() {} }) });
		const one = manager.spawn(PROFILE, "one");
		const two = manager.spawn(PROFILE, "two");
		await manager.abortAll();
		expect(one.status).toBe("aborted");
		expect(two.status).toBe("aborted");
	});
});
