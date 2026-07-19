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
- `maxTurns` — cap the run's **soft** turn budget (see [Soft turn budget](#soft-turn-budget) below). Reaching it wraps the run up with a partial answer rather than killing it.
- `background` — start the run and return immediately with a run id; the live overview keeps updating. Fetch the result later with `subagent_result { id, wait? }`.

`subagent_result` returns the full summary when the run is terminal or `wait: true`; otherwise it returns current status and recent milestones. It also returns the latest result after a run is continued with `subagent_send`.

`subagent_send { id, message, wait? }` sends a follow-up to an existing run in this session. A **running** run is redirected mid-flight (steered) and the tool returns immediately; the run's own result still surfaces via its original call or `subagent_result`. A **completed** run is continued with a new turn on its retained session, and unless `wait: false` the tool blocks and returns the new result. This is also how you **extend a run that landed on its soft turn budget** (status `completed`, note `⏳ turn budget reached`): the resumed leg gets a fresh budget to finish the work. Runs that ended as failed, aborted, or timed out cannot be continued.

## Soft turn budget

Turn budgets are a soft landing, not a hard kill. When a run reaches its `maxTurns`, the child is asked to stop investigating and submit its best partial answer (marking anything unverified as an assumption); the run then completes normally with a `stoppedBy: "turn_budget"` marker and a `⏳ turn budget reached — partial answer; extend with subagent_send` note in the summary. Deterministic code keeps a runaway backstop — an absolute ceiling at 3× the soft budget still fails as `max_turns` — but normal work never reaches it. Because a landed run is a completed partial, the parent can read it and extend it with `subagent_send`, which gives the resumed leg a fresh budget. See core `docs/design.md` §8.1 for the full three-layer design.

## `/subagents`

- `/subagents` lists this session's runs, each with its run id and artifacts directory.
- `/subagents abort <id>` aborts a specific run.

## Configuration

User-scoped settings live in `~/.pi/agent/subagent-kit.json` (or the agent directory selected by `PI_CODING_AGENT_DIR`):

```json
{
  "mode": "medium",
  "agents": { "oracle": { "model": "gpt-5.5" } },
  "modelFilter": "openrouter",
  "tiers": [{ "pattern": "terra", "tier": "fast" }],
  "parentModel": "openrouter/openai/gpt-5.5",
  "oracleGuidance": true,
  "artifactsDir": "./.pi/subagent-runs",
  "retentionDays": 14,
  "maxRuns": 200
}
```

- `mode` — effort knob, `"low"` or `"medium"` (default `"medium"`). See [Mode & model routing](#mode--model-routing).
- `agents.<name>.model` — per-agent model override and the escape hatch that **beats the routing table** (and **bypasses `modelFilter`**). A bare model ID or name must match exactly one authenticated model; use `provider/model-id` to disambiguate. An unavailable or ambiguous target fails the run. Unconfigured agents follow the mode routing table (alias resolution with a parent-model fallback). Model resolution runs through core's injected `resolveModel` (`createModelResolver`, exported for third-party hosts).
- `modelFilter` — a case-insensitive keyword (or array of keywords) matched as a substring against each model's `provider`, `id`, and `provider/id`. When set, **only matching models form the candidate pool** for alias resolution — the way to keep routing on your cloud providers (e.g. `"openrouter"`) instead of a mixed registry that includes free local models. Manual `agents.<role>.model` overrides bypass it. If a filter matches **zero** models, resolution falls back to the unfiltered pool and the outcome is marked **degraded** (`modelFilter matched no models`) rather than silently ignored. Set/clear it live with `/mode filter <keyword>` / `/mode filter off`.
- `tiers` — user tier rules, each `{ "pattern": <id substring>, "tier": "strong" | "mid" | "fast" }`. They are **prepended** to the built-in prior table (`MODEL_TIER_PRIORS`) at resolution time, so a user rule wins over the built-ins and earlier user rules win over later ones (first match wins). This is the escape hatch for models the built-in table doesn't name. Worked example: with `[{ "pattern": "terra", "tier": "fast" }]`, a model id containing `terra` is treated as fast-tier and becomes eligible for `fast-search`.
- `parentModel` — an exact model (bare id or `provider/model-id`) for the **parent session** in both modes, overriding the parent alias. Thinking level is still driven by the mode. Shown in `/mode` with a `(manual override)` marker. If the id isn't in the registry the parent model is left unchanged.
- `oracleGuidance` — accepted for backwards compatibility but no longer has any effect. The Oracle consultation policy now lives in the dedicated `oracle` tool description instead of being injected into the parent system prompt.
- `artifactsDir` — override the artifacts location (relative paths resolve against cwd). By default runs are stored globally under `<agentDir>/subagent-runs/<project-slug>-<hash>`, so they no longer clutter the project tree.
- `retentionDays` / `maxRuns` — lazy retention. On first use per project, run directories older than `retentionDays` are pruned (0 disables age pruning), then the newest survivors are trimmed to `maxRuns`. Cleanup never fails a spawn.

## Mode & model routing

Each built-in role resolves its model through a two-mode routing table (`low` | `medium`, default `medium`). A mode entry is `{ model alias, thinkingLevel, maxTurns? }`, so effort stays real even when the model pool is shallow: if every alias collapses to the same model, `low` and `medium` still differ by thinking level and turn budget. Turn budgets are **soft** (see [Soft turn budget](#soft-turn-budget)), so they are set to generous "background insurance" values a normal run rarely reaches: search `8`/`12`, reviewer `8`/`12`, worker `12`/`16`, and oracle a generous `16` in both modes (oracle is a few-turn, heavy-thinking role, so its budget is only a backstop, never a daily constraint).

Aliases resolve against the **actual** authenticated model registry (optionally narrowed by `modelFilter`), scored on registry metadata (cost, context window, reasoning support) plus a small, editable prior table mapping known model-id substrings to coarse tiers (`gpt-5*`/`o*`/`opus`/`fable` → strong; `glm`/`deepseek`/`qwen`/`kimi`/`sonnet` → mid; `*-air`/`*flash`/`*mini`/`haiku`/`turbo`/`highspeed` → fast). The tables are exported (`MODEL_TIER_PRIORS`, `MODEL_FAMILY_PRIORS`) and easy to edit; the `tiers` config prepends your own rules without touching the source.

- `strong-reasoning` (oracle) — the strongest model from a **different** provider/family than the parent (a heterogeneous second opinion); if none, the strongest overall; if that is the parent itself, it falls back to the parent and is flagged **degraded** (oracle then runs with half its value: independent context only, no independent model).
- `fast-search` (search) — **tier-first, cost-second**: among fast-tier models it takes the cheapest **non-zero-cost** one; if no fast tier exists it falls back to the cheapest mid-tier model; only as a last resort does it pick a zero-cost/unknown model, and that outcome is flagged **degraded** (`only free/local models available for fast-search — quality unknown`).
- `balanced` (reviewer, worker) — a mid-tier model.

**Free-local-model guard.** A `$0`-cost model whose tier is only a metadata guess (no id prior matched) is never treated as a qualified pick — *free is not a qualification*. Such a model can never win a scored alias over a prior-matched model, and a nonzero-cost fast model is always preferred over a zero-cost local one for `fast-search`. This is why a mixed registry (paid cloud models + a free 4-bit local model) no longer routes `search` to the local model just because it is the raw-cheapest. Give a local model a real tier with a `tiers` rule to make it eligible.

Per-role sensitivity guidance: **search** and **reviewer** work fine on weak/cheap models — routing them to a fast or mid model is the whole point of `low` mode. **Oracle** is the one role worth a paid strong-model key: a degraded oracle gives you only an independent context, not an independent stronger reasoner. Set `agents.oracle.model` to force a specific strong model.

Every resolution produces a structured outcome (`{ alias, modelId, reason, degraded, degradedReason? }`); degradation is never silent. When a run uses a degraded resolution, a one-line note is added to its milestones and completed summary.

### `/mode`

- `/mode` — print the current resolved routing table: a pool line (`pool: 6 of 14 models (filter: openrouter)` when a filter is active, otherwise `pool: 14 models (no filter)`) followed by one line per role showing resolved model id, thinking level, and turn budget, with a `⚠` marker and explanation on degraded rows.
- `/mode low` / `/mode medium` — persist the mode into `subagent-kit.json` (other fields preserved) and reprint the table.
- `/mode filter <keyword>` / `/mode filter off` — set or clear `modelFilter` (persisted, other fields preserved) and reprint the table with the new pool.

Because the Pi extension API exposes `setModel`/`setThinkingLevel`, `/mode low|medium` also **retunes the parent session**, mirroring Amp's mode tiers: `medium` runs the parent on the **strong** model (like Amp's medium tier), `low` runs it on a **mid-tier** model, both at medium thinking. A `parentModel` config override pins an exact parent model in both modes (shown with a `(manual override)` marker). A manual `agents.<role>.model` override always beats the table for that role.

## Oracle workflow

- `/oracle <question>` asks Oracle for a second opinion and includes the current Git diff.
- Prefer the dedicated `oracle` tool; it includes the working-tree diff by default. For plan review, pass `inheritConversation: true` to fork the original conversation into the read-only reasoner.
- Oracle results expose `verdict`, `confidence`, and a full Markdown report for rendering and routing. The output contract is the shared `oracleReportSchema` exported from `pi-subagent-ux`.
