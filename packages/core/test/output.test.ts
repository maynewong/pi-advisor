import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { resolveOutput } from "../src/output/resolveOutput.ts";

describe("resolveOutput", () => {
	test("uses submitted structured output when it matches the contract", () => {
		const contract = { kind: "schema" as const, schema: Type.Object({ answer: Type.String() }) };
		expect(resolveOutput(contract, "ignored", { answer: "ok" })).toEqual({ output: { answer: "ok" } });
	});

	test("falls back to a JSON object in final text", () => {
		const contract = { kind: "schema" as const, schema: Type.Object({ count: Type.Number() }) };
		expect(resolveOutput(contract, "Result: {\"count\":2}")).toEqual({ output: { count: 2 } });
	});

	test("accepts an array JSON root in final text", () => {
		const contract = { kind: "schema" as const, schema: Type.Array(Type.String()) };
		expect(resolveOutput(contract, "[\"one\",\"two\"]")).toEqual({ output: ["one", "two"] });
	});

	test("returns a protocol error when no valid value exists", () => {
		const contract = { kind: "schema" as const, schema: Type.Object({ count: Type.Number() }) };
		expect(resolveOutput(contract, "not json")).toMatchObject({ error: { kind: "protocol" } });
	});
});
