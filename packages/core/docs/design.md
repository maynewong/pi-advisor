# pi-subagent-core Design v0.1

Date: 2026-07-05

`pi-subagent-core` is the lowest-level, in-process SDK runtime for Pi subagents.
Custom roles, UX integrations, and workflow composition build on this package.

## 1. Goals and Non-Goals

### Goals

1. Provide a headless library that spawns an in-process child agent and returns
   an observable, controllable handle.
2. Treat profiles, permissions, context modes, output contracts, usage, and cost
   as runtime concepts rather than host conventions.
3. Keep policy boundaries injectable: model resolution, permission rules,
   workspace provisioning, event consumption, and artifacts can be replaced.
4. Expose stable runtime, result, and event contracts for external adapters.
5. Keep Core independent from UX packages and workflow consumers.

### Non-goals

- TUI components and live cards
- Cross-machine or container isolation
- Read-session retrieval and timeline reasoning
- Multi-worker merge coordination
- Product-specific workflow adapters

## 2. Design Principles

The runtime follows several agent-as-tool principles:

| Principle | Implementation |
| --- | --- |
| Context isolation | Each child owns an independent `AgentSession`. |
| Structured return | The handle returns a `SubagentResult`; full transcripts stay in artifacts. |
| Model routing | Hosts may inject `resolveModel`; Core also accepts concrete models and registry IDs. |
| Layered permissions | Tool selection is the first boundary; the injected permission gate is the second. |
| Role reuse | Profiles are data, so a host can spawn the same role for many tasks. |
| Mechanical disclosure | File and command disclosure comes from tool lifecycle events, never model self-reporting. |
| Supervisor control | A host can steer, follow up, abort, and resolve permission escalations. |

## 3. Package Architecture

```text
pi-subagent-kit/
  packages/
    core/                pi-subagent-core
      src/runtime/       manager, handles, SDK driver
      src/profile/       profile types and Markdown loader
      src/permission/    permission evaluation and escalation
      src/context/       selected-context packet construction
      src/output/        output contract resolution
      src/artifacts/     persisted run evidence
      src/workspace/     optional workspace provisioning
    ux/                  pi-subagent-ux
      agents/            built-in role cards
      extensions/        Pi extension integration
```

The dependency direction is strict:

```text
pi-subagent-ux -> pi-subagent-core
```

Core must not import UX, a workflow package, or product-specific adapters.

## 4. Public API

### 4.1 Profiles

```ts
interface SubagentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  model?: ModelSpec;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  permission?: PermissionPolicy;
  contextMode?: "fresh" | "fork" | "selected";
  output?: OutputContract;
  skills?: string[];
  maxTurns?: number;
  timeoutMs?: number;
}
```

The profile loader reads Markdown with YAML frontmatter. The body becomes the
system prompt. Profile discovery is a host concern; Core does not hard-code an
agent directory.

### 4.2 Manager

```ts
interface SubagentManagerOptions {
  cwd: string;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  resolveModel?: (spec: ModelSpec, profile: SubagentProfile) => Promise<Model>;
  maxConcurrent?: number;
  maxConcurrentPerKey?: number;
  resolveConcurrencyKey?: (profile: SubagentProfile) => string | undefined;
  maxDepth?: number;
  artifactsDir?: string;
  createDriver?: RuntimeDriverFactory;
  workspaceProvider?: WorkspaceProvider;
}

class SubagentManager {
  spawn(profile: SubagentProfile, task: string, options?: SpawnOptions): SubagentHandle;
  spawnChild(parentId: string, profile: SubagentProfile, task: string, options?: SpawnOptions): SubagentHandle;
  get(id: string): SubagentHandle | undefined;
  list(): SubagentHandle[];
  abortAll(): Promise<void>;
}
```

`cwd` is mandatory. An in-process multi-agent runtime must never rely on
`process.cwd()` as hidden global state.

### 4.3 Spawn Options

```ts
interface SpawnOptions {
  context?: ContextInput;
  signal?: AbortSignal;
  runMode?: "foreground" | "background";
  overrides?: Partial<SubagentProfile>;
  metadata?: Record<string, unknown>;
  depth?: number;
  workspace?: WorkspaceRequest;
}
```

Profile overrides apply to one run. Metadata is copied to start events and can
be used by a host to correlate runs.

### 4.4 Handle

```ts
interface SubagentHandle {
  readonly id: string;
  readonly profile: SubagentProfile;
  readonly status: SubagentStatus;
  readonly usage: UsageSnapshot;
  readonly events: AsyncIterable<SubagentEvent>;
  subscribe(listener: (event: SubagentEvent) => void): () => void;
  steer(message: string): void;
  followUp(message: string): void;
  abort(): Promise<void>;
  resolveEscalation(id: string, decision: "allow" | "deny"): boolean;
  wait(): Promise<SubagentResult>;
}
```

`wait()` always resolves with a terminal result. Runtime failures are data in
the result rather than rejected promises.

### 4.5 Events

The event stream is a reduced projection of child session events:

- `started`
- `turn`
- `tool_call`
- `tool_result`
- `file_read`
- `file_write`
- `permission_blocked`
- `escalation`
- `progress`
- `completed`
- `failed`
- `aborted`
- `timeout`

Full message content is deliberately excluded to avoid polluting a supervisor's
context. When artifacts are enabled, the same projected events are appended to
`events.jsonl`.

### 4.6 Result

```ts
interface SubagentResult {
  status: "completed" | "failed" | "aborted" | "timeout";
  output?: unknown;
  text: string;
  error?: {
    message: string;
    kind: "model" | "tool" | "timeout" | "aborted" | "protocol" | "max_turns";
  };
  usage: UsageSnapshot;
  disclosure: {
    filesRead: string[];
    filesModified: string[];
    commandsRun: string[];
    contextSources: string[];
    truncated: string[];
  };
  artifacts?: ArtifactReferences;
  sessionRef?: { file?: string };
  workspace?: { path: string; retained: boolean };
}
```

Disclosure is derived from successful tool completion events. A denied or
failed write must never appear in `filesModified`.

## 5. Permission Gate

Every child receives an inline extension factory that intercepts `tool_call`
events before tool execution. The gate can allow the call, block it with a
reason, or suspend it while waiting for a supervisor decision.

```ts
interface PermissionPolicy {
  write?: { allow: string[]; deny?: string[] };
  bash?: {
    allow?: string[];
    deny?: string[];
    mode: "allowlist" | "denylist" | "off";
  };
  onViolation?: "block" | "escalate";
  escalationTimeoutMs?: number;
}
```

Tool selection remains the first security boundary. Read-only profiles should
not receive mutation tools. The permission gate is defense in depth and
provides path- and command-level policy.

Write paths are resolved relative to the explicit run directory. The run
directory (cwd) boundary is enforced unconditionally for `edit` and `write`:
even a profile that omits `write` may not escape cwd. When `write` is present,
its `deny` and `allow` globs (matched with minimatch) further scope writes;
when `write` is absent, any path inside cwd is writable. Escalation timeouts
fail closed.

Bash commands are matched with prefix-token semantics, not path globs. A
pattern's tokens are compared on whitespace-normalized boundaries; a trailing
`*` means "these leading tokens followed by any further arguments" (`git diff*`
matches `git diff --stat` but not `git difftool`). In `allowlist` mode a
command containing shell control or metacharacters (`;`, `&&`, `||`, `|`,
`$(`, backtick, `>`, `<`, `&`, newline) can never match an allowlist entry and
is blocked as a compound command. In `denylist` mode `deny` patterns are
matched against the whole command and against each chained segment.

Denylist mode is protection against accidental destructive commands, not a
defense against an adversarial model: a model that intends to bypass it can
compose commands the denylist does not enumerate. Real isolation comes from
tool selection and, where needed, workspace or container boundaries.

## 6. Context Modes

| Mode | Behavior | Typical use |
| --- | --- | --- |
| `fresh` | Start an independent in-memory session with the task. | Scout, Oracle |
| `selected` | Build a bounded context packet from explicit files, diffs, and text. | Review, focused investigation |
| `fork` | Fork an explicit parent session file and optional entry. | Continuation with inherited conversation context |

```ts
interface ContextInput {
  files?: string[];
  diff?: string | { base: string };
  text?: string[];
  forkFrom?: { sessionFile: string; entryId?: string };
}
```

Child resource loading disables ambient extensions, context files, skills, and
prompt templates. A profile may explicitly add skill paths. This prevents host
extensions from recursively loading inside a child.

Selected files are size bounded. Truncation is disclosed in the result.

## 7. Output Contracts

```ts
type OutputContract =
  | { kind: "text" }
  | { kind: "schema"; schema: TSchema; toolName?: string };
```

Schema mode registers a custom output tool, defaulting to `submit_result`. The
driver appends that tool to the active tool list even when a profile provides an
explicit allowlist. Without this rule, the custom tool would be registered but
unavailable to the model.

Calling the output tool validates and captures structured data. If the model
does not call it, the resolver may parse final-text JSON. A missing or invalid
result becomes a `protocol` failure.

## 8. Driver Failure Semantics

The Pi SDK can represent provider and authentication failures as an assistant
message with `stopReason: "error"`. The driver must inspect the final assistant
message and return a `model` failure rather than treating empty text as success.

The driver also preserves transcripts and usage on failures. The manager writes
those artifacts before completing the handle.

Turn-budget exhaustion has the distinct `max_turns` kind. It must not be
collapsed into a generic model error.

## 9. Runtime Constraints

1. One run owns one `AgentSession`; active sessions are never reused.
2. Child extensions are disabled except for explicitly injected factories.
3. Nested spawning is depth bounded.
4. Model registry and authentication objects are shared read-only.
5. The runtime does not configure process-wide HTTP dispatchers.
6. Every filesystem operation uses an explicit run directory.
7. Parent abort signals propagate to children.
8. Timeout calls `abort()` and resolves as `timeout`.
9. Concurrency can be limited globally and per injected credential key.
10. Unknown models fail with an explicit result rather than an empty success.

## 10. Workspace Isolation

The default workspace provider can provision a Git worktree for a run. The
result reports the path and whether it was retained. Cleanup failures become
tool failures so that isolation errors are not hidden.

Workspace providers are injected, allowing hosts to add containers or other
isolation without changing Core.

## 11. Artifacts

When `artifactsDir` is configured, each run writes:

```text
<artifactsDir>/<runId>/
  profile.json
  task.md
  events.jsonl
  result.json
  transcript.md
```

`transcript.md` is written for completed runs and model failures that reached a
session. Failed runs need transcripts most, so artifact persistence must not be
limited to the success path.

Artifact write or workspace cleanup failures update the final result rather
than disappearing into logs.

`pruneSubagentRuns(dir, { retentionDays, maxRuns })` is a policy-free retention
helper: it deletes run directories older than `retentionDays` (0 disables age
pruning) and then trims the newest survivors down to `maxRuns`. Core takes only
explicit parameters; where the bucket lives and when to prune are host
decisions.

## 12. UX Integration

`pi-subagent-ux` owns host-facing integration:

- The `subagent` tool
- The `/subagents` command
- Built-in Oracle, Worker, Scout, and Reviewer profiles
- Streaming progress projection
- Host UI notifications

The UX package imports only public exports from Core. It must never import
`packages/core/src/*` or other private paths. This package boundary is the same
contract available to third-party integrations.

## 13. Implemented Scope

The current implementation includes:

- Manager and observable handles
- Global and credential-key concurrency limits
- Timeout, abort, steering, and follow-up
- Fresh, selected, and fork contexts
- Permission blocking and supervisor escalation
- Text and schema outputs
- Accurate model-error and turn-budget failures
- Successful-operation disclosure
- Artifacts and persisted run history
- Nested spawning with depth limits
- Optional Git worktree isolation
- Built-in UX role cards and a Pi extension

Future packages may add read-session retrieval, durable cross-host background
runs, or multi-worker merge coordination. Those capabilities must depend on
Core's public API rather than expanding Core with product-specific policy.

## 14. Verification Requirements

Changes are complete only when all of the following hold:

1. Unit tests pass in every workspace.
2. TypeScript checks pass in every workspace.
3. Package dry runs contain only intended files.
4. Core has no dependency on UX or workflow consumers.
5. Schema output works without manually adding `submit_result` to a profile.
6. Model stream errors produce failed results with transcripts.
7. Blocked or failed writes do not pollute disclosure.
8. Timeout, abort, escalation, and max-turn paths reach terminal states.
