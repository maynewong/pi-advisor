/**
 * Keyboard-driven interactive popup listing all subagent runs in the session, with expandable
 * per-run detail (task, milestones, activity/final report, files touched, usage). Decoupled from
 * pi-tui/pi-coding-agent concrete types (except the structural Component shape) so it stays
 * unit-testable without a real terminal or theme.
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { SubagentStatus } from "pi-advisor-core";
import {
	compactActivity,
	displayAgentName,
	firstTaskLine,
	formatElapsed,
	groupRunsByAttention,
} from "./presentation.ts";

export interface ViewerRun {
	id: string;
	agent: string;
	task: string;
	model?: string;
	status: string;
	usage: { turns: number; input: number; output: number; cost: number; [k: string]: any };
	milestones: string[];
	activity: string[];
	filesRead: string[];
	filesModified: string[];
	filesReadMore?: string;
	filesModifiedMore?: string;
	artifactsDir?: string;
	error?: string;
	finalText?: string;
	verdict?: string;
	confidence?: string;
	background?: boolean;
	acknowledged?: boolean;
	startedAt?: number;
}

export interface ViewerCallbacks {
	onClose(): void;
	onAbort?(id: string): void;
	onInspect?(id: string): void;
	onStateChange?(): void;
}

/** Structural subset of the real Theme so viewer.ts has no pi-coding-agent dependency. */
export interface ViewerTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Renders markdown text to lines at a given width; the extension wires this to the real Markdown component. */
export type MarkdownRenderer = (text: string, width: number) => string[];

const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "timeout"]);

function statusIcon(status: string): string {
	switch (status) {
		case "waiting_permission": return "⏸";
		case "completed": return "✓";
		case "failed":
		case "timeout": return "✗";
		case "aborted": return "⊘";
		default: return "◐";
	}
}

function formatUsageDetail(usage: ViewerRun["usage"]): string {
	const parts: string[] = [
		`input ${usage.input}`,
		`output ${usage.output}`,
		`$${usage.cost.toFixed(4)}`,
	];
	return parts.join(" · ");
}

interface CachedMarkdown {
	text: string;
	width: number;
	lines: string[];
}

/** Keyboard-driven popup component listing all subagent runs, with per-run expand/collapse detail. */
export class SubagentViewer {
	private selected = 0;
	private readonly expanded = new Set<string>();
	private scrollTop = 0;
	private userScrolled = false;
	private readonly markdownCache = new Map<string, CachedMarkdown>();

	constructor(
		private readonly getRuns: () => ViewerRun[],
		private readonly theme: ViewerTheme,
		private readonly callbacks: ViewerCallbacks,
		private readonly getViewportRows: () => number,
		private readonly renderMarkdown: MarkdownRenderer,
	) {}

	/** Test-only accessor for the currently selected row index. */
	get selectedIndex(): number {
		return this.selected;
	}

	invalidate(): void {
		this.markdownCache.clear();
	}

	private orderedRuns(): ViewerRun[] {
		return groupRunsByAttention(this.getRuns().map((run) => ({
			...run,
			status: run.status as SubagentStatus,
			background: run.background === true,
			acknowledged: run.acknowledged === true,
		}))).flatMap((section) => section.runs);
	}

	handleInput(data: string): void {
		const runs = this.orderedRuns();
		let changed = false;

		if (matchesKey(data, "up") || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.userScrolled = false;
			changed = true;
		} else if (matchesKey(data, "down") || data === "j") {
			this.selected = Math.min(Math.max(0, runs.length - 1), this.selected + 1);
			this.userScrolled = false;
			changed = true;
		} else if (matchesKey(data, "enter")) {
			const run = runs[this.selected];
			if (run && this.callbacks.onInspect) {
				this.callbacks.onInspect(run.id);
				this.callbacks.onClose();
				return;
			}
		} else if (matchesKey(data, "space") || data === "o") {
			const run = runs[this.selected];
			if (run) {
				if (this.expanded.has(run.id)) this.expanded.delete(run.id);
				else this.expanded.add(run.id);
				changed = true;
			}
		} else if (matchesKey(data, "right")) {
			const run = runs[this.selected];
			if (run) {
				this.expanded.add(run.id);
				changed = true;
			}
		} else if (matchesKey(data, "left")) {
			const run = runs[this.selected];
			if (run) {
				this.expanded.delete(run.id);
				changed = true;
			}
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
			this.scrollTop = Math.max(0, this.scrollTop - Math.max(1, this.getViewportRows() - 3));
			this.userScrolled = true;
			changed = true;
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
			this.scrollTop = this.scrollTop + Math.max(1, this.getViewportRows() - 3);
			this.userScrolled = true;
			changed = true;
		} else if (data === "a") {
			const run = runs[this.selected];
			if (run && !TERMINAL_STATUSES.has(run.status) && this.callbacks.onAbort) {
				this.callbacks.onAbort(run.id);
			}
		} else if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
			this.callbacks.onClose();
			return;
		}

		if (changed) this.callbacks.onStateChange?.();
	}

	private renderMarkdownCached(id: string, text: string, width: number): string[] {
		const cached = this.markdownCache.get(id);
		if (cached && cached.text === text && cached.width === width) return cached.lines;
		const lines = this.renderMarkdown(text, width);
		this.markdownCache.set(id, { text, width, lines });
		return lines;
	}

	private renderRow(run: ViewerRun, index: number, width: number): string[] {
		const isSelected = index === this.selected;
		const prefix = isSelected ? this.theme.fg("accent", "❯ ") : "  ";
		const icon = statusIcon(run.status);
		const agentName = isSelected ? this.theme.bold(displayAgentName(run.agent)) : displayAgentName(run.agent);
		const activity = compactActivity({
			status: run.status as SubagentStatus,
			error: run.error,
			milestones: run.milestones,
			activity: run.activity,
			filesRead: run.filesRead,
		});
		const elapsed = run.startedAt ? formatElapsed(run.startedAt) : "";
		const rowLine = [`${prefix}${icon} ${agentName}`, firstTaskLine(run.task, 28), activity, elapsed].filter(Boolean).join(" · ");
		const lines = [rowLine];

		if (!this.expanded.has(run.id)) return lines;

		const indent = "  ";
		lines.push(`${indent}${this.theme.fg("dim", firstTaskLine(run.task))}`);
		for (const milestone of run.milestones) {
			lines.push(`${indent}${this.theme.fg("accent", "● ")}${milestone}`);
		}
		if (run.filesRead.length > 0) {
			const suffix = run.filesReadMore ? `, ${run.filesReadMore}` : "";
			lines.push(`${indent}read: ${run.filesRead.join(", ")}${suffix}`);
		}
		if (run.filesModified.length > 0) {
			const suffix = run.filesModifiedMore ? `, ${run.filesModifiedMore}` : "";
			lines.push(`${indent}modified: ${run.filesModified.join(", ")}${suffix}`);
		}
		if (run.error) {
			lines.push(`${indent}${this.theme.fg("error", run.error)}`);
		}
		if (run.finalText) {
			const rendered = this.renderMarkdownCached(run.id, run.finalText.trim(), Math.max(1, width - 4));
			for (const line of rendered) lines.push(`${indent}${line}`);
		} else {
			const recent = run.activity.slice(-5);
			for (const line of recent) lines.push(`${indent}${this.theme.fg("dim", line)}`);
		}
		lines.push(`${indent}${this.theme.fg("dim", formatUsageDetail(run.usage))}`);
		return lines;
	}

	render(width: number): string[] {
		const source = this.getRuns();
		const runs = this.orderedRuns();
		// Runs can finish/be pruned between frames; keep the selection on a real row.
		this.selected = Math.max(0, Math.min(this.selected, runs.length - 1));
		const header = [
			this.theme.bold(`Pi Advisor (${runs.length})`),
			this.theme.fg("dim", "↑↓ move · Enter inspect · space expand · a abort · q/esc close"),
		];

		if (runs.length === 0) {
			return [...header, "No subagent runs yet."];
		}

		const bodyLines: string[] = [];
		const rowStart: number[] = [];
		const grouped = groupRunsByAttention(source.map((run) => ({
			...run,
			status: run.status as SubagentStatus,
			background: run.background === true,
			acknowledged: run.acknowledged === true,
		})));
		let index = 0;
		for (const section of grouped) {
			bodyLines.push(this.theme.fg("accent", this.theme.bold(section.label)));
			for (const groupedRun of section.runs) {
				const run = source.find((candidate) => candidate.id === groupedRun.id)!;
				rowStart[index] = bodyLines.length;
				for (const line of this.renderRow(run, index, width)) bodyLines.push(line);
				index += 1;
			}
		}

		const H = Math.max(8, this.getViewportRows());
		const bodyH = Math.max(3, H - header.length - 1);

		const selectedStart = rowStart[Math.min(this.selected, rowStart.length - 1)] ?? 0;
		const selectedEnd = (rowStart[this.selected + 1] ?? bodyLines.length) - 1;
		const selectedFits = selectedEnd - selectedStart + 1 <= bodyH;
		if (!this.userScrolled) {
			if (selectedFits) {
				if (selectedStart < this.scrollTop) this.scrollTop = selectedStart;
				else if (selectedEnd > this.scrollTop + bodyH - 1) this.scrollTop = selectedEnd - bodyH + 1;
			} else if (this.scrollTop + bodyH - 1 < selectedStart || this.scrollTop > selectedEnd) {
				this.scrollTop = selectedStart;
			}
		}
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, bodyLines.length - bodyH)));

		const visible = bodyLines.slice(this.scrollTop, this.scrollTop + bodyH);
		const lines = [...header, ...visible];
		if (bodyLines.length > bodyH) {
			const from = this.scrollTop + 1;
			const to = Math.min(this.scrollTop + bodyH, bodyLines.length);
			lines.push(this.theme.fg("dim", `(${from}–${to} of ${bodyLines.length} lines)`));
		}
		return lines;
	}
}
