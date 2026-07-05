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

export function evaluatePermission(policy: PermissionPolicy | undefined, tool: string, args: Record<string, unknown>, cwd: string): PermissionDecision {
	if (!policy) return { allowed: true };
	if ((tool === "edit" || tool === "write") && policy.write) {
		const rawPath = typeof args.path === "string" ? args.path : "";
		const path = relative(cwd, resolve(cwd, rawPath));
		if (!rawPath || path.startsWith("..") || isAbsolute(path)) return blocked(`Write path is outside cwd: ${rawPath}`);
		if (policy.write.deny?.some((pattern) => minimatch(path, pattern))) return blocked(`Write path is denied: ${path}`);
		if (!policy.write.allow.some((pattern) => minimatch(path, pattern))) return blocked(`Write path is outside the allowed scope: ${path}`);
	}
	if (tool === "bash" && policy.bash) {
		const command = typeof args.command === "string" ? args.command.trim() : "";
		if (policy.bash.mode === "off") return blocked("Bash is disabled by policy");
		if (policy.bash.deny?.some((pattern) => minimatch(command, pattern))) return blocked(`Command is denied: ${command}`);
		if (policy.bash.mode === "allowlist" && !policy.bash.allow?.some((pattern) => minimatch(command, pattern))) {
			return blocked(`Command is not allowlisted: ${command}`);
		}
	}
	return { allowed: true };
}
