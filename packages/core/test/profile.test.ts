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
			permission: { bash: { mode: "allowlist", allow: ["git status"] } },
			output: { kind: "text" },
			systemPrompt: "Review only the supplied evidence.",
		});
	});
});
