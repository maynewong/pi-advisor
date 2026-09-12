import assert from "node:assert/strict";
import { join } from "node:path";
import { createEventBus, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();
const plugin = join(cwd, "node_modules/@maynewong/pi-advisor");
const events = createEventBus();
const providers = [];
events.on("pi-advisor:runtime-provider-register", (provider) => providers.push(provider.id));
const loader = new DefaultResourceLoader({
	cwd,
	agentDir: process.env.PI_CODING_AGENT_DIR,
	settingsManager: SettingsManager.inMemory({ packages: [plugin] }),
	eventBus: events,
	additionalExtensionPaths: [
		join(plugin, "examples/runtime-providers/herdr/extension.ts"),
		join(cwd, "package-probe.ts"),
	],
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await loader.reload();
const { extensions, errors } = loader.getExtensions();
assert.deepEqual(errors, [], "Packed extensions must load without errors");
const main = extensions.filter((extension) => extension.commands.has("advisor"));
assert.equal(main.length, 1, "The package manifest must load exactly one Advisor extension");
for (const command of ["mode", "subagents", "subagent"]) assert.ok(main[0].commands.has(command));
for (const tool of ["advisor", "search", "subagent", "subagent_result", "subagent_send"]) assert.ok(main[0].tools.has(tool));
assert.ok(extensions.some((extension) => extension.commands.has("package-probe")), "Public exports and role cards must load");
assert.deepEqual(providers, ["herdr-advisor"]);
console.log("Clean install: Pi manifest, commands, tools, role cards, public exports, and Herdr registration passed.");
