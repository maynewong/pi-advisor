# Grok pane prompt ablation

Date: 2026-09-08

Goal: reduce tokens sent to the local Grok Advisor without removing the bounded Context Packet or weakening the read-only policy.

## Task

`What is the latest commit id?`

Expected answer: local `main` HEAD `a4254480f25bb090a3489c4bbaaad24894a29d3c`.

Each measurement used a fresh Grok 4.6 single-turn session in the same repository. `Edit`, `Write`, and `Bash` remained denied. Token totals include repeated model/tool turns and cache-read tokens reported by Grok, so they are directional rather than a deterministic benchmark.

## Results

| Variant | Initial consultation | Turns | Total tokens | Cost | Correct |
| --- | --- | ---: | ---: | ---: | --- |
| Inline baseline | Advisor contract + task + 124,766-byte working-tree diff | 4 | 99,766 | $0.02169 | yes |
| No diff | Advisor contract at startup + task only | 4 | 73,051 | $0.01616 | yes |
| Lazy packet | Advisor contract at startup + task + private context-file reference | 4 | 63,200 | $0.01395 | yes |
| Read-only git allow experiment | Task only; exact `git rev-parse` allowed, no blanket Bash deny | 2 | 31,859 | $0.00724 | yes |

The exact git allow reduced turns, but it cannot be combined safely with Grok's blanket `Bash(**)` deny: the deny wins regardless of CLI flag order. Removing the blanket deny would weaken the adapter's policy-enforcement claim, so this variant was rejected.

## Decision

1. Keep `includeDiff: true` semantics intact.
2. For local `grok-4.6-high`, write the already-bounded Context Packet to a mode-`0600` temporary file.
3. Send only the task, packet size/source summary, and path. Tell Grok to read it only when diff, scoped-file, or inherited-conversation evidence is relevant.
4. Create a fresh randomly named `grok-advisor-<hex>` pane for every new Advisor run so unrelated calls never inherit another run's conversation tokens. A resume stays on its run-owned pane.
5. Install stable Advisor instructions once through Grok `--rules`; do not repeat them in every pane user message.
6. Retain the context file and pane for resumed turns; remove the file and close the pane on driver disposal.
7. Keep blanket Bash denial. Token savings do not justify weakening read-only enforcement.

For this sample, the selected implementation cut reported total tokens by about 37% and cost by about 36% versus the inline baseline. More importantly, it removes the large packet from the initial user message, so irrelevant consultations do not prepay the diff on every model turn.
