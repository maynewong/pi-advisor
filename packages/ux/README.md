# pi-advisor-ux

Pi Advisor's host-side dashboard and Advisor workspace integration. Built-in role cards are replaceable data and contain no runtime implementation.

```ts
import { loadBuiltInAgent } from "pi-advisor-ux";

const advisor = await loadBuiltInAgent("advisor");
```

Built-in agents: `advisor` and `search`.

## Extensible Advisor examples

The primary example is a compile-checked [Herdr local-pane Runtime Provider](./examples/runtime-providers/herdr/README.md). Every Advisor run creates a fresh isolated pane. It supports the built-in `grok-4.6-high` target plus provider-configured Grok and Codex aliases whose model and reasoning effort come from `herdr-advisor.json`; the example uses Pi Main `gpt-5.6-sol` with Codex `gpt-6-astra` at low effort. Stable rules are installed once per run; selected context is exposed through a private temporary-file reference so an unrelated large diff is not preloaded into every model turn. There is no Agent Skill. `claude-code-remote` remains a documented target id only. Pi Advisor does not bundle Herdr; the example assumes `herdr` is on `PATH` and Pi is already running inside a Herdr pane.

## Activation

Pi Advisor ships **session-deactivated**: installing the extension registers its commands but exposes **no Advisor tools** until you opt in. The selected tier is remembered as a preference, but a new session starts off unless `autoActivate: true` is explicitly configured. Turn it on by choosing an effort tier:

- `/mode low` · `/mode medium` · `/mode high` · `/mode ultra` — activate the current session at that tier; the tier preference is persisted, but activation is not unless `autoActivate` is enabled.
- `/mode off` — deactivate again and hide the tools.
- `autoActivate: true` — optional user setting for restoring the selected tier automatically in every new session; default `false`.

Activation is session-local by default. At `session_start`, tools are exposed only when `autoActivate: true` and a tier is configured. The host's `getActiveTools`/`setActiveTools` only adds/removes this kit's own tools. `/mode`, `/subagent`, `/subagents`, and `/advisor` remain registered while off, but explicit invocation commands that start a run (`/subagent` and `/advisor`) reject until the session is activated. Ordinary user text is never intercepted or consumed by this extension.

## Tools

The tools below are exposed to the model **only while the kit is activated** (see [Activation](#activation)).

Each built-in role that the parent should reach for directly is registered as its own dedicated tool, so the tool description is the trigger surface:

- `advisor` — read-only second opinion and adversarial review of a finished change (verdict, confidence, markdown). Params: `task`, `files?`, `inheritConversation?`, `includeDiff?` (defaults to **true**; set `false` to opt out), `background?`.
- `search` — read-only breadth reconnaissance **after** the parent has inspected the primary path and files it may edit. Params: `task`, `root?`, `files?`, `background?`. `root` changes the child run's cwd to another repository (absolute, or relative to the current cwd).

The default code-reading policy is **Main-first, Advisor-for-judgment, Search-for-breadth**: keep high-reuse source context in the parent, especially the main call path and files likely to be edited. Use Advisor for plan review, risk analysis, and diff challenges. Use Search to isolate low-reuse exploration that can be compressed into paths, confirmed conclusions, searched scope, and unknowns. The parent should still read and verify any source file before modifying it.

The generic `subagent` tool is primarily for custom profile `.md` paths. Params:

- `agent`, `task` — the role card (a `.md` path, or any built-in name) and its task.
- `files`, `includeDiff` — `files` are scope paths, not inlined contents; the child reads them if needed. `includeDiff` injects the working-tree diff (working tree vs `HEAD`). Paths remain bounded to the run cwd. For read-only search in a different repository, use the dedicated `search.root` parameter rather than an outside `files` path.
- `inheritConversation` — include the active parent branch as read-only user/assistant text (tool traces and thinking are omitted). Requires a persisted session.
- `writeScope` — restrict the subagent's writes to these globs (relative to cwd). Use this for a project-local profile when a write boundary is required.
- `maxTurns` — cap the run's **soft** turn budget (see [Soft turn budget](#soft-turn-budget) below). Reaching it wraps the run up with a partial answer rather than killing it.
- `background` — start the run and return immediately with a run id; the live overview keeps updating. Fetch the result later with `subagent_result { id, wait? }`.

For deterministic user invocation, use `/subagent <advisor|search|profile.md> <task>`. Natural-language text, including text beginning with `subagent`, follows Pi's normal submission path; the extension does not treat ordinary prose as a command.

`subagent_result` returns the compact answer when the run is terminal or `wait: true` (verdict/confidence for Advisor, the report text, plus error / turn-budget / truncation only when they apply). Otherwise it returns current status and id. File lists, cost, and artifact paths stay in the TUI expand layer and run artifacts.

`subagent_send { id, message, wait? }` sends a follow-up to an existing run: steers if still running, continues if completed. This is also how you **extend a run that landed on its soft turn budget** (note `⏳ turn budget reached`). Runs that ended as failed, aborted, or timed out cannot be continued.

## Soft turn budget

Turn budgets use a bounded finalize-only landing. When a run reaches `maxTurns`, investigation tools are removed and the child gets `finalizeTurns` answer-only turns (default 2). If it still fails to finish, the runtime aborts that finalize window but rescues the latest non-empty assistant text—or a deterministic progress fallback—and returns a completed partial with `stoppedBy: "turn_budget"`. It never converts budget exhaustion into an empty failed run. The parent can extend it with `subagent_send`, which restores tools and grants a fresh budget.

## Main/Advisor workspace switching

In TUI mode, the extension wraps the current editor and adds a Claude Code-style workspace switcher:

- `Alt+↓` / `Alt+↑` (macOS: `⌥+↑/↓`) cycles between Main and the most recent Advisor/Search runs.
- Selecting an Advisor run opens a full-width conversation view showing the child session's user, assistant, and compact tool blocks rather than only milestones and a final summary.
- The editor border shows `INSPECTING <agent> · <status>` and `input → main`: selecting Advisor changes only the displayed conversation, never the submission destination.
- When the input is empty, `↑` / `↓` scroll one line, `PageUp` / `PageDown` scroll a full page, and `Ctrl+U` / `Ctrl+D` scroll half a page. With a draft or autocomplete open, these keys stay with the Main editor.
- `Alt+I` (macOS: `⌥+I`) opens the inspector for model, usage, files, artifacts, and recent activity.
- `Alt+A` (macOS: `⌥+A`) acknowledges an unread background result while inspecting it. Opening the workspace is not enough.
- `Esc` with an empty editor returns the view to Main.
- Enter always follows Pi's normal user-input path. To steer or continue a run, use the explicit `subagent_send` tool rather than implicit editor interception.

This is a presentation overlay rather than a replacement for Pi's internal chat container. It composes with another installed custom editor by wrapping its editor factory.

## `/subagents`

- `/subagents` or `/subagents runs` opens the Pi Advisor dashboard, grouped by attention; `Alt+S` is the shortcut. Enter inspects the selected run in the workspace.
- `/subagents list` prints this session's runs, each with its run id and artifacts directory.
- `/subagents focus [id]` selects a run in the Main/Advisor workspace; omit `id` for the latest run.
- `/subagents main` returns to Main.
- `/subagents view [id]` inspects a run in the workspace. Omit `id` for the latest run.
- `/subagents toggle` / `expand` / `collapse` controls the ambient overview. A single foreground run stays on its tool card; background work, concurrent runs, permission waits, and unread background results get a one-line indicator. Expanded mode shows per-run activity and recent milestones.
- Running result cards are capped at two terminal rows. Live activity stays in the card or workspace header, not in the conversation body or a duplicate footer/Working message. Pi retains ownership of its global Working indicator.
- `/subagents ack [id]` / `/subagents dismiss [id]` marks an unread background result as seen. Omit `id` only while inspecting a run. This does not abort or delete the run.
- `/subagents abort <id>` aborts a specific run.

## Configuration

User-scoped Pi Advisor settings live in `~/.pi/agent/pi-advisor.json` (or the agent directory selected by `PI_CODING_AGENT_DIR`). If that file is absent, Pi Advisor reads the legacy `subagent-kit.json` once; the next settings write atomically creates `pi-advisor.json` and archives the old file as `subagent-kit.json.bak`. When both files exist, `pi-advisor.json` wins:

```json
{
  "mode": "medium",
  "autoActivate": false,
  "modes": {
    "low": {
      "agent": { "model": "xai/grok-4.6", "thinkingLevel": "high" },
      "advisor": { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "high" }
    },
    "medium": {
      "agent": { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "high" },
      "advisor": { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "xhigh" }
    },
    "high": {
      "agent": { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "xhigh" },
      "advisor": { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "high" }
    },
    "ultra": {
      "agent": { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "xhigh" },
      "advisor": { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "xhigh", "maxTurns": 24 }
    }
  },
  "agents": { "advisor": { "maxTurns": 8, "finalizeTurns": 2, "contextMaxBytes": 384000 } },
  "modelFilter": "openrouter",
  "tiers": [{ "pattern": "terra", "tier": "fast" }],
  "parentModel": "openrouter/openai/gpt-5.5",
  "advisorGuidance": true,
  "artifactsDir": "./.pi/subagent-runs",
  "retentionDays": 14,
  "maxRuns": 200
}
```

- `mode` — preferred effort tier (`"low"` / `"medium"` / `"high"` / `"ultra"`) or `"off"`. `/mode …` activates the current session and remembers this preference.
- `autoActivate` — restore the preferred tier automatically on new sessions. Default `false`.
- `modes.<low|medium|high|ultra>.agent` — exact parent model and `thinkingLevel` for that tier.
- `modes.<low|medium|high|ultra>.<role>` — exact subagent model, `thinkingLevel`, and optional `maxTurns` for that role and tier. These JSON entries override the legacy shipped routing table, so model routing can be changed without editing TypeScript.
- `agents.<name>.maxTurns` / `finalizeTurns` — per-role investigation and final-answer-only budgets. Legacy `finalizeAfterTurns` is accepted as an alias for `maxTurns`.
- `agents.<name>.contextMaxBytes` — positive UTF-8-byte cap for the role's complete context packet (diffs, inherited conversation text, and scope hints). It overrides the role-card budget, not the selected model's context window. The shipped roles use 64,000 bytes for `search` and 256,000 for `advisor`; custom profiles otherwise use Core's 128,000-byte default.
- `agents.<name>.model` — optional per-agent model override that **beats the routing table**. A bare model ID or name must match exactly one authenticated model; use `provider/model-id` to disambiguate. An unavailable or ambiguous target fails the run. When omitted, built-in roles use the current mode's explicit table entry. Model resolution runs through core's injected `resolveModel` (`createModelResolver`, exported for third-party hosts).
- `agents.<name>.thinkingLevel` — optional reasoning-effort override. When omitted, built-in roles use the current mode's table entry.
- `agents.<name>.onlyInModes` — restrict an override to specific tiers, a non-empty array of `"low"`/`"medium"`/`"high"`/`"ultra"`. When set, the `model`, `thinkingLevel`, and `runtime` override applies **only** in those tiers; in every other tier the role falls back to the shipped mode table. Omit to apply the override in all tiers.
- `agents.<name>.runtime` — select an independently installed Runtime Provider. Kit config accepts only a non-empty `provider` id and optional logical `target` alias. Machine addresses, credentials, ports, transport settings, and secrets belong to the provider's own configuration. Example:
  ```json
  {
    "agents": {
      "advisor": {
        "runtime": {
          "provider": "claude-channel",
          "target": "fable-advisor"
        },
        "onlyInModes": ["high", "ultra"]
      }
    }
  }
  ```
  The provider must be installed as a trusted Pi extension and register a compatible `RuntimeDriverProvider`. If it is missing or does not support the role's context/output/policy requirements, the run fails before dispatch with a provider-neutral error.
- `modelFilter` / `tiers` — accepted for backwards compatibility with earlier alias-routing releases. They no longer affect explicit role or parent model selection; `/mode filter` still reports the narrowed registry pool for diagnostics.
- `parentModel` — an optional exact model (bare id or `provider/model-id`) for the **parent session** in every tier, overriding the mode table. Thinking level is still driven by the tier. Shown in `/mode` with a `(manual override)` marker. If the id isn't in the registry the parent model is left unchanged.
- `advisorGuidance` — accepted for backwards compatibility but no longer has any effect. The Advisor consultation policy now lives in the dedicated `advisor` tool description instead of being injected into the parent system prompt.
- `artifactsDir` — override the artifacts location (relative paths resolve against cwd). By default runs are stored globally under `<agentDir>/subagent-runs/<project-slug>-<hash>`, so they no longer clutter the project tree.
- `retentionDays` / `maxRuns` — lazy retention. On first use per project, run directories older than `retentionDays` are pruned (0 disables age pruning), then the newest survivors are trimmed to `maxRuns`. Cleanup never fails a spawn.

## Profiles: personal and company routes

`profile` selects a complete model and runtime route set. `mode` still means the effort tier: `low`, `medium`, `high`, or `ultra`. The two concepts are independent: switching profiles does not change the current tier and does not activate tools by itself. This configuration profile is different from a Markdown role profile passed to the generic runtime surface.

Declare profiles in the user-level `pi-advisor.json`:

```json
{
  "profile": "personal",
  "mode": "medium",
  "autoActivate": false,
  "profiles": {
    "personal": {
      "parentModel": "personal-provider/main-model",
      "agents": {
        "advisor": { "model": "personal-provider/reasoning-model", "thinkingLevel": "high" },
        "search": { "model": "personal-provider/fast-model", "thinkingLevel": "low" }
      }
    },
    "company": {
      "parentModel": "company-provider/main-model",
      "agents": {
        "advisor": { "model": "company-provider/reasoning-model", "thinkingLevel": "high" },
        "search": { "model": "company-provider/fast-model", "thinkingLevel": "low" }
      }
    }
  }
}
```

The provider/model values above are placeholders. Replace them with authenticated, registered **`provider/model-id`** values. See [`pi-advisor.profiles.example.json`](./pi-advisor.profiles.example.json) for a complete example; its company profile uses per-tier `modes` routing.

### Declaration and precedence

- `profile` must reference an entry in `profiles`. Names support letters, digits, underscores, and hyphens; the first character must be a letter or digit; names are case-sensitive.
- Each profile accepts only `parentModel`, `agents`, and `modes`. Common settings such as `mode`, `autoActivate`, artifacts, and retention stay at the top level.
- When `profiles` exists, top-level `parentModel`, `agents`, and `modes` are not allowed. There is no cross-profile inheritance, deep merge, or implicit default profile.
- Parent: `parentModel` beats `modes.<tier>.agent.model` in that profile. Reasoning comes from `agent.thinkingLevel` for the selected tier; when omitted, the built-in tier reasoning is kept.
- Advisor/Search: an active `agents.<role>` override for the current tier beats that profile's `modes.<tier>.<role>` entry. Budgets and unoverridden reasoning may still use built-in defaults.
- **All four tiers must cover parent, advisor, and search routing.** The simplest setup is fixed `parentModel` plus `agents.<role>.model`, but a full `modes` table is also valid. Missing entries fail validation instead of inheriting built-in models, which prevents calls to the wrong subscription.
- `onlyInModes` disables that role override outside the listed tiers; those tiers must then be covered by the current profile's `modes` table. Validation includes unselected profiles so latent config errors are caught early.
- `agents.<role>.runtime` still accepts `{ "provider": "...", "target": "..." }`. A provider-owned model runtime may omit `model`; a host-model runtime still needs an explicit model. Runtime installation and capability compatibility are checked during switching; target connection and execution errors are reported by the provider.
- Under named profiles, any extra role card must explicitly configure that role's model or runtime. It does not inherit the role card's own model. Config files without `profiles` keep the legacy behavior.

### Switching and session boundaries

```text
/mode profile             open the selector; without UI, list available names
/mode profile personal    switch to the personal route set
/mode profile company     switch to the company route set
/mode profile me high     switch route set, tier, and activate in one step
/mode high                keep the current profile, switch to high, and activate
/mode ultra               keep the current profile, switch to ultra, and activate
/mode off                 hide tools, keep the profile choice, leave parent unchanged
/mode                     show profile, mode, and role routing
```

- When active, switching profiles retunes the parent and future runs use the new route set. When inactive, only configuration is changed.
- Before switching or activating, Pi Advisor validates the models and runtimes required by the selected tier. A failed validation does not commit the new selection. If parent retuning or file persistence fails, Pi Advisor attempts to restore the previous parent model and reasoning level. Switching is rejected while the parent is busy.
- Named profiles are snapshotted in the current session. Changes made by another session do not automatically change this session's profile or tier. After editing JSON, run `/mode profile <same-name>` to reload that profile explicitly; common settings are read on new sessions or reload.
- The global file persists only the selected `profile`, `mode`, and other preferences; it does not rewrite profile definitions. New sessions still start inactive by default. With `autoActivate: true`, Pi Advisor validates, retunes the parent, and only then exposes tools.
- Started runs, including queued runs and `subagent_send` continuations, keep their original model and runtime target. Run metadata records `configProfile` and `mode`.
- **Profile switching does not isolate sessions or credentials.** After switching, future requests may send the current conversation to a different provider. Start a new session when context isolation matters. Switching profiles does not change API keys, OAuth tokens, or global login state. Two accounts for the same provider must first be isolated by the authentication layer as distinct providers or runtime targets.

### Migrating an existing JSON file

Move existing top-level `modes`, `agents`, and `parentModel` into `profiles.company`, fill all four tier routes, then add `profiles.personal` and top-level `"profile": "company"`. There is no separate Review role to migrate; Advisor handles diff review.

## Mode & model routing

Once activated (see [Activation](#activation)), Pi Advisor uses four explicit tiers. In flat configuration, the complete table can be declared under `modes` in `pi-advisor.json`; omitted entries inherit `default-routing.json`. Named profiles instead require explicit model routing as described above. Model values are stored in JSON rather than hardcoded in TypeScript. There is no alias resolution, automatic ranking, fallback, or model pool:

| Tier | Parent model | Reasoning | Advisor model | Reasoning |
| --- | --- | --- | --- | --- |
| `low` | `glm-5.3` | `medium` | `openai-codex/gpt-5.6-sol` | `high` |
| `medium` | `openai-codex/gpt-5.6-sol` | `medium` | `openai-codex/gpt-5.6-sol` | `high` |
| `high` | `openai-codex/gpt-5.6-sol` | `xhigh` | `anthropic/claude-fable-5.1` | `high` |
| `ultra` | `openai-codex/gpt-6-astra` | `high` | `anthropic/claude-fable-5.1` | `xhigh` |

Fixed role route:

- `search` — `openai-codex/gpt-5.6-terra`, `low` reasoning

Advisor handles adversarial diff review; there is no separate Review role.

[`pi-advisor.example.json`](./pi-advisor.example.json) shows optional reasoning overrides, and [`pi-advisor.profiles.example.json`](./pi-advisor.profiles.example.json) shows named profiles. You do not need to repeat built-in role models; when `agents.<role>.model` is omitted, the tier table controls the role. If a table model or manual override is unavailable or ambiguous, the run fails before launch instead of switching to another model.

Turn budgets are **soft** (see [Soft turn budget](#soft-turn-budget)); they are only background safety limits and do not affect model selection.

To use a local model, write its exact model id into the mode table or user override and make sure that model is registered.

### `/mode`

- `/mode profile [name] [tier]` — select or switch a named route set. Omitting `tier` keeps the current tier and activation state. Passing `low`, `medium`, `high`, or `ultra` switches and activates in one step; passing `off` switches and remains inactive. See [Profiles](#profiles-personal-and-company-routes).
- `/mode` — print the current status: `profile <name> · mode <tier>` for named profiles (otherwise `mode <tier>`), parent/advisor/search routes, and warnings only when a model is missing, ambiguous, or a filter is active. Turn budgets, pool size, and config help stay out of the status line.
- `/mode low` / `/mode medium` / `/mode high` / `/mode ultra` — **activate this session** at that tier: persist the preferred tier, expose tools until the session ends, retune the parent session, and reprint the table.
- `/mode off` — **deactivate**: persist `off` and hide the subagent tools (the parent session is left as-is).
- `/mode filter <keyword>` / `/mode filter off` — set or clear `modelFilter` (persisted, other fields preserved) and reprint the table with the new pool.

Because the Pi extension API exposes `setModel`/`setThinkingLevel`, activating a tier also **retunes the parent session** using the exact parent entry shown in the table. A `parentModel` config override pins an exact parent model in every tier (shown with a `(manual override)` marker). A manual `agents.<role>.model` override always beats the table for that role.

## Advisor workflow

- `/advisor <question>` asks Advisor for a second opinion and includes the current Git diff.
- Prefer the dedicated `advisor` tool; it includes the working-tree diff by default. Use it both for plan review (`inheritConversation: true`) and for adversarial review of a finished change.
- Advisor results expose `verdict`, `confidence`, and a full Markdown report for rendering and routing. The output contract is the shared `advisorReportSchema` exported from `pi-advisor-ux`.
