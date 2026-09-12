import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrCliAdapter } from "./adapter.ts";
import { loadHerdrAdvisorConfig } from "./config.ts";
import { createHerdrAdvisorProvider, exampleHerdrTargets } from "./provider.ts";
import { registerRuntimeProvider } from "pi-advisor-core";

/** Registers the Grok/Codex local-pane adapter. Load with `pi -e <this file>` from a Herdr-hosted Pi pane. */
export default function herdrAdvisorExample(pi: ExtensionAPI): void {
	const targets = new Map(exampleHerdrTargets.map((target) => [target.id, target]));
	for (const target of loadHerdrAdvisorConfig()) targets.set(target.id, target);
	registerRuntimeProvider(pi.events, createHerdrAdvisorProvider({
		adapter: createHerdrCliAdapter(),
		targets: [...targets.values()],
	}));
}
