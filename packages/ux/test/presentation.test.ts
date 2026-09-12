import { describe, expect, test } from "vitest";
import {
	attentionGroup,
	ambientHeadline,
	compactActivity,
	displayAgentName,
	groupRunsByAttention,
	selectAmbientRuns,
	semanticItemCount,
	transcriptContains,
} from "../src/presentation.ts";
import type { AmbientRun } from "../src/presentation.ts";

function run(partial: Partial<AmbientRun> & Pick<AmbientRun, "id" | "agent" | "status">): AmbientRun {
	return {
		background: false,
		acknowledged: false,
		activity: [],
		milestones: [],
		...partial,
	};
}

describe("display names", () => {
	test("keeps advisor as the profile id and Advisor as the display name", () => {
		expect(displayAgentName("advisor")).toBe("advisor");
		expect(displayAgentName("search")).toBe("search");
	});
});

describe("compactActivity", () => {
	test("prefers permission, then explicit progress, then tool activity, then a thought", () => {
		expect(compactActivity({
			status: "waiting_permission",
			milestones: ["⛔ bash: git fetch origin"],
			activity: ["→ read path"],
		})).toContain("git fetch origin");

		expect(compactActivity({
			status: "running",
			progress: "Comparing public API",
			milestones: ["Comparing public API"],
			activity: ["Reading src/index.ts"],
		})).toBe("Comparing public API");

		expect(compactActivity({
			status: "running",
			milestones: ["started"],
			activity: ["Finding **/*", "Reading .git/refs/heads/main"],
			filesRead: ["a", "b", "c"],
		})).toBe("Reading .git/refs/heads/main · 3 files");

		expect(compactActivity({
			status: "running",
			milestones: [],
			activity: ["✻ comparing the public API"],
		})).toBe("comparing the public API");
	});
});

describe("ambient ownership", () => {
	test("hides the overview for a single foreground run", () => {
		expect(selectAmbientRuns([run({ id: "a", agent: "advisor", status: "running" })])).toEqual([]);
	});

	test("shows background, concurrent, permission, and unacked completions", () => {
		const background = run({ id: "b", agent: "search", status: "running", background: true });
		expect(selectAmbientRuns([background])).toEqual([background]);

		const two = [
			run({ id: "a", agent: "advisor", status: "running" }),
			run({ id: "c", agent: "search", status: "running" }),
		];
		expect(selectAmbientRuns(two)).toHaveLength(2);

		const waiting = run({ id: "w", agent: "advisor", status: "waiting_permission" });
		expect(selectAmbientRuns([waiting])).toEqual([waiting]);

		const ready = run({ id: "r", agent: "search", status: "completed", background: true, acknowledged: false });
		expect(selectAmbientRuns([ready])).toEqual([ready]);
		expect(ambientHeadline([ready])).toBe("✓ 1 result ready");
	});
});

describe("semantic counts", () => {
	test("counts a schema report only when the conversation already contains the full report", () => {
		const sharedPrefix = "## Verdict\n" + "same opening ".repeat(10);
		const messages = [{ role: "assistant" as const, text: `${sharedPrefix}\nold conclusion` }];
		expect(semanticItemCount({ messages, pendingMessages: 0, finalText: `${sharedPrefix}\nnew conclusion` })).toBe(2);
		expect(semanticItemCount({ messages, pendingMessages: 0, finalText: `${sharedPrefix}\nold conclusion` })).toBe(1);
		expect(semanticItemCount({ messages: [], pendingMessages: 0, finalText: "## Verdict\nLooks good" })).toBe(1);
		expect(transcriptContains(messages, `${sharedPrefix}\nold conclusion`)).toBe(true);
		expect(transcriptContains(messages, `${sharedPrefix}\nnew conclusion`)).toBe(false);
	});
});

describe("attention grouping", () => {
	test("orders needs input before working, ready, and history", () => {
		const waiting = run({ id: "w", agent: "advisor", status: "waiting_permission" });
		const working = run({ id: "a", agent: "search", status: "running" });
		const ready = run({ id: "r", agent: "search", status: "completed", background: true, acknowledged: false });
		const history = run({ id: "h", agent: "advisor", status: "completed", background: false, acknowledged: true });
		expect(attentionGroup(waiting)).toBe("needs_input");
		expect(groupRunsByAttention([history, working, ready, waiting]).map((section) => section.group)).toEqual([
			"needs_input", "working", "ready", "history",
		]);
	});
});
