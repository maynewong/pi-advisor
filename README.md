# Pi Advisor

**A second opinion for your Pi coding agent.**

Pi Advisor gives [Pi](https://pi.dev) a separate, read-only reviewer to challenge plans and catch bugs before you commit. Main consults Advisor when needed and decides what to change; Advisor returns findings, evidence, and next steps.

## Why use it?

Reviewing code in the conversation that produced it can carry the same assumptions forward. A separate reviewer gives you:

- **Fresh scrutiny:** challenge a plan or diff in its own context, optionally with a different model.
- **Less clutter:** keep the investigation out of your main conversation.
- **Flexible spending:** use a fast coding model and reserve a stronger model for important reviews.

Start with one model you already have. Reviews add model usage and do not replace tests.

## Quick start

### 1. Install

You need Node.js **22.19.0+**, Git, and [Pi with an authenticated model](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#quick-start).

```bash
pi install git:github.com/maynewong/pi-advisor
```

Only install extensions you trust: they execute code on your machine.

### 2. Configure one model

Create `~/.pi/agent/pi-advisor.json`. This example uses GPT-6 Astra for all three roles and enables Advisor automatically:

```json
{
  "mode": "medium",
  "autoActivate": true,
  "parentModel": "openai-codex/gpt-6-astra",
  "agents": {
    "advisor": { "model": "openai-codex/gpt-6-astra" },
    "search": { "model": "openai-codex/gpt-6-astra" }
  }
}
```

`parentModel` handles coding, `advisor` handles review, and `search` handles broader code exploration. One model works for all three. Run `pi --list-models` and replace these IDs if your account uses another model.

Merge into an existing config rather than overwriting it. For named profiles, edit the [selected profile](packages/ux/README.md#profiles-personal-and-company-routes) instead.

### 3. Work as usual

Start or restart Pi **in the project you want reviewed**, then describe your task:

```text
Implement the migration in docs/plan.md. Check data-loss and rollback risks before editing.
```

With the config above, Advisor is enabled at startup. Main decides when to consult it—for risky changes, uncertain plans, or a finished diff. **You do not need to type `/advisor`.**

Use `/advisor <question>` when you want to explicitly request a review. Without `autoActivate: true`, enable Advisor with `/mode medium`; this also applies Main's configured model and tier reasoning level. `/mode off` disables it.

If a model is unavailable or ambiguous, check `/mode` and use an exact authenticated `provider/model-id`. Advisor and Search do not silently fall back to another model.

## Everyday use

Talk to Main normally; it can consult Advisor without a command. To request a specific second opinion yourself:

```text
/advisor Read docs/plan.md. What should we test before implementing it?
/advisor Challenge the current diff. Focus on error handling and compatibility.
```

Provide file paths or the relevant details. For a plan that exists only in the conversation, ask Main to use `inheritConversation: true` when consulting Advisor; this requires a saved Pi session.

| Action | Command or shortcut |
| --- | --- |
| Check models and mode | `/mode` |
| View runs | `/subagents` |
| Switch between Main and recent runs | `Alt+↑` / `Alt+↓` (`⌥` on macOS) |
| Stop a run | `/subagents abort <id>` |

**Typing always goes to Main**, even while viewing Advisor. Ask Main to use `subagent_send` for follow-ups or `background: true` to review while you keep coding. Follow-up support depends on the runtime.

## Upgrade the reviewer, not every turn

For a different perspective, keep GPT-6 Astra as Main and replace `agents.advisor` with Claude Fable 5.1:

```json
{
  "model": "anthropic/claude-fable-5.1",
  "thinkingLevel": "high"
}
```

This requires access to both models. You can also use a cheaper Main or Search model, such as `openai-codex/gpt-5.6-terra` if available to your account.

The four modes—`low`, `medium`, `high`, `ultra`—are configurable model/reasoning presets, not spending caps. The quick-start config pins model choices across tiers. For different models per tier, see [routing and override precedence](packages/ux/README.md#mode--model-routing).

## Advanced: run Advisor in Herdr

[Herdr](https://github.com/earendil-works/herdr) lets Advisor run through **Codex or Grok in a fresh terminal pane**, with the report returned to Pi. Skip this setup if Pi-managed review sessions already meet your needs.

### 1. Prepare the runtime

Install Herdr and authenticate your chosen CLI. Start from your project directory inside a real Herdr pane; Herdr supplies `HERDR_ENV=1` automatically. Both `herdr` and the agent CLI must be on `PATH`.

The example below uses Codex. Pi and the new pane must use the same Codex installation and configuration, including `CODEX_HOME`.

### 2. Choose the external model

Create `~/.config/pi-advisor/herdr-advisor.json` and its parent directory if needed:

```json
{
  "targets": {
    "codex-reviewer": {
      "agent": "codex",
      "model": "gpt-6-astra",
      "reasoningEffort": "high"
    }
  }
}
```

Codex takes `gpt-6-astra` directly, without Pi's `openai-codex/` prefix. Choose a model and effort your CLI supports. For Grok, use `"agent": "grok"` and, for example, `"model": "grok-4.6"`.

### 3. Connect Advisor

Replace `agents.advisor` in `~/.pi/agent/pi-advisor.json` with:

```json
{
  "runtime": {
    "provider": "herdr-advisor",
    "target": "codex-reviewer"
  }
}
```

Keep `parentModel` and `agents.search`. Remove Advisor's old `model` and `thinkingLevel` fields: the Herdr config now controls them. The target name must match in both files.

### 4. Load the provider

With Pi Advisor already installed, run this from your project directory inside Herdr. The path below assumes the quick-start Git install:

```bash
pi -e "$HOME/.pi/agent/git/github.com/maynewong/pi-advisor/packages/ux/examples/runtime-providers/herdr/extension.ts"
```

For a local checkout, substitute its absolute path. Main's automatic consultations now use Herdr. To test it explicitly:

```text
/advisor Review the current diff for correctness and hidden risks.
```

With `autoActivate: true` from the quick start, a new Advisor pane should appear and return its report to Pi. Setting `runtime.provider` alone does not load the provider; the extension must also be loaded.

For regular use, append the provider's absolute path to the `extensions` array in `~/.pi/agent/settings.json` instead of passing `-e`. Preserve existing entries, load the provider only once, and restart Pi after config changes.

The adapter applies read-only runtime controls. See the [Herdr guide](packages/ux/examples/runtime-providers/herdr/README.md) for security constraints, troubleshooting, and adapter details.

## Extend it to fit your workflow

Keep the same review interface as your setup grows:

- **Personal and company routes:** [named profiles](packages/ux/README.md#profiles-personal-and-company-routes) switch model and runtime configurations without editing JSON each time. They do not isolate credentials or conversation history; start a new session when context must stay separate.
- **Specialist reviewers:** [Markdown role cards](packages/core/README.md#profile) define focused instructions, tools, and output requirements, invoked through the generic subagent interface.
- **Other CLIs or remote reviewers:** the [Runtime Provider API](packages/core/README.md#external-runtime-providers) lets you add a backend without forking the core. Herdr examples include Codex and Grok; Claude Code and remote Claude require a separate adapter.
- **Your own tooling:** the [headless core](packages/core/README.md) provides structured results, run artifacts, and lifecycle APIs for custom integrations outside Pi's terminal UI.

For all commands, configuration options, and turn budgets, see the [full reference](packages/ux/README.md).

## Development

```bash
git clone https://github.com/maynewong/pi-advisor.git
cd pi-advisor
npm install
npm test
npm run typecheck
```
