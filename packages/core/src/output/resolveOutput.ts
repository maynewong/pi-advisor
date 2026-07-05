import { Compile } from "typebox/compile";
import type { OutputContract } from "../types.ts";

export interface ResolvedOutput {
	output?: unknown;
	error?: { message: string; kind: "protocol" };
}

function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
	const object = text.indexOf("{") >= 0 ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : undefined;
	const array = text.indexOf("[") >= 0 ? text.slice(text.indexOf("["), text.lastIndexOf("]") + 1) : undefined;
	for (const candidate of [fenced, text.trim(), object, array]) {
		if (!candidate) continue;
		try {
			return JSON.parse(candidate);
		} catch {
			// Try the next extraction shape.
		}
	}
	return undefined;
}

export function resolveOutput(contract: OutputContract | undefined, text: string, submitted?: unknown): ResolvedOutput {
	if (!contract || contract.kind === "text") return { output: text };
	const validator = Compile(contract.schema);
	if (submitted !== undefined && validator.Check(submitted)) return { output: submitted };
	const parsed = extractJson(text);
	if (parsed !== undefined && validator.Check(parsed)) return { output: parsed };
	return { error: { kind: "protocol", message: "Subagent did not submit output matching the schema contract" } };
}
