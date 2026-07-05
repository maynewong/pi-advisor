import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContextInput } from "../types.ts";

const execFileAsync = promisify(execFile);

export interface ContextPacket {
	text: string;
	sources: string[];
	truncated: string[];
}

export interface BuildContextOptions {
	cwd: string;
	maxFileBytes?: number;
}

function resolveInside(cwd: string, path: string): { absolute: string; display: string } {
	const absolute = resolve(cwd, path);
	const display = relative(cwd, absolute);
	if (display.startsWith("..") || isAbsolute(display)) throw new Error(`Context file is outside cwd: ${path}`);
	return { absolute, display };
}

export async function buildContextPacket(input: ContextInput | undefined, options: BuildContextOptions): Promise<ContextPacket> {
	if (!input) return { text: "", sources: [], truncated: [] };
	const sections: string[] = [];
	const sources: string[] = [];
	const truncated: string[] = [];
	const maxFileBytes = options.maxFileBytes ?? 128_000;
	for (const path of input.files ?? []) {
		const { absolute, display } = resolveInside(options.cwd, path);
		const content = await readFile(absolute, "utf8");
		const value = Buffer.byteLength(content) > maxFileBytes ? Buffer.from(content).subarray(0, maxFileBytes).toString("utf8") : content;
		if (value.length !== content.length) truncated.push(`file:${display}`);
		sections.push(`## File: ${display}\n\n${value}`);
		sources.push(`file:${display}`);
	}
	if (typeof input.diff === "string") {
		sections.push(`## Diff\n\n${input.diff}`);
		sources.push("diff:inline");
	} else if (input.diff) {
		const { stdout } = await execFileAsync("git", ["diff", input.diff.base], { cwd: options.cwd, maxBuffer: 2_000_000 });
		sections.push(`## Diff from ${input.diff.base}\n\n${stdout}`);
		sources.push(`diff:${input.diff.base}`);
	}
	(input.text ?? []).forEach((text, index) => {
		sections.push(`## Context ${index + 1}\n\n${text}`);
		sources.push(`text:${index + 1}`);
	});
	if (input.forkFrom) sources.push(`fork:${input.forkFrom.sessionFile}${input.forkFrom.entryId ? `#${input.forkFrom.entryId}` : ""}`);
	return { text: sections.join("\n\n"), sources, truncated };
}
