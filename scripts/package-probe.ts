import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadBuiltInAgent } from "@maynewong/pi-advisor";
import { RUNTIME_PROVIDER_API_VERSION, SubagentManager } from "@maynewong/pi-advisor-core";

// Loaded only by the package smoke test, through Pi's TypeScript loader.
export default async function packageProbe(pi: ExtensionAPI): Promise<void> {
	assert.equal(typeof SubagentManager, "function");
	assert.equal(RUNTIME_PROVIDER_API_VERSION, 1);
	for (const name of ["advisor", "search"] as const) {
		const profile = await loadBuiltInAgent(name);
		assert.equal(profile.name, name);
		assert.ok(profile.systemPrompt.length > 0);
	}
	pi.registerCommand("package-probe", { handler: async () => {} });
}
