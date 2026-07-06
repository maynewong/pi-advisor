# pi-subagent-ux

Host-side UX integration for Pi subagents. Built-in role cards are replaceable data and contain no runtime implementation.

```ts
import { loadBuiltInAgent } from "pi-subagent-ux";

const reviewer = await loadBuiltInAgent("reviewer");
```

## Per-agent models

Override role-card models for the current user in
`~/.pi/agent/subagent-kit.json` (or the agent directory selected by `PI_CODING_AGENT_DIR`):

```json
{
  "agents": {
    "oracle": {
      "model": "gpt-5.5"
    },
    "oracle-plan": {
      "model": "gpt-5.5"
    }
  }
}
```

A bare model ID or name must match exactly one authenticated model. If multiple providers expose the
same ID, use `provider/model-id` to make the choice explicit. An unavailable or ambiguous override fails
before the child session starts. Unconfigured agents retain their role-card and parent-model fallback behavior.

## Oracle workflow

- `/oracle <question>` asks the standard Oracle for a second opinion and includes the current Git diff.
- `oracle-plan` uses a forked parent session for plan reviews that need the original conversation.
- Oracle results expose `verdict`, `confidence`, and a full Markdown report for rendering and routing.
