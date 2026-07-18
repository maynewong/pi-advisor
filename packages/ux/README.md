# pi-subagent-ux

Host-side UX integration for Pi subagents. Built-in role cards are replaceable data and contain no runtime implementation.

```ts
import { loadBuiltInAgent } from "pi-subagent-ux";

const reviewer = await loadBuiltInAgent("reviewer");
```

Built-in agents: `oracle`, `search`, `reviewer`, and `worker`.

## Tools

Each built-in role that the parent should reach for directly is registered as its own dedicated tool, so the tool description is the trigger surface:

- `oracle` — read-only second opinion returning a verdict, confidence, and Markdown report. Params: `task`, `files?`, `inheritConversation?`, `includeDiff?` (defaults to **true**; set `false` to opt out), `background?`.
- `search` — fast read-only repository reconnaissance; use before grepping around yourself when the search is non-trivial. Params: `task`, `files?`, `background?`.
- `reviewer` — adversarial review of a diff/change for concrete bugs, regressions, and missing tests. Params: `task`, `files?`, `includeDiff?` (defaults to **true**), `background?`.

The generic `subagent` tool is primarily for custom profile `.md` paths — including the bundled `worker` card for scoped implementation, which has no dedicated tool. Params:

- `agent`, `task` — the role card (a `.md` path, or any built-in name) and its task.
- `files`, `includeDiff` — inject selected files and/or the current working-tree diff (working tree vs `HEAD`) into the context packet.
- `inheritConversation` — fork the current conversation into the subagent so it inherits parent context. Overrides the agent's context mode to `fork` and requires a persisted session.
- `writeScope` — restrict the subagent's writes to these globs (relative to cwd). Use this when delegating to the `worker` card so writes stay inside the intended blast radius.
- `maxTurns` — cap the run's turn budget.
- `background` — start the run and return immediately with a run id; the live overview keeps updating. Fetch the result later with `subagent_result { id, wait? }`.

`subagent_result` returns the full summary when the run is terminal or `wait: true`; otherwise it returns current status and recent milestones. It also returns the latest result after a run is continued with `subagent_send`.

`subagent_send { id, message, wait? }` sends a follow-up to an existing run in this session. A **running** run is redirected mid-flight (steered) and the tool returns immediately; the run's own result still surfaces via its original call or `subagent_result`. A **completed** run is continued with a new turn on its retained session, and unless `wait: false` the tool blocks and returns the new result. Runs that ended as failed, aborted, or timed out cannot be continued.

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
- `oracleGuidance` — accepted for backwards compatibility but no longer has any effect. The Oracle consultation policy now lives in the dedicated `oracle` tool description instead of being injected into the parent system prompt.
- `artifactsDir` — override the artifacts location (relative paths resolve against cwd). By default runs are stored globally under `<agentDir>/subagent-runs/<project-slug>-<hash>`, so they no longer clutter the project tree.
- `retentionDays` / `maxRuns` — lazy retention. On first use per project, run directories older than `retentionDays` are pruned (0 disables age pruning), then the newest survivors are trimmed to `maxRuns`. Cleanup never fails a spawn.

## Oracle workflow

- `/oracle <question>` asks Oracle for a second opinion and includes the current Git diff.
- Prefer the dedicated `oracle` tool; it includes the working-tree diff by default. For plan review, pass `inheritConversation: true` to fork the original conversation into the read-only reasoner.
- Oracle results expose `verdict`, `confidence`, and a full Markdown report for rendering and routing. The output contract is the shared `oracleReportSchema` exported from `pi-subagent-ux`.
