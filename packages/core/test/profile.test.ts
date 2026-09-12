import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadProfileFile } from "../src/profile/loadProfile.ts";

describe("loadProfileFile", () => {
	test("loads compatible YAML frontmatter and markdown body", async () => {
		const dir = await mkdtemp(join(tmpdir(), "subagent-profile-"));
		const file = join(dir, "reviewer.md");
		await writeFile(file, [
			"---",
			"name: reviewer",
			"description: Reviews a change",
			"tools: [read, grep]",
			"model: fast",
			"contextMode: selected",
			"maxTurns: 4",
			"contextMaxBytes: 64000",
			"permission:",
			"  bash:",
			"    mode: allowlist",
			"    allow: [git status]",
			"output:",
			"  kind: text",
			"---",
			"Review only the supplied evidence.",
		].join("\n"));

		await expect(loadProfileFile(file)).resolves.toMatchObject({
			name: "reviewer",
			description: "Reviews a change",
			tools: ["read", "grep"],
			model: "fast",
			contextMode: "selected",
			maxTurns: 4,
			contextMaxBytes: 64000,
			permission: { bash: { mode: "allowlist", allow: ["git status"] } },
			output: { kind: "text" },
			systemPrompt: "Review only the supplied evidence.",
		});
	});

	test("rejects unknown permission keys such as the removed network switch", async () => {
		const dir = await mkdtemp(join(tmpdir(), "subagent-profile-net-"));
		const file = join(dir, "bad.md");
		await writeFile(file, ["---", "name: bad", "permission:", "  network: false", "---", "body"].join("\n"));

		await expect(loadProfileFile(file)).rejects.toThrow(/unsupported permission key: network/i);
	});

	test("rejects unknown nested write and bash permission keys", async () => {
		const dir = await mkdtemp(join(tmpdir(), "subagent-profile-nested-"));
		const file = join(dir, "bad.md");
		await writeFile(file, ["---", "name: bad", "permission:", "  bash:", "    mode: off", "    extra: 1", "---", "body"].join("\n"));

		await expect(loadProfileFile(file)).rejects.toThrow(/unsupported permission.bash key: extra/i);
	});

	test("drops a schema output marker with no inline schema for the host to fill in", async () => {
		const dir = await mkdtemp(join(tmpdir(), "subagent-profile-marker-"));
		const file = join(dir, "marker.md");
		await writeFile(file, ["---", "name: marker", "output:", "  kind: schema", "---", "body"].join("\n"));

		await expect(loadProfileFile(file)).resolves.toMatchObject({ name: "marker" });
		const profile = await loadProfileFile(file);
		expect(profile.output).toBeUndefined();
	});
});
