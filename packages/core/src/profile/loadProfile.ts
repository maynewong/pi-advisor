import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { SubagentProfile } from "../types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function splitFrontmatter(source: string): { data: Record<string, unknown>; body: string } {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
	if (!match) return { data: {}, body: source.trim() };
	const parsed = parse(match[1]);
	return { data: parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}, body: match[2].trim() };
}

/** Load one markdown role card while preserving the official subagent frontmatter shape. */
export async function loadProfileFile(path: string): Promise<SubagentProfile> {
	const { data, body } = splitFrontmatter(await readFile(path, "utf8"));
	const name = typeof data.name === "string" ? data.name.trim() : "";
	if (!name) throw new Error(`Profile ${path} is missing a name`);
	return {
		name,
		description: typeof data.description === "string" ? data.description.trim() : "",
		systemPrompt: body,
		...(typeof data.model === "string" ? { model: data.model } : {}),
		...(typeof data.thinkingLevel === "string" ? { thinkingLevel: data.thinkingLevel as SubagentProfile["thinkingLevel"] } : {}),
		...(Array.isArray(data.tools) ? { tools: data.tools.filter((value): value is string => typeof value === "string") } : {}),
		...(typeof data.contextMode === "string" ? { contextMode: data.contextMode as SubagentProfile["contextMode"] } : {}),
		...(Array.isArray(data.skills) ? { skills: data.skills.filter((value): value is string => typeof value === "string") } : {}),
		...(isRecord(data.permission) ? { permission: data.permission as SubagentProfile["permission"] } : {}),
		...(isRecord(data.output) && (data.output.kind === "text" || data.output.kind === "schema") ? { output: data.output as SubagentProfile["output"] } : {}),
		...(typeof data.maxTurns === "number" ? { maxTurns: data.maxTurns } : {}),
		...(typeof data.timeoutMs === "number" ? { timeoutMs: data.timeoutMs } : {}),
	};
}
