import { CustomEditor, type AppKeybinding, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type AutocompleteProvider,
	type Component,
	type EditorComponent,
	type OverlayHandle,
} from "@earendil-works/pi-tui";
import type { SubagentStatus, SubagentTranscriptItem, SubagentTranscriptMessage, UsageSnapshot } from "pi-advisor-core";
import {
	compactActivity,
	displayAgentLabel,
	firstTaskLine,
	semanticItemCount,
	transcriptContains,
	visibleTranscriptItems,
} from "./presentation.ts";

type EditorTui = ConstructorParameters<typeof CustomEditor>[0];
type EditorTheme = ConstructorParameters<typeof CustomEditor>[1];
type EditorKeybindings = ConstructorParameters<typeof CustomEditor>[2];

export interface WorkspaceRunView {
	id: string;
	agent: string;
	status: SubagentStatus;
	model?: string;
	task: string;
	usage: UsageSnapshot;
	progress?: string;
	milestones: string[];
	activity: string[];
	filesRead: string[];
	filesModified: string[];
	messages: SubagentTranscriptMessage[];
	items?: SubagentTranscriptItem[];
	finalText?: string;
	error?: string;
	pendingMessages: number;
	artifactsDir?: string;
	degradedNote?: string;
	stoppedBy?: string;
	resultReady?: boolean;
}

export interface WorkspaceControllerOptions {
	runs: () => WorkspaceRunView[];
	onTargetChange?: (run: WorkspaceRunView | undefined) => void;
	onAcknowledge?: (id: string) => void;
	markdownTheme?: ConstructorParameters<typeof Markdown>[3];
}

type AppEditorBridge = EditorComponent & {
	actionHandlers?: Map<AppKeybinding, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
	focused?: boolean;
	wantsKeyRelease?: boolean;
	isShowingAutocomplete?: () => boolean;
	getLines?: () => string[];
	getCursor?: () => { line: number; col: number };
};

export interface RunViewportState {
	followTail: boolean;
	scrollTop: number;
	unseenItems: number;
	seenItems: number;
	anchorItemId?: string;
}

/** Local projection identities, not the future Core transcript IDs. */
interface ConversationBlock {
	id: string;
	start: number;
	lineWidths: number[];
}

interface CachedMarkdown {
	text: string;
	width: number;
	lines: string[];
}

function paddedLine(content: string, width: number): string {
	const value = truncateToWidth(content, Math.max(0, width), "…");
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function framedBorder(
	width: number,
	left: string,
	label: string,
	right: string,
	paint: (text: string) => string,
): string {
	if (width <= 0) return "";
	if (width === 1) return paint("─");
	const inner = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
	const fitted = truncateToWidth(label, inner, "…");
	const fill = "─".repeat(Math.max(0, inner - visibleWidth(fitted)));
	return paint(left) + fitted + paint(fill + right);
}

function formatUsage(usage: UsageSnapshot, model?: string): string {
	return [
		`↑${usage.input}`,
		`↓${usage.output}`,
		usage.cacheRead ? `R${usage.cacheRead}` : "",
		usage.cacheWrite ? `W${usage.cacheWrite}` : "",
		usage.cost ? `$${usage.cost.toFixed(4)}` : "",
		usage.contextTokens ? `ctx:${usage.contextTokens}` : "",
		model ?? "",
	].filter(Boolean).join(" · ");
}

function defaultMarkdownTheme(): ConstructorParameters<typeof Markdown>[3] {
	return {
		heading: (text) => text,
		link: (text) => text,
		linkUrl: (text) => text,
		code: (text) => text,
		codeBlock: (text) => text,
		codeBlockBorder: (text) => text,
		quote: (text) => text,
		quoteBorder: (text) => text,
		hr: (text) => text,
		listBullet: (text) => text,
		bold: (text) => text,
		italic: (text) => text,
		strikethrough: (text) => text,
		underline: (text) => text,
	};
}

function compactToolPreview(text: string): string {
	const first = text.split("\n")[0]?.trim() || "(no output)";
	const extra = Math.max(0, text.split("\n").length - 1);
	return extra > 0 ? `${first} · +${extra}` : first;
}

export function workspaceConversationLines(
	run: WorkspaceRunView,
	theme: Theme,
	innerWidth: number,
	markdownTheme: ConstructorParameters<typeof Markdown>[3],
	cache: Map<string, CachedMarkdown>,
	blocks?: ConversationBlock[],
): string[] {
	const lines: string[] = [];
	const mark = (id: string) => blocks?.push({ id, start: lines.length, lineWidths: [] });
	const wrap = (text: string, color?: "accent" | "error" | "muted" | "warning") => {
		for (const raw of text.split("\n")) {
			const wrapped = wrapTextWithAnsi(raw, Math.max(1, innerWidth));
			for (const line of wrapped.length > 0 ? wrapped : [""]) {
				lines.push(color ? theme.fg(color, line) : line);
			}
		}
	};
	const renderMarkdown = (id: string, text: string) => {
		const cached = cache.get(id);
		if (cached && cached.text === text && cached.width === innerWidth) {
			lines.push(...cached.lines);
			return;
		}
		const rendered = new Markdown(text, 0, 0, markdownTheme).render(Math.max(1, innerWidth));
		cache.set(id, { text, width: innerWidth, lines: rendered });
		lines.push(...rendered);
	};

	if (run.pendingMessages > 0) {
		mark("pending");
		wrap(`${run.pendingMessages} follow-up message${run.pendingMessages === 1 ? "" : "s"} queued`, "warning");
		lines.push("");
	}
	const items = visibleTranscriptItems(run);
	if (items.length > 0) {
		for (const item of items) {
			mark(item.id);
			if (item.kind === "user") {
				lines.push(theme.fg("accent", theme.bold("USER")));
				wrap(item.markdown.trim() || "(no text)");
			} else if (item.kind === "assistant") {
				lines.push(theme.fg("muted", theme.bold("ASSISTANT")));
				renderMarkdown(item.id, item.markdown.trim() || "(no text)");
			} else if (item.kind === "tool") {
				const failed = item.status === "failed";
				const running = item.status === "running";
				const prefix = failed ? "✗" : running ? "◐" : "›";
				lines.push(theme.fg(failed ? "error" : "muted", theme.bold(`${prefix} ${item.summary}`)));
				if (failed && item.resultText) wrap(compactToolPreview(item.resultText), "error");
			}
			lines.push("");
		}
	} else {
		mark("message:0");
		lines.push(theme.fg("accent", theme.bold("USER")));
		wrap(run.task);
		lines.push("");
	}
	if (run.error) {
		mark("error");
		lines.push(theme.fg("error", theme.bold("ERROR")));
		wrap(run.error, "error");
		lines.push("");
	}
	if (run.finalText && (run.messages.length === 0 || !transcriptContains(run.messages, run.finalText))) {
		mark("report");
		lines.push(theme.fg("accent", theme.bold("REPORT")));
		renderMarkdown(`report:${run.id}`, run.finalText.trim());
		lines.push("");
	}
	if (lines.at(-1) === "") lines.pop();
	blocks?.forEach((block, index) => {
		block.lineWidths = lines.slice(block.start, blocks[index + 1]?.start ?? lines.length).map((line) => Math.max(1, visibleWidth(line)));
	});
	return lines;
}

export function workspaceInspectorLines(run: WorkspaceRunView, theme: Theme, width = 80): string[] {
	const lines = [
		theme.fg("accent", theme.bold("Run details")),
		`id        ${run.id}`,
		`status    ${run.status}`,
		run.model ? `model     ${run.model}` : "",
		`usage     ${formatUsage(run.usage, run.model)}`,
		`files     ${run.filesRead.length} read · ${run.filesModified.length} modified`,
	].filter(Boolean);
	if (run.artifactsDir) lines.push(`artifacts ${run.artifactsDir}`);
	if (run.degradedNote) lines.push(run.degradedNote);
	if (run.stoppedBy) lines.push(`stopped   ${run.stoppedBy}`);
	if (run.milestones.length > 0) {
		lines.push("");
		lines.push(theme.fg("accent", "Milestones"));
		for (const milestone of run.milestones) lines.push(`● ${milestone}`);
	}
	if (run.activity.length > 0) {
		lines.push("");
		lines.push(theme.fg("accent", "Recent activity"));
		lines.push(...run.activity);
	}
	if (run.filesRead.length > 0) {
		lines.push("");
		lines.push(theme.fg("accent", "Files read"));
		lines.push(...run.filesRead);
	}
	if (run.filesModified.length > 0) {
		lines.push("");
		lines.push(theme.fg("accent", "Files modified"));
		lines.push(...run.filesModified);
	}
	return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

class WorkspaceOverlay implements Component {
	constructor(
		private readonly tui: EditorTui,
		private readonly controller: SubagentWorkspaceController,
		private readonly theme: () => Theme,
	) {}

	render(width: number): string[] {
		const run = this.controller.activeRun();
		if (!run) return [];
		const theme = this.theme();
		const availableHeight = Math.max(8, this.tui.terminal.rows - this.controller.editorHeight - 1);
		const height = availableHeight;
		const innerWidth = Math.max(1, width - 2);
		const inspector = this.controller.inspectorOpen;
		const blocks: ConversationBlock[] = [];
		const body = inspector
			? workspaceInspectorLines(run, theme, innerWidth)
			: workspaceConversationLines(run, theme, innerWidth, this.controller.markdownTheme, this.controller.markdownCache, blocks);
		const headerLines = 3;
		const footerLines = 1;
		const bodyHeight = Math.max(1, height - headerLines - footerLines);
		const viewport = inspector
			? undefined
			: this.controller.syncViewport(run, body.length, bodyHeight, blocks);
		const scrollTop = inspector
			? this.controller.clampInspectorScroll(body.length, bodyHeight)
			: viewport!.scrollTop;
		const visible = body.slice(scrollTop, scrollTop + bodyHeight);
		const surface = (text: string) => theme.bg("customMessageBg", text);
		const border = (text: string) => theme.fg("borderAccent", text);
		const activity = compactActivity(run);
		const title = ` ${displayAgentLabel(run.agent).toUpperCase()} · ${firstTaskLine(run.task, 36)} · ${run.status.toUpperCase()} `;
		const lines = [
			framedBorder(width, "╭─", title, "╮", border),
			surface(border("│") + paddedLine(theme.fg("dim", activity), innerWidth) + border("│")),
			border("├" + "─".repeat(innerWidth) + "┤"),
		];
		for (const line of visible) lines.push(surface(border("│") + paddedLine(line, innerWidth) + border("│")));
		while (lines.length < height - 1) lines.push(surface(border("│") + " ".repeat(innerWidth) + border("│")));
		const followHint = inspector
			? body.length > bodyHeight
				? ` inspector · ${scrollTop + 1}-${Math.min(body.length, scrollTop + bodyHeight)} of ${body.length} `
				: " inspector "
			: viewport!.followTail
				? " following live "
				: viewport!.unseenItems > 0
					? ` ${viewport!.unseenItems} new · End latest `
					: body.length > bodyHeight
						? ` ${viewport!.scrollTop + 1}-${Math.min(body.length, viewport!.scrollTop + bodyHeight)} of ${body.length} `
						: "";
		lines.push(framedBorder(width, "╰─", followHint, "╯", border));
		return lines;
	}

	invalidate(): void {}
}

/** Maintains the selected Main/specialist target and the passive full-width transcript overlay. */
export class SubagentWorkspaceController {
	private activeRunId: string | undefined;
	private tui?: EditorTui;
	private overlay?: OverlayHandle;
	private overlayComponent?: WorkspaceOverlay;
	private theme?: () => Theme;
	private readonly viewports = new Map<string, RunViewportState>();
	private readonly layouts = new Map<string, ConversationBlock[]>();
	private inspectorScrollTop = 0;
	editorHeight = 3;
	inspectorOpen = false;
	markdownTheme: ConstructorParameters<typeof Markdown>[3];
	markdownCache = new Map<string, CachedMarkdown>();

	constructor(private readonly options: WorkspaceControllerOptions) {
		this.markdownTheme = options.markdownTheme ?? defaultMarkdownTheme();
	}

	mount(tui: EditorTui, theme: () => Theme): void {
		if (this.overlay) return;
		this.tui = tui;
		this.theme = theme;
		this.overlayComponent = new WorkspaceOverlay(tui, this, theme);
		this.overlay = tui.showOverlay(this.overlayComponent, {
			nonCapturing: true,
			row: 0,
			col: 0,
			width: "100%",
			maxHeight: "100%",
		});
		this.overlay.setHidden(true);
	}

	dispose(): void {
		this.overlay?.hide();
		this.overlay = undefined;
		this.overlayComponent = undefined;
		this.tui = undefined;
		this.activeRunId = undefined;
		this.inspectorOpen = false;
		this.inspectorScrollTop = 0;
		this.viewports.clear();
		this.layouts.clear();
		this.markdownCache.clear();
	}

	activeRun(): WorkspaceRunView | undefined {
		if (!this.activeRunId) return undefined;
		const run = this.options.runs().find((candidate) => candidate.id === this.activeRunId);
		if (!run) {
			this.activeRunId = undefined;
			this.inspectorOpen = false;
			queueMicrotask(() => this.sync());
			return undefined;
		}
		return run;
	}

	isMain(): boolean {
		return this.activeRun() === undefined;
	}

	viewportFor(id: string): RunViewportState {
		const existing = this.viewports.get(id);
		if (existing) return existing;
		const created: RunViewportState = { followTail: true, scrollTop: 0, unseenItems: 0, seenItems: 0 };
		this.viewports.set(id, created);
		return created;
	}

	syncViewport(run: WorkspaceRunView, bodyLength: number, bodyHeight: number, blocks?: ConversationBlock[]): RunViewportState {
		const viewport = this.viewportFor(run.id);
		if (blocks) {
			const previous = this.layouts.get(run.id);
			if (!viewport.followTail && previous) {
				const anchor = previous.findLast((block) => block.start <= viewport.scrollTop);
				const next = anchor && blocks.find((block) => block.id === anchor.id);
				if (anchor && next) {
					// Preserve a rendered-character offset within the message across line reflow.
					// Markdown decorations make this approximate; the message identity is exact.
					let offset = anchor.lineWidths.slice(0, viewport.scrollTop - anchor.start).reduce((sum, width) => sum + width, 0);
					let row = 0;
					while (row < next.lineWidths.length - 1 && offset >= next.lineWidths[row]!) offset -= next.lineWidths[row++]!;
					viewport.scrollTop = next.start + row;
				}
			}
			this.layouts.set(run.id, blocks);
		}
		const itemCount = semanticItemCount(run);
		if (itemCount > viewport.seenItems) {
			const delta = itemCount - viewport.seenItems;
			if (viewport.followTail || viewport.seenItems === 0) viewport.unseenItems = 0;
			else viewport.unseenItems += delta;
		}
		viewport.seenItems = itemCount;
		const maxScroll = Math.max(0, bodyLength - bodyHeight);
		if (viewport.followTail) viewport.scrollTop = maxScroll;
		else viewport.scrollTop = Math.min(viewport.scrollTop, maxScroll);
		viewport.anchorItemId = blocks?.findLast((block) => block.start <= viewport.scrollTop)?.id;
		return viewport;
	}

	cycle(direction: 1 | -1): void {
		const targets: Array<string | undefined> = [undefined, ...this.options.runs().slice().reverse().map((run) => run.id)];
		if (targets.length === 1) return;
		const current = targets.findIndex((target) => target === this.activeRunId);
		const start = current >= 0 ? current : 0;
		const next = (start + direction + targets.length) % targets.length;
		this.activeRunId = targets[next];
		this.inspectorOpen = false;
		this.sync();
	}

	selectMain(): void {
		if (!this.activeRunId) return;
		this.activeRunId = undefined;
		this.inspectorOpen = false;
		this.sync();
	}

	selectRun(id: string): boolean {
		if (!this.options.runs().some((run) => run.id === id)) return false;
		this.activeRunId = id;
		this.inspectorOpen = false;
		this.sync();
		return true;
	}

	scroll(lines: number): void {
		const run = this.activeRun();
		if (!run) return;
		if (this.inspectorOpen) {
			this.inspectorScrollTop = Math.max(0, this.inspectorScrollTop + lines);
		} else {
			const viewport = this.viewportFor(run.id);
			viewport.followTail = false;
			viewport.scrollTop = Math.max(0, viewport.scrollTop + lines);
		}
		this.requestRender();
	}

	scrollToStart(): void {
		const run = this.activeRun();
		if (!run) return;
		if (this.inspectorOpen) {
			this.inspectorScrollTop = 0;
		} else {
			const viewport = this.viewportFor(run.id);
			viewport.followTail = false;
			viewport.scrollTop = 0;
		}
		this.requestRender();
	}

	followLatest(): void {
		const run = this.activeRun();
		if (!run) return;
		if (this.inspectorOpen) {
			this.inspectorScrollTop = Number.MAX_SAFE_INTEGER;
		} else {
			const viewport = this.viewportFor(run.id);
			viewport.followTail = true;
			viewport.unseenItems = 0;
			viewport.seenItems = semanticItemCount(run);
		}
		this.requestRender();
	}

	acknowledgeResult(): void {
		const run = this.activeRun();
		if (run?.resultReady) this.options.onAcknowledge?.(run.id);
	}

	toggleInspector(): void {
		if (this.isMain()) return;
		this.inspectorOpen = !this.inspectorOpen;
		if (this.inspectorOpen) this.inspectorScrollTop = 0;
		this.requestRender();
	}

	clampInspectorScroll(bodyLength: number, bodyHeight: number): number {
		this.inspectorScrollTop = Math.min(this.inspectorScrollTop, Math.max(0, bodyLength - bodyHeight));
		return this.inspectorScrollTop;
	}

	setEditorHeight(height: number): void {
		if (height === this.editorHeight) return;
		this.editorHeight = Math.max(1, height);
	}

	requestRender(): void {
		this.overlayComponent?.invalidate();
		this.tui?.requestRender();
	}

	private sync(): void {
		const run = this.activeRun();
		this.overlay?.setHidden(!run);
		this.options.onTargetChange?.(run);
		this.requestRender();
	}
}

/**
 * Editor wrapper that preserves any previously-installed editor while adding workspace switching and view framing.
 * Selecting a run never changes where submitted text goes: Pi's normal editor submission path remains authoritative.
 */
export class SubagentSwitchEditor implements EditorComponent {
	private readonly bridge: AppEditorBridge;

	constructor(
		private readonly tui: EditorTui,
		private readonly base: EditorComponent,
		private readonly controller: SubagentWorkspaceController,
		private readonly theme: () => Theme,
	) {
		this.bridge = base as AppEditorBridge;
		this.controller.mount(tui, theme);
	}

	get onSubmit(): ((text: string) => void) | undefined { return this.base.onSubmit; }
	set onSubmit(value: ((text: string) => void) | undefined) { this.base.onSubmit = value; }
	get onChange(): ((text: string) => void) | undefined { return this.base.onChange; }
	set onChange(value: ((text: string) => void) | undefined) { this.base.onChange = value; }

	get actionHandlers(): Map<AppKeybinding, () => void> | undefined { return this.bridge.actionHandlers; }
	get onEscape(): (() => void) | undefined { return this.bridge.onEscape; }
	set onEscape(value: (() => void) | undefined) { this.bridge.onEscape = value; }
	get onCtrlD(): (() => void) | undefined { return this.bridge.onCtrlD; }
	set onCtrlD(value: (() => void) | undefined) { this.bridge.onCtrlD = value; }
	get onPasteImage(): (() => void) | undefined { return this.bridge.onPasteImage; }
	set onPasteImage(value: (() => void) | undefined) { this.bridge.onPasteImage = value; }
	get onExtensionShortcut(): ((data: string) => boolean) | undefined { return this.bridge.onExtensionShortcut; }
	set onExtensionShortcut(value: ((data: string) => boolean) | undefined) { this.bridge.onExtensionShortcut = value; }
	get focused(): boolean { return this.bridge.focused ?? false; }
	set focused(value: boolean) { this.bridge.focused = value; }
	get wantsKeyRelease(): boolean | undefined { return this.bridge.wantsKeyRelease; }
	get borderColor(): ((str: string) => string) | undefined { return this.base.borderColor; }
	set borderColor(value: ((str: string) => string) | undefined) { this.base.borderColor = value; }

	private editorIdle(): boolean {
		return !this.getText().trim() && !this.bridge.isShowingAutocomplete?.();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "alt+down")) {
			this.controller.cycle(1);
			return;
		}
		if (matchesKey(data, "alt+up")) {
			this.controller.cycle(-1);
			return;
		}
		if (!this.controller.isMain() && matchesKey(data, "alt+a")) {
			this.controller.acknowledgeResult();
			return;
		}
		if (!this.controller.isMain() && matchesKey(data, "alt+i")) {
			this.controller.toggleInspector();
			return;
		}
		if (!this.controller.isMain() && this.editorIdle()) {
			if (matchesKey(data, "end")) {
				this.controller.followLatest();
				return;
			}
			if (matchesKey(data, "home")) {
				this.controller.scrollToStart();
				return;
			}
			if (matchesKey(data, "up")) {
				this.controller.scroll(-1);
				return;
			}
			if (matchesKey(data, "down")) {
				this.controller.scroll(1);
				return;
			}
			const pageHeight = Math.max(8, this.tui.terminal.rows - this.controller.editorHeight - 1) - 4;
			if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
				this.controller.scroll(matchesKey(data, "pageUp") ? -pageHeight : pageHeight);
				return;
			}
			if (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+d")) {
				const halfPage = Math.max(1, Math.floor(pageHeight / 2));
				this.controller.scroll(matchesKey(data, "ctrl+u") ? -halfPage : halfPage);
				return;
			}
			if (matchesKey(data, "escape")) {
				this.controller.selectMain();
				return;
			}
		}
		this.base.handleInput(data);
	}

	render(width: number): string[] {
		const lines = this.base.render(width);
		this.controller.setEditorHeight(lines.length);
		const run = this.controller.activeRun();
		if (!run || lines.length < 2) return lines;
		const theme = this.theme();
		const accent = (text: string) => theme.fg("borderAccent", text);
		lines[0] = framedBorder(width, "╭─", ` INSPECTING ${displayAgentLabel(run.agent).toUpperCase()} · ${run.status.toUpperCase()} `, "╮", accent);
		const alt = process.platform === "darwin" ? "⌥" : "Alt";
		lines[lines.length - 1] = framedBorder(width, "╰─", ` input → Main${run.resultReady ? ` · ${alt}+A acknowledge result` : ""} · ${alt}+↑/↓ switch · ${alt}+I details · End latest · Esc main `, "╯", accent);
		return lines;
	}

	invalidate(): void { this.base.invalidate(); }
	getText(): string { return this.base.getText(); }
	getExpandedText(): string { return this.base.getExpandedText?.() ?? this.base.getText(); }
	setText(text: string): void { this.base.setText(text); }
	addToHistory(text: string): void { this.base.addToHistory?.(text); }
	insertTextAtCursor(text: string): void { this.base.insertTextAtCursor?.(text); }
	setAutocompleteProvider(provider: AutocompleteProvider): void { this.base.setAutocompleteProvider?.(provider); }
	setPaddingX(padding: number): void { this.base.setPaddingX?.(padding); }
	setAutocompleteMaxVisible(maxVisible: number): void { this.base.setAutocompleteMaxVisible?.(maxVisible); }
	isShowingAutocomplete(): boolean { return this.bridge.isShowingAutocomplete?.() ?? false; }
	getLines(): string[] { return this.bridge.getLines?.() ?? this.getText().split("\n"); }
	getCursor(): { line: number; col: number } {
		return this.bridge.getCursor?.() ?? { line: 0, col: 0 };
	}
}

export function createSubagentSwitchEditor(
	tui: EditorTui,
	editorTheme: EditorTheme,
	keybindings: EditorKeybindings,
	controller: SubagentWorkspaceController,
	theme: () => Theme,
	base?: EditorComponent,
): SubagentSwitchEditor {
	return new SubagentSwitchEditor(tui, base ?? new CustomEditor(tui, editorTheme, keybindings), controller, theme);
}
