/**
 * Exposes bundled role cards without coupling the runtime to presentation or
 * product-specific defaults. Hosts may load these profiles or replace them.
 */
import { fileURLToPath } from "node:url";
import { loadProfileFile, type SubagentProfile } from "pi-subagent-core";

export const builtInAgentNames = ["oracle", "oracle-plan", "worker", "scout", "reviewer"] as const;
export type BuiltInAgentName = typeof builtInAgentNames[number];

/** Return the installed markdown path for a bundled role card. */
export function getBuiltInAgentPath(name: BuiltInAgentName): string {
	return fileURLToPath(new URL(`../agents/${name}.md`, import.meta.url));
}

/** Load a bundled role card through the core profile parser. */
export function loadBuiltInAgent(name: BuiltInAgentName): Promise<SubagentProfile> {
	return loadProfileFile(getBuiltInAgentPath(name));
}
