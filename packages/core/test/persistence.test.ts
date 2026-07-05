import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { listSubagentRuns, readSubagentRun } from "../src/artifacts/readRuns.ts";
import { SubagentManager } from "../src/runtime/SubagentManager.ts";

const PROFILE = { name: "reader", description: "reads", systemPrompt: "read" };

describe("artifact run history", () => {
	test("lists and reads completed runs after the manager is gone", async () => {
		const artifactsDir = await mkdtemp(join(tmpdir(), "subagent-history-"));
		const manager = new SubagentManager({ cwd: "/repo", artifactsDir, createDriver: async () => ({ run: async () => ({ text: "remember me", transcript: "transcript" }), async abort() {} }) });
		const handle = manager.spawn(PROFILE, "remember");
		await handle.wait();

		await expect(listSubagentRuns(artifactsDir)).resolves.toEqual([expect.objectContaining({ id: handle.id, status: "completed" })]);
		await expect(readSubagentRun(artifactsDir, handle.id)).resolves.toMatchObject({ result: { text: "remember me" }, transcript: "transcript" });
	});

	test("marks a run without result.json as interrupted", async () => {
		const artifactsDir = await mkdtemp(join(tmpdir(), "subagent-history-"));
		const runDir = join(artifactsDir, "stale-run");
		await mkdir(runDir);
		await writeFile(join(runDir, "profile.json"), "{}\n");
		await expect(listSubagentRuns(artifactsDir)).resolves.toEqual([{ id: "stale-run", status: "interrupted", dir: runDir }]);
	});
});
