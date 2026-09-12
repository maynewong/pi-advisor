# pi-advisor-core

A headless runtime for isolated Pi Advisor reviews. It provides manager and handle APIs for host-side orchestration.

## v0 Capabilities

- `SubagentManager`: Concurrency queues, timeouts, parent cancellation, `abortAll()`, and handle lookup.
- `SubagentHandle`: Event streams, subscriptions, `wait()`, `abort()`, `steer()`, `followUp()`, and permission resolution.
- Markdown profiles compatible with YAML frontmatter role cards.
- `fresh`, `selected`, and `fork` context modes with files, diffs, text packets, and independent fork sessions.
- Write globs plus an unconditional cwd boundary, and bash allowlist, denylist, or disabled policies enforced by an inline child extension. Bash matching is prefix-token aware; allowlist mode rejects compound commands, and denylist mode also inspects each chained segment (accident protection, not adversary defense).
- `pruneSubagentRuns(dir, { retentionDays, maxRuns })`: policy-free retention for an artifacts bucket.
- Supervisor escalation with fail-closed timeouts.
- Text and TypeBox schema output contracts with `submit_result` and final-text JSON fallback.
- Mechanical disclosure and usage collection from child events and assistant usage.
- Profile, task, event, result, and transcript artifacts.
- Depth-derived `spawnChild()` with `maxDepth` recursion protection.
- Injectable credential concurrency keys for per-credential throttling.
- A versioned Runtime Provider SPI for independently installed execution backends, with capability checks, provider/target selection, discovery helpers, model-resolution boundaries, and provider-defined concurrency keys.

Core neither imports nor names workflow consumers. TUI extensions, preset role cards,
workflow adapters, remote execution transports, and cross-host background recovery belong in separate packages or hosts. `Subagent*` API names are stable runtime protocol names, not the Pi Advisor product brand.

## Usage

```ts
import { SubagentManager } from "pi-advisor-core";

const manager = new SubagentManager({
  cwd: "/absolute/project/path",
  maxConcurrent: 4,
	maxConcurrentPerKey: 1,
	resolveConcurrencyKey: (profile) => String(profile.model),
  artifactsDir: "/absolute/artifacts/path",
});

const handle = manager.spawn({
  name: "reviewer",
  description: "Reviews a focused change",
  systemPrompt: "Review only the supplied evidence.",
  model: "anthropic/claude-sonnet-4-5",
  tools: ["read", "grep", "bash"],
  permission: {
    bash: { mode: "allowlist", allow: ["git diff*", "npm test*"] },
  },
  contextMode: "selected",
  contextMaxBytes: 128_000,
  timeoutMs: 120_000,
}, "Review this change", {
  context: { files: ["src/index.ts"], diff: { base: "main" } },
});

for await (const event of handle.events) {
  console.log(event);
}

const result = await handle.wait();
```

Forked children require an explicit parent session file:

```ts
manager.spawn({ ...profile, contextMode: "fork" }, "Continue the task", {
  context: { forkFrom: { sessionFile: "/sessions/parent.jsonl", entryId: "entry-id" } },
});
```

Model aliases such as `fast` and `strong` must be resolved through the manager's injected `resolveModel` function.
An injected `ModelRegistry` can resolve `provider/model-id` references.

## External Runtime Providers

Third-party Pi extensions can implement `RuntimeDriverProvider` without adding transport-specific code to Core. Providers register on Pi's shared event bus:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerRuntimeProvider,
  type RuntimeDriverProvider,
} from "pi-advisor-core";

const provider: RuntimeDriverProvider = {
  id: "example-runtime",
  apiVersion: 1,
  displayName: "Example Runtime",
  capabilities: {
    resume: false,
    steer: false,
    followUp: false,
    contextModes: ["fresh", "selected"],
    modelResolution: "provider",
    policyEnforcement: "adapter",
    structuredOutput: false,
  },
  async create(selection, request, host) {
    return {
      async run() {
        host.emit({ type: "progress", text: `Running ${selection.target ?? "default"}` });
        return { text: await runSomewhere(request.prompt) };
      },
      async abort() {},
    };
  },
};

export default function (pi: ExtensionAPI) {
  registerRuntimeProvider(pi.events, provider);
}
```

The host owns Context Packet construction, output validation, artifacts, timeout, and UX. Providers own target resolution and execution transport. Provider configuration and secrets must stay outside the Kit config.

## Profile

```md
---
name: reviewer
description: Reviews a focused change
model: fast
tools: [read, grep, bash]
contextMode: selected
maxTurns: 6
contextMaxBytes: 128000
timeoutMs: 120000
permission:
  bash:
    mode: allowlist
    allow: [git diff*, npm test*]
---
Review only the supplied evidence and report concrete findings.
```

## Development

```bash
npm test
npm run typecheck
```
