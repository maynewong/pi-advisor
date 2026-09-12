# Pi Advisor

Pi Advisor adds a dedicated Advisor to Pi: a second mind that reviews plans, challenges diffs, checks blind spots, and gives evidence-backed recommendations while the main Pi session stays in control.

Main is still the actor. Advisor is the counselor.

## Why Advisor?

A single agent is convenient, but it has three recurring failure modes:

- **Context gets crowded.** The main session needs to keep the task, code path, user preferences, edits, and tests in view. Review and side investigation often pollute that context.
- **One model has one bias.** Asking the same model to both write and review its own work is weaker than asking a different model, or the same model in a different isolated run, to challenge it.
- **Cost is not uniform.** Most turns do not need the strongest reasoning model. The expensive intelligence is most valuable at decision points: plan review, diff review, and risk analysis.

Pi Advisor is built around that split:

```text
Main:    understand, edit, decide
Advisor: inspect, challenge, recommend
Search:  gather broad evidence when needed
```

This makes it practical to keep Main cheaper or faster, while giving Advisor a stronger model and a cleaner context when judgment matters.

## Install

From source:

```bash
git clone https://github.com/maynewong/pi-advisor.git
cd pi-advisor
npm install
npm test
npm run typecheck
pi install /absolute/path/to/pi-advisor
```

Then start Pi in a project and activate Advisor for the current session:

```text
/mode medium
/advisor review this plan
/advisor challenge this diff
```

Pi Advisor starts disabled in every new session unless you set `autoActivate: true` in `~/.pi/agent/pi-advisor.json`.

## Basic use

Use Advisor when you want judgment, not busywork:

```text
/advisor review this implementation plan
/advisor challenge the current diff for correctness and hidden risks
/advisor check whether this migration is safe to deploy
/advisor compare these two approaches and recommend one
```

Search is available as a supporting capability for broader reconnaissance, but it is not the primary product surface. The main user-facing entry point should remain Advisor.

Inspecting an Advisor run in the TUI only changes what you see. Your typed input still goes to Main. Follow-up controls should be presented as Advisor controls rather than as the product identity.

## Recommended tier strategy

The best cost/performance setup is usually asymmetric: keep Main efficient, make Advisor smarter.

| Tier | Recommended use | Main | Advisor | Search |
| --- | --- | --- | --- | --- |
| `low` | Daily coding, cheap second opinions | fast/cheap | strong | cheap |
| `medium` | Default mode for serious work | balanced | strong reasoning | cheap |
| `high` | Risky changes, architecture, production impact | strong | stronger reasoning | cheap or balanced |
| `ultra` | Rare, high-stakes decisions | strongest practical | strongest practical | balanced |

In other words: spend on Advisor when a mistake would be expensive. Do not spend the strongest model on every Main turn if only the review step needs that intelligence.

## Example configuration

User config lives at:

```text
~/.pi/agent/pi-advisor.json
```

Example: efficient Main, stronger Advisor, cheap Search.

```json
{
  "mode": "medium",
  "autoActivate": false,
  "modes": {
    "low": {
      "agent": { "model": "glm-5.3", "thinkingLevel": "medium" },
      "advisor": { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "high" },
      "search": { "model": "openai-codex/gpt-5.6-terra", "thinkingLevel": "low" }
    },
    "medium": {
      "agent": { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "medium" },
      "advisor": { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "high" },
      "search": { "model": "openai-codex/gpt-5.6-terra", "thinkingLevel": "low" }
    },
    "high": {
      "agent": { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "xhigh" },
      "advisor": { "model": "anthropic/claude-fable-5.1", "thinkingLevel": "high" },
      "search": { "model": "openai-codex/gpt-5.6-terra", "thinkingLevel": "low" }
    },
    "ultra": {
      "agent": { "model": "openai-codex/gpt-6-astra", "thinkingLevel": "high" },
      "advisor": { "model": "anthropic/claude-fable-5.1", "thinkingLevel": "xhigh", "maxTurns": 24 },
      "search": { "model": "openai-codex/gpt-5.6-terra", "thinkingLevel": "low" }
    }
  },
  "agents": {
    "advisor": { "maxTurns": 8, "finalizeTurns": 2, "contextMaxBytes": 256000 },
    "search": { "maxTurns": 6, "finalizeTurns": 2, "contextMaxBytes": 64000 }
  }
}
```

Model ids are examples. Replace them with models available in your authenticated Pi model registry. Pi Advisor does not silently replace an unavailable or ambiguous model with another one.

## Herdr runtime option

The default runtime launches managed Pi child sessions. That is the recommended path for normal use.

Pi Advisor can also run Advisor through an external Runtime Provider. The Herdr pane runtime in this repository is an example provider, not something enabled automatically. You install it as a separate trusted Pi extension and then select it in `pi-advisor.json`.

Thanks to [Herdr](https://github.com/earendil-works/herdr) for providing the terminal-pane foundation that makes this style of visible, isolated local Advisor run possible.

Use the Herdr runtime when you specifically want Advisor to run in a fresh pane through another CLI agent. The checked-in Herdr example currently includes ready-to-copy Grok and Codex adapters. It does not include a Claude adapter.

| Runtime | Best for | Tradeoff |
| --- | --- | --- |
| Default Pi runtime | Normal Advisor use, tight Pi integration, simple setup | Uses Pi-managed child sessions |
| Herdr pane runtime | Visible isolated panes, external CLI agents, provider-owned model routing | Requires Herdr, the provider plugin, and the selected CLI on `PATH` |

### Herdr provider install sketch

The example provider lives at:

```text
packages/ux/examples/runtime-providers/herdr
```

For local development, load both the main Pi Advisor extension and the Herdr provider extension:

```bash
pi \
  -e /absolute/path/to/pi-advisor/packages/ux/extensions/subagent.ts \
  -e /absolute/path/to/pi-advisor/packages/ux/examples/runtime-providers/herdr/extension.ts
```

For regular use, copy the provider into your own trusted Pi plugin, depend on `pi-advisor-core`, and install that plugin separately. Runtime providers own their own configuration, credentials, target aliases, and transport details.

## Grok and Codex examples

The Herdr provider example includes working Grok and Codex implementations:

- `grok-4.6-high`: a built-in Grok target.
- configurable Grok aliases from `~/.config/pi-advisor/herdr-advisor.json`.
- configurable Codex aliases from `~/.config/pi-advisor/herdr-advisor.json`.

Provider config example:

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
      "model": "openai-codex/gpt-6-astra",
      "reasoningEffort": "low"
    }
  }
}
```

Pi Advisor config example:

```json
{
  "mode": "low",
  "parentModel": "openai-codex/gpt-5.6-sol",
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

Here, `parentModel` is resolved by Pi. The Codex model is passed directly to the Codex CLI by the Herdr provider, so do not also set `agents.advisor.model` for this Advisor route.

## Claude and remote Claude

Claude or remote Claude support is not implemented in this repository. It should be built as a separate Runtime Provider, installed as its own trusted Pi extension, and selected from `pi-advisor.json`.

The user-facing Pi Advisor config should stay small: a stable provider id plus a target alias.

```json
{
  "agents": {
    "advisor": {
      "runtime": {
        "provider": "claude-channel",
        "target": "remote-advisor"
      }
    }
  }
}
```

A Claude provider should use the `RuntimeDriverProvider` SPI from `pi-advisor-core`. The provider registers itself on Pi's event bus, declares capabilities, receives a bounded Advisor request, runs Claude however it wants, emits progress, and returns a final Advisor result.

Implementation notes for a Claude provider:

- Keep Claude credentials, hostnames, SSH options, sockets, channel endpoints, and transcript paths in provider-owned config, not in `pi-advisor.json`.
- Treat `target` as a logical alias such as `local-claude`, `remote-advisor`, or `fable-reviewer`; resolve it inside the provider.
- Install stable Advisor instructions once per run instead of pasting the full contract into every follow-up.
- Deliver context as a bounded packet by temporary file, task store, RPC, or channel message. Avoid dumping unrelated parent context into every Claude turn.
- Enforce read-only or write-scoped behavior with Claude runtime controls where possible. Do not rely on prompt text alone for safety.
- Return structured Advisor output when possible. If the Claude transport only yields Markdown, map it to a conservative Advisor result with explicit uncertainty.
- Support abort, timeout, resume, and follow-up only if the underlying Claude transport can make those operations reliable. Declare unsupported capabilities as unsupported.
- Make remote execution auditable: persist task ids, delivery status, transcript references, and the final parsed result as provider artifacts.

Useful references:

- [`packages/core/README.md`](packages/core/README.md): the public Runtime Provider SPI and a minimal provider skeleton.
- [`packages/ux/README.md`](packages/ux/README.md): user configuration, `agents.<role>.runtime`, activation, and model routing behavior.
- [`packages/ux/examples/runtime-providers/herdr/README.md`](packages/ux/examples/runtime-providers/herdr/README.md): a working external-runtime example with Grok and Codex adapters.

## Soft budget

Advisor runs use a soft budget. When `maxTurns` is reached, investigation tools are removed and Advisor gets a small final-answer-only window. If that window is exhausted, Pi Advisor preserves the latest non-empty partial result with `stoppedBy: "turn_budget"` instead of failing empty.

## Development

```bash
npm install
npm test
npm run typecheck
```
