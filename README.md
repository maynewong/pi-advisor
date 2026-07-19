# pi-subagent-kit

A Pi subagent monorepo organized by capability rather than by individual agent role.

## Packages

- `pi-subagent-core`: A headless runtime providing managers, handles, permissions, output contracts, and artifacts.
- `pi-subagent-ux`: Host-side UX integration with dedicated `oracle`, `search`, and `reviewer` tools, a generic `subagent` tool for custom profiles, and built-in Oracle, Search, Reviewer, and Worker role cards.

The dependency direction is fixed: `pi-subagent-ux -> pi-subagent-core`. Core never depends on UX or a workflow host.

## Effort mode & model routing

A `mode` knob (`low` | `medium`, default `medium`) drives a per-role routing table that resolves model **aliases** against the actual authenticated model registry:

- `strong-reasoning` (oracle) — strongest model from a different provider/family than the parent (heterogeneous second opinion); flagged **degraded** if it can only fall back to the parent.
- `fast-search` (search) — cheapest/fastest qualifying model.
- `balanced` (reviewer, worker) — mid-tier model.

Per-role sensitivity: **search** and **reviewer** run fine on weak/cheap models; **oracle** is the one role worth a paid strong-model key (a degraded oracle gives independent context only, not an independent stronger reasoner). `agents.<role>.model` in `subagent-kit.json` is a manual per-role escape hatch that beats the table. `/mode`, `/mode low`, and `/mode medium` print/persist the mode (and retune the parent session's model + thinking level). Details live in [`packages/ux/README.md`](packages/ux/README.md#mode--model-routing).

## Soft turn budget

Per-role turn budgets are a **soft landing**, not a hard kill. Reaching a run's `maxTurns` asks the subagent to wrap up and submit its best partial answer; the run then completes with a `stoppedBy: "turn_budget"` marker that the parent can extend via `subagent_send`. A deterministic hard ceiling at 3× the soft budget is the only path that still fails as `max_turns`. See core [`docs/design.md`](packages/core/docs/design.md) §8.1.

## Development

```bash
npm install
npm test
npm run typecheck
```
