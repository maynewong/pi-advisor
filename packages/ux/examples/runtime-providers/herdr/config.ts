import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexReasoningEffort, HerdrAdvisorTarget } from "./provider.ts";

export const HERDR_ADVISOR_CONFIG_ENV = "PI_HERDR_ADVISOR_CONFIG";
export const DEFAULT_HERDR_ADVISOR_CONFIG_PATH = join(homedir(), ".config", "pi-advisor", "herdr-advisor.json");

interface ConfiguredTarget {
	label?: unknown;
	agent?: unknown;
	model?: unknown;
	reasoningEffort?: unknown;
}

function targetFrom(id: string, value: unknown, path: string): HerdrAdvisorTarget {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) throw new Error(`Invalid Herdr Advisor target id in ${path}: ${JSON.stringify(id)}`);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Herdr Advisor target ${id} in ${path} must be an object`);
	const target = value as ConfiguredTarget;
	if (target.agent !== "grok" && target.agent !== "codex") {
		throw new Error(`Herdr Advisor target ${id} in ${path} requires agent "grok" or "codex"`);
	}
	if (typeof target.model !== "string" || !target.model.trim()) {
		throw new Error(`Herdr Advisor target ${id} in ${path} requires a non-empty model`);
	}
	if (target.reasoningEffort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"].includes(String(target.reasoningEffort))) {
		throw new Error(`Herdr Advisor target ${id} in ${path} has invalid reasoningEffort`);
	}
	if (target.reasoningEffort === undefined) {
		throw new Error(`${target.agent === "codex" ? "Codex" : "Grok"} target ${id} in ${path} requires reasoningEffort`);
	}
	if (target.label !== undefined && (typeof target.label !== "string" || !target.label.trim())) {
		throw new Error(`Herdr Advisor target ${id} in ${path} has invalid label`);
	}
	return {
		id,
		label: typeof target.label === "string" ? target.label.trim() : `${target.agent === "codex" ? "Codex" : "Grok"} · ${target.model.trim()} · ${String(target.reasoningEffort)}`,
		mode: "local-pane",
		agent: target.agent,
		model: target.model.trim(),
		...(target.reasoningEffort !== undefined ? { reasoningEffort: target.reasoningEffort as CodexReasoningEffort } : {}),
	};
}

export function parseHerdrAdvisorConfig(raw: unknown, path = "Herdr Advisor config"): HerdrAdvisorTarget[] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must be a JSON object`);
	const targets = (raw as Record<string, unknown>).targets;
	if (!targets || typeof targets !== "object" || Array.isArray(targets)) throw new Error(`${path} requires a targets object`);
	return Object.entries(targets as Record<string, unknown>).map(([id, value]) => targetFrom(id, value, path));
}

export function loadHerdrAdvisorConfig(path = process.env[HERDR_ADVISOR_CONFIG_ENV] || DEFAULT_HERDR_ADVISOR_CONFIG_PATH): HerdrAdvisorTarget[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return parseHerdrAdvisorConfig(JSON.parse(raw), path);
}
