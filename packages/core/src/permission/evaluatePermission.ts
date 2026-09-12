import { isAbsolute, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import type { PermissionPolicy } from "../types.ts";

export interface PermissionDecision {
	allowed: boolean;
	reason?: string;
}

function blocked(reason: string): PermissionDecision {
	return { allowed: false, reason };
}

/** Shell control/metacharacters that turn a single command into a compound one. */
const SHELL_CONTROL = /[;|&<>\n`]|\$\(/;
/** Separators used to split a compound command into individually evaluable segments. */
const SEGMENT_SEPARATORS = /&&|\|\||[;|&\n]/;

/** True when the command chains, pipes, redirects, or substitutes — i.e. is not a single simple command. */
export function hasShellControl(command: string): boolean {
	return SHELL_CONTROL.test(command);
}

function tokenize(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * Prefix-token match for bash commands. Patterns are matched on whitespace-normalized
 * token boundaries rather than as path globs. A trailing `*` means "these leading tokens,
 * followed by any additional arguments"; without it the command must match token-for-token.
 * `git diff*` matches `git diff --stat` but not `git difftool` and not `git diff && curl x`.
 */
export function matchBashCommand(command: string, pattern: string): boolean {
	const trimmed = pattern.trim();
	const wildcard = trimmed.endsWith("*");
	const patternTokens = tokenize(wildcard ? trimmed.slice(0, -1) : trimmed);
	const commandTokens = tokenize(command);
	if (wildcard) {
		if (commandTokens.length < patternTokens.length) return false;
	} else if (commandTokens.length !== patternTokens.length) {
		return false;
	}
	return patternTokens.every((token, index) => commandTokens[index] === token);
}

function commandSegments(command: string): string[] {
	return command.split(SEGMENT_SEPARATORS).map((part) => part.trim()).filter(Boolean);
}

/** Deny patterns are matched against the whole command and each chained segment. */
function deniedByBash(patterns: string[] | undefined, command: string): boolean {
	if (!patterns?.length) return false;
	const candidates = [command, ...commandSegments(command)];
	return patterns.some((pattern) => candidates.some((candidate) => matchBashCommand(candidate, pattern)));
}

export function evaluatePermission(policy: PermissionPolicy | undefined, tool: string, args: Record<string, unknown>, cwd: string): PermissionDecision {
	if (!policy) return { allowed: true };
	if (tool === "edit" || tool === "write") {
		// The cwd boundary is enforced unconditionally: a profile that omits `write` still may not escape cwd.
		const rawPath = typeof args.path === "string" ? args.path : "";
		const path = relative(cwd, resolve(cwd, rawPath));
		if (!rawPath || path.startsWith("..") || isAbsolute(path)) return blocked(`Write path is outside cwd: ${rawPath}`);
		if (policy.write) {
			if (policy.write.deny?.some((pattern) => minimatch(path, pattern))) return blocked(`Write path is denied: ${path}`);
			if (!policy.write.allow.some((pattern) => minimatch(path, pattern))) return blocked(`Write path is outside the allowed scope: ${path}`);
		}
	}
	if (tool === "bash" && policy.bash) {
		const command = typeof args.command === "string" ? args.command.trim() : "";
		if (policy.bash.mode === "off") return blocked("Bash is disabled by policy");
		// Deny patterns apply in every mode, against the whole command and each chained segment.
		if (deniedByBash(policy.bash.deny, command)) return blocked(`Command is denied: ${command}`);
		if (policy.bash.mode === "allowlist") {
			if (hasShellControl(command)) return blocked(`Command is not allowlisted: compound commands are not allowlisted: ${command}`);
			if (!policy.bash.allow?.some((pattern) => matchBashCommand(command, pattern))) return blocked(`Command is not allowlisted: ${command}`);
		}
	}
	return { allowed: true };
}
