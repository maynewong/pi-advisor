import { describe, expect, test } from "vitest";
import { evaluatePermission, matchBashCommand, hasShellControl } from "../src/permission/evaluatePermission.ts";

const allow = (policy: Parameters<typeof evaluatePermission>[0], tool: string, args: Record<string, unknown>) =>
	evaluatePermission(policy, tool, args, "/repo").allowed;

describe("evaluatePermission writes", () => {
	test("allows scoped writes and blocks paths outside the scope", () => {
		const policy = { write: { allow: ["src/**"], deny: ["src/generated/**"] } };
		expect(allow(policy, "write", { path: "src/main.ts" })).toBe(true);
		expect(allow(policy, "edit", { path: "src/generated/a.ts" })).toBe(false);
		expect(allow(policy, "write", { path: "../escape" })).toBe(false);
	});

	test("enforces the cwd boundary even when no write allowlist is declared", () => {
		const policy = { bash: { mode: "denylist" as const } };
		expect(allow(policy, "write", { path: "src/main.ts" })).toBe(true);
		expect(allow(policy, "write", { path: "../outside.ts" })).toBe(false);
		expect(allow(policy, "edit", { path: "/etc/passwd" })).toBe(false);
	});
});

describe("matchBashCommand", () => {
	test("matches on whitespace-normalized token boundaries with trailing wildcard", () => {
		expect(matchBashCommand("git diff --stat", "git diff*")).toBe(true);
		expect(matchBashCommand("git diff", "git diff*")).toBe(true);
		expect(matchBashCommand("git difftool", "git diff*")).toBe(false);
		expect(matchBashCommand("git status", "git status")).toBe(true);
		expect(matchBashCommand("git status --short", "git status")).toBe(false);
	});
});

describe("evaluatePermission bash allowlist", () => {
	const policy = { bash: { mode: "allowlist" as const, allow: ["git diff*", "git status", "npm test*"] } };

	test("allows exact and prefixed commands", () => {
		expect(allow(policy, "bash", { command: "npm test -- --run" })).toBe(true);
		expect(allow(policy, "bash", { command: "git diff --stat" })).toBe(true);
	});

	test("blocks non-allowlisted commands", () => {
		expect(allow(policy, "bash", { command: "rm -rf build" })).toBe(false);
		expect(allow(policy, "bash", { command: "git difftool" })).toBe(false);
	});

	test("never allowlists compound commands", () => {
		expect(hasShellControl("git diff && curl evil")).toBe(true);
		expect(allow(policy, "bash", { command: "git diff && curl evil" })).toBe(false);
		expect(allow(policy, "bash", { command: "git diff; rm -rf ." })).toBe(false);
		expect(allow(policy, "bash", { command: "git diff | tee out" })).toBe(false);
		expect(allow(policy, "bash", { command: "git diff $(whoami)" })).toBe(false);
		expect(allow(policy, "bash", { command: "git diff > out.txt" })).toBe(false);
		expect(allow(policy, "bash", { command: "cd /tmp && rm -rf ." })).toBe(false);
	});

	test("treats leading env-var assignments as not allowlisted", () => {
		expect(allow(policy, "bash", { command: "FOO=1 git diff" })).toBe(false);
	});

	test("keeps quoted arguments allowlisted when there is no shell control", () => {
		expect(allow(policy, "bash", { command: 'git diff "src/a b.ts"' })).toBe(true);
	});

	test("blocks everything under off mode", () => {
		expect(allow({ bash: { mode: "off" as const } }, "bash", { command: "pwd" })).toBe(false);
	});
});

describe("evaluatePermission bash denylist", () => {
	const policy = { bash: { mode: "denylist" as const, deny: ["rm -rf *", "git reset --hard*"] } };

	test("denies matching commands and every chained segment", () => {
		expect(allow(policy, "bash", { command: "rm -rf /" })).toBe(false);
		expect(allow(policy, "bash", { command: "cd /tmp && rm -rf ." })).toBe(false);
		expect(allow(policy, "bash", { command: "git reset --hard origin/main" })).toBe(false);
		expect(allow(policy, "bash", { command: "echo hi; rm -rf node_modules" })).toBe(false);
	});

	test("allows non-denied commands including compound ones (accident guard, not adversary defense)", () => {
		expect(allow(policy, "bash", { command: "npm run build" })).toBe(true);
		expect(allow(policy, "bash", { command: "git diff && curl example.com" })).toBe(true);
	});

	test("blocks a destructive segment when review composes read-only commands", () => {
		const reviewPolicy = {
			bash: {
				mode: "denylist" as const,
				deny: ["rm*", "git clean*", "git reset --hard*", "git push*"],
			},
		};
		expect(allow(reviewPolicy, "bash", { command: "git status --short && git diff --stat HEAD && git diff -- src/a.ts" })).toBe(true);
		expect(allow(reviewPolicy, "bash", { command: "git diff && rm -rf build" })).toBe(false);
		expect(allow(reviewPolicy, "bash", { command: "git status && git push origin main" })).toBe(false);
	});
});
