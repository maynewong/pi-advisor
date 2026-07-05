import { access } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { builtInAgentNames, getBuiltInAgentPath, loadBuiltInAgent } from "../src/index.ts";

describe("built-in agents", () => {
	test("ships loadable markdown profiles for every declared role", async () => {
		const profiles = await Promise.all(builtInAgentNames.map(async (name) => {
			await access(getBuiltInAgentPath(name));
			return loadBuiltInAgent(name);
		}));

		expect(profiles.map((profile) => profile.name)).toEqual(builtInAgentNames);
		expect(profiles.every((profile) => profile.systemPrompt.length > 0)).toBe(true);
	});

	test("keeps mutation capability exclusive to the worker role", async () => {
		const profiles = await Promise.all(builtInAgentNames.map((name) => loadBuiltInAgent(name)));
		const worker = profiles.find((profile) => profile.name === "worker");
		const readOnly = profiles.filter((profile) => profile.name !== "worker");

		expect(worker?.tools).toEqual(expect.arrayContaining(["edit", "write"]));
		expect(readOnly.every((profile) => !profile.tools?.includes("edit") && !profile.tools?.includes("write"))).toBe(true);
	});
});
