import { describe, expect, test } from "vitest";
import { evaluatePermission } from "../src/permission/evaluatePermission.ts";

describe("evaluatePermission", () => {
	test("allows scoped writes and blocks paths outside the scope", () => {
		const policy = { write: { allow: ["src/**"], deny: ["src/generated/**"] } };
		expect(evaluatePermission(policy, "write", { path: "src/main.ts" }, "/repo").allowed).toBe(true);
		expect(evaluatePermission(policy, "edit", { path: "src/generated/a.ts" }, "/repo").allowed).toBe(false);
		expect(evaluatePermission(policy, "write", { path: "../escape" }, "/repo").allowed).toBe(false);
	});

	test("enforces bash allowlists and off mode", () => {
		expect(evaluatePermission({ bash: { mode: "allowlist", allow: ["git status", "npm test*"] } }, "bash", { command: "npm test -- --run" }, "/repo").allowed).toBe(true);
		expect(evaluatePermission({ bash: { mode: "allowlist", allow: ["git status"] } }, "bash", { command: "rm -rf build" }, "/repo").allowed).toBe(false);
		expect(evaluatePermission({ bash: { mode: "off" } }, "bash", { command: "pwd" }, "/repo").allowed).toBe(false);
	});
});
