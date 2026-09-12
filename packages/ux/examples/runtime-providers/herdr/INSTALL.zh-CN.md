# 将 Herdr runtime 接入 Pi

需要同时加载 Pi Advisor 主扩展和 Herdr provider 扩展。主扩展提供 `/mode`、`/advisor` 与运行管理；`extension.ts` 通过 `registerRuntimeProvider(pi.events, ...)` 注册 `herdr-advisor`。只填写 runtime 配置不会自动加载 provider。

## 1. 从当前仓库试用

先在仓库根目录安装依赖：

```bash
cd /absolute/path/to/pi-advisor
npm install
```

在 Herdr 的 pane 内启动 Pi，确保 `HERDR_ENV=1`，且 `herdr`、`codex` 均在 `PATH` 中。Codex 应已完成登录，能使用你配置的模型。Pi 与新 pane 必须使用相同的 Codex 安装和配置，包括 `CODEX_HOME`。

```bash
pi \
  -e /absolute/path/to/pi-advisor/packages/ux/extensions/subagent.ts \
  -e /absolute/path/to/pi-advisor/packages/ux/examples/runtime-providers/herdr/extension.ts
```

绝对路径允许你在被审查的项目目录中启动 Pi；不要为了加载扩展切换到插件仓库，否则 Advisor 的工作目录也会变化。若已安装 Pi Advisor 主扩展，只添加第二个 `-e`，避免重复加载主扩展。

## 2. 配置 Grok / Codex target

创建 `~/.config/pi-advisor/herdr-advisor.json`：

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
      "model": "gpt-6-astra",
      "reasoningEffort": "low"
    },
    "codex-astra-high": {
      "agent": "codex",
      "model": "gpt-6-astra",
      "reasoningEffort": "high"
    }
  }
}
```

target 名称建议使用“模型 + 思考深度”，例如 `grok-4.6-high`、`codex-astra-low` 和 `codex-astra-high`。`model` 必须是对应 CLI 当前可用的模型，`reasoningEffort` 必须受该模型支持。模型和推理强度由这个文件管理，不经过 Pi 的模型注册表。

也可在启动 Pi 前设置 `PI_HERDR_ADVISOR_CONFIG` 指向其他配置文件。配置在扩展加载时读取，修改后重启 Pi。

将下面字段合并到 `~/.pi/agent/pi-advisor.json`，保留已有的其他配置：

```json
{
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

移除已有的 `agents.advisor.model`，避免同时指定 Pi 模型和 provider 模型。Main 与 Search 仍走 Pi 的模型路由，需要在 Pi 中配置可用模型；这份配置只切换 Advisor。使用命名 profile 时，应修改实际启用的 profile，并保留完整的 Main、Advisor、Search 路由。

## 3. 长期加载

若直接使用当前仓库，可以在 `~/.pi/agent/settings.json` 的 `extensions` 数组中追加两个绝对路径，保留已有条目：

```json
{
  "extensions": [
    "/absolute/path/to/pi-advisor/packages/ux/extensions/subagent.ts",
    "/absolute/path/to/pi-advisor/packages/ux/examples/runtime-providers/herdr/extension.ts"
  ]
}
```

已通过 Pi package 安装主扩展时，只追加 Herdr 的 `extension.ts`。重启 Pi 后不再需要 `-e`。

## 4. 接入自己的 Pi 插件

把以下五个 TypeScript 文件一起放到插件的 `runtime/herdr/` 目录，保持相对路径：

```text
my-pi-plugin/
  package.json
  runtime/herdr/
    extension.ts
    provider.ts
    adapter.ts
    cli.ts
    config.ts
```

示例 JSON 是配置参考，不是扩展入口。不要把每个辅助 `.ts` 文件都注册为扩展。

在插件的 `package.json` 中合并扩展入口和依赖。以下为使用本地 core 的最小示例，把路径替换为实际仓库路径：

```json
{
  "name": "my-pi-plugin",
  "private": true,
  "type": "module",
  "pi": {
    "extensions": ["./runtime/herdr/extension.ts"]
  },
  "dependencies": {
    "@maynewong/pi-advisor-core": "file:/absolute/path/to/pi-advisor/packages/core"
  }
}
```

保留你已有的扩展入口及依赖。此处使用本地依赖，不假设 `@maynewong/pi-advisor-core` 已发布到 npm；分发插件时应换成实际可安装且与主插件兼容的 core 版本。

在自己的插件目录安装依赖，再注册本地包：

```bash
cd /absolute/path/to/my-pi-plugin
npm install
pi install /absolute/path/to/my-pi-plugin
```

这个包只注册 runtime，Pi Advisor 主插件仍需加载。不要再通过 `-e` 或 `settings.json` 重复加载同一个 Herdr provider。

若希望复用已有的插件入口，也可以在入口中导入 `./runtime/herdr/extension.ts` 的默认导出，并在初始化函数中调用 `herdrAdvisorExample(pi)`。此时只注册原有入口，不要再把 Herdr 入口添加到 `pi.extensions`。

## 5. 验证

重启 Herdr pane 中的 Pi，然后执行：

```text
/mode low
/advisor 请审查当前工作区的 diff，指出需要修复的问题
```

预期出现一个新的 `codex-advisor-<随机后缀>` pane，Codex 完成审查后，报告返回 Pi Advisor。会话保留期间该 pane 可能继续存在，以支持后续追问；释放运行时才会关闭。

| 现象 | 检查项 |
| --- | --- |
| 没有 `/mode` 或 `/advisor` | Pi Advisor 主扩展是否加载成功 |
| provider 未注册或找不到 | Herdr `extension.ts` 是否已加载，而不是仅填写 JSON |
| `Unknown Herdr advisor target` | 两份 JSON 中的 target 名称是否一致，修改后是否重启 |
| `requires Pi to run inside Herdr` | 从真实 Herdr pane 启动 Pi，不要仅手动设置环境变量 |
| MCP inventory 相关错误 | 在相同工作目录执行 `codex mcp list --json`，确认 CLI 可读取配置 |
| 模型不可用 | 区分 Pi 的 Main/Search 模型与 Codex 的 Advisor 模型，检查对应账号权限 |

只读限制和 MCP 配置约束详见 [运行说明](./README.md#read-only-enforcement)。
