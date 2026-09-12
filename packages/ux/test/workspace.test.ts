import { describe, expect, test, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorComponent, type OverlayHandle } from "@earendil-works/pi-tui";
import {
	createSubagentSwitchEditor,
	SubagentSwitchEditor,
	SubagentWorkspaceController,
	workspaceConversationLines,
	workspaceInspectorLines,
	type WorkspaceRunView,
} from "../src/workspace.ts";

const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
const markdownTheme = {
	heading: (text: string) => text,
	link: (text: string) => text,
	linkUrl: (text: string) => text,
	code: (text: string) => text,
	codeBlock: (text: string) => text,
	codeBlockBorder: (text: string) => text,
	quote: (text: string) => text,
	quoteBorder: (text: string) => text,
	hr: (text: string) => text,
	listBullet: (text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
};

function run(id: string, agent: string, status: WorkspaceRunView["status"] = "running"): WorkspaceRunView {
	return {
		id,
		agent,
		status,
		model: "test-model",
		task: `task for ${agent}`,
		usage,
		milestones: ["started"],
		activity: ["Reading src/index.ts"],
		filesRead: ["src/index.ts"],
		filesModified: [],
		messages: [],
		pendingMessages: 0,
	};
}

function theme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
}

function overlayHandle(): OverlayHandle {
	let hidden = false;
	return {
		hide: vi.fn(),
		setHidden: vi.fn((value: boolean) => { hidden = value; }),
		isHidden: () => hidden,
		focus: vi.fn(),
		unfocus: vi.fn(),
		isFocused: () => false,
		getBounds: () => undefined,
	};
}

function fakeTui(handle: OverlayHandle, rows = 30) {
	return {
		terminal: { rows },
		showOverlay: vi.fn(() => handle),
		requestRender: vi.fn(),
	} as never;
}

class FakeEditor implements EditorComponent {
	text = "";
	focused = false;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	inputs: string[] = [];
	borderColor = (text: string) => text;

	render(width: number): string[] { return ["─".repeat(width), this.text, "─".repeat(width)]; }
	handleInput(data: string): void { this.inputs.push(data); }
	invalidate(): void {}
	getText(): string { return this.text; }
	setText(text: string): void { this.text = text; }
}

describe("workspace conversation projection", () => {
	test("puts conversation first and keeps telemetry in the inspector", () => {
		const view = run("one", "advisor", "completed");
		view.messages = [
			{ role: "user", text: "Review the plan" },
			{ role: "assistant", text: "## Verdict\nLooks good" },
			{ role: "tool", text: "file contents\nline 2\nline 3", toolName: "read" },
		];
		const conversation = workspaceConversationLines(view, theme(), 60, markdownTheme, new Map()).join("\n");
		expect(conversation).toContain("USER");
		expect(conversation).toContain("Review the plan");
		expect(conversation).toContain("ASSISTANT");
		expect(conversation).toContain("Verdict");
		expect(conversation).not.toContain("model: test-model");
		expect(conversation).not.toContain("id: one");
		expect(conversation).toContain("read");
		expect(conversation).not.toContain("line 3");

		view.items = [
			{ id: "user:0", kind: "user", markdown: "Review the plan" },
			{ id: "assistant:1", kind: "assistant", markdown: "## Verdict\nLooks good" },
			{ id: "tool:read", kind: "tool", callId: "call-1", name: "read", args: { path: "src/a.ts" }, status: "completed", summary: "Reading src/a.ts", resultText: "file contents\nline 2\nline 3" },
		];
		const structured = workspaceConversationLines(view, theme(), 60, markdownTheme, new Map()).join("\n");
		expect(structured).toContain("› Reading src/a.ts");
		expect(structured).not.toContain("line 3");

		const inspector = workspaceInspectorLines(view, theme()).join("\n");
		expect(inspector).toContain("id        one");
		expect(inspector).toContain("model     test-model");
		expect(inspector).toContain("Files read");
	});

	test("keeps live activity out of the conversation body", () => {
		const view = run("one", "advisor");
		view.progress = "Comparing public API";
		view.activity = ["Reading src/index.ts", "Finding **/*"];
		const conversation = workspaceConversationLines(view, theme(), 60, markdownTheme, new Map()).join("\n");
		expect(conversation.startsWith("USER\n")).toBe(true);
		expect(conversation).not.toContain("LIVE");
		expect(conversation).not.toContain("Comparing public API");
		expect(conversation).not.toContain("Reading src/index.ts");
		view.status = "completed";
		expect(workspaceConversationLines(view, theme(), 60, markdownTheme, new Map()).join("\n")).toBe(conversation);
	});

	test.each([16, 32])("keeps recent activity inspectable at %i columns even after completion", (width) => {
		const view = run("one", "advisor", "completed");
		view.progress = "Comparing public API";
		view.finalText = "Review complete";
		view.activity = ["Reading packages/ux/src/a-very-long-file-name-ending-here.ts", "Finding **/*"];
		const lines = workspaceInspectorLines(view, theme(), width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(lines.join("\n")).toContain("Recent activity");
		expect(lines.join("")).toContain("a-very-long-file-name-ending-here.ts");
		expect(lines.join("\n")).toContain("Finding **/*");
	});

	test("shows a canonical report when the transcript does not already contain it", () => {
		const view = run("one", "advisor", "completed");
		view.finalText = "## Report\nBlocked on auth";
		const conversation = workspaceConversationLines(view, theme(), 60, markdownTheme, new Map()).join("\n");
		expect(conversation).toContain("REPORT");
		expect(conversation).toContain("Blocked on auth");
	});
});

describe("Subagent workspace controller", () => {
	test("cycles Main and the most recent subagents while toggling the passive overlay", () => {
		const runs = [run("one", "search"), run("two", "advisor")];
		const handle = overlayHandle();
		const selected: Array<string | undefined> = [];
		const controller = new SubagentWorkspaceController({ runs: () => runs, onTargetChange: (value) => selected.push(value?.id) });
		controller.mount(fakeTui(handle), theme);

		expect(controller.isMain()).toBe(true);
		controller.cycle(1);
		expect(controller.activeRun()?.id).toBe("two");
		controller.cycle(1);
		expect(controller.activeRun()?.id).toBe("one");
		controller.cycle(1);
		expect(controller.isMain()).toBe(true);
		expect(selected).toEqual(["two", "one", undefined]);
		expect(handle.setHidden).toHaveBeenCalledWith(false);
		expect(handle.setHidden).toHaveBeenLastCalledWith(true);
	});

	test("opens a conversation-first transcript at the tail and restores per-run scroll", () => {
		const view = run("one", "advisor", "completed");
		view.messages = Array.from({ length: 40 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			text: `message ${index}`,
		})) as WorkspaceRunView["messages"];
		const handle = overlayHandle();
		const tui = fakeTui(handle, 20) as unknown as { showOverlay: ReturnType<typeof vi.fn>; terminal: { rows: number } };
		const controller = new SubagentWorkspaceController({ runs: () => [view] });
		controller.mount(tui as never, theme);
		controller.selectRun("one");
		const component = tui.showOverlay.mock.calls[0]![0] as { render: (width: number) => string[] };
		const first = component.render(60).join("\n");

		expect(first).toContain("ADVISOR");
		expect(first).toContain("following live");
		expect(first).toContain("message 39");
		expect(first).not.toContain("message 0");
		expect(first).not.toContain("Conversation");
		expect(component.render(60).length).toBeGreaterThan(10);

		controller.scroll(-8);
		const paused = component.render(60).join("\n");
		expect(paused).not.toContain("following live");
		const pausedTop = controller.viewportFor("one").scrollTop;
		expect(controller.viewportFor("one").followTail).toBe(false);

		controller.toggleInspector();
		component.render(60);
		controller.scroll(3);
		component.render(60);
		controller.toggleInspector();
		expect(controller.viewportFor("one").scrollTop).toBe(pausedTop);
		expect(controller.viewportFor("one").followTail).toBe(false);

		controller.selectMain();
		controller.selectRun("one");
		expect(controller.viewportFor("one").scrollTop).toBe(pausedTop);
		expect(controller.viewportFor("one").followTail).toBe(false);

		controller.followLatest();
		expect(controller.viewportFor("one").followTail).toBe(true);
		expect(component.render(60).join("\n")).toContain("following live");
	});

	test("counts unseen items while paused and does not treat telemetry as new conversation", () => {
		const view = run("one", "advisor");
		view.messages = [{ role: "user", text: "start" }];
		const controller = new SubagentWorkspaceController({ runs: () => [view] });
		controller.mount(fakeTui(overlayHandle()), theme);
		controller.selectRun("one");
		controller.syncViewport(view, 20, 8);
		controller.scroll(-2);
		view.usage = { ...view.usage, input: 999 };
		view.activity = ["Finding **/*"];
		controller.syncViewport(view, 20, 8);
		expect(controller.viewportFor("one").unseenItems).toBe(0);
		view.messages = [...view.messages, { role: "assistant", text: "working" }];
		controller.syncViewport(view, 24, 8);
		expect(controller.viewportFor("one").unseenItems).toBe(1);
	});

	test("keeps the paused reading block across width reflow", () => {
		const view = run("one", "advisor", "completed");
		view.items = [
			{ id: "user:0", kind: "user", markdown: "short intro" },
			{ id: "assistant:1", kind: "assistant", markdown: Array.from({ length: 24 }, () => "alpha beta gamma delta").join(" ") },
		];
		const handle = overlayHandle();
		const tui = fakeTui(handle, 12) as unknown as { showOverlay: ReturnType<typeof vi.fn> };
		const controller = new SubagentWorkspaceController({ runs: () => [view] });
		controller.mount(tui as never, theme);
		controller.selectRun("one");
		const component = tui.showOverlay.mock.calls[0]![0] as { render: (width: number) => string[] };
		component.render(80);
		controller.scroll(-2);
		component.render(80);
		expect(controller.viewportFor("one").followTail).toBe(false);
		expect(controller.viewportFor("one").anchorItemId).toBe("assistant:1");
		component.render(24);
		expect(controller.viewportFor("one").anchorItemId).toBe("assistant:1");
	});

	test("acknowledges only an unread ready result, not merely inspecting it", () => {
		const view = run("one", "advisor", "completed");
		view.resultReady = true;
		const acked: string[] = [];
		const controller = new SubagentWorkspaceController({ runs: () => [view], onAcknowledge: (id) => acked.push(id) });
		const editor = new SubagentSwitchEditor(fakeTui(overlayHandle()), new FakeEditor(), controller, theme);
		controller.selectRun("one");
		expect(acked).toEqual([]);
		editor.handleInput("\x1ba");
		expect(acked).toEqual(["one"]);
	});
});

describe("Subagent switch editor", () => {
	test("creates a default CustomEditor wrapper when no previous editor exists", () => {
		const controller = new SubagentWorkspaceController({ runs: () => [] });
		const handle = overlayHandle();
		const keybindings = { matches: () => false };
		const editorTheme = { borderColor: (text: string) => text, selectList: {} };
		const editor = createSubagentSwitchEditor(fakeTui(handle), editorTheme as never, keybindings as never, controller, theme);
		expect(editor).toBeInstanceOf(SubagentSwitchEditor);
	});

	test("forwards callbacks assigned by Pi to the wrapped editor", () => {
		const controller = new SubagentWorkspaceController({ runs: () => [] });
		const base = new FakeEditor();
		const editor = new SubagentSwitchEditor(fakeTui(overlayHandle()), base, controller, theme);
		const submit = vi.fn();
		const change = vi.fn();
		editor.onSubmit = submit;
		editor.onChange = change;
		base.onSubmit?.("hello");
		base.onChange?.("draft");
		expect(submit).toHaveBeenCalledWith("hello");
		expect(change).toHaveBeenCalledWith("draft");
	});

	test("uses Alt arrows for switching, Escape to Main, and otherwise preserves the wrapped editor", () => {
		const runs = [run("one", "advisor")];
		const handle = overlayHandle();
		const tui = fakeTui(handle);
		const controller = new SubagentWorkspaceController({ runs: () => runs });
		const base = new FakeEditor();
		const editor = new SubagentSwitchEditor(tui, base, controller, theme);

		editor.handleInput("\x1b[1;3B"); // alt+down
		expect(controller.activeRun()?.id).toBe("one");
		expect(editor.render(50)[0]).toContain("INSPECTING ADVISOR · RUNNING");
		expect(editor.render(50).at(-1)).toContain("input → Main");
		const alt = process.platform === "darwin" ? "⌥" : "Alt";
		expect(editor.render(120).at(-1)).toContain(`${alt}+I details`);
		expect(editor.render(120).at(-1)).toContain(`${alt}+↑/↓ switch`);
		editor.handleInput("\x1b[A"); // plain up scrolls while focused on a subagent
		expect(base.inputs).toEqual([]);
		editor.handleInput("i");
		expect(controller.inspectorOpen).toBe(false);
		expect(base.inputs).toEqual(["i"]);
		base.inputs = [];
		base.setText("");
		editor.handleInput("\x1bi"); // alt+i
		expect(controller.inspectorOpen).toBe(true);
		editor.handleInput("\x1b");
		expect(controller.isMain()).toBe(true);
		editor.handleInput("x");
		expect(base.inputs).toEqual(["x"]);
	});

	test("does not steal typed letters or Home/End while the editor has text", () => {
		const runs = [run("one", "advisor")];
		const controller = new SubagentWorkspaceController({ runs: () => runs });
		const base = new FakeEditor();
		const editor = new SubagentSwitchEditor(fakeTui(overlayHandle()), base, controller, theme);
		controller.selectRun("one");
		for (const key of "inspect this") editor.handleInput(key);
		expect(controller.inspectorOpen).toBe(false);
		expect(base.inputs.join("")).toBe("inspect this");
		base.setText("inspect this");
		base.inputs = [];
		editor.handleInput("\x1b[H"); // home
		editor.handleInput("\x1b[F"); // end
		expect(base.inputs).toEqual(["\x1b[H", "\x1b[F"]);
		expect(controller.viewportFor("one").followTail).toBe(true);
	});

	test.each([30, 10])("distinguishes line, full-page and half-page scrolling at %i rows", (rows) => {
		const view = run("one", "advisor");
		const controller = new SubagentWorkspaceController({ runs: () => [view] });
		const base = new FakeEditor();
		const editor = new SubagentSwitchEditor(fakeTui(overlayHandle(), rows), base, controller, theme);
		controller.selectRun("one");
		const scroll = vi.spyOn(controller, "scroll");
		const page = Math.max(8, rows - controller.editorHeight - 1) - 4;
		for (const [key, delta] of [
			["\x1b[A", -1], ["\x1b[B", 1],
			["\x1b[5~", -page], ["\x1b[6~", page],
			["\x15", -Math.floor(page / 2)], ["\x04", Math.floor(page / 2)],
		] as const) {
			editor.handleInput(key);
			expect(scroll).toHaveBeenLastCalledWith(delta);
		}
		expect(base.inputs).toEqual([]);
		base.setText("draft to Main");
		for (const key of ["\x1b[5~", "\x1b[6~", "\x15", "\x04"]) editor.handleInput(key);
		expect(base.inputs).toEqual(["\x1b[5~", "\x1b[6~", "\x15", "\x04"]);
	});

	test("keeps normal submit callbacks intact while a Subagent view is selected", () => {
		const runs = [run("one", "advisor")];
		const controller = new SubagentWorkspaceController({ runs: () => runs });
		const base = new FakeEditor();
		const editor = new SubagentSwitchEditor(fakeTui(overlayHandle()), base, controller, theme);
		const submit = vi.fn();
		editor.onSubmit = submit;

		controller.selectRun("one");
		base.onSubmit?.("ordinary user message");

		expect(submit).toHaveBeenCalledWith("ordinary user message");
	});
});
