/**
 * pi extension exposing the generic subagent runtime as a `subagent` tool
 * plus a `/subagents` command, with a rich TUI display modeled on the
 * Amp / Claude Code subagent UIs: a live "N subagents running" overview
 * widget, a compact renderCall line, and a renderResult view that shows
 * milestones/activity while running and a full markdown report when done.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	SubagentManager,
	loadProfileFile,
	type SubagentEvent,
	type SubagentHandle,
	type SubagentProfile,
	type SubagentStatus,
	type UsageSnapshot,
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

/** Structured details streamed via onUpdate and returned in the final tool result. */
interface RunDetails {
	agent: string;
	task: string;
	model?: string;
	status: SubagentStatus;
	usage: UsageSnapshot;
	/** Major-progress notes surfaced by the subagent (and blocked-permission notices). */
	milestones: string[];
	/** Rolling window of recent low-level activity lines. */
	activity: string[];
	filesRead: string[];
	filesModified: string[];
	error?: string;
	finalText?: string;
}

const ACTIVITY_LIMIT = 6;
const COLLAPSED_LINE_LIMIT = 6;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageSnapshot, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function activityLine(event: SubagentEvent): string | undefined {
	switch (event.type) {
		case "tool_call":
			return `→ ${event.name} ${event.argsPreview.slice(0, 60)}`;
		case "tool_result":
			return event.ok ? undefined : `← ${event.name} ${event.summary.slice(0, 60)}`;
		case "turn":
			return `turn ${event.index}`;
		default:
			return undefined;
	}
}

function resolveModel(profile: SubagentProfile, usage: UsageSnapshot, ctx: ExtensionContext): string | undefined {
	if (profile.model) return typeof profile.model === "string" ? profile.model : profile.model.id;
	if (usage.model) return usage.model;
	return ctx.model?.id;
}

function statusWord(status: SubagentStatus): string {
	switch (status) {
		case "waiting_permission": return "waiting for permission";
		case "queued": return "queued";
		case "running": return "running";
		case "completed": return "completed";
		case "failed": return "failed";
		case "aborted": return "aborted";
		case "timeout": return "timed out";
		default: return status;
	}
}

function statusIcon(status: SubagentStatus, theme: Theme): string {
	switch (status) {
		case "running":
		case "queued":
			return theme.fg("warning", "◐");
		case "waiting_permission":
			return theme.fg("warning", "⏸");
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
		case "timeout":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("muted", "⊘");
		default:
			return theme.fg("muted", "?");
	}
}

/** Overview lines shown above the editor while any subagent runs are active. */
const activeRuns = new Map<string, RunDetails>();

function overviewIcon(status: SubagentStatus): string {
	switch (status) {
		case "waiting_permission": return "⏸";
		case "completed": return "✓";
		case "failed":
		case "timeout": return "✗";
		case "aborted": return "⊘";
		default: return "◐";
	}
}

function renderOverview(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (activeRuns.size === 0) {
		ctx.ui.setWidget("subagent-overview", undefined);
		return;
	}
	const lines: string[] = [`Subagents · ${activeRuns.size} running`];
	for (const details of activeRuns.values()) {
		const usage = details.usage;
		const latest = details.activity[details.activity.length - 1] ?? details.milestones[details.milestones.length - 1] ?? "";
		const trimmedLatest = latest.length > 50 ? `${latest.slice(0, 50)}...` : latest;
		lines.push(
			[
				`${overviewIcon(details.status)} ${details.agent}`,
				statusWord(details.status),
				`${usage.turns} turns`,
				`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`,
				`$${usage.cost.toFixed(4)}`,
				details.model ?? "",
			]
				.filter(Boolean)
				.join(" · ") + (trimmedLatest ? ` — ${trimmedLatest}` : ""),
		);
	}
	ctx.ui.setWidget("subagent-overview", lines);
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

			const details: RunDetails = {
				agent: profile.name,
				task: params.task,
				model: resolveModel(profile, handle.usage, ctx),
				status: handle.status,
				usage: handle.usage,
				milestones: [],
				activity: [],
				filesRead: [],
				filesModified: [],
			};
			activeRuns.set(handle.id, details);

			const emit = () => {
				details.status = handle.status;
				details.usage = handle.usage;
				details.model = resolveModel(profile, handle.usage, ctx);
				renderOverview(ctx);
				const preview = [
					`subagent ${details.agent} · ${statusWord(details.status)}`,
					...details.milestones.slice(-3),
					...details.activity.slice(-3),
				].join("\n");
				onUpdate?.({
					content: [{ type: "text", text: preview }],
					details,
				});
			};

			const unsubscribe = handle.subscribe((event: SubagentEvent) => {
				if (event.type === "progress") {
					details.milestones.push(event.text);
				} else if (event.type === "permission_blocked") {
					details.milestones.push(`⛔ ${event.tool}: ${event.reason}`);
				} else if (event.type === "failed") {
					details.error = event.error;
				}
				const line = activityLine(event);
				if (line !== undefined) {
					details.activity.push(line);
					if (details.activity.length > ACTIVITY_LIMIT) details.activity.shift();
				}
				emit();
			});

			let result: Awaited<ReturnType<typeof handle.wait>>;
			try {
				result = await handle.wait();
			} finally {
				unsubscribe();
				activeRuns.delete(handle.id);
				renderOverview(ctx);
			}

			details.status = result.status;
			details.usage = result.usage;
			details.filesRead = result.disclosure.filesRead;
			details.filesModified = result.disclosure.filesModified;
			details.finalText =
				result.output !== undefined && typeof result.output !== "string"
					? JSON.stringify(result.output, null, 2)
					: result.text;
			if (result.error) details.error = `${result.error.kind}: ${result.error.message}`;

			const summary = [
				`agent: ${profile.name} · status: ${result.status} · turns: ${result.usage.turns} · cost: $${result.usage.cost.toFixed(4)}`,
				result.disclosure.filesRead.length ? `read: ${result.disclosure.filesRead.join(", ")}` : "",
				result.disclosure.filesModified.length ? `modified: ${result.disclosure.filesModified.join(", ")}` : "",
				result.error ? `error(${result.error.kind}): ${result.error.message}` : "",
				"",
				details.finalText ?? "",
			].filter((line) => line !== "").join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details,
				isError: result.status !== "completed",
			};
		},

		renderCall(args, theme) {
			const agentName = args.agent || "...";
			const firstLine = (args.task ?? "").split("\n")[0] ?? "";
			const preview = firstLine.length > 70 ? `${firstLine.slice(0, 70)}...` : firstLine;
			const text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				`\n${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as RunDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const titleLine = () => {
				const usageStr = formatUsageStats(details.usage, details.model);
				let line =
					`${statusIcon(details.status, theme)} ${theme.fg("toolTitle", theme.bold(details.agent))} ` +
					theme.fg("muted", statusWord(details.status));
				if (usageStr) line += ` ${theme.fg("dim", usageStr)}`;
				return line;
			};

			if (isPartial) {
				let text = titleLine();
				for (const milestone of details.milestones) {
					text += `\n${theme.fg("accent", "● ")}${milestone}`;
				}
				for (const line of details.activity) {
					text += `\n  ${theme.fg("dim", line)}`;
				}
				return new Text(text, 0, 0);
			}

			if (!expanded) {
				let text = titleLine();
				for (const milestone of details.milestones) {
					text += `\n${theme.fg("accent", "● ")}${milestone}`;
				}
				if (details.error) {
					text += `\n${theme.fg("error", details.error)}`;
				} else if (details.finalText) {
					const lines = details.finalText.split("\n");
					const shown = lines.slice(0, COLLAPSED_LINE_LIMIT);
					text += `\n${theme.fg("toolOutput", shown.join("\n"))}`;
					if (lines.length > COLLAPSED_LINE_LIMIT) text += `\n${theme.fg("muted", "(ctrl+o expand)")}`;
				}
				return new Text(text, 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(titleLine(), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
			if (details.milestones.length > 0) {
				container.addChild(new Spacer(1));
				for (const milestone of details.milestones) {
					container.addChild(new Text(theme.fg("accent", "● ") + milestone, 0, 0));
				}
			}
			if (details.filesRead.length > 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "read: ") + theme.fg("dim", details.filesRead.join(", ")), 0, 0));
			}
			if (details.filesModified.length > 0) {
				container.addChild(
					new Text(theme.fg("muted", "modified: ") + theme.fg("dim", details.filesModified.join(", ")), 0, 0),
				);
			}
			if (details.error) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("error", details.error), 0, 0));
			}
			if (details.finalText) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(details.finalText.trim(), 0, 0, getMarkdownTheme()));
			}
			const usageStr = formatUsageStats(details.usage, details.model);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			return container;
		},
	});

	pi.registerCommand("subagents", {
		description: "List subagent runs in this session",
		handler: async (_args, ctx) => {
			const lines = runs.length
				? runs.map((run) => {
						const usage = run.usage;
						const model = resolveModel(run.profile, usage, ctx) ?? "";
						return (
							`${run.profile.name}  ${run.status}  turns=${usage.turns}  ` +
							`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}  $${usage.cost.toFixed(4)}` +
							(model ? `  ${model}` : "")
						);
					})
				: ["No subagent runs yet."];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
