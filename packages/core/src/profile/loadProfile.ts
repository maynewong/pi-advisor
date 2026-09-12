import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { SubagentProfile } from "../types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PERMISSION_KEYS = new Set(["write", "bash", "onViolation", "escalationTimeoutMs"]);
const WRITE_KEYS = new Set(["allow", "deny"]);
const BASH_KEYS = new Set(["allow", "deny", "mode"]);

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, path: string, scope: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`Profile ${path} has an unsupported ${scope} key: ${key}`);
	}
}

/** Reject unknown permission keys so an unenforced switch (e.g. `network`) fails loudly instead of silently. */
function validatePermission(permission: Record<string, unknown>, path: string): void {
	assertKnownKeys(permission, PERMISSION_KEYS, path, "permission");
	if (isRecord(permission.write)) assertKnownKeys(permission.write, WRITE_KEYS, path, "permission.write");
	if (isRecord(permission.bash)) assertKnownKeys(permission.bash, BASH_KEYS, path, "permission.bash");
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
	if (isRecord(data.permission)) validatePermission(data.permission, path);
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
		// A `schema` marker with no inline schema is a placeholder the host fills in (e.g. loadBuiltInAgent); ignore it here.
		...(isRecord(data.output) && data.output.kind === "text" ? { output: { kind: "text" } } : {}),
		...(isRecord(data.output) && data.output.kind === "schema" && isRecord(data.output.schema) ? { output: data.output as SubagentProfile["output"] } : {}),
		...(typeof data.maxTurns === "number" ? { maxTurns: data.maxTurns } : {}),
		...(typeof data.contextMaxBytes === "number" ? { contextMaxBytes: data.contextMaxBytes } : {}),
		...(typeof data.timeoutMs === "number" ? { timeoutMs: data.timeoutMs } : {}),
	};
}
