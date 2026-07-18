# pi-subagent-ux

Host-side UX integration for Pi subagents. Built-in role cards are replaceable data and contain no runtime implementation.

```ts
import { loadBuiltInAgent } from "pi-subagent-ux";

const reviewer = await loadBuiltInAgent("reviewer");
```

Built-in agents: `oracle`, `worker`, `scout`, `reviewer`.

## The `subagent` tool

Parameters:

- `agent`, `task` — the role card (built-in name or `.md` path) and its task.
- `files`, `includeDiff` — inject selected files and/or the current working-tree diff (working tree vs `HEAD`) into the context packet.
- `inheritConversation` — fork the current conversation into the subagent so it inherits parent context. Overrides the agent's context mode to `fork` and requires a persisted session. This is how Oracle does a plan review with the original conversation.
- `writeScope` — restrict the subagent's writes to these globs (relative to cwd).
- `maxTurns` — cap the run's turn budget.
- `background` — start the run and return immediately with a run id; the live overview keeps updating. Fetch the result later with `subagent_result { id, wait? }`.

`subagent_result` returns the full summary when the run is terminal or `wait: true`; otherwise it returns current status and recent milestones.

## `/subagents`

- `/subagents` lists this session's runs, each with its run id and artifacts directory.
- `/subagents abort <id>` aborts a specific run.

## Configuration

User-scoped settings live in `~/.pi/agent/subagent-kit.json` (or the agent directory selected by `PI_CODING_AGENT_DIR`):

```json
{
  "agents": { "oracle": { "model": "gpt-5.5" } },
  "oracleGuidance": true,
  "artifactsDir": "./.pi/subagent-runs",
  "retentionDays": 14,
  "maxRuns": 200
}
```

- `agents.<name>.model` — per-agent model override. A bare model ID or name must match exactly one authenticated model; use `provider/model-id` to disambiguate. An unavailable or ambiguous target fails the run. Unconfigured agents keep their role-card and parent-model fallback (via the `strong-reasoning` alias). Model resolution runs through core's injected `resolveModel` (`createModelResolver`, exported for third-party hosts).
- `oracleGuidance` — set `false` to stop injecting the Oracle consultation policy into the parent system prompt (default `true`).
- `artifactsDir` — override the artifacts location (relative paths resolve against cwd). By default runs are stored globally under `<agentDir>/subagent-runs/<project-slug>-<hash>`, so they no longer clutter the project tree.
- `retentionDays` / `maxRuns` — lazy retention. On first use per project, run directories older than `retentionDays` are pruned (0 disables age pruning), then the newest survivors are trimmed to `maxRuns`. Cleanup never fails a spawn.

## Oracle workflow

- `/oracle <question>` asks Oracle for a second opinion and includes the current Git diff.
- For plan review, call `subagent` with `agent: "oracle"` and `inheritConversation: true` to fork the original conversation into the read-only reasoner.
- Oracle results expose `verdict`, `confidence`, and a full Markdown report for rendering and routing. The output contract is the shared `oracleReportSchema` exported from `pi-subagent-ux`.
