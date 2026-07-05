# pi-subagent-core

An in-process Pi subagent runtime. It provides a headless manager and handle API for host-side orchestration.

## v0 Capabilities

- `SubagentManager`: Concurrency queues, timeouts, parent cancellation, `abortAll()`, and handle lookup.
- `SubagentHandle`: Event streams, subscriptions, `wait()`, `abort()`, `steer()`, `followUp()`, and permission resolution.
- Markdown profiles compatible with YAML frontmatter role cards.
- `fresh`, `selected`, and `fork` context modes with files, diffs, text packets, and independent fork sessions.
- Write globs and bash allowlist, denylist, or disabled policies enforced by an inline child extension.
- Supervisor escalation with fail-closed timeouts.
- Text and TypeBox schema output contracts with `submit_result` and final-text JSON fallback.
- Mechanical disclosure and usage collection from child events and assistant usage.
- Profile, task, event, result, and transcript artifacts.
- Depth-derived `spawnChild()` with `maxDepth` recursion protection.
- Injectable credential concurrency keys for per-credential throttling.

Core neither imports nor names workflow consumers. TUI extensions, preset role cards,
workflow adapters, and cross-host background recovery belong in separate packages or hosts.

## Usage

```ts
import { SubagentManager } from "pi-subagent-core";

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

## Profile

```md
---
name: reviewer
description: Reviews a focused change
model: fast
tools: [read, grep, bash]
contextMode: selected
maxTurns: 6
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

See [docs/design.md](docs/design.md) for the complete design and roadmap.
