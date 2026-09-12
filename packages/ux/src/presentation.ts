import type { SubagentStatus, SubagentTranscriptItem, SubagentTranscriptMessage } from "@maynewong/pi-advisor-core";
import { upsertTranscriptItem } from "@maynewong/pi-advisor-core";

const TERMINAL_STATUSES = new Set<SubagentStatus>(["completed", "failed", "aborted", "timeout"]);

export type MarkdownRenderer = (text: string, width: number) => string[];

export interface AmbientRun {
	id: string;
	agent: string;
	status: SubagentStatus;
	background: boolean;
	acknowledged: boolean;
	activity: string[];
	milestones: string[];
	error?: string;
	filesRead?: string[];
}

export interface CompactActivityInput {
	status: SubagentStatus;
	error?: string;
	progress?: string;
	milestones: string[];
	activity: string[];
	filesRead?: string[];
}

export interface SemanticCountInput {
	messages: SubagentTranscriptMessage[];
	items?: SubagentTranscriptItem[];
	pendingMessages: number;
	error?: string;
	finalText?: string;
}

export type AttentionGroup = "needs_input" | "failed" | "working" | "ready" | "history";

export const ATTENTION_ORDER: AttentionGroup[] = ["needs_input", "failed", "working", "ready", "history"];

export const ATTENTION_LABELS: Record<AttentionGroup, string> = {
	needs_input: "Needs input",
	failed: "Failed",
	working: "Working",
	ready: "Ready",
	history: "History",
};

/** Product-facing name for a role. */
export function displayAgentName(agent: string): string {
	return agent;
}

export function displayAgentLabel(agent: string): string {
	const name = displayAgentName(agent);
	return name.charAt(0).toUpperCase() + name.slice(1);
}

export function isTerminalStatus(status: SubagentStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

export function formatElapsed(startedAt: number, now = Date.now()): string {
	const sec = Math.max(0, Math.round((now - startedAt) / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	return rem ? `${min}m ${rem}s` : `${min}m`;
}

export function firstTaskLine(task: string, max = 72): string {
	const line = task.split("\n")[0]?.trim() ?? "";
	if (line.length <= max) return line;
	return `${line.slice(0, Math.max(0, max - 1))}…`;
}

function stripActivityDecorations(line: string): string {
	return line.replace(/^[→←✻●⛔✅]\s*/u, "").trim();
}

function compactLine(text: string, max = 96): string {
	return firstTaskLine(text, max);
}

function latestProgress(input: CompactActivityInput): string | undefined {
	return input.progress?.trim() ? compactLine(stripActivityDecorations(input.progress)) : undefined;
}

function latestToolActivity(input: CompactActivityInput): string | undefined {
	const latest = [...input.activity].reverse().find((line) => !line.startsWith("✻ "));
	if (!latest) return undefined;
	const text = compactLine(stripActivityDecorations(latest), 80);
	const files = input.filesRead?.length ?? 0;
	if (files > 0 && /^(Reading|Read|Inspecting|Listing|Finding|Searching)\b/i.test(text)) {
		return compactLine(`${text} · ${files} file${files === 1 ? "" : "s"}`);
	}
	return text;
}

function latestThought(input: CompactActivityInput): string | undefined {
	const latest = [...input.activity].reverse().find((line) => line.startsWith("✻ "));
	return latest ? compactLine(stripActivityDecorations(latest), 80) : undefined;
}

/**
 * One-line status for live cards and workspace headers.
 * Prefers permission, then explicit progress, then a tool activity, then a thought.
 */
export function compactActivity(input: CompactActivityInput): string {
	if (input.status === "waiting_permission") {
		const permission = [...input.milestones].reverse().find((line) =>
			/permission|escalat|⛔/i.test(line)
		) ?? input.milestones.at(-1);
		return permission ? compactLine(stripActivityDecorations(permission)) : "Permission required";
	}
	if (input.error) return compactLine(input.error);
	const progress = latestProgress(input);
	if (progress) return progress;
	const tool = latestToolActivity(input);
	if (tool) return tool;
	const thought = latestThought(input);
	if (thought) return thought;
	if (input.status === "queued") return "Queued";
	if (input.status === "running") return "Working";
	return input.status.replaceAll("_", " ");
}

export function semanticItemCount(input: SemanticCountInput): number {
	const visible = visibleTranscriptItems(input);
	const hasReport = !!input.finalText && (
		visible.length === 0
		|| !transcriptContains(input.messages, input.finalText)
	);
	return visible.length
		+ input.pendingMessages
		+ (input.error ? 1 : 0)
		+ (hasReport ? 1 : 0);
}

export function visibleTranscriptItems(input: { messages: SubagentTranscriptMessage[]; items?: SubagentTranscriptItem[] }): SubagentTranscriptItem[] {
	if (input.items && input.items.length > 0) return input.items.filter((item) => item.kind !== "thinking");
	return input.messages.map((message, index) => {
		if (message.role === "user") return { id: `user:${index}`, kind: "user" as const, markdown: message.text, timestamp: message.timestamp };
		if (message.role === "assistant") return { id: `assistant:${index}`, kind: "assistant" as const, markdown: message.text, timestamp: message.timestamp };
		return {
			id: `tool:${index}`,
			kind: "tool" as const,
			callId: `legacy:${index}`,
			name: message.toolName ?? "tool",
			args: {},
			status: message.isError ? "failed" as const : "completed" as const,
			summary: message.toolName ?? "tool",
			resultText: message.text,
			timestamp: message.timestamp,
		};
	});
}

export function applyTranscriptItem(items: SubagentTranscriptItem[], item: SubagentTranscriptItem): SubagentTranscriptItem[] {
	const next = [...items];
	upsertTranscriptItem(next, item);
	return next;
}

export function attentionGroup(run: AmbientRun): AttentionGroup {
	if (run.status === "waiting_permission") return "needs_input";
	if (run.status === "failed" || run.status === "timeout") return "failed";
	if (run.status === "queued" || run.status === "running") return "working";
	if (run.background && isTerminalStatus(run.status) && !run.acknowledged) return "ready";
	return "history";
}

export function groupRunsByAttention<T extends AmbientRun>(runs: T[]): Array<{ group: AttentionGroup; label: string; runs: T[] }> {
	const buckets = new Map<AttentionGroup, T[]>(ATTENTION_ORDER.map((group) => [group, []]));
	for (const run of runs) buckets.get(attentionGroup(run))!.push(run);
	return ATTENTION_ORDER
		.map((group) => ({ group, label: ATTENTION_LABELS[group], runs: buckets.get(group)! }))
		.filter((section) => section.runs.length > 0);
}

export function transcriptContains(messages: SubagentTranscriptMessage[], text: string): boolean {
	const normalize = (value: string) => value.replace(/\r\n/g, "\n").trim();
	const needle = normalize(text);
	if (!needle) return true;
	return messages.some((message) => message.role === "assistant" && normalize(message.text).includes(needle));
}

/**
 * Overview/ambient ownership: a single foreground run stays on its tool card.
 * Background work, concurrency, permission waits, and unacked completions own the widget.
 */
export function selectAmbientRuns<T extends AmbientRun>(runs: T[]): T[] {
	const active = runs.filter((run) => !isTerminalStatus(run.status));
	const ready = runs.filter((run) => run.background && isTerminalStatus(run.status) && !run.acknowledged);
	const foregroundActive = active.filter((run) => !run.background);
	const backgroundActive = active.filter((run) => run.background);
	const needsInput = active.filter((run) => run.status === "waiting_permission");
	const onlySingleForeground = foregroundActive.length <= 1 && backgroundActive.length === 0 && ready.length === 0;
	if (onlySingleForeground && needsInput.length === 0) return [];
	if (onlySingleForeground) return needsInput;
	return [...active, ...ready];
}

export function ambientHeadline(runs: AmbientRun[]): string | undefined {
	if (runs.length === 0) return undefined;
	const needs = runs.filter((run) => run.status === "waiting_permission").length;
	const working = runs.filter((run) => run.status === "queued" || run.status === "running" || run.status === "waiting_permission").length;
	const ready = runs.filter((run) => isTerminalStatus(run.status) && run.background && !run.acknowledged);
	if (needs > 0) {
		return needs === 1 ? "⚠ 1 specialist needs input" : `⚠ ${needs} specialists need input`;
	}
	if (working > 0) {
		return working === 1 ? "◐ 1 specialist" : `◐ ${working} specialists`;
	}
	if (ready.length > 0) {
		const failed = ready.some((run) => run.status === "failed" || run.status === "timeout");
		const icon = failed ? "✗" : "✓";
		return ready.length === 1 ? `${icon} 1 result ready` : `${icon} ${ready.length} results ready`;
	}
	return runs.length === 1 ? "◐ 1 specialist" : `◐ ${runs.length} specialists`;
}

export function truncateToolPreview(text: string, limit = 4): string[] {
	const lines = (text.trim() || "(no text)").split("\n");
	if (lines.length <= limit) return lines;
	return [...lines.slice(0, limit), `… ${lines.length - limit} more lines`];
}
