# Herdr local-pane Runtime Provider

Chinese installation guide: [Integrate the runtime into Pi or your own plugin](./INSTALL.zh-CN.md).

Minimal working example for running Pi Advisor through a separate Herdr pane. Two local agent kinds are implemented:

| Target | Advisor runtime | Model | Effort |
| --- | --- | --- | --- |
| `grok-4.6-high` | Grok | `grok-4.6` | `high` |
| configured alias | Grok or Codex | provider config | provider config |

Every Advisor run creates a fresh randomly named pane (`grok-advisor-<hex>` or `codex-advisor-<hex>`), so unrelated runs never share conversation history. `resume()` stays on the pane owned by that run. When Main selected a Context Packet, the provider stores that already-bounded packet in a mode-`0600` temporary file and sends only its path and source summary. The Advisor reads it on demand when the task needs diff, scoped-file, or inherited-conversation evidence.

There is no Agent Skill, local bridge model, or prompt transcript scraping. Copy the five TypeScript files below into a trusted Pi package; the JSON file is a configuration example. Install `@maynewong/pi-advisor-core` as a dependency and load the Pi Advisor main extension as well. The `herdr` CLI and the selected agent CLI (`codex` or Grok) must be on `PATH`.

| File | Role |
| --- | --- |
| [`provider.ts`](./provider.ts) | Runtime Provider: targets, capabilities, JSON contract, resume, abort |
| [`adapter.ts`](./adapter.ts) | Create a fresh Grok/Codex pane, launch the agent, prompt, wait, read, close |
| [`config.ts`](./config.ts) | Load provider-owned target/model/effort aliases from JSON |
| [`herdr-advisor.example.json`](./herdr-advisor.example.json) | Example Codex model aliases |
| [`cli.ts`](./cli.ts) | `execFile("herdr", args)` — consultation text stays one shell-free argv |
| [`extension.ts`](./extension.ts) | `registerRuntimeProvider(...)` |

`claude-code-remote` remains a documented target id only. The shipped adapter throws if you select it.

## Why the CLI is enough

Advisor packets are capped at 256KB. For local panes, the provider writes the materialized packet to a private temporary file and `herdr agent prompt <name> <text>` sends a small task plus reference message. This avoids preloading a large unrelated diff into every model turn. The file remains available for retained-session resume and is removed when the driver is disposed. You do not need a Unix-socket client or `--prompt-file`.

## Enable it

From a **Herdr-hosted Pi pane** (`HERDR_ENV=1`):

```bash
pi -e packages/ux/examples/runtime-providers/herdr/extension.ts
```

Or add the example directory as a Pi package whose `package.json` points at `extension.ts`.

### Grok Advisor

`~/.pi/agent/pi-advisor.json`:

```json
{
  "agents": {
    "advisor": {
      "runtime": {
        "provider": "herdr-advisor",
        "target": "grok-4.6-high"
      }
    }
  }
}
```

### Pi Main `gpt-5.6-sol` + a configurable Grok or Codex Advisor

Advisor model and effort selection belongs to the Runtime Provider, not Pi's model registry. Copy [`herdr-advisor.example.json`](./herdr-advisor.example.json) to `~/.config/pi-advisor/herdr-advisor.json`, then define one or more aliases:

```json
{
  "targets": {
    "grok-4.6-high": {
      "agent": "grok",
      "model": "grok-4.6",
      "reasoningEffort": "high"
    },
    "codex-astra-low": {
      "agent": "codex",
      "model": "gpt-6-astra",
      "reasoningEffort": "low"
    },
    "codex-astra-high": {
      "agent": "codex",
      "model": "gpt-6-astra",
      "reasoningEffort": "high"
    }
  }
}
```

Then select an alias from `~/.pi/agent/pi-advisor.json`:

```json
{
  "mode": "low",
  "parentModel": "gpt-5.6-sol",
  "agents": {
    "advisor": {
      "runtime": {
        "provider": "herdr-advisor",
        "target": "codex-astra-low"
      }
    }
  }
}
```

Set `PI_HERDR_ADVISOR_CONFIG` to use another provider-config path. Every Grok or Codex target requires `model` and `reasoningEffort`; accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, or `persistent` and must also be supported by the selected CLI/model. Add aliases such as `grok-4.6-high` and `codex-astra-xhigh` to switch effort through Pi Advisor profiles without changing Provider code.

`parentModel` is resolved by Pi's authenticated model registry. The Codex Advisor model is passed directly to the Codex CLI. Do not also set `agents.advisor.model`; this provider uses `modelResolution: "provider"`.

Named profiles still need complete parent, Advisor, and Search routes. A flat config such as the examples above can keep the packaged Search route.

Then run:

```text
/mode low
/advisor challenge this diff
```

Call `advisor` with `includeDiff: true` (default) and `inheritConversation: true` when the parent thread is evidence. Stable Advisor instructions are installed once at agent startup. The new pane's user message contains the task plus an optional private context-file reference; resume messages contain only the follow-up.

## Read-only enforcement

- Grok: `--permission-mode plan` plus `--deny Edit(**)`, `--deny Write(**)`, and `--deny Bash(**)`.
- Codex: `--sandbox read-only`, `--ask-for-approval never`, inherited MCP servers individually disabled, and apps/browser/computer-use/plugins disabled. Before creating the pane, the adapter runs `codex mcp list --json` in the run directory and passes `-c mcp_servers.<name>.enabled=false` for every listed server. Inventory errors or server names that cannot be safely addressed stop startup. The Advisor contract is supplied through Codex `developer_instructions`. The exact run `cwd` is trusted through a launch-only config override, avoiding the first-use dialog without modifying the user's persisted Codex config.

The Pi process and the new pane must resolve the same Codex installation and configuration (`CODEX_HOME` included). Do not change MCP configuration between inventory and launch. An empty `mcp_servers={}` override does not remove inherited servers because Codex merges configuration tables.

These are adapter-owned controls, not prompt-only policy. Machine addresses, credentials, pane ids, and launch flags stay outside `pi-advisor.json`.

## What the adapter runs

For every target:

1. generate a fresh per-run name
2. `pane split --direction right --cwd <run cwd> --no-focus`, then rename the new pane
3. poll `pane process-info` until the shell owns the foreground process group; after a short grace period, interrupt a stuck shell startup hook once, then let the interactive line editor settle and verify the shell again
4. start the selected agent with read-only launch flags and stable Advisor instructions
5. write selected context to a private temporary file when needed, then submit a lean prompt
6. poll for a completed result and require its completion marker to remain stable across repeated reads
7. parse the last matching JSON object `{ verdict, confidence, report_markdown }`; if the agent returns ordinary Markdown, preserve it with conservative `need_more_information` / `low` metadata
8. on abort send `ctrl+c`; on disposal remove temporary context and close only this run's pane

Grok uses its `Worked for` marker because minimal mode remains detection-idle while working. Codex submits without Herdr's short activity gate, then polls until a new complete Advisor JSON object is stable across repeated reads. Completion therefore does not depend on Codex's non-authoritative screen lifecycle state, and animated terminal chrome does not prevent return.

For the `codex-astra-low` example alias, the effective Codex launch is equivalent to:

```text
herdr agent start <name> --kind codex --pane <id> -- \
  -m gpt-6-astra \
  -c model_reasoning_effort="low" \
  -c 'projects."<run cwd>".trust_level="trusted"' \
  --sandbox read-only \
  --ask-for-approval never \
  --disable apps --disable browser_use --disable computer_use --disable plugins \
  -c mcp_servers.<configured-server>.enabled=false \
  --no-alt-screen \
  -c developer_instructions="<advisor contract>"
```

Repeat the MCP override for each server found in the configuration; omit it when the inventory is empty.

## Copy this for another agent

Keep `provider.ts`. In a forked adapter, change:

- target id and generated run-name prefix
- `herdr agent start --kind ...`
- launch args after `--`
- completion/wait behavior if the agent's Herdr lifecycle differs

## Tests

```bash
npm test -w packages/ux -- herdrRuntimeExample
```

Provider tests inject a fake `HerdrAdapter`. Adapter tests inject a fake `HerdrCli` and never spawn Herdr, Grok, or Codex.
