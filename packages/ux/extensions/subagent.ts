/**
 * Minimal pi extension exposing the generic subagent runtime as a `subagent`
 * tool plus a `/subagents` command. Loads bundled role cards (oracle / worker /
 * scout / reviewer) or any project-local profile markdown passed by path.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	SubagentManager,
	loadProfileFile,
	type SubagentEvent,
	type SubagentHandle,
	type SubagentProfile,
} from "pi-subagent-core";
import { builtInAgentNames, loadBuiltInAgent, type BuiltInAgentName } from "../src/index.ts";

const parameters = Type.Object({
	agent: Type.String({
		description: `Agent to run: one of ${builtInAgentNames.join(", ")}, or a path to a profile .md file`,
	}),
	task: Type.String({ description: "The task for the subagent" }),
	files: Type.Optional(Type.Array(Type.String(), {
		description: "Optional files to inject into the subagent context packet",
	})),
});

function isBuiltIn(name: string): name is BuiltInAgentName {
	return (builtInAgentNames as readonly string[]).includes(name);
}

function eventLine(event: SubagentEvent): string {
	switch (event.type) {
		case "tool_call": return `→ ${event.name} ${event.argsPreview.slice(0, 80)}`;
		case "tool_result": return `← ${event.name} ${event.ok ? "ok" : "error"}`;
		case "permission_blocked": return `⛔ ${event.tool}: ${event.reason}`;
		case "turn": return `turn ${event.index}`;
		case "failed": return `failed: ${event.error}`;
		default: return event.type;
	}
}

export default function subagentExtension(pi: ExtensionAPI) {
	let manager: SubagentManager | undefined;
	const runs: SubagentHandle[] = [];

	const getManager = (ctx: ExtensionContext): SubagentManager => {
		manager ??= new SubagentManager({
			cwd: ctx.cwd,
			artifactsDir: `${ctx.cwd}/.pi/subagent-runs`,
		});
		return manager;
	};

	pi.on("session_shutdown", async () => {
		await manager?.abortAll();
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run a task in an isolated child agent and return its result. " +
			`Available agents: ${builtInAgentNames.join(", ")}, or pass a profile .md path. ` +
			"Use for reconnaissance, second opinions, reviews, and scoped implementation.",
		parameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const profile: SubagentProfile = isBuiltIn(params.agent)
				? await loadBuiltInAgent(params.agent)
				: await loadProfileFile(params.agent);
			const handle = getManager(ctx).spawn(profile, params.task, {
				...(params.files?.length ? { context: { files: params.files } } : {}),
				...(signal ? { signal } : {}),
				// Child inherits the parent session's current model unless the card pins one.
				...(ctx.model && !profile.model ? { overrides: { model: ctx.model } } : {}),
			});
			runs.push(handle);
			const recent: string[] = [];
			handle.subscribe((event) => {
				recent.push(eventLine(event));
				if (recent.length > 8) recent.shift();
				onUpdate?.({
					content: [{ type: "text", text: recent.join("\n") }],
					details: { agent: profile.name, status: handle.status, usage: handle.usage },
				});
			});
			const result = await handle.wait();
			const summary = [
				`agent: ${profile.name} · status: ${result.status} · turns: ${result.usage.turns} · cost: $${result.usage.cost.toFixed(4)}`,
				result.disclosure.filesRead.length ? `read: ${result.disclosure.filesRead.join(", ")}` : "",
				result.disclosure.filesModified.length ? `modified: ${result.disclosure.filesModified.join(", ")}` : "",
				result.error ? `error(${result.error.kind}): ${result.error.message}` : "",
				"",
				result.output !== undefined && typeof result.output !== "string"
					? JSON.stringify(result.output, null, 2)
					: result.text,
			].filter((line) => line !== "").join("\n");
			return {
				content: [{ type: "text", text: summary }],
				details: { agent: profile.name, status: result.status, usage: result.usage, artifacts: result.artifacts },
				isError: result.status !== "completed",
			};
		},
	});

	pi.registerCommand("subagents", {
		description: "List subagent runs in this session",
		handler: async (_args, ctx) => {
			const lines = runs.length
				? runs.map((run) => `${run.profile.name}  ${run.status}  turns=${run.usage.turns}  $${run.usage.cost.toFixed(4)}`)
				: ["No subagent runs yet."];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
