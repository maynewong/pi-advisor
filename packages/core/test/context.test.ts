import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { buildContextPacket } from "../src/context/buildContext.ts";

const execFile = promisify(execFileCallback);

describe("buildContextPacket", () => {
	test("packages selected files, diff, and text with disclosure", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "subagent-context-"));
		await mkdir(join(cwd, "src"));
		await writeFile(join(cwd, "src/a.ts"), "export const value = 1;\n");
		const result = await buildContextPacket({ files: ["src/a.ts"], diff: "diff --git a/a b/a", text: ["Focus on correctness."] }, { cwd });

		expect(result.text).toContain("## File scope: src/a.ts");
		expect(result.text).not.toContain("export const value = 1");
		expect(result.text).toContain("Focus on correctness.");
		expect(result.sources).toEqual(["file:src/a.ts", "diff:inline", "text:1"]);
	});

	test("turns selected paths into scope guidance instead of inlining file contents", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "subagent-context-"));
		await mkdir(join(cwd, "src"));
		await writeFile(join(cwd, "src", "a.ts"), "export const value = 1;\n");

		const result = await buildContextPacket({ files: ["src", "src/a.ts"] }, { cwd });

		expect(result.text).toContain("## Directory scope: src");
		expect(result.text).toContain("Use find, grep, or ls");
		expect(result.text).toContain("## File scope: src/a.ts");
		expect(result.text).not.toContain("export const value = 1");
		expect(result.sources).toEqual(["directory:src", "file:src/a.ts"]);
		expect(result.truncated).toEqual([]);
	});

	test("labels the selected cwd itself as dot", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "subagent-context-"));
		const result = await buildContextPacket({ files: ["."] }, { cwd });

		expect(result.text).toContain("## Directory scope: .");
		expect(result.sources).toEqual(["directory:."]);
	});

	test("caps selected-file context by total UTF-8 bytes and discloses skipped content", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "subagent-context-"));
		await writeFile(join(cwd, "a.txt"), "a".repeat(80));
		await writeFile(join(cwd, "b.txt"), "b".repeat(80));

		const result = await buildContextPacket({ files: ["a.txt", "b.txt"] }, { cwd, maxTotalBytes: 50 });

		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(50);
		expect(result.text).toContain("## File scope: a.txt");
		expect(result.text).not.toContain("## File scope: b.txt");
		expect(result.text).not.toContain("a".repeat(80));
		expect(result.sources).toEqual(["file:a.txt"]);
		expect(result.truncated).toEqual(["file:a.txt", "file:b.txt"]);
	});

	test("streams and truncates a large git diff rather than overflowing execFile's buffer", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "subagent-context-"));
		await execFile("git", ["init", "--quiet"], { cwd });
		await execFile("git", ["config", "user.email", "test@example.com"], { cwd });
		await execFile("git", ["config", "user.name", "Test"], { cwd });
		await writeFile(join(cwd, "large.txt"), "initial\n");
		await execFile("git", ["add", "large.txt"], { cwd });
		await execFile("git", ["commit", "--quiet", "-m", "initial"], { cwd });
		await writeFile(join(cwd, "large.txt"), "x".repeat(2_100_000));

		const result = await buildContextPacket({ diff: { base: "HEAD" } }, { cwd, maxTotalBytes: 512 });

		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(512);
		expect(result.sources).toEqual(["diff:HEAD"]);
		expect(result.truncated).toEqual(["diff:HEAD"]);
	});

	test("rejects selected files outside cwd", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "subagent-context-"));
		await expect(buildContextPacket({ files: ["../secret"] }, { cwd })).rejects.toThrow("outside cwd");
	});
});
