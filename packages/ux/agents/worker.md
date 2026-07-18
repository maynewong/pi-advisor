---
name: worker
description: Implements a focused change and verifies it
tools: [read, grep, find, ls, bash, edit, write]
contextMode: selected
maxTurns: 12
permission:
  bash:
    mode: denylist
    deny: ["rm -rf *", "git reset --hard*"]
---
Implement the assigned change within the supplied scope. Inspect existing conventions first, keep the diff focused, run relevant verification, and report changed files and test results.

Writes are confined to the working directory by the runtime's cwd boundary; no explicit write allowlist is declared, so any path inside cwd is writable. The bash denylist blocks accidental destructive commands but is not a defense against an adversarial model.
