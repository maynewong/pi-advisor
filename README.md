# pi-subagent-kit

A Pi subagent monorepo organized by capability rather than by individual agent role.

## Packages

- `pi-subagent-core`: A headless runtime providing managers, handles, permissions, output contracts, and artifacts.
- `pi-subagent-ux`: Host-side UX integration with built-in Oracle, Worker, Scout, and Reviewer role cards.

The dependency direction is fixed: `pi-subagent-ux -> pi-subagent-core`. Core never depends on UX or a workflow host.

## Development

```bash
npm install
npm test
npm run typecheck
```
