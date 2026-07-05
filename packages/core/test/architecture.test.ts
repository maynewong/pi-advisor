import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

async function sourceFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? sourceFiles(join(root, entry.name)) : [join(root, entry.name)]));
	return nested.flat().filter((path) => path.endsWith(".ts"));
}

describe("core dependency direction", () => {
	test("does not name or import loop and sweep consumers", async () => {
		const root = join(import.meta.dirname, "../src");
		const files = await sourceFiles(root);
		const violations: string[] = [];
		for (const file of files) {
			const source = await readFile(file, "utf8");
			if (/pi[-_]?loop|pi[-_]?sweep|PiSweep|LoopEvidence/u.test(`${relative(root, file)}\n${source}`)) violations.push(relative(root, file));
		}
		expect(violations).toEqual([]);
	});

	test("does not depend on the UX package", async () => {
		const manifest = JSON.parse(await readFile(join(import.meta.dirname, "../package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		expect(manifest.dependencies).not.toHaveProperty("pi-subagent-ux");
	});
});
