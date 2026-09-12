import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ContextInput } from "../types.ts";

/** Aggregate ceiling prevents a large diff or text packet from bloating a child prompt. */
export const DEFAULT_MAX_CONTEXT_BYTES = 128_000;

export interface ContextPacket {
	text: string;
	sources: string[];
	truncated: string[];
}

export interface BuildContextOptions {
	cwd: string;
	maxTotalBytes?: number;
}

function resolveInside(cwd: string, path: string): { absolute: string; display: string } {
	const absolute = resolve(cwd, path);
	const relativePath = relative(cwd, absolute);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`Context file is outside cwd: ${path}`);
	return { absolute, display: relativePath || "." };
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Truncate on a UTF-8 character boundary so context packets never contain malformed text. */
function truncateUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
	return buffer.subarray(0, end).toString("utf8");
}

/**
 * Read only the prefix needed for a context packet. `execFile` buffers all output before
 * returning, so a large working-tree diff could fail on its `maxBuffer` before packet
 * truncation had a chance to apply.
 */
async function readGitDiff(cwd: string, base: string, maxBytes: number): Promise<{ stdout: string; truncated: boolean }> {
	const captureLimit = Math.max(0, maxBytes) + 4; // Keep enough look-ahead to preserve a UTF-8 boundary.
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["diff", base], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const stderr: Buffer[] = [];
		let captured = 0;
		let truncated = false;
		let spawnError: Error | undefined;

		child.stdout.on("data", (chunk: Buffer) => {
			const remaining = captureLimit - captured;
			if (remaining > 0) {
				const value = chunk.subarray(0, remaining);
				chunks.push(value);
				captured += value.length;
			}
			if (chunk.length > remaining || captured >= captureLimit) {
				truncated = true;
				child.kill();
			}
		});
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", (error) => { spawnError = error; });
		child.once("close", (code) => {
			if (spawnError) {
				reject(spawnError);
				return;
			}
			if (!truncated && code !== 0) {
				reject(new Error(`git diff ${base} failed: ${Buffer.concat(stderr).toString("utf8").trim() || `exit ${code}`}`));
				return;
			}
			const output = Buffer.concat(chunks);
			resolve({ stdout: output.length > maxBytes ? truncateUtf8(output.toString("utf8"), maxBytes) : output.toString("utf8"), truncated });
		});
	});
}

export async function buildContextPacket(input: ContextInput | undefined, options: BuildContextOptions): Promise<ContextPacket> {
	if (!input) return { text: "", sources: [], truncated: [] };
	const sections: string[] = [];
	const sources: string[] = [];
	const truncated: string[] = [];
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
	let usedBytes = 0;

	const append = (title: string, content: string, source: string, truncationKey?: string): void => {
		const prefix = `${sections.length > 0 ? "\n\n" : ""}## ${title}\n\n`;
		const available = maxTotalBytes - usedBytes - byteLength(prefix);
		if (available <= 0) {
			if (truncationKey) truncated.push(truncationKey);
			return;
		}
		const value = truncateUtf8(content, available);
		if (value.length < content.length && truncationKey) truncated.push(truncationKey);
		sections.push(`${prefix}${value}`);
		usedBytes += byteLength(prefix) + byteLength(value);
		sources.push(source);
	};

	for (const path of input.files ?? []) {
		const { absolute, display } = resolveInside(options.cwd, path);
		const stats = await stat(absolute);
		if (stats.isDirectory()) {
			append(
				`Directory scope: ${display}`,
				"This directory was supplied as scope, not as file content. Use find, grep, or ls to locate the smallest relevant files before reading them.",
				`directory:${display}`,
				`directory:${display}`,
			);
			continue;
		}
		append(
			`File scope: ${display}`,
			"This file was supplied as scope, not as file content. Read it if needed.",
			`file:${display}`,
			`file:${display}`,
		);
	}
	if (typeof input.diff === "string") {
		append("Diff", input.diff, "diff:inline", "diff:inline");
	} else if (input.diff) {
		const diff = await readGitDiff(options.cwd, input.diff.base, maxTotalBytes);
		append(`Diff from ${input.diff.base}`, diff.stdout, `diff:${input.diff.base}`, `diff:${input.diff.base}`);
		if (diff.truncated) truncated.push(`diff:${input.diff.base}`);
	}
	(input.text ?? []).forEach((text, index) => append(`Context ${index + 1}`, text, `text:${index + 1}`, `text:${index + 1}`));
	if (input.forkFrom) sources.push(`fork:${input.forkFrom.sessionFile}${input.forkFrom.entryId ? `#${input.forkFrom.entryId}` : ""}`);
	return { text: sections.join(""), sources, truncated: [...new Set(truncated)] };
}
