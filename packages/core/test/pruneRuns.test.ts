import { mkdtemp, mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { pruneSubagentRuns } from "../src/artifacts/pruneRuns.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeRun(dir: string, id: string, ageDays: number): Promise<void> {
	const runDir = join(dir, id);
	await mkdir(runDir, { recursive: true });
	await writeFile(join(runDir, "result.json"), "{}\n");
	const when = new Date(Date.now() - ageDays * DAY_MS);
	await utimes(runDir, when, when);
}

describe("pruneSubagentRuns", () => {
	test("returns an empty result for a missing bucket", async () => {
		await expect(pruneSubagentRuns(join(tmpdir(), "does-not-exist-xyz"))).resolves.toEqual({ scanned: 0, deleted: [] });
	});

	test("deletes runs older than retentionDays", async () => {
		const dir = await mkdtemp(join(tmpdir(), "prune-age-"));
		await makeRun(dir, "old", 20);
		await makeRun(dir, "recent", 1);

		const result = await pruneSubagentRuns(dir, { retentionDays: 14, maxRuns: 200 });
		expect(result.scanned).toBe(2);
		const remaining = (await readdir(dir)).sort();
		expect(remaining).toEqual(["recent"]);
	});

	test("never prunes by age when retentionDays is 0, but still enforces maxRuns", async () => {
		const dir = await mkdtemp(join(tmpdir(), "prune-max-"));
		await makeRun(dir, "a", 30);
		await makeRun(dir, "b", 20);
		await makeRun(dir, "c", 10);

		await pruneSubagentRuns(dir, { retentionDays: 0, maxRuns: 2 });
		const remaining = (await readdir(dir)).sort();
		expect(remaining).toEqual(["b", "c"]);
	});

	test("trims the oldest runs down to maxRuns after age pruning", async () => {
		const dir = await mkdtemp(join(tmpdir(), "prune-both-"));
		await makeRun(dir, "ancient", 40);
		await makeRun(dir, "mid", 5);
		await makeRun(dir, "newer", 2);
		await makeRun(dir, "newest", 1);

		await pruneSubagentRuns(dir, { retentionDays: 14, maxRuns: 2 });
		const remaining = (await readdir(dir)).sort();
		expect(remaining).toEqual(["newer", "newest"]);
	});

	test("ignores stray files in the bucket", async () => {
		const dir = await mkdtemp(join(tmpdir(), "prune-files-"));
		await writeFile(join(dir, "index.json"), "{}");
		await makeRun(dir, "run", 1);

		const result = await pruneSubagentRuns(dir, { retentionDays: 14 });
		expect(result.scanned).toBe(1);
		expect((await stat(join(dir, "index.json"))).isFile()).toBe(true);
	});
});
