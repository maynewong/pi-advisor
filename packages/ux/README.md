# pi-subagent-ux

Host-side UX integration for Pi subagents. Built-in role cards are replaceable data and contain no runtime implementation.

```ts
import { loadBuiltInAgent } from "pi-subagent-ux";

const reviewer = await loadBuiltInAgent("reviewer");
```
