import { execFile } from "node:child_process";

export interface HerdrCliResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface HerdrCli {
	run(args: string[], options?: { signal?: AbortSignal }): Promise<HerdrCliResult>;
}

/** Spawn `herdr` without a shell so the consultation text stays one argv, not a quoted command string. */
export function createExecFileCli(command = "herdr", cwd?: string): HerdrCli {
	return {
		run(args, options) {
			return new Promise((resolve, reject) => {
				execFile(command, args, {
					encoding: "utf8",
					cwd,
					maxBuffer: 8 * 1024 * 1024,
					env: process.env,
					signal: options?.signal,
				}, (error, stdout, stderr) => {
					if (error && error.name === "AbortError") {
						reject(error);
						return;
					}
					const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
					resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
				});
			});
		},
	};
}

function formatArgs(args: string[]): string {
	return args.map((arg) => arg.length > 80 ? `${arg.slice(0, 32)}…(${arg.length} bytes)` : arg).join(" ");
}

function herdrErrorMessage(text: string): string | undefined {
	try {
		const body = JSON.parse(text) as Record<string, unknown>;
		if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
		const error = body.error;
		if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
		const message = (error as Record<string, unknown>).message;
		return typeof message === "string" && message.trim() ? message.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Commands such as `agent read` intentionally print transcript text, not an API JSON envelope. */
export async function herdrTextResult(cli: HerdrCli, args: string[], signal?: AbortSignal, commandName = "herdr"): Promise<string> {
	const { stdout, stderr, code } = await cli.run(args, { signal });
	if (code === 0) return stdout;
	const text = stderr.trim() || stdout.trim();
	const invoked = `${commandName} ${formatArgs(args)}`;
	throw new Error(herdrErrorMessage(text) ?? (text ? `${invoked} failed: ${text}` : `${invoked} failed with exit ${code}`));
}

export async function herdrResult(cli: HerdrCli, args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
	const { stdout, stderr, code } = await cli.run(args, { signal });
	const text = stdout.trim() || stderr.trim();
	const invoked = `herdr ${formatArgs(args)}`;
	if (!text) {
		if (code === 0) return {};
		throw new Error(`${invoked} failed with exit ${code} and no JSON`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${invoked} returned non-JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${invoked} returned a non-object JSON value`);
	}
	const body = parsed as Record<string, unknown>;
	if (body.error && typeof body.error === "object" && !Array.isArray(body.error)) {
		const error = body.error as Record<string, unknown>;
		throw new Error(typeof error.message === "string" && error.message.trim() ? error.message : `${invoked} failed`);
	}
	if (code !== 0) throw new Error(`${invoked} failed with exit ${code}`);
	const result = body.result;
	return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : body;
}
