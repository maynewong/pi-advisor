import { describe, expect, test, vi } from "vitest";
import { SubagentViewer, type MarkdownRenderer, type ViewerRun, type ViewerTheme } from "../src/viewer.ts";

const theme: ViewerTheme = { fg: (_c, t) => t, bold: (t) => t };
const renderMarkdown: MarkdownRenderer = (text) => text.split("\n");

function run(partial: Partial<ViewerRun> & Pick<ViewerRun, "id" | "agent">): ViewerRun {
	return {
		task: "do the thing",
		status: "running",
		usage: { turns: 1, input: 10, output: 20, cost: 0.01 },
		milestones: [],
		activity: [],
		filesRead: [],
		filesModified: [],
		...partial,
	};
}

// Raw escape sequences matchesKey recognizes (confirmed against pi-tui's keys.js).
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";

function makeCallbacks() {
	return { onClose: vi.fn(), onAbort: vi.fn(), onInspect: vi.fn(), onStateChange: vi.fn() };
}

describe("SubagentViewer", () => {
	test("renders empty state when there are no runs", () => {
		const viewer = new SubagentViewer(() => [], theme, makeCallbacks(), () => 20, renderMarkdown);
		const lines = viewer.render(80);
		expect(lines.join("\n")).toContain("No subagent runs yet.");
	});

	test("renders N runs with the selected row marked", () => {
		const runs = [run({ id: "a", agent: "advisor" }), run({ id: "b", agent: "search" })];
		const viewer = new SubagentViewer(() => runs, theme, makeCallbacks(), () => 20, renderMarkdown);
		const lines = viewer.render(80);
		const advisorLine = lines.find((l) => l.includes("advisor"));
		expect(advisorLine).toContain("❯");
	});

	test("down moves selection forward, up moves it back", () => {
		const runs = [run({ id: "a", agent: "advisor" }), run({ id: "b", agent: "search" })];
		const callbacks = makeCallbacks();
		const viewer = new SubagentViewer(() => runs, theme, callbacks, () => 20, renderMarkdown);

		viewer.handleInput(KEY_DOWN);
		expect(viewer.selectedIndex).toBe(1);
		expect(callbacks.onStateChange).toHaveBeenCalled();
		let lines = viewer.render(80);
		expect(lines.find((l) => l.includes("search"))).toContain("❯");
		expect(lines.find((l) => l.includes("advisor"))).not.toContain("❯");

		viewer.handleInput(KEY_UP);
		expect(viewer.selectedIndex).toBe(0);
		lines = viewer.render(80);
		expect(lines.find((l) => l.includes("advisor"))).toContain("❯");
	});

	test("enter inspects the selected run and space expands it", () => {
		const runs = [run({ id: "a", agent: "advisor", status: "completed", finalText: "## Report\nAll good." })];
		const callbacks = makeCallbacks();
		const viewer = new SubagentViewer(() => runs, theme, callbacks, () => 20, renderMarkdown);

		expect(viewer.render(80).join("\n")).toContain("Pi Advisor");
		expect(viewer.render(80).join("\n")).not.toContain("All good.");
		viewer.handleInput(KEY_ENTER);
		expect(callbacks.onInspect).toHaveBeenCalledWith("a");
		expect(callbacks.onClose).toHaveBeenCalled();

		const expander = new SubagentViewer(() => runs, theme, makeCallbacks(), () => 20, renderMarkdown);
		expander.handleInput(" ");
		expect(expander.render(80).join("\n")).toContain("All good.");
	});

	test("q closes the viewer", () => {
		const callbacks = makeCallbacks();
		const viewer = new SubagentViewer(() => [run({ id: "a", agent: "advisor" })], theme, callbacks, () => 20, renderMarkdown);
		viewer.handleInput("q");
		expect(callbacks.onClose).toHaveBeenCalledTimes(1);
	});

	test("escape also closes the viewer", () => {
		const callbacks = makeCallbacks();
		const viewer = new SubagentViewer(() => [run({ id: "a", agent: "advisor" })], theme, callbacks, () => 20, renderMarkdown);
		viewer.handleInput(KEY_ESCAPE);
		expect(callbacks.onClose).toHaveBeenCalledTimes(1);
	});

	test("a aborts an active run but not a completed one", () => {
		const active = run({ id: "a", agent: "advisor", status: "running" });
		const done = run({ id: "b", agent: "search", status: "completed" });
		const callbacks = makeCallbacks();
		const viewer = new SubagentViewer(() => [active, done], theme, callbacks, () => 20, renderMarkdown);

		viewer.handleInput("a");
		expect(callbacks.onAbort).toHaveBeenCalledWith("a");

		callbacks.onAbort.mockClear();
		viewer.handleInput(KEY_DOWN);
		viewer.handleInput("a");
		expect(callbacks.onAbort).not.toHaveBeenCalled();
	});

	test("viewport scrolling bounds output and shows a scroll indicator", () => {
		const longMarkdown = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
		const runs = [run({ id: "a", agent: "advisor", status: "completed", finalText: longMarkdown })];
		const viewer = new SubagentViewer(() => runs, theme, makeCallbacks(), () => 10, renderMarkdown);

		viewer.handleInput(" ");
		const lines = viewer.render(80);

		expect(lines.length).toBeLessThan(20);
		expect(lines.some((l) => /\d+.\d+ of \d+ lines/.test(l))).toBe(true);
	});

	test("pageDown can reach the last line of a long expanded run", () => {
		const longMarkdown = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
		const runs = [run({ id: "a", agent: "advisor", status: "completed", finalText: longMarkdown })];
		const viewer = new SubagentViewer(() => runs, theme, makeCallbacks(), () => 10, renderMarkdown);
		viewer.handleInput(" ");
		for (let i = 0; i < 12; i++) viewer.handleInput("\x1b[6~");
		const lines = viewer.render(80).join("\n");
		expect(lines).toContain("line 49");
	});

	test("markdown cache is keyed by width so resize reflows", () => {
		const calls: number[] = [];
		const renderer: MarkdownRenderer = (text, width) => {
			calls.push(width);
			return [`w${width}:${text}`];
		};
		const runs = [run({ id: "a", agent: "advisor", status: "completed", finalText: "hello" })];
		const viewer = new SubagentViewer(() => runs, theme, makeCallbacks(), () => 20, renderer);
		viewer.handleInput(" ");
		expect(viewer.render(40).join("\n")).toContain("w36:hello");
		expect(viewer.render(20).join("\n")).toContain("w16:hello");
		expect(calls).toEqual([36, 16]);
	});
});
