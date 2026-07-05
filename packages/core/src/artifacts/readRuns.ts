import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SubagentResult } from "../types.ts";

export interface SubagentRunRecord {
	id: string;
	status: SubagentResult["status"] | "interrupted";
	dir: string;
	result?: SubagentResult;
	transcript?: string;
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function readSubagentRun(artifactsDir: string, id: string): Promise<SubagentRunRecord> {
	const dir = join(artifactsDir, id);
	const resultText = await readOptional(join(dir, "result.json"));
	if (!resultText) return { id, status: "interrupted", dir };
	const result = JSON.parse(resultText) as SubagentResult;
	const transcript = await readOptional(join(dir, "transcript.md"));
	return { id, status: result.status, dir, result, ...(transcript !== undefined ? { transcript } : {}) };
}

export async function listSubagentRuns(artifactsDir: string): Promise<SubagentRunRecord[]> {
	let entries;
	try {
		entries = await readdir(artifactsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	return Promise.all(ids.map((id) => readSubagentRun(artifactsDir, id)));
}
