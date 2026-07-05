import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildContextPacket } from "../src/context/buildContext.ts";

describe("buildContextPacket", () => {
	test("packages selected files, diff, and text with disclosure", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "subagent-context-"));
		await mkdir(join(cwd, "src"));
		await writeFile(join(cwd, "src/a.ts"), "export const value = 1;\n");
		const result = await buildContextPacket({ files: ["src/a.ts"], diff: "diff --git a/a b/a", text: ["Focus on correctness."] }, { cwd });

		expect(result.text).toContain("src/a.ts");
		expect(result.text).toContain("Focus on correctness.");
		expect(result.sources).toEqual(["file:src/a.ts", "diff:inline", "text:1"]);
	});

	test("rejects selected files outside cwd", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "subagent-context-"));
		await expect(buildContextPacket({ files: ["../secret"] }, { cwd })).rejects.toThrow("outside cwd");
	});
});
