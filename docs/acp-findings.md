# CodeBuddy CLI ACP 协议笔记（文档 + 本机实测）

> 目标：为 DSH 插件「把本机 CodeBuddy CLI 通过 ACP 当 agent/模型用」提供**可照着写客户端**的协议事实。
>
> - 实测环境：Windows 11 / PowerShell / Node v24.22.0 / npm 11.19.1
> - CLI：`@tencent-ai/codebuddy-code` **v2.177.1**（`codebuddy --version`）
> - 安装位置：`%APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code`
> - CLI 内部依赖：`@agentclientprotocol/sdk@1.9.0`（本机自带官方 ACP schema，本文的「标准」定义均据此核对）
> - 实测日期：2026-10-28
>
> **证据等级标记**
> - 【文档】= 官方文档 <https://www.codebuddy.ai/docs/zh/cli/acp>（已抓全文，本地留存 `probe/acp-doc.txt`，不随仓库分发）
> - 【实测】= 本机探针抓到的真实帧（抓包日志留在本机 `probe/out/*.jsonl`，含账号标识，不入仓库）
> - 【schema】= 本机 `@agentclientprotocol/sdk` 的 `schema/schema.json`（ACP 1.x 标准定义）
> - 【未验证】= 本次未跑通/未覆盖，写明原因

---

## 0. 一页速查（写客户端最关键的 10 条）

1. **启动**：`codebuddy --acp`，stdio 传输，**NDJSON**（每行一个 JSON-RPC 2.0 消息，**没有** `Content-Length` 头）。【文档+实测】
2. **必须先 `authenticate`，再 `session/new`**。即使本机已有登录凭据，不调 `authenticate` 时 `session/new` 也会稳定返回 `-32000 Authentication required`。【实测】
3. `authenticate` 的 4 个 method 里，**`internal`（微信）在本机可静默成功**（8.7s / 12.2s，返回 userinfo）；`iOA`/`external`/`selfhosted` 会**挂起并拉起浏览器**（实测拉起了 msedge），10s 内不返回。【实测】
4. `session/new` 的响应同时给 **`models`**（ACP 模型扩展，含 `maxInputTokens`/`effortOptions`）和 **`configOptions`**（`model`/`mode`/`thought_level`/`sandbox`/`multitask`/`codeMode`）。模型列表**以 `models.availableModels` 为准**，`--help` 里的清单是另一套静态表。【实测】
5. `session/prompt` 的 result **没有 `usage` 字段**（只有 `stopReason` / `userMessageId` / `_meta`）；token 用量和费用只能从 **`usage_update` 通知**里累计。【实测】
6. 流式正文是 `session/update` 通知，`params.update.sessionUpdate` 是判别字段；标准共 **19 种**变体，本次实测触发 5 种。【schema+实测】
7. **未知通知、未知 `_meta` 必须忽略**：CodeBuddy 会发非标准方法 `_codebuddy.ai/command`（如 `workspace_info`）和大量 `codebuddy.ai/*` 元数据。【实测】
8. `session/update` 极其密集：一次「1+1=?」在 10s 内发了 **37 条**，其中 `session_info_update` 占 15 条。插件要按需节流/过滤。【实测】
9. **关 stdin 不会让进程退出**（等 8s 仍存活），必须显式杀进程树（Windows 用 `taskkill /PID <pid> /T /F`）。【实测】
10. stdout **零污染**、stderr **零字节**（含 62s 空闲期）：可以安全地把 stdout 当纯协议流。【实测】

---

## 1. 启动方式

### 1.1 确切命令

```bash
codebuddy --acp
```

【文档】官方 ACP 文档「启动 ACP 模式」一节原文即 `codebuddy --acp`；Zed 配置为 `{"command":"codebuddy","args":["--acp"],"env":{}}`。

【实测】`codebuddy --help` 中相关三条（原文）：

```
  --serve                    Start HTTP server (Web UI, REST API, ACP over HTTP SSE).
                             Without --acp, ACP does not use stdio. (default: false)
  --acp                      Start in ACP (Agent Client Protocol) mode - enables
                             communication via stdin/stdout using ndJsonStream (default: false)
  --acp-transport <transport>  ACP transport (only works with --acp): "stdio" (default)
                             or "streamable-http" (default: "stdio")
```

→ **「ndJsonStream」是 CLI 自己的措辞**，与实测一致（见第 2 节）。

### 1.2 与 ACP 客户端相关的其它启动参数【实测（help 原文）】

| 参数 | 作用 | 备注 |
|---|---|---|
| `--acp-transport stdio\|streamable-http` | 传输方式 | 默认 stdio；http 未验证 |
| `--model <model>` | 会话默认模型 | 静态清单 19 个，见 5.4 |
| `--permission-mode <mode>` | 权限模式：`acceptEdits`/`bypassPermissions`/`default`/`plan`/`dontAsk`/`auto` | 会改变是否发 `session/request_permission` |
| `-y, --dangerously-skip-permissions` | 跳过权限提示 | 高风险；HIGH/CRITICAL 仍会问 |
| `--mcp-config <fileOrString>` | 从 CLI 侧加载 MCP server | 与 ACP 的 `mcpServers` 是两条独立通道 |
| `--strict-mcp-config` | 只用 `--mcp-config`，忽略其它 MCP 配置 | |
| `--add-dir <dirs...>` | 追加可访问目录 | 会话内也有 `additionalDirectories` |
| `--agent <agent>` | 进程级默认 agent | ACP 下**不要**加 `--agent multitask`/`--multitask`，入口守卫会拒（【文档】） |
| `--session-id <uuid>` | 指定会话 id | 与 ACP `session/new` 生成 id 的关系未验证 |

### 1.3 启动前置条件（登录）【文档+实测】

两条路（官方文档只对 Zed 场景写了第 2 条）：

1. **交互式登录**：直接跑 `codebuddy` 进 TUI，执行 `/login`，按提示完成浏览器授权（本机 `~/.codebuddy/settings.json` 不存 token，登录态在 `local_storage` 里）。
2. **环境变量**：`CODEBUDDY_API_KEY=<key>`，并按发行版配 `CODEBUDDY_INTERNET_ENVIRONMENT`：
   - 海外版：不设置（默认）
   - 中国版：`internal`
   - iOA 版：`ioa`

> 【实测】本机未登录时，headless 模式 `codebuddy -p "..."` 的行为：
> ```
> Authentication required. Please use /login command to sign in to your account
> ```
> 注意 **exit code = 0**（失败但退出码为 0，脚本化时要靠 stdout 文本判定）。
>
> 【实测】ACP 进程启动本身**不需要登录**：`initialize` 正常返回并带回 `authMethods`；直到 `session/new` 才被拦。

### 1.4 启动开销【实测】

- 进程 start → `initialize` 响应：**约 1.6s**（第 1 帧 15ms 发出，响应 1668ms 到达）。
- 之后 `authenticate(internal)`：**8.7s / 12.2s**（一次 20s 超时失败，建议给 **60~120s** 超时）。
- `session/new`：约 1~2s（含拉取模型清单）。

→ **不要在每次 prompt 时新起进程**，应复用长驻进程。

---

## 2. 传输与帧格式【实测】

| 项 | 结论 | 证据 |
|---|---|---|
| 编码 | **NDJSON**：一行一个 JSON-RPC 2.0 对象，`\n` 结尾 | 所有 `probe/out/*.jsonl` 的 `dir:"in"/"out"` 帧 |
| 分帧头 | **没有** `Content-Length` / `\r\n\r\n` | 首帧响应是从 stdout 直接读到的整行 JSON |
| 空行 | 忽略 | 探针按 `trim()` 空行跳过，未出现异常 |
| 畸形行 | 回 `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`，**进程继续存活** | `errors` 场景 |
| 客户端 id | 数字或**字符串均可**（服务端原样回显） | `errors.stringIdRequest` 用 `"dsh-probe-string-id"` 正常收到 -32601 |
| 服务端 id | 服务端→客户端请求用**自己的数字 id 空间** | 与客户端 id 可能撞号，必须用「有无 `method`」区分请求/响应 |
| stdout | **纯协议流，零污染**（多次运行 `stdoutPollutedLines=[]`） | `probe/out/*.summary.json` |
| stderr | **0 字节**（含 62s 空闲/鉴权挂起期） | `probe/out/*.stderr.log` 全为空 |
| stdin EOF | **进程不退出**（关 stdin 后等 8s 仍 `timedOut:true`） | `auth` 场景 `gracefulExit` |
| 结束方式 | 必须显式杀进程树；Windows 用 `taskkill /PID <pid> /T /F` | 探针 `stop()` |

### 2.1 JSON-RPC 信封

```jsonc
// 客户端 → 服务端 请求
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
// 服务端 → 客户端 响应
{"jsonrpc":"2.0","id":1,"result":{...}}          // 或 "error":{"code":...,"message":...,"data":...}
// 服务端 → 客户端 通知（无 id）
{"jsonrpc":"2.0","method":"session/update","params":{...}}
// 客户端 → 服务端 通知（无 id）
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"..."}}
```

> 【实测】`session/cancel` 是**通知**（无 id），符合 ACP 规范；但本次未成功实测其行为（见第 11 节）。

### 2.2 探针实测到的完整时序（`init` 场景，原始 JSONL）

```
  15ms  out  initialize
1668ms  in   { id:1, result:{protocolVersion, agentCapabilities, authMethods} }
1669ms  out  authenticate {methodId:"iOA"}
 ...    无任何帧（挂起，浏览器授权等待中）
```

---

## 3. 握手：`initialize`

### 3.1 请求（探针实际发送，推荐照抄）

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": true, "writeTextFile": true },
      "terminal": true,
      "auth": { "terminal": false }
    },
    "clientInfo": { "name": "dsh-acp-probe", "title": "DSH ACP Probe", "version": "0.0.1" }
  }
}
```

- `protocolVersion: 1` 被接受，响应里**原样回 `1`**。【实测】
- `clientCapabilities` 只有 `fs`/`terminal` 会实际改变服务端行为（文档「工具代理机制」）；`auth.terminal` 未见效果。
- 重复 `initialize` 幂等，返回同一份结果。【实测】

### 3.2 响应全文（本机真实返回，S 级证据）

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "promptCapabilities": { "image": true, "embeddedContext": true },
    "mcpCapabilities": { "http": true, "sse": true },
    "loadSession": true,
    "delegateToolsSupport": true,
    "mainAgentSupport": false,
    "multitaskSupport": true,
    "codeModeSupport": true,
    "metaPromptSupport": true
  },
  "authMethods": [
    { "id": "iOA",        "name": "Login with iOA",              "description": null },
    { "id": "external",   "name": "Login with Google/Github",    "description": null },
    { "id": "internal",   "name": "Login with WeChat",           "description": null },
    { "id": "selfhosted", "name": "Login with Enterprise Domain", "description": null }
  ]
}
```

### 3.3 `agentCapabilities` 逐字段

| 字段 | 值 | 含义 | 来源 |
|---|---|---|---|
| `promptCapabilities.image` | `true` | prompt 里可带 `{"type":"image"}` | 【实测】+【schema】 |
| `promptCapabilities.embeddedContext` | `true` | 可带 `{"type":"resource"}` 内嵌上下文 | 【实测】+【schema】 |
| `promptCapabilities.audio` | **缺失**（=false） | 不支持音频 | 【实测】 |
| `mcpCapabilities.http` | `true` | 支持 `{"type":"http",...}` 的 MCP server | 【实测】 |
| `mcpCapabilities.sse` | `true` | 支持 `{"type":"sse",...}` 的 MCP server | 【实测】 |
| `mcpCapabilities.acp` | **缺失**（=false） | 不支持 ACP 形态的 MCP | 【实测】 |
| `loadSession` | `true` | 支持 `session/load` | 【实测】 |
| `delegateToolsSupport` | `true` | **CodeBuddy 扩展**：工具委派（客户端代理 fs/terminal） | 【实测】 |
| `mainAgentSupport` | `false` | **CodeBuddy 扩展**：agent picker / `session/set_agent` 不可用 | 【实测】 |
| `multitaskSupport` | `true` | **CodeBuddy 扩展**：可开 Multitask | 【实测】+【文档】 |
| `codeModeSupport` | `true` | **CodeBuddy 扩展**：可开 PTC Code Mode | 【实测】+【文档】 |
| `metaPromptSupport` | `true` | **CodeBuddy 扩展**：`_meta` 提示词相关 | 【实测】（文档未提） |

> 注意：**响应里没有 `sessionCapabilities` 字段**，所以不能据此判断 `session/list`、`session/resume`、`session/fork`、`session/close` 是否可用（CLI bundle 里这些方法名字符串都存在）。本次未逐个验证。

> `authMethods` **不是**「未登录」的信号：登录成功后再次 `initialize` 依然返回这 4 条。【实测】

---

## 4. 鉴权：`authenticate`

### 4.1 请求

```json
{"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":"internal"}}
```

### 4.2 四个 method 的实测行为（本机，逐条真发）

| methodId | name | 实测行为 | 耗时 | 返回值 |
|---|---|---|---|---|
| `iOA` | Login with iOA | **挂起**，期间无任何帧；本轮检测到新起 msedge 进程 | >10s（我方超时） | 无 |
| `external` | Login with Google/Github | **挂起**，期间收到 1 帧；同期新起 msedge 进程 | >10s | 无 |
| `internal` | Login with WeChat | **静默成功**（本机有缓存凭据） | 8.7s / 12.2s | 见下 |
| `selfhosted` | Login with Enterprise Domain | **挂起**，无帧 | >10s | 无 |

> 结论：**这些 `authenticate` 是真正的登录动作**（不是纯声明），会拉起浏览器授权页并阻塞等待用户操作。
> 若要给 DSH 做「一键登录」，只能选 `internal`，且必须处理「无缓存凭据时长时间挂起 → 主动超时并提示用户去 TUI `/login`」。

### 4.3 成功返回（`internal`，真实响应）

```json
{
  "_meta": {
    "codebuddy.ai/userinfo": {
      "userId": "<你的 userId，UUID 形式>",
      "userName": "<你的昵称>",
      "userNickname": "<你的昵称>",
      "authType": "personal"
    }
  }
}
```

- 【文档】只写了 `userId` / `userName` / `userNickname`；【实测】多一个 **`authType: "personal"`**。
- 【实测】这个登录态**不写盘复用**：下一个进程 `initialize` 时日志仍显示 `hasAccessToken=false`，必须重新 `authenticate`。

### 4.4 未鉴权时的错误（S 级证据，插件按这个分支）

`session/new` 在**未调 `authenticate`** 时返回（耗时约 1.6~2.5s）：

```json
{"code":-32000,"message":"Authentication required","data":{"category":"auth"}}
```

完整帧：

```json
{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required","data":{"category":"auth"}}}
```

- 判断依据请用 **`error.data.category === "auth"`**，不要匹配 message 文案。【实测】
- 同一错误在 `initialize` 之前调用任何会话方法也会出现（探针 `callBeforeInitialize_sessionNew` 同样得到 auth 错误，说明**鉴权检查早于「是否已初始化」检查**）。

---

## 5. 会话：`session/new`

### 5.1 请求

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/new",
  "params": {
    "cwd": "C:\\...\\plugins\\dsh-codebuddy-acp\\probe\\work",
    "mcpServers": []
  }
}
```

- `cwd`：**必填，绝对路径**（【schema】+【实测】）
- `mcpServers`：**必填**，即使不用也要给 `[]`（漏了会 -32602，见 10.2）
- 可选：`additionalDirectories`、`systemPrompt`（需 agent 声明 `sessionCapabilities.systemPrompt`，本机未声明）、`_meta`

### 5.2 成功响应结构（本机真实，顶层字段）

```
sessionId, models, modes, configOptions, multitaskOn
```

| 字段 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `sessionId` | string | 例如 `01a00000-0000-7000-8000-000000000001`（UUIDv7 形态） | 【实测】 |
| `models` | object | `{availableModels:[...], currentModelId}`，**ACP 模型扩展** | 【实测】 |
| `modes` | object | `{availableModes:[...], currentModeId}`，标准 ACP | 【实测】 |
| `configOptions` | array | ACP session config options（`type: select\|boolean`） | 【实测】 |
| `multitaskOn` | boolean | **CodeBuddy 顶层扩展**，true 表示 multitask overlay 已开 | 【实测】 |
| `_meta` | — | 本机**未返回** | 【实测】 |

### 5.3 `models`（模型权威来源）

```jsonc
{
  "currentModelId": "hy4-preview",
  "availableModels": [
    {
      "modelId": "hy4-preview",
      "name": "Hy4 preview",
      "description": "x0.29 credits",
      "_meta": {
        "supportsImages": true,
        "supportsReasoning": true,
        "credits": "x0.29 credits",
        "maxInputTokens": 1000000,
        "effortOptions": [ { "value": "high", "name": "High" } ]
      }
    }
  ]
}
```

- `_meta` 里的 `maxInputTokens` / `effortOptions` 是**CodeBuddy 扩展**，标准 ACP 没有；对插件做上下文预算、reasoning effort 映射非常有用。

**本机登录账号下 `availableModels` 全量（17 个，实测）：**

| modelId | name | maxInputTokens | credits | 能力 | effort 档 |
|---|---|---|---|---|---|
| `hy4-preview` | Hy4 preview | 1000000 | x0.29 | 图像+推理 | high |
| `hy3` | Hy3 | 192000 | x0.00 | 图像+推理 | low/medium/high/xhigh |
| `hy3-x` | Hy3 | 192000 | x0.05 | 图像+推理 | low/medium/high/xhigh |
| `deepseek-v4.1-flash` | Deepseek-V4.1-Flash | 1000000 | x0.03 | 图像+推理 | low/medium/high/xhigh |
| `glm-5.3` | GLM-5.3 | 1000000 | x0.79 | 图像+推理 | low/medium/high/xhigh |
| `glm-5.3-flash` | GLM-5.3-Flash | 1000000 | x0.06 | 图像+推理 | low/high/max |
| `glm-5.3-flashx` | GLM-5.3-FlashX | 1000000 | x0.14 | 图像+推理 | low/high/max |
| `glm-5.2` | GLM-5.2 | 1000000 | x0.79 | 推理 | low/medium/high/xhigh |
| `glm-5.1` | GLM-5.1 | 200000 | x0.79 | 推理 | low/medium/high/xhigh |
| `glm-5v-turbo` | GLM-5v-Turbo | 200000 | x0.71 | 图像+推理 | low/medium/high/xhigh |
| `minimax-m3-pay` | MiniMax-M3 | 512000 | x0.25 | 图像+推理 | low/medium/high/xhigh |
| `minimax-m2.7` | MiniMax-M2.7 | 200000 | x0.26 | 图像+推理 | low/medium/high/xhigh |
| `kimi-k3-2` | Kimi-K3 | 1000000 | x1.62 | 图像+推理 | low/high/max |
| `kimi-k2.8-preview` | Kimi-K2.8-Preview | 1000000 | x0.77 | 图像+推理 | low/high/max |
| `kimi-k2.7` | Kimi-K2.7-Code | 256000 | x0.57 | 图像+推理 | low/medium/high/xhigh |
| `kimi-k2.6` | Kimi-K2.6 | 256000 | x0.52 | 图像+推理 | low/medium/high/xhigh |
| `deepseek-v4-pro` | Deepseek-V4-Pro | 1000000 | x0.51 | 图像+推理 | low/medium/high/xhigh |

> ⚠️ **`currentModelId` 可能不在 `availableModels` 里**：实测第一次建会话返回 `"currentModelId": "codewise-chat"`，而 17 个选项里没有这个 id，实际请求用的却是 `Hy4 preview`。
> → 插件必须容错；判断「真正生效的模型」要读 `session_info_update._meta['codebuddy.ai/requestModelName']` / `responseModelId`（见 6.5）。

### 5.4 `--help` 的静态模型清单 vs 会话模型清单

`codebuddy --help` 原文（本地留存 `probe/cli-help.txt`，官方文档全文同理，均不随仓库分发）：

```
--model <model>  Model for the current session. Please provide the model ID. Currently supported:
(hy4-preview, hy3, hy3-x, deepseek-v4.1-flash, step-5-preview, glm-5.3, glm-5.3-flash, glm-5.2,
glm-5.1, glm-5v-turbo, space-bunny, minimax-m3.1-flash, minimax-m3, minimax-m2.7, kimi-k3.1-pro,
kimi-k3-1, kimi-k2.8-preview, deepseek-v4-pro, mimo-v2.6-pro)
```

数一下是 **19 个**，与会话里的 17 个**不一致**：

- help 独有：`step-5-preview`, `space-bunny`, `minimax-m3.1-flash`, `minimax-m3`, `kimi-k3.1-pro`, `kimi-k3-1`, `mimo-v2.6-pro`
- 会话独有：`glm-5.3-flashx`, `minimax-m3-pay`, `kimi-k3-2`, `kimi-k2.7`, `kimi-k2.6`

**结论：`--help` 是写死的静态表；真实可用的模型随账号权益/发行变体变化，必须以 `session/new` 的 `models.availableModels` 为准。**

> 关于「37 个模型（含 `claude-sonnet-5` … `deepseek-v4-pro-ioa`）」：本机 v2.177.1 的 `--help` 里**没有** `claude-sonnet-5`。该字符串只出现在发行变体文件 `product.ioa.json`（8 处），本机当前生效变体是 `internal`（CLI 日志：`Product configuration for environment 'internal'`）。
> 即：**不同发行（internal / iOA / cloudhosted / selfhosted）的模型池不同**，可执行文件是同一个。若要覆盖多变体，应从 `session/new` 动态取，而不是抄静态表。

### 5.5 `modes`（标准 ACP）

```json
{
  "currentModeId": "default",
  "availableModes": [
    {"id":"default","name":"Always Ask"},
    {"id":"acceptEdits","name":"Accept Edits"},
    {"id":"plan","name":"Plan"},
    {"id":"auto","name":"Auto"},
    {"id":"dontAsk","name":"Don't Ask"},
    {"id":"bypassPermissions","name":"Bypass Permissions"},
    {"id":"fullAccess","name":"Full Access"}
  ]
}
```

- `fullAccess` 是**CodeBuddy 扩展模式**（「跳过所有权限检查，包括危险命令」）。
- 切换：`session/set_mode` `{"sessionId":..., "modeId":"acceptEdits"}` → 返回 `{}`。【实测】

### 5.6 `configOptions`（完整实测值）

| id | type | currentValue | options 数 | 备注 |
|---|---|---|---|---|
| `mode` | select | `default` | 7 | 与 `modes` 重复，两种表达 |
| `model` | select | `hy4-preview`（首测为 `codewise-chat`） | 17 | 与 `models` 重复 |
| `thought_level` | select | `enabled` | 2 | `high` / `enabled`；**CodeBuddy 扩展** |
| `sandbox` | select | `"false"` | 2 | `"true"`/`"false"` 字符串布尔；**CodeBuddy 扩展** |
| `multitask` | boolean | `false` | 0 | `category: "_codebuddy.ai/multitask"` |
| `codeMode` | select | `off` | 2 | `off` / `all`；`category: "_codebuddy.ai/codeMode"` |

> 官方文档约定：**按 `id` 作为主键**，`category` 只是元数据；插件必须能消化未知 `category`。

---

## 6. `session/prompt` 与流式更新

### 6.1 请求

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/prompt",
  "params": {
    "sessionId": "01a00000-0000-7000-8000-000000000001",
    "prompt": [{ "type": "text", "text": "用一句话回答：1+1=? 只输出结果。" }]
  }
}
```

- 可选 `_meta['codebuddy.ai/conversationRequestId']`（32 位小写无连字符 UUIDv7），用于把这一轮串到 `PromptResponse._meta`、`SessionUpdate._meta`、模型请求头 `X-Conversation-Request-ID`。【文档】本次未验证。

### 6.2 结果（真实响应，注意：**没有 usage**）

```json
{
  "stopReason": "end_turn",
  "userMessageId": "01a00000-0000-7000-8000-000000000002",
  "_meta": {
    "timestamp": "2026-10-28T10:31:06.432Z",
    "codebuddy.ai/requestId": "01a00000000070008000000000000003",
    "codebuddy.ai/conversationRequestId": "01a00000000070008000000000000003",
    "codebuddy.ai/traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "codebuddy.ai/finishReason": "stop",
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "baggage": "codebuddy.session_id=01a18210-...,codebuddy.conversation_request_id=...",
    "codebuddy.ai/traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "codebuddy.ai/outcome": "SUCCESS"
  }
}
```

- `stopReason`：标准 ACP 枚举（`end_turn` / `max_tokens` / `max_turn_requests` / `refusal` / `cancelled`）。实测 `end_turn`。
- **`userMessageId` 是 CodeBuddy 扩展**（标准 ACP 的 PromptResponse 只有 `stopReason` + 可选 `usage`）。
- **`usage` 字段缺失** → token/费用必须从 `usage_update` 通知累计。【实测】
- `_meta` 里的 `traceparent`/`baggage` 是 W3C trace 透传，插件可忽略（但可存下来排障）。

### 6.3 实测：一次 prompt 的 37 条 `session/update` 顺序

```
01 available_commands_update      (82 个 slash 命令)
02 usage_update                   used=0   size=1000000
03 session_info_update            agentPhase=idle
04 session_info_update            progress=null
05 session_info_update            agentPhase=preparing
06 session_info_update            agentPhase=preparing
07 usage_update                   used=49577 size=1000000 (systemPrompt 3194/conversation 13/tools 43954/skills 2416)
08 session_info_update            agentPhase=model_requesting, requestModelName="Hy4 preview"
09 available_commands_update      (再来一次，同上)
10-11 session_info_update
12-32 agent_thought_chunk ×21     reasoning 文本分片
33 agent_message_chunk            "2"
34 usage_update                   used=0 size=0 cost{amount:3.81,currency:""} + 详细 token 明细
35-37 session_info_update         agentPhase=model_done → idle → idle → 标题更新
```

外加 1 条**非 `session/update` 通知**：`_codebuddy.ai/command`（见 6.7）。

### 6.4 `session/update` 变体全集（19 种，标准 schema）

判别字段：`params.update.sessionUpdate`。**未知值必须静默忽略**。

| # | `sessionUpdate` 值 | 关键字段 | 本次实测 |
|---|---|---|---|
| 1 | `user_message_chunk` | `content` | 未观察到 |
| 2 | `agent_message_chunk` | `content` | ✅ 实测 |
| 3 | `agent_thought_chunk` | `content` | ✅ 实测（21 条推理分片） |
| 4 | `tool_call` | `toolCallId,title,kind,status,content,locations,rawInput` | 未观察到（prompt 未触发工具） |
| 5 | `tool_call_update` | `toolCallId,status,kind,title,content` | 未观察到 |
| 6 | `plan` | `entries[]` | 未观察到 |
| 7 | `plan_update` | — | 未观察到（UNSTABLE） |
| 8 | `plan_removed` | — | 未观察到（UNSTABLE） |
| 9 | `available_commands_update` | `availableCommands[]` | ✅ 实测（82 条，含 name/description） |
| 10 | `current_mode_update` | `currentModeId` | 未观察到（切 mode 后可能出现） |
| 11 | `config_option_update` | `configOptions[]`（全量） | 未观察到 |
| 12 | `session_info_update` | `title`,`_meta` | ✅ 实测（15 条，含 agentPhase） |
| 13 | `usage_update` | `used`,`size`,`cost?`,`_meta` | ✅ 实测（3 条） |
| 14 | `notice` | `severity`,`message` | 未观察到 |
| 15 | `compaction_update` | — | 未观察到 |
| 16 | `compaction_summary_chunk` | — | 未观察到 |
| 17 | `subagent_update` | — | 未观察到（UNSTABLE） |
| 18 | `session_message` | — | 未观察到（UNSTABLE） |
| 19 | `session_message_chunk` | — | 未观察到（UNSTABLE） |

> 另外，CodeBuddy 文档还提到 `session_info_update._meta['codebuddy.ai/teamUpdate']`（Agent Teams）与 `memberEvent` 标记，本次未复现。

### 6.5 `session_info_update`：CodeBuddy 的「阶段机」

真实帧（节选）：

```json
{
  "sessionUpdate": "session_info_update",
  "title": "Answer simple math question",
  "_meta": {
    "codebuddy.ai/agentPhase": { "phase": "model_requesting", "startedAt": 1793183456880 },
    "codebuddy.ai/requestId": "01a00000000070008000000000000003",
    "codebuddy.ai/messageRequestId": "01a00000-0000-7000-8000-000000000004",
    "codebuddy.ai/traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "codebuddy.ai/requestModelName": "Hy4 preview",
    "codebuddy.ai/responseModelId": "hy4-preview",
    "codebuddy.ai/traceparent": "00-...-01",
    "traceparent": "00-...-01",
    "baggage": "codebuddy.session_id=...,codebuddy.conversation_request_id=...",
    "timestamp": "2026-10-28T10:30:56.880Z"
  }
}
```

- 已观测的 `phase`：`idle` → `preparing` → `model_requesting` → `model_done` → `idle`。
- **`requestModelName` / `responseModelId` 是判断「这一轮实际用了哪个模型」的可靠来源**（比 `currentModelId` 可靠）。
- 有 `title` 的帧表示会话标题被自动生成（`"Answer simple math question"`）。

### 6.6 `usage_update` 的两种形态（重要）

**a) 上下文占用（无 cost）**

```json
{
  "sessionUpdate": "usage_update",
  "used": 49577,
  "size": 1000000,
  "_meta": {
    "codebuddy.ai/usageByCategory": {
      "systemPrompt": 3194, "conversation": 13, "tools": 43954, "mcp": 0, "skills": 2416, "version": 1
    }
  }
}
```

**b) 本轮结算（带 cost，`used`/`size` 归零）**

```json
{
  "sessionUpdate": "usage_update",
  "used": 0,
  "size": 0,
  "cost": { "amount": 3.81, "currency": "" },
  "_meta": {
    "codebuddy.ai/requestId": "01a00000000070008000000000000003",
    "codebuddy.ai/messageId": "01a00000000070008000000000000005",
    "usage": {
      "prompt_tokens": 27073, "completion_tokens": 46, "total_tokens": 27119,
      "completion_tokens_details": { "reasoning_tokens": 43, "cached_tokens": 0 },
      "prompt_tokens_details": { "cached_tokens": 512 },
      "prompt_cache_hit_tokens": 512, "prompt_cache_miss_tokens": 26561,
      "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
      "completion_thinking_tokens": 43, "credit": 3.81, "cached_tokens": 0
    },
    "codebuddy.ai/requestCredits": { "01a00000000070008000000000000003": 3.81 }
  }
}
```

- 标准 ACP `Usage` = `{totalTokens, inputTokens, outputTokens, thoughtTokens?, cachedReadTokens?, cachedWriteTokens?}`；
  CodeBuddy 实际给的是 **OpenAI 风格 `_meta.usage`** + 顶层 `cost`，**没有**标准的 `totalTokens/inputTokens/outputTokens` 三件套。
  → 插件要做字段映射：`inputTokens←prompt_tokens`、`outputTokens←completion_tokens`、`totalTokens←total_tokens`、`thoughtTokens←completion_tokens_details.reasoning_tokens`、`cachedReadTokens←prompt_tokens_details.cached_tokens`。
- `cost.currency` 是**空串**（不是 `USD`/`CNY`），`amount` 与 `credit` 同值。
- 「1+1=?」被计 **3.81 credits**，`prompt_tokens=27073`（系统提示+工具定义 43954 字符级占用导致），可见**空会话首轮成本很高**，插件做预算时要按 `usage_update` 首个 `used` 估算。

### 6.7 非标准通知：`_codebuddy.ai/command`

```json
{
  "jsonrpc": "2.0",
  "method": "_codebuddy.ai/command",
  "params": {
    "sessionId": "01a00000-0000-7000-8000-000000000001",
    "action": "workspace_info",
    "params": { "isGitWorkspace": false }
  }
}
```

- 不是 ACP 方法，是 CodeBuddy 私有扩展；**客户端必须忽略未知通知**，否则会因 -32601 干扰服务端。
- 本次只观测到 `workspace_info` 一种 action。

### 6.8 `available_commands_update`（82 条 slash 命令，实测）

```
background, bg, branch, btw, clear, autocompact, context, cost, doctor, feedback, fork, fork-bg,
gateway, goal, remote-control, keybindings, login, logout, model:lite, model:reasoning, multitask,
delegate, agent-mode, plan, pr-comments, release-notes, review, skills, web, todos, reload-plugins,
plugin-validate, workflows, effort, deep-research, simplify, code-review, verify, copy, debug,
model:text-to-video, model:image-to-video, init, compact, _compact, statusline, security-review,
commit, commit-push-pr, insights, loop, lark-approval, lark-apps, lark-attendance, lark-base,
lark-calendar, lark-contact, lark-doc, lark-drive, lark-event, lark-im, lark-mail, lark-markdown,
lark-meeting, lark-minutes, lark-note, lark-okr, lark-openapi-explorer, lark-shared, lark-sheets,
lark-skill-maker, lark-slides, lark-task, lark-vc-agent, lark-vc, lark-whiteboard, lark-wiki,
lark-workflow-meeting-summary, lark-workflow-standup-report
```

- 该列表里出现了 `login` / `logout`：说明**在 ACP 会话内也可以发 `/login` 这类 slash 命令**（作为普通 prompt 文本）。
- 列表包含本机安装的 lark 系列 skill，说明**命令列表 = 内置命令 + 本机 skills/plugins 动态合成**，因机器而异，不能写死。

---

## 7. 模型切换（三条路径，实测对比）

| 方法 | 请求 | 返回 | 是否校验 modelId | 评价 |
|---|---|---|---|---|
| `session/set_model` | `{"sessionId","modelId"}` | `{"modelId":"..."}` | **不校验** | 传 `__dsh_probe_no_such_model__` 也返回 OK，危险 |
| `session/set_config_option` | `{"sessionId","configId":"model","value":"hy3"}` | `{"configOptions":[...]}` 全量回显 | **校验** | 推荐路径（文档也这么写） |
| `--model <id>` 启动参数 | 命令行 | — | 启动时校验 | 只影响新建会话的默认值 |

实测：

```jsonc
// 不校验（危险）
→ {"jsonrpc":"2.0","id":6,"result":{"modelId":"__dsh_probe_no_such_model__"}}

// 校验 + 回显
→ {"jsonrpc":"2.0","id":7,"result":{"configOptions":[
     {"type":"select","id":"model","currentValue":"hy3", ...},
     ...其它 5 个 configOption 原样回显...
   ]}}
```

- `session/get_config_options` **不存在**（-32601）。读当前值靠 `session/new` 响应或 `set_config_option` 的回显。
- `session/set_config_option` 用 **`configId`** 字段（不是 `id`），`value` 类型要与 option 的 `type` 匹配（boolean 必须真 boolean，字符串 `"true"` 会被拒 —— 文档对 `multitask` 明确说明）。
- `session/set_mode` 与 `configOptions.mode` 是同一件事的两种表达，返回 `{}`。

---

## 8. 权限询问 `session/request_permission`（【未验证】）

> 本次因中途停止（用户正在手动登录），**未跑到写文件/执行命令的 prompt**，所以没有实测帧。
> 下面全部来自【schema】+【文档】，插件可按此实现，但需再验一次。

### 8.1 服务端 → 客户端 请求

```jsonc
{
  "jsonrpc": "2.0",
  "id": 100,                       // 服务端自己的 id 空间
  "method": "session/request_permission",
  "params": {
    "sessionId": "01a18210-...",
    "toolCall": {                  // ToolCallUpdate（非完整 ToolCall）
      "toolCallId": "call_abc",
      "title": "Write acp-perm-test.txt",
      "kind": "edit",              // read|edit|delete|move|search|execute|think|fetch|other
      "status": "pending",         // pending|in_progress|completed|failed
      "content": [ /* ToolCallContent[] */ ],
      "locations": [ { "path": "C:\\...\\acp-perm-test.txt", "line": null } ],
      "rawInput": { "file_path": "...", "content": "..." }
    },
    "options": [
      { "optionId": "allow_once",    "name": "Allow once",    "kind": "allow_once" },
      { "optionId": "allow_always",  "name": "Always allow",  "kind": "allow_always" },
      { "optionId": "reject_once",   "name": "Reject",        "kind": "reject_once" }
    ]
  }
}
```

- `PermissionOption.kind` 枚举：`allow_once` | `allow_always` | `reject_once` | `reject_always`。
- `optionId` 的具体取值**由 agent 决定**，不要硬编码 —— 必须按 `kind` 选，或直接把 `options` 原样渲染给用户点。

### 8.2 客户端回应

```jsonc
// 选中某个选项
{"jsonrpc":"2.0","id":100,"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}
// 用户取消
{"jsonrpc":"2.0","id":100,"result":{"outcome":{"outcome":"cancelled"}}}
```

### 8.3 与 permission mode 的关系

- `modes.availableModes` 决定「问不问」：`default` 每次都问，`acceptEdits` 自动接受编辑，`bypassPermissions`/`fullAccess` 不问。
- 若客户端**没有**声明 `fs`/`terminal` 能力，CodeBuddy 会用自己的内置工具执行，此时才需要 `request_permission`；若声明了，按【文档】「工具代理机制」会把 `fs.readTextFile`/`fs.writeTextFile`/`terminal/*` **代理给客户端**执行。
  → 这正是 DSH 插件可以「接管文件/终端」的钩子，但**本次未验证代理是否真的发生**。

---

## 9. MCP 注入（`session/new.mcpServers`）【文档+schema，未实测】

### 9.1 结论

- 【文档】CodeBuddy 的 ACP 文档**完全没有提** `mcpServers`。
- 【schema】ACP 标准里 `session/new` 的 `mcpServers` 是**必填数组**，元素为 `McpServer` 联合类型。
- 【实测】`agentCapabilities.mcpCapabilities = {http:true, sse:true}`，**没有 `acp:true`**；`stdio` 是基线默认形态（无 `type` 字段），不体现在能力位里。
- 【未验证】CodeBuddy 是否真的会拉起 `mcpServers` 里的 stdio server、是否把其工具并入工具集。**这是 DSH 把工具以 MCP 暴露给 CodeBuddy 的关键，必须补验。**

### 9.2 三种字段格式（schema 权威）

```jsonc
// stdio：无 type 字段，靠字段形状区分；env 是数组不是对象！
{
  "name": "dsh-tools",
  "command": "node",
  "args": ["C:\\path\\to\\mcp-server.mjs"],
  "env": [ { "name": "MCP_LOG", "value": "C:\\tmp\\mcp.jsonl" } ]
}

// http（需 mcpCapabilities.http）
{
  "type": "http",
  "name": "dsh-tools",
  "url": "http://127.0.0.1:3000/mcp",
  "headers": [ { "name": "Authorization", "value": "Bearer ..." } ]
}

// sse（需 mcpCapabilities.sse）
{
  "type": "sse",
  "name": "dsh-tools",
  "url": "http://127.0.0.1:3000/sse",
  "headers": []
}
```

**易错点**：`env` / `headers` 是 **`[{name,value}]` 数组**，不是 `{k:v}` 对象。写成对象大概率被 zod 拒（-32602）。

### 9.3 备选通道（CLI 侧，不依赖 ACP）

若 ACP 的 `mcpServers` 不通，可用 CLI 参数让 MCP 在进程级生效：

```bash
codebuddy --acp --mcp-config '{"mcpServers":{"dsh-tools":{"command":"node","args":["..."]}}}'
# 或 --mcp-config <file.json>；配合 --strict-mcp-config 可屏蔽其它来源
```

【实测（help 原文）】`--mcp-config <fileOrString>`、`--strict-mcp-config` 均存在。本机已有 MCP 配置（`codebuddy mcp` 子命令可管理）。

---

## 10. 错误与边界

### 10.1 错误对象结构

```jsonc
{"jsonrpc":"2.0","id":<id|null>,"error":{"code":<int>,"message":<string>,"data":<object|undefined>}}
```

| code | message 示例 | `data` 结构 | 触发场景 |
|---|---|---|---|
| `-32700` | `Parse error` | 无；**`id` 为 `null`** | 发送非 JSON 行 |
| `-32601` | `"Method not found": dsh/not_a_real_method` | `{"method":"..."}` | 未知方法（注意 message 里方法名带引号） |
| `-32602` | `Invalid params` | **zod 扁平化错误树**，见下 | 参数 schema 不匹配 |
| `-32603` | `Internal error` | `{"details":"Session not found: <id>"}` | 未知 sessionId 的 prompt/set_model/set_config_option |
| `-32000` | `Authentication required` | `{"category":"auth"}` | 未鉴权的会话方法 |

**`-32602` 的 `data` 是 zod 报错树，插件可直接展示/定位**（实测原文）：

```json
{
  "code": -32602,
  "message": "Invalid params",
  "data": {
    "_errors": [],
    "cwd": { "_errors": ["Invalid input: expected string, received undefined"] },
    "mcpServers": { "_errors": ["Invalid input: expected array, received undefined"] }
  }
}
```

> 文档还约定：**业务拒绝走 `-32602`，原因在 `error.data.details`**，`error.message` 常为 `Invalid params`，不要只读 message。

### 10.2 边界行为速查（全部【实测】）

| 场景 | 行为 |
|---|---|
| `initialize` 之前调 `session/new` | 返回 **-32000 auth**（不是「未初始化」错误）→ 鉴权检查最优先 |
| `session/new` 传 `{}` | -32602，`cwd` 与 `mcpServers` 各一条 `_errors` |
| `session/new` 只传 `cwd` | -32602，仅 `mcpServers` 报错 |
| `session/new` 的 `cwd` 传数字 | -32602，`expected string, received number` |
| 未知 sessionId 的 `session/prompt` | -32603，`details: "Session not found: ..."` |
| 未知 sessionId 的 `session/set_model` / `set_config_option` | 同上 -32603 |
| 未知方法 | -32601，`data.method` 回带方法名 |
| 畸形 JSON 行 | -32700（`id:null`），**进程不死**；随后正常请求仍可往返 |
| 字符串形式的请求 id | 接受，原样回显 |
| 重复 `initialize` | 幂等，返回同样结果 |
| 关闭 stdin | **进程不退出**（8s 后仍存活） |
| 被 `taskkill /T /F` 强杀 | 记录到 exit code `1` |
| 一次异常退出 | 观测到 `code=4294967295`（= -1）在 `authenticate` 等待期间，属外部打断（当时用户正在登录），不代表协议错误 |

### 10.3 日志污染

- ACP 模式下 **stdout 只走协议**（`stdoutPollutedLines=[]`），**stderr 0 字节**。
- 但 CLI 会写文件日志到 `~/.codebuddy/logs/<date>/<cwd>__<hash>.log`，包含 `[AuthenticationManager]`、`[Startup]` 等明细，排障时可读（只读，勿改）。
- 若加 `-d/--debug`，**不保证**还会不会污染 stdout —— 插件里不要随便加 `--debug`。

---

## 11. 未验证项清单（按优先级）

| # | 项 | 为什么没验 | 补验方式 |
|---|---|---|---|
| 1 | `session/cancel` 的行为与 `stopReason` | 本轮 prompt 太短（10s 就结束），cancel 场景未跑成 | `node run-probe.mjs cancel --run --auth-method internal`（长任务 prompt + 4s 后发 cancel） |
| 2 | `session/request_permission` 真实结构 + optionId | 未跑到写文件/执行命令的任务 | `node run-probe.mjs permission --run --auth-method internal`（探针自动回 `allow_once`） |
| 3 | `fs/read_text_file` / `fs/write_text_file` / `terminal/*` 是否真被代理 | 同上 | 同上场景里看 `probe/out/permission.jsonl` 有没有 `fs/*`、`terminal/*` 入站请求 |
| 4 | **MCP `mcpServers` 是否真的连上并暴露工具** | 中途停止 | `node run-probe.mjs mcp --run --auth-method internal`（自带极简 MCP server，会把收到的帧写到 `probe/out/mcp-server.jsonl`） |
| 5 | `session/load` / `session/resume` / `session/list` / `session/fork` / `session/close` | 未测 | 用已有 sessionId 直接调，记录返回/错误 |
| 6 | `--acp-transport streamable-http` + `--serve` | 未测 | `codebuddy --acp --acp-transport streamable-http` 起后探 HTTP 端点 |
| 7 | `_meta['codebuddy.ai/conversationRequestId']` 是否被接受/回写 | 未测 | prompt 时带该字段，检查 PromptResponse._meta 是否回显 |
| 8 | 图片 / embeddedContext 内容块 | 未测 | prompt 里放 `{"type":"image","mimeType","data"}` |
| 9 | 同一 session 连续多轮 prompt 的上下文累积 | 未测 | 连续两次 prompt，看第二次 `usage_update.used` 是否包含首轮 |
| 10 | 并发 prompt（同 session 两个请求） | 未测 | 同 session 同时发两个请求，看是否 -32603/排队 |
| 11 | `CODEBUDDY_API_KEY` 能否替代 `authenticate` | 未测（需真实 key） | 设 `CODEBUDDY_API_KEY` + `CODEBUDDY_INTERNET_ENVIRONMENT=internal` 后直接 `session/new`，观察是否仍需 authenticate |
| 12 | `systemPrompt` / `additionalDirectories`（ACP 标准字段） | 本机未声明 `sessionCapabilities.systemPrompt` | 传了看是否 -32602 或静默忽略 |

---

## 12. 复跑命令

探针默认 **dry-run（不 spawn 任何进程）**，必须显式加 `--run` 才会真起 CLI。

```powershell
cd <本插件目录>\probe

# 0) 只看计划，不起进程（默认行为）
node run-probe.mjs all

# 1) 握手 + 鉴权（会尝试 4 种登录方式，可能弹浏览器！）
node run-probe.mjs init --run
node run-probe.mjs auth --run

# 2) 建会话（需要先能 authenticate；internal 走缓存凭据）
node run-probe.mjs session --run --auth-method internal --auth-timeout 90000

# 3) 最小 prompt 全流（37 条 update + 原始帧）
node run-probe.mjs prompt --run --auth-method internal --auth-timeout 90000

# 4) 模型枚举与切换
node run-probe.mjs models --run --auth-method internal --auth-timeout 90000

# 5) 取消 / 权限 / MCP（未验证项补验）
node run-probe.mjs cancel     --run --auth-method internal
node run-probe.mjs permission --run --auth-method internal
node run-probe.mjs mcp        --run --auth-method internal

# 6) 错误边界（不需要登录）
node run-probe.mjs errors --run

# 7) 环境变量通道试验（把 key 换成真实的）
node run-probe.mjs session --run --name-suffix apikey `
  --env CODEBUDDY_API_KEY=sk-xxx --env CODEBUDDY_INTERNET_ENVIRONMENT=internal
```

产物：

| 文件 | 内容 |
|---|---|
| `probe/out/<场景>.jsonl` | **双向原始帧**（`{ts,t,dir,msg}`，`dir` ∈ out/in/stderr/exit/permission-request…） |
| `probe/out/<场景>.summary.json` | 结构化摘要（initialize/session/prompt/错误/模型清单…） |
| `probe/out/<场景>.console.txt` | 人类可读控制台输出 |
| `probe/out/<场景>.stderr.log` | 子进程 stderr 原文（本机为空） |
| `probe/out/<场景>.stdout-raw.log` | stdout 里非 JSON 的行（本机为空 = 零污染） |
| `probe/acp-doc.txt` / `acp-doc.html` | 官方文档全文快照（本地留存，不随仓库分发） |
| `probe/acp-schema-excerpt.json` | 从 SDK schema 抽出的关键定义（ACP schema 来源：agentclientprotocol.com，Apache-2.0） |
| `probe/cli-help.txt` / `cli-acp-help.txt` | CLI help 原文（本地留存，不随仓库分发） |

探针文件：

| 文件 | 作用 |
|---|---|
| `probe/lib/acp-client.mjs` | 零依赖 ACP 客户端（NDJSON 分帧、请求/响应/通知、fs/terminal/权限的客户端实现、进程树清理） |
| `probe/lib/mini-mcp-server.mjs` | 零依赖极简 MCP server（仅 `echo_probe` 工具），用于验证 MCP 注入 |
| `probe/run-probe.mjs` | 场景驱动（`init/auth/params/session/models/prompt/cancel/permission/errors/mcp/all`） |

---

## 13. 给 DSH 插件的落地建议

1. **进程模型**：一个 DSH provider 实例常驻 1 个 `codebuddy --acp` 进程；启动 1.6s + authenticate 最长 20s+，每次请求重起不可接受。
2. **握手顺序固定**：`initialize` → `authenticate`（优先 `internal`，60~120s 超时）→ `session/new` → `session/prompt`。
   - `authenticate` 超时/失败时，映射成中文引导：「请在终端运行 `codebuddy` 后执行 `/login` 完成登录」。
   - 判断鉴权失败只认 `error.code===-32000 && error.data.category==='auth'`。
3. **模型列表**：用 `session/new` 的 `models.availableModels`（含 `maxInputTokens`、`effortOptions`、`supportsImages`），**不要**用 `--help` 的静态表；`currentModelId` 可能非法，容错。
4. **切模型**：用 `session/set_config_option {configId:"model", value:<id>}`（有校验）；`session/set_model` 不校验，别用。
5. **流式**：只处理 `agent_message_chunk`（正文）、`agent_thought_chunk`（推理，可按需丢弃）、`tool_call`/`tool_call_update`（工具）、`usage_update`（用量）；其余 `session_info_update` 建议节流或忽略（10s 内 15 条）。
6. **usage 映射**：`PromptResponse` 没有 usage。从最后一条 `usage_update` 的 `_meta.usage` 映射到 ACP `Usage`；`cost.amount` 可作为计费展示，`currency` 为空串要兜底。
7. **超时与取消**：`session/prompt` 是长请求，DSH 侧要支持取消；取消发 `session/cancel` 通知（**未验证**，需先补验）。
8. **健壮性**：忽略未知通知（`_codebuddy.ai/command`）、未知 `sessionUpdate`、未知 `_meta`；不要因为未知字段报错。
9. **进程清理**：关 stdin 不退出；DSH 关闭时必须 `taskkill /PID <pid> /T /F`（Windows），否则会残留 node 进程。
10. **工具暴露**：优先验证 `session/new.mcpServers` 的 stdio 形态（`env` 是 `[{name,value}]` 数组）；备用 `--mcp-config`。若两者都不通，再考虑用 `clientCapabilities.fs/terminal` 做「反向代理」把 DSH 的能力接进 CodeBuddy。

---

## 14. 插件实现阶段的补充实测（2026-10-28，v0.1.0）

写适配器时又实测了几条，按「结论 → 证据」记在这里。

1. **`authenticate` 会真的拉起浏览器，不能每次启动都调。**
   【实测】CLI 日志 `[AcpAgent] External URL opened, sending auth URL notification`
   + `[CliExternalUriOpener] Attempting to open external URI` + `openSuccess=true`。
   即使本机登录态有效（进程启动日志 `hasAccessToken=true`），调用 `authenticate` 仍会开浏览器。
   → 正确做法是**惰性鉴权**：先 `session/new`，只在返回
   `-32000 / data.category === "auth"` 时补一次 `authenticate`，并且每进程只补一次。
   实测这样在已登录机器上 `session/new` 直接通过，浏览器不会被拉起。

2. **登录态确实持久化在磁盘。**
   【实测】CLI 每个进程启动时打印
   `[AuthDoInitProbe] stage=afterRestore … hasSession=true hasAccessToken=true uid=<你的 uid>…`，
   说明凭据会被 restore；`hasAccessToken=false` 只出现在登录完成之前的那些进程。

3. **`session/set_config_option {configId:"model"}` 可以中途换模型且保留上下文。**
   【实测】返回全量 `configOptions`，`currentValue` 变为新模型；随后
   `session_info_update._meta["codebuddy.ai/requestModelId"]` 也是新模型 id。

4. **角色档位别名（`default-model` / `fast-model` / …）经 ACP 切换后拿不到回答。**
   【实测】`set_config_option` 接受 `default-model`（返回 `currentValue: "default-model"`），
   但随后一轮只有 `session_info_update`（`model_requesting → idle`，约 0.5s），
   没有任何 `agent_message_chunk`；换成真实模型 id（如 `hy3`）立刻恢复正常回答。
   → 选择器默认不展示这些别名。

5. **`usage_update` 第二条才是本轮结算。**
   【实测】`_meta.usage` 形如
   `{prompt_tokens:27333, completion_tokens:29, total_tokens:27362,
   completion_tokens_details:{reasoning_tokens:19}, prompt_tokens_details:{cached_tokens:512}}`，
   映射到 DSH：`inputTokens/outputTokens/totalTokens/reasoningTokens/cacheReadTokens`。

6. **端到端跑通（DSH 侧）。**
   【实测】`dsh --profile <test> "用一句话回答：3+4等于几？"` →
   stdout `3+4等于7。`，stderr reasoning `…这是简单的数学题，3+4=7。用中文…`。
   链路：`ctx.llm` 路由 `codebuddy/hy3` → 适配器 → ACP → CodeBuddy 用自己的额度调用模型。

7. **仍未验证**：`session/request_permission`（需要触发写文件/执行命令且 permissionMode 不足）、
   `session/cancel` 的实际中断效果、`session/new.mcpServers` 的真实注入。

---

## 15. 思考档位与多轮工具调用的补充实测（2026-10-28，v0.2.0）

这一节是「升级思考维度 + 修多轮工具调用显示」时补测的，全部用 `probe`/临时探针在本机真跑。

### 15.1 `thought_level` 的真实取值与边界

`session/new` 返回的 `configOptions` 里 `thought_level` 只是**该会话当前模型的子集**：

```jsonc
// 实测：首次建会话（模型 hy4-preview）
{"type":"select","id":"thought_level","name":"Deep Thinking","currentValue":"enabled",
 "options":[{"value":"high","name":"High"},{"value":"enabled","name":"On (default)"}]}

// 实测：切到 hy3 后，同一条 set_config_option 的回显变成 7 档
{"id":"thought_level","currentValue":"enabled",
 "options":[{"value":"minimal"},{"value":"low"},{"value":"medium"},
            {"value":"high"},{"value":"xhigh"},{"value":"max"},{"value":"enabled"}]}
```

**可以写入的值**（逐个真发 `session/set_config_option`）：

| value | 结果 |
|---|---|
| `low` / `medium` / `high` / `xhigh` / `max` / `enabled` | 全部 `OK`，回显全量 configOptions |
| `off` | **-32603**，`data.details` = `Invalid thought_level value: "off". Allowed: minimal, low, medium, high, xhigh, max \| enabled \| disabled` |

要点：

- **档位集合随模型变化**。实测 `hy4-preview` 只有 `high`；`deepseek-v4.1-flash` 是
  `low/high/max`；`hy3`/`glm-5.2`/`deepseek-v4-pro` 是 `low/medium/high/xhigh`；
  `space-bunny`/`minimax-m3.1-flash` 有 5 档。写非法档位时**服务端拒绝但仍回带全集**，
  所以客户端可以拿 `data.details` 自愈。
- `enabled` 是 CodeBuddy 自己的「跟随模型默认档」，语义上不属于 DSH 的可选档位。
- 每个模型的完整档位同时出现在 `models.availableModels[]._meta.effortOptions` 里
  （实测 19 个模型逐个确认，见下表），但 `product.json` 的 `reasoning.effort`
  只给**默认值一个**（如 `{"effort":"high"}`），**不能**当成全集。
- `session/set_config_option {configId:"thought_level"}` 与 `model` 一样是**会话级**设置，
  切档位保留上下文，不需要重开会话。

`.meta.effortOptions` 实测（19 个模型，2026-10-28）：

```
hy4-preview            high
hy3 / hy3-x            low medium high xhigh
deepseek-v4.1-flash    low high max
step-5-preview         low medium high
glm-5.3 / -flash       low high max
glm-5.2 / glm-5.1      low medium high xhigh
glm-5v-turbo           low medium high xhigh
space-bunny            low medium high xhigh max
minimax-m3.1-flash     low medium high xhigh max
minimax-m3 / m2.7      low medium high xhigh
kimi-k3.1-pro          low high max
kimi-k3-1              low medium high xhigh
kimi-k2.8-preview      low high max
deepseek-v4-pro        low medium high xhigh
mimo-v2.6-pro          low medium high xhigh
```

### 15.2 一次「多轮工具调用」prompt 的完整 `session/update` 时序

任务：让 agent 用读文件工具分别读取 `a.txt`、`b.txt` 再回答。实测帧序（节选）：

```
session_info  agentPhase=idle → preparing → model_requesting
usage_update  used=48419  size=192000          ← 上下文占用（无 cost）
available_commands_update ×2
session_info  agentPhase=model_streaming
agent_thought_chunk ×21                        ← 第一轮思考
tool_call     call_00 "Read" kind=other status=in_progress   ← 工具开始流式生成
tool_call_update call_00 rawInput.file_path="" content="…"    ← 参数**增量**流出
tool_call     call_01 "Read" kind=other status=in_progress
usage_update  used=27549 cost{amount:0.36} _meta.usage{...}  ← 第 1 轮模型请求结算
session_info  agentPhase=model_done → tool_executing(Read) ×2 → model_requesting
tool_call     call_00 "Read <绝对路径>" kind=read status=pending  ← **同 id 二次 tool_call = 标题补全**
tool_call     call_01 "Read <绝对路径>" kind=read status=pending
tool_call_update call_00 status=completed rawOutput{text:"1→alpha"}
tool_call_update call_01 status=completed rawOutput{text:"1→bravo"}
usage_update  used=27739 cost{amount:0.01} _meta.usage{...}  ← 第 2 轮模型请求结算
session_info  agentPhase=model_streaming
agent_message_chunk ×N                         ← 最终正文
usage_update  同上（**重复推送**）
session_info  model_done → idle → idle（标题更新）
PromptResponse stopReason=end_turn
```

### 15.3 踩到的四个坑（都已在适配器里处理）

1. **`usage_update` 结算帧会被重复推送。**
   【实测】同一条 `_meta['codebuddy.ai/messageId']` 连发两条，`prompt_tokens` / `cost` 完全一致。
   简单把 `usage_update` 累加会让 inputTokens 翻倍（一轮 2 次模型请求实测累出 110524，
   真值是 27549+27739）。→ 必须按 `messageId` upsert，而不是纯累加。
2. **一次 prompt 内有多次模型请求，每轮各一条结算。**
   只取最后一条会漏掉前几轮的 token 与积分。→ 归并后再求和。
3. **同一 `toolCallId` 会收到两次 `tool_call`。**
   第一次 `kind=other`、`title="Read"`；第二次 `kind=read`、`title="Read <绝对路径>"`。
   这不是两个工具，是标题补全，按 id 去重即可。
4. **工具结果只在 `tool_call_update` 里**（`rawOutput` 或 `content[].content.text`），
   且在 `status=completed` 那一帧；`tool_call` 本身没有任何输出。
   → 想显示「拿到了什么」，必须监听 `tool_call_update`。

### 15.4 `reasoningEffort` 的正确映射结论

- DSH 的 `GenerateOptions.reasoningEffort`（`ReasoningEffortId`）**直接**就是
  CodeBuddy `thought_level` 的合法值域（两边的 `low/medium/high/max` 命名一致）；
  `minimal` / `xhigh` 是 CodeBuddy 独有的扩展档位，DSH 侧未内置但**可以传**（协议接受）。
- 要让模型选择器出现档位，`resolveModel` 必须返回
  `reasoning: { efforts: [{id,name}], defaultEffort }`；只返回模型信息时选择器不给档位入口。
- `defaultEffort` **不要取第一档**：CodeBuddy 的档位列表按由低到高排列，取第一档等于
  把新会话静默降成最省模式。实测取 `high`（存在时）最符合预期。

---

## 16. 工具调用完整进 DSH 的补充实测（2026-10-29，v0.3.0）

这一节记的是「把 CodeBuddy 的工具调用**完整转换**成 DSH 原生工具调用」时的实测结论。
背景：ACP 的工具由 CodeBuddy 自己在**它自己的进程里**执行，客户端既不能替它执行，
也没有「把结果塞回 agent」的通道（`session/request_permission` 只能 allow/deny）。
所以要拿到完整的 `tool/call` + `tool/result` 链路，只能由**适配器发 `tool-call` 块 +
DSH 执行一个「回放工具」把 CodeBuddy 的真实结果交回**。

### 16.1 实测时序（一轮里两个工具，2026-10-29 抓取）

```
agent_thought_chunk ×N                          ← 思考流
tool_call call_00 "Read" kind=other status=in_progress   ← ① 占位帧（没有路径）
tool_call call_01 "Read" kind=other status=in_progress
tool_call_update call_00 rawInput{file_path:"…package.json"}  ← ② 参数是增量的
usage_update (msg-1) … usage_update (msg-1)     ← 结算帧重复推送
session_info agentPhase=tool_executing
tool_call call_00 "Read …package.json (1 - 3)" kind=read status=pending  ← ③ 补全帧
tool_call call_01 "Read …b.txt" kind=read status=pending
tool_call_update call_00 status=completed rawOutput{text:"   1→{…"}      ← ④ 结果帧
tool_call_update call_01 status=completed rawOutput{text:"…"}
usage_update (msg-2)
agent_message_chunk ×N                          ← 正文
PromptResponse stopReason=end_turn
```

映射到 DSH 的块（`assistant/message` 的 content）：

```
[reasoning, tool-call(codebuddy_tool, "Read …package.json (1 - 3)"),
          tool-call(codebuddy_tool, "Read …b.txt"), text]
```

随后 agent loop 执行回放工具，落 `tool/call` `tool/result`，`concludeTurn()` 结束本轮
（**一次 step、一次模型请求**）。

### 16.2 四个坑（都已在实现里处理）

1. **占位帧不能直接发块。**
   ① 的标题只有 `Read`、`kind=other`；③ 才是带路径与正确 `kind` 的版本。
   按「第一次见到就发块」会在卡片上留下 `Read`，用户看不出读的哪个文件。
   → 把占位帧压在滞留队列里，等补全帧（`kind !== other` 或标题带主语）再发；
   但**收口时必须强制发出**，否则块顺序会乱。
2. **不能拿 `rawInput` 里的路径当「可以发块」的信号。**
   ② 的增量参数会先把 `file_path` 填上，此时标题还是占位版。
   第一版实现就是这么提前发块的（端到端实测拿到 `title="Read"`、`kind="other"`）。
3. **`rawInput` 是增量下发的，必须合并。**
   `tool_call_update` 每帧只带一部分字段（先是 `file_path:""`，后是 `cwd`…），
   覆盖式写入会让最后一条只剩残片。
4. **发块之后参数就冻结了。** `block-end` 里的 block 是权威值，后续 `tool_call_update`
   改不了它；所以 title/kind 必须在发块**之前**就是最终值，状态与输出走 `tool/result`。

### 16.3 DSH 侧的两个硬约束（决定实现形态）

- **`tool-call` 块一定会被执行。** agent loop 只看 `message.content` 里有没有
  `tool-call`，`finish.reason` 不参与判断（`packages/core/agent-loop/src/agent.ts`
  的 `const toolCalls = message.content.filter(...)`）。所以块里的工具名**必须**是
  已注册、且该 step 可见的工具，否则 `UNKNOWN_TOOL` 直接失败。
- **`exec.concludeTurn()` 是「不多跑一次模型」的关键。** 工具返回成功并标记
  `concludesTurn` 后，loop 在 `tools.execute` 之后直接
  `return result.concluded ? { kind: 'completed' } : null`，
  不再发起下一次模型请求——这正是回放工具需要的语义（CodeBuddy 已经跑完了）。

### 16.4 端到端证据（2026-10-29，装好的 DSH 0.2.1-rc.3）

```
$ dsh --profile headless --json "用 Read 工具读 …\package.json 的第 1-3 行，告诉我 name"
{"type":"tool_call","tool":"codebuddy_tool",
 "input":{"title":"Read …\\package.json (1 - 3)","kind":"read","path":"…","status":"pending"}}
{"type":"tool_result","callId":"call_00_…","status":"completed",
 "result":"✓ Read …\\package.json (1 - 3)\n\n   1→{\n   2→  \"name\": \"dsh-codebuddy-acp\","}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":63784,…}}  ← 只有一次模型请求
```

会话日志（`session.v4.jsonl.zstd` 解压后）能看到四段式：
`assistant/message(含 tool-call 块) → tool/call → tool/result → step/end`；
同一会话续聊（`--session-id`）正常，且上一轮的工具参数/结果**不会**被回灌给 CodeBuddy。

### 16.5 仍然没做的

- **审批链**：ACP 的 `session/request_permission` 仍按 `permissionPolicy` 直接 allow/deny，
  没有接到 DSH 的审批框（`bypassPermissions` 下根本不会发这个请求）。
- **`plan` 更新**：ACP `plan` 没映射成 DSH 的 `todo/write`，目前只在旧模式下播报成文字。
- **耗时与审批**：工具卡片上的耗时/审批状态反映不了 CodeBuddy 的真实执行过程（这里只做回放）。

---

## 17. 标题 / 计划 / 审批三条通路（2026-10-29，v0.4.0）

第 16 节把**工具**接成了 DSH 原生调用；这一节记另外三样 CodeBuddy 有、DSH 需要的东西，
以及为什么它们看起来「应该用标准 ACP 字段」但其实都不行。

### 17.1 会话标题：CodeBuddy 会发，DSH 的 provider 也不会

【实测】CodeBuddy 跑完一轮后发：

```jsonc
{"sessionUpdate":"session_info_update","title":"Plan and execute mjs file analysis","_meta":{"timestamp":"…"}}
```

`title` 是模型自己起的名，比 DSH 侧任何截断/生成都准。映射用
`ctx.sessionTitle.rename(session, title)` —— 它写一条 `source:{kind:'user'}` 的
`session/title`，**钉住**标题（之后用户消息不再触发自动生成）。实测日志：

```
14 session/title {"title":"请用 TodoWrite 建立任务清单：1)","source":{"kind":"fallback"}}
16 session/title {"title":"请用 TodoWrite 建立任务清单：1) 列…","source":{"kind":"provider"}}
17 session/title {"title":"List plugins directory and count .mjs files","source":{"kind":"user"}}  ← CodeBuddy 的
```

**「标题永远是 Generate the session tit…」的根因**（顺带修掉的老 bug）：
DSH 的 `session-title-first-prompt-llm` 发给 provider 的**不是**原始用户消息，而是

```
Generate the session title from this JSON array of human messages:
[{"seq":9,"text":"搜索一下最近的it局势"}]
```

旧实现 `buildTitle(users.at(-1))` 直接截这条模板的前 24 字 →
`Generate the session tit…`。修法：解出 JSON 数组取第一条 `text`；
解不出来时至少把模板前缀剥掉（`firstHumanMessage()`）。

### 17.2 计划：CodeBuddy **不发** ACP `plan`

这是本节最反直觉的一条。**实测证据**（2026-10-29，v2.177.1，`probe/capture-frames.mjs`）：

| 任务 | `session_info_update` 条数 | `sessionUpdate:"plan"` 条数 |
|---|---|---|
| 「列出 3 个步骤再执行」 | 25 | **0** |
| 「复杂重构，务必用计划工具」 | 25（超时前） | **0** |
| 「用 TodoWrite 建清单并执行」 | 54 | **0** |

CodeBuddy 用的是**自己的工具** `TaskCreate` / `TaskUpdate`，任务清单藏在
`tool_call_update._meta['codebuddy.ai/rawResponse']` 里：

```jsonc
{
  "task":  { "id":"1", "subject":"列出 plugins 目录", "description":"…",
             "activeForm":"正在列出 plugins 目录", "status":"pending", "createdAt":…, "updatedAt":… },
  "todos": [ { "id":"1", "content":"列出 plugins 目录", "activeForm":"…", "status":"pending", … } ]
}
```

所以映射以 `todos` 为准，落成 DSH 的 `todo/write` 整表快照（与 `todo_write` 工具同一个事件、
同一个 `todos` 投影，界面直接出待办面板）。实测日志（一轮里 10 条）：

```
18 todo/write {"todos":[{"content":"列出 plugins 目录内容","status":"pending"}]}
19 todo/write {"todos":[…,"统计 .mjs 文件数量"…]}
21 todo/write {"todos":[{"content":"列出 plugins 目录内容","status":"in_progress"},…]}
24 todo/write {"todos":[{"content":"列出 plugins 目录内容","status":"completed"},…]}
```

三个坑：

1. **`TaskCreate` 的 `rawInput` 先到是空的**：`tool_call` 帧 `rawInput:{}`，
   真正参数在随后的 `tool_call_update` 里（`{subject, description, activeForm}`），
   而**清单**只在完成的 `tool_call_update._meta` 里。→ 必须监听更新帧，不能只看调用帧。
2. **`TaskUpdate` 的 `rawInput` 是 `{taskId, status}`**，不带内容；清单要按 id 去合并，
   或者直接信 `_meta` 里那份完整 `todos`（它每次都是全量）。
3. **状态值就是 DSH 的三态**（`pending`/`in_progress`/`completed`），但仍做了归一，
   未知值降级成 `pending`——否则一条新状态就能让整条 `todo/write` 被 schema 拒掉。

标准 ACP `plan` 的兼容通路保留（`#forwardPlan`），万一将来协议对齐就不用改。

### 17.3 审批：请求里有 options，但**没有 title**

【实测】`permissionMode: default` 下执行命令会发：

```jsonc
{"method":"session/request_permission","params":{
  "sessionId":"01a18661-…",
  "options":[
    {"kind":"allow_always","name":"Always Allow","optionId":"allow_always"},
    {"kind":"allow_once","name":"Allow","optionId":"allow"},
    {"kind":"reject_once","name":"Reject","optionId":"reject"}],
  "toolCall":{
    "toolCallId":"chatcmpl-tool-…",
    "rawInput":{"command":"find . -name \"*.mjs\" -type f | wc -l","description":"递归统计 .mjs 文件数量"},
    "_meta":{"codebuddy.ai/toolName":"Bash"}     ← 只有这里知道是哪个工具
  }}}
```

两个坑：

1. **`optionId` 不能硬编码**：实测是 `allow_always` / `allow` / `reject`
   （不是文档示例里的 `allow_once`）。只能按 `kind` 选。
2. **`toolCall` 没有 `title`**：`title` 只出现在 `tool_call` 通知里，权限请求这一帧**没带**。
   直接取 `title` 会显示「CodeBuddy 工具」，用户不知道要批准什么。
   → 按「`_meta` 里的 toolName + `rawInput.description`/`command`/`file_path`」拼文案，
   实测显示成 `Bash: 查看工作目录顶层内容`。
3. **回应是双层 `outcome`**：`{"outcome":{"outcome":"selected","optionId":"allow"}}`。
   漏一层会被判 `PERMISSION_DENIED`（探针就踩过：`codebuddy.ai/outcome: PERMISSION_DENIED`）。

DSH 侧的映射（`ctx.approval.request()` → ACP outcome）：

| DSH 结果 | ACP 回应 |
|---|---|
| `allowed-once` | 第一个 `kind` 以 `allow` 开头的 option |
| `rejected` | 第一个 `kind` 以 `reject` 开头的 option；没有就 `{outcome:'cancelled'}` |
| `cancelled` / `unavailable` / 无服务 | 按 `permissionAskFallback`（默认 `allow`） |

`unavailable` 为什么**不** fail-closed：DSH 自己的语义是「没有审批方就拒绝」，但这里
不是 DSH 在决定要不要执行工具，而是**把 CodeBuddy 的权限结果回话给它**。拿不到用户意见时
若一律拒绝，一次「没装 UI」就会让整轮工具全部失败。所以默认兜底 allow，
要严格就用 `permissionAskFallback: deny`。

另外：会话审批策略是 `never` 时**不去问**审批服务（它会直接返回 `rejected`，问也白问），
直接按兜底走。这是读 `approval/policy` 事件得到的（`snapshotEvents()` 倒序找最后一条）。

### 17.4 实测日志（同一会话里三条通路同时生效）

```
14 session/title  {"title":"请用 TodoWrite 建立任务清单：1)","source":{"kind":"fallback"}}
17 session/title  {"title":"List plugins directory and count .mjs files","source":{"kind":"user"}}   ← 标题
18 todo/write     {"todos":[{"content":"列出 plugins 目录内容","status":"pending"}]}                  ← 待办
21 todo/write     {"todos":[… "status":"in_progress" …]}
22 approval/asked {"id":"784e…","toolName":"Bash: 查看工作目录顶层内容","reason":"CodeBuddy 请求执行 Bash"}  ← 审批
23 approval/decided {"id":"784e…","outcome":"unavailable"}     ← headless 没有审批 UI，按兜底 allow
24 todo/write     {"todos":[{"content":"列出 plugins 目录内容","status":"completed"},…]}
…
turn_end {"kind":"completed"}           ← 审批 unavailable 没有卡住这一轮
```

### 17.5 仍然没做的

- **`plan` 的优先级**：ACP 的 `PlanEntry.priority`（high/medium/low）DSH 的 `TodoItem`
  没有这个字段，直接丢弃（`TodoItem` 只有 `content`/`status`，这是 DSH 侧的设计）。
- **`activeForm`**：CodeBuddy 每条任务都带「正在做…」的进行时文案，DSH 待办没有这个槽位。
- **斜杠命令 / `loadSession`**：仍未做（见第 15 节能力清单）。

---

## 18. 协议层审计：三处缺陷已修 + 剩下的优化面（2026-11-01，v0.4.0 之后）

这一节来自一次**只读源码的协议审计**（对 ACP 帧、`AcpConnection`、适配器映射逐条核对），
下面三条是确认的缺陷（已修 + 有回归测试，见 `test/cancel-and-recovery.test.mjs`），
再往后是「协议已给、插件还没用」的能力清单。

### 18.1 中断没有告诉 agent（已修）

旧实现把 DSH 的 `AbortSignal` 直接穿给 `session/prompt` 的 `request()`，于是中断只做了一件事：
**本地**把 Promise 拒掉。后果有两个：

- CodeBuddy 不知道用户已经放弃，会把这一轮跑完（继续消耗额度）；
- 在它眼里这条 ACP 会话一直是「忙」的，紧跟着的下一轮可能被拒或长时间串行等待。

正确做法是按 ACP 语义先发**通知** `session/cancel`：

```jsonc
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"01a186b3-…"}}
```

agent 收到后会把挂起的 `session/prompt` 结算成 `stopReason: "cancelled"`（这正是
`mapStopReason` 里 `case 'cancelled'` 那条分支的来源）。所以现在的顺序是：
**发通知 → 给 `cancelGraceMs`（默认 3s）等它体面收口 → 超时才本地中断**。
信号在发请求前就已 abort 时，发完通知立刻本地放弃，不再等宽限期。

> 【实测线索】`probe/out/concurrency-two-cancel.jsonl:259` 那条 cancel 帧的
> `sessionId` 与真正在跑的会话不是同一条，之后该会话继续出 `agent_thought_chunk`——
> 说明 **cancel 是按 sessionId 精确生效的**，发错会话等于没发。所以插件里必须用
> 「这一轮实际在跑的 `sessionId`」，不能用 `record.acpSessionId` 的旧值。

### 18.2 `allowed-once` 被映射成 `allow_always`（已修）

`session/request_permission` 的 `options` 实测顺序是：

```jsonc
[{"kind":"allow_always"}, {"kind":"allow"}, {"kind":"reject"}]
```

旧实现用 `options.find(o => o.kind.startsWith('allow'))` 选「允许」→ 命中的是**第一个**
`allow_always`。于是用户在 DSH 审批框里点「允许一次」，CodeBuddy 那边却拿到**永久放行**，
之后同类工具再也不问——既违背用户意图，也让 DSH 的审批形同虚设。

修法：按「一次性优先」精确匹配。允许侧顺序 `allow_once → allow → accept_once → accept`，
都没有才退到前缀匹配（`allow_always`）；拒绝侧 `reject_once → reject → deny` 再退前缀。
DSH 的审批结果只有 `allowed-once` / `rejected` 两种（`ui-approval` 的
`ApprovalDecision`），所以**永远不该**落到 `allow_always`。

### 18.3 进程被回收后不会自愈（已修）

`codebuddy --acp` 进程会因为崩溃、空闲 30 分钟、或空闲连接数超上限被回收。旧实现仍有两条
路径继续使用**已失效的 `sessionId`**：

1. `#ensureSession` 只判断 `record.acpSessionId === undefined`，不判断「连接对象换了」；
2. agent 回 `-32603 / data.details: "Session not found: …"` 时直接判整轮失败。

后果是这条 DSH 会话**之后每一轮都失败**（`record.acpSessionId` 永远指着一个不存在的会话）。

修法两条：
- `#ensureSession` 记住 `record.shared`，发现连接对象被替换就把会话态作废（`acpSessionId` /
  `signatures` / `effort` / `heldAnswer` 全清），走「新建会话 + 重放历史」；
- `#turn` 里如果这一轮**还没吐出任何块**就收到 Session-not-found / `PROCESS_EXITED`，
  作废会话态并用**完整历史**重试一次（`attempt` 只允许 0→1）。

顺带修掉一个同源问题：`#ensureSession` 现在返回 `recreated`，`#turn` 据此决定
「投喂增量」还是「重放完整历史」。在此之前，README 说「换模型失败 → 新开会话 + 重放历史」，
实际只重放了**增量尾巴**，模型在新会话里是失忆的。

### 18.4 协议已给、插件还没用的能力（按性价比排序）

| # | 能力 | 协议入口 | 现状 | 价值 / 风险 |
|---|---|---|---|---|
| 1 | **图片真的发给模型** | `agentCapabilities.promptCapabilities.image = true`；prompt 里放 `{"type":"image","mimeType","data"}` | ✅ **已实现并实测**（2026-11-01，v2.178.1）：text+image 与 image+text 两种顺序都能被接受，纯红/纯蓝图分别答「红色」「蓝色」，阴性对照（不带图）答「没有收到图片」；**只给 `uri` 不给 `data` 会被 -32602 Invalid params 拒绝**，故 `data` 必填。探针 `probe/image-prompt.mjs`，原始帧 `probe/out/image-prompt.*`，插件侧自测 `test/image-prompt.test.mjs` + `test/image-live.mjs` |
| 2 | **会话恢复** | `agentCapabilities.loadSession = true`；`session/load {sessionId, cwd, mcpServers}` | ❌ 完全没用 | 高价值：进程回收/重启后可以按 sessionId 续上，而不是把整段历史压成一段文本重喂（省 token、保 prompt cache） |
| 3 | **把 DSH 工具通过 MCP 交给 CodeBuddy** | `session/new.mcpServers`（`mcpCapabilities.http/sse = true`） | ⚠️ 恒传 `[]` | 最高价值也最重：能让 CodeBuddy **真的调用** DSH 的原生工具（而不是现在的「回放」）。注意 `env`/`headers` 是 `[{name,value}]` 数组不是对象（第 9.2 节，未实测） |
| 4 | **斜杠命令** | `available_commands_update`（实测 82 条） | ⚠️ 只记日志 | 中价值：命令列表随本机 skills/plugins 动态合成，可以把 CodeBuddy 的 `/review`、`/commit` 等暴露成 DSH 的入口 |
| 5 | **终端代理** | `clientCapabilities.terminal` + `terminal/create|output|wait_for_exit|kill|release` | ❌ **声明了却没实现**（`proxyTerminal: true` 时把 capability 置真，`#handleAgentRequest` 里没有 `terminal/*` 分支 → 回 -32601） | 协议违规：声明了不支持的能力。要么实现（`child_process` + 输出缓冲），要么别再声明。默认 `false` 所以日常踩不到 |
| 6 | **权限模式** | `session/set_mode {sessionId, modeId}`（已有未使用的 `AcpConnection.setSessionMode`）+ `configOptions.mode` | ❌ `permissionMode` 配置项**完全没被使用**（`args` 里没有 `--permission-mode`，`set_mode` 也没调过） | 中价值：可以把 DSH 的审批策略映射成 CodeBuddy 的 7 档模式（`default`/`acceptEdits`/`bypassPermissions`/`fullAccess`/…），会话级生效、带校验 |
| 7 | **上下文用量** | `usage_update` 的第一种形态（只有 `used`/`size`，无 `cost`） | ❌ 只喂给账本、被 `mapUsage` 丢掉（它只认 `_meta.usage`） | 中价值：`used`/`size` 是 CodeBuddy 自己的上下文占用，可用来在 DSH 里显示「还剩多少上下文」、或在接近上限时提示压缩 |
| 8 | **`notice` / `compaction_update`** | 19 种 `sessionUpdate` 里的两种 | ❌ 落在 `default` 分支只记日志 | 低价值：`notice`（severity/message）适合当额度/策略告警；`compaction_update` 能说明 CodeBuddy 自己压缩了上下文 |
| 9 | **`session/list` / `session/close` / `session/fork`** | CodeBuddy 未在 `sessionCapabilities` 里声明，但 CLI bundle 里方法名都在 | ❌ 未验证 | 低价值/未知：`session/close` 能在 DSH 会话关闭时主动释放 agent 侧会话，省一条常驻上下文 |
| 10 | **`options.system`** | `GenerateOptions.system`（一次性调用方的系统提示） | ❌ 被忽略；`systemPrompt` 配置项也是死的 | 低价值：loop 请求把系统提示放在 `messages[0]`，只有手工一次性调用会用到 |

### 18.5 传输层的两处小隐患（未改）

- `#onStdout` 每切一行都 `slice()` 一次剩余缓冲，长帧密集时是 O(n²)；
- stdout 缓冲超 `LINE_LIMIT`（32MB）时**清空缓冲继续跑**，等于把协议流截断后接着解析，
  之后所有帧都会错位。更安全的做法是直接关连接并报错。
- `#write` 不看 `stdin.write()` 的返回值，也不等 `drain`；重放超长历史时理论上会堆内存。
