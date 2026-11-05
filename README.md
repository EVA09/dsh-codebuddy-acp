# dsh-codebuddy-acp

把本机 [CodeBuddy Code CLI](https://www.codebuddy.ai/docs/zh/cli/acp)（`@tencent-ai/codebuddy-code`）
通过 **ACP（Agent Client Protocol）** 接入 DeepSeek Harness，作为 DSH 内部的**模型/agent 后端**。

装上之后：

- 模型选择器里多出一个 **CodeBuddy** 分组，和普通 provider 一样选中即可；
- 分组里的条目就是**你账号下真实可用的 CodeBuddy 模型**（本机实测 19 个，如 `hy3`、
  `deepseek-v4.1-flash`、`glm-5.3`、`kimi-k2.8-preview`…），每个模型名后面直接标着
  **积分倍率**（如 `Claude Sonnet 4.6 ×1.2`），一眼看出这一轮贵不贵；
- **每个模型都能选思考档位**（`low / medium / high / xhigh / max`，具体有哪几档由模型决定），
  选中即生效，换档位不丢上下文；
- 选中哪个，CodeBuddy 就用哪个模型跑，**消耗的是你 CodeBuddy 账号里腾讯给的那份额度**；
- **工具调用会变成 DSH 原生工具卡片，并在轮次中途逐个结算**：一次 ACP turn 被切成多个
  step，每个工具在自己的那一步里执行并当场变成「完成」，助手正文留在它真实出现的位置
  （见下文「工具调用怎么进 DSH」）；
- **侧栏多一个 CodeBuddy 控制台**：看账号里真实的剩余积分、领每日积分、管理模型开关与顺序。

```
DSH 会话
  └─ ctx.llm 适配器（provider = codebuddy）
       └─ codebuddy --acp（每工作目录一个常驻进程，内含多条 ACP 会话）
            ├─ initialize → session/new → session/prompt
            ├─ session/set_config_option  → 切模型（model）/ 思考档位（thought_level）
            ├─ session/update → 正文/思考流、工具调用（含结果）、阶段、用量
            └─ session/request_permission、fs/* → 由 DSH 侧应答
  └─ ctx.tools 回放工具（codebuddy_tool）
       └─ 把 CodeBuddy 已执行完的工具结果交回 DSH → 会话里留下 tool/call + tool/result
```

## 工具调用怎么进 DSH（调用链）

CodeBuddy 的 agent 循环在**它自己的进程里**执行工具，ACP 只会把过程作为通知告诉客户端，
客户端既不能替它执行、也没有「把结果塞回去」的通道。所以「工具调用完整进 DSH」靠的是两半：

1. **适配器发原生 `tool-call` 块**：每收到一次 ACP `tool_call`，就在模型流里发一个独立的
   `tool-call` 块（`block-start` + `tool-call-delta` + `block-end`），参数是
   `{ title, kind, tool, callId, status, path, line, command, input }`。
2. **回放工具把结果交回 DSH**：插件注册 `codebuddy_tool`，DSH 执行它时按 `toolCallId`
   从结果桥里取出 CodeBuddy 的**真实输出**，原样返回。

于是会话里留下完整的 `assistant/message(tool-call 块) → tool/call → tool/result`
四段式链路，界面渲染成工具卡片：类别、标题、路径、状态、可展开的真实输出。
**不会**重复执行工具，也**不会**多跑一次模型请求。

### 一次 ACP turn 切成多个 step（`toolCut: 'step'`，默认）

DSH 只在**一个 step 的模型流结束之后**才执行这一步里的 `tool-call` 块。所以「一轮 ACP = 一个
step」时，整轮的工具卡片要等 CodeBuddy 把这一轮跑完才一起结算——期间界面上全是「执行中」，
而助手正文又被攒到最后，顺序看起来就不对。

现在适配器把**同一条 ACP turn 切成多个 step**：

```
turn 1 ─┬─ step 1  assistant[思考, tool-call(Read a.txt, 已完成)] → tool/call → tool/result
        ├─ step 2  assistant[tool-call(Read b.txt, 已完成)]      → tool/call → tool/result
        └─ step 3  assistant[最终正文]                          ← 不含 tool-call，是最终答案
```

- **切点**：某个工具在 CodeBuddy 那边结算（`completed` / `failed`）时，当前 step 发完它的
  `tool-call` 块就收口。DSH 立刻执行回放工具，卡片**当场**变成完成态，不再挂到轮末。
- **不额外花钱**：step 之间**不发任何 ACP 请求**，CodeBuddy 那边仍然是「一轮跑完」，
  后面的 step 只是把已经排队的帧接着取走（`session/prompt` 只发一次）。
- **正文留在原位**：思考/正文按真实到达顺序落进它所属的那一步，结论天然落在最后一步
  （那一步不含 `tool-call` 块，`ui-chat` 的 `latestAnswer` 才认得它是最终答案）。
- **收口判断**：回放工具执行前先问桥「这条 ACP turn 还有没有后续内容」
  （`toolCutWaitMs`，默认 1500ms）。还有就继续下一个 step；已经收口且没有剩余帧就
  `concludeTurn()` 结束本轮，避免多出一个空的 step。

实测（本机 v2.178.1，`test/step-cut.live.mjs`）：一条「读两个文件」的 turn 被切成 3 步，
第 1 步在 7.7s 收口（整轮 9.4s）；含 5 秒慢命令的场景里，慢命令那一步 15.9s 收口、
后面的读文件与结论各自只花 0-2ms（帧早已排队）。

`toolCut: 'turn'` 是旧行为（一轮一个 step，工具卡片要等整轮结束才结算），保留给需要
「所有工具块落在同一条 assistant 消息里」的组合；那种模式下 `toolEmit` 仍然生效。

### 卡片什么时候出现、长什么样

分段模式下工具块**只在结算后**发出（`toolEmit` 不参与），所以卡片一出现就是终态，
多个工具按结算顺序逐个出现，一个工具一步。

- **区分度**：所有 CodeBuddy 工具在 DSH 里共用一个回放工具名，DSH 自带「按工具名换图标/标题」
  用不上。所以 `client.js` 按**真实工具名**（`Read` / `Bash` / `Edit` / `Grep` / `Write`…）
  归到家族，各自一套徽章文案与配色（读取/命令/修改/写入/搜索/抓取/任务/待办/智能体），
  左侧还有一条同色竖条；主行只放「工具名 + 主语」，路径可点、命令走等宽字体。

### 为什么结论必须落在「不含 tool-call 块」的那一步

DSH 的 Chat 只把**最后一个 step 中、且不含 `tool-call` 块**的 assistant 回复当作「最终答案」
（`ui-chat` 的 `latestAnswer`：`blocks.some(block => block.kind === 'tool-call') ? null : data`）。
其余正文一律算过程内容，会随整轮折叠一起收起——这就是「CodeBuddy 的结论被折叠」的根因。

分段模式天然满足：正文落在它自己的 step 里，结论那一步没有工具块。兼容模式
（`toolCut: 'turn'`）则靠「正文先攒住（`TurnEmitter.heldText`）+ 记录上打 `holdAnswer`」，
由下一个 step 单独交出。

回放工具只在「这一轮的模型是 CodeBuddy」时可见（注册时按 `modelSelection.provider`
过滤），换成别的模型时它既不在工具表里、也不进请求头。

## 图片：贴的截图真的到模型眼前（而不是一行 `[图片附件]`）

**修掉的 bug**：DSH 消息里的图片是 `{ type:'image', attachment }`，`attachment` 只是**引用**
（同一份字节只存一次），真字节在 `ctx.attachments` 里。旧实现把整个图片块压成文本
`[图片附件：name]`，于是「贴张截图问一句」等于让模型凭空猜——**图片从来没发出去过**。

现在的通路是：

```
DSH 消息 ImageBlock
  └─ host.readImage(ref, {width,height,maxBytes})     ← index.js 的宿主桥
       └─ ctx.attachments.readImageRequest(...)       ← 按目标降质/降尺寸；失败回落 readImage 原图
            └─ base64 + mimeType
                 └─ ACP session/prompt: [{type:'text'}, {type:'image',data,mimeType}…]
```

实测结论（2026-11-01，CodeBuddy CLI v2.178.1，`probe/image-prompt.mjs` + `test/image-live.mjs`）：

| 场景 | 结果 |
|---|---|
| `text` + `image`（纯红 64×64） | 答「红色」 ✅ |
| `image` + `text`（顺序相反） | 答「红色」 ✅ 顺序无关 |
| 换纯蓝图 | 答「蓝色」 ✅ 不是默认猜测（还触发了 `ViewImage`） |
| 阴性对照（不带图、同样的问题） | 「没有收到图片」 ✅ 证明答案由图片导致 |
| 只给 `uri`、不给 `data` | `-32602 Invalid params` ✅ `data`+`mimeType` 必填 |

适配器这边的几条约束：

- **正文里留编号标号**：图片块发在正文之后，正文对应位置写 `[图片 1：a.png]`，
  模型因此知道第几张图对应哪句话。
- **没发出去的图会说清原因**：没挂载 `ctx.attachments`、读失败、超过 `maxImagesPerPrompt`、
  重放历史时被策略裁掉，标号会变成 `[图片 2：b.png（未发送：…）]`——
  模型不会误以为自己看见了图，这一轮也不会因此失败。
- **被压缩省略的图**（`offloaded: true`）没有字节可读，渲染成固定说明，不再当图片发。
- **重放不重发历史截图**：进程回收/换模型导致重开会话、需要重放整段历史时，
  按 `replayImages`（默认 `latest`）只投最后一条用户消息的图。
- **同一张图只发一份**：附件是内容寻址的，重复出现不会翻倍 token。
- **签名认图片身份**：消息签名带上 `attachmentId`，否则「同一句话换一张图」会被判成
  「已转发过」而不发新图（这是同一个 bug 的隐蔽变体）。
- **只发位图**：ACP 没有 svg 之类的通路，这类图退回占位符并注明。

## 会话标题、待办计划、审批（CodeBuddy → DSH 的另外三条通路）

工具之外，还有三样东西在 CodeBuddy 那边有、DSH 这边需要，都做成真实同步：

### 标题：用 CodeBuddy 起的名，而不是固定模板

CodeBuddy 跑完一轮会发 `session_info_update.title`（实测 `"Plan and execute mjs file analysis"`、
`"List plugins directory and count .mjs files"`）。适配器把它转给 `ctx.sessionTitle.rename()`，
DSH 侧因此写一条 `source:{kind:'user'}` 的 `session/title` —— 这条会**钉住**标题，
后续用户消息不再触发自动生成。

顺带修掉了一个老 bug：DSH 自己的标题 provider 发来的不是原始用户消息，而是
`Generate the session title from this JSON array of human messages:[{...}]` 模板帧，
旧实现直接截前 24 字，于是标题永远是 `Generate the session tit…`。
现在会先把 JSON 数组解出来取第一条 `text`，再退回本地截断。

### 待办：CodeBuddy 的任务清单直接变成 DSH 待办面板

**关键实测结论**：CodeBuddy **完全不发** ACP 标准的 `plan` 通知 —— 跑两个多步任务、
54 条 `session_info_update`，一条 plan 都没有。它用的是自己的工具
`TaskCreate` / `TaskUpdate`，任务清单藏在
`tool_call_update._meta['codebuddy.ai/rawResponse'].todos`：

```jsonc
{ "task": { "id": "1", "subject": "…", "activeForm": "…", "status": "pending" },
  "todos": [ { "id": "1", "content": "列出 plugins 目录", "activeForm": "…", "status": "pending" } ] }
```

所以以这个字段为准：每次任务清单变化 → 归一成 `todo/write` 快照 → DSH 的
`todos` 投影 → 界面待办面板。标准 ACP `plan` 通知的兼容通路也留着（万一将来改协议）。
去重按「内容+状态」指纹，同一份清单不会重复写事件。

### 审批：ACP 权限请求变成 DSH 原生审批框

CodeBuddy 在 `permissionMode: default` 下，跑命令这类敏感操作会发
`session/request_permission`（实测带 `options:[allow_always / allow / reject]`）。
`permissionPolicy: 'ask'` 时适配器把它转成 `ctx.approval.request()`：

| DSH 审批结果 | 回给 CodeBuddy |
|---|---|
| `allowed-once` | 选第一个 `kind` 以 `allow` 开头的 option |
| `rejected` | 选第一个 `kind` 以 `reject` 开头的 option；没有就回 `cancelled` |
| `cancelled` / `unavailable` / 问不到 | 按 `permissionAskFallback`（默认 allow） |

两个实测细节：

- **`optionId` 不能硬编码**：实测是 `allow_always` / `allow` / `reject`，只能按 `kind` 选；
- **请求里的 `toolCall` 没有 `title`**：只有 `_meta['codebuddy.ai/toolName']`（`Bash`）
  和 `rawInput`（`{command, description}`）。所以审批文案按「工具名 + 最关键参数」拼，
  实测显示为 `Bash: 查看工作目录顶层内容`。
- 会话的审批策略是 `never` 时不去问（DSH 那边会直接拒绝，问也白问），直接按兜底走。
- 没有审批 UI 的组合（例如 `dsh headless`）会拿到 `unavailable`，同样按兜底走 ——
  否则一次「没有界面」就会让整轮工具全部失败。


## 控制台页面（侧栏 CodeBuddy 图标）

| 区块 | 内容 |
|---|---|
| KPI | **账号真实剩余积分**、今日 / 本月 / 累计的积分消耗、调用次数、Token |
| 账号与积分 | 账号与站点域、额度包明细（剩余 / 已用 / 有效期）、每日积分状态与「领取每日积分」 |
| 模型管理 | 勾选启用的模型、上下移调整顺序、选默认模型，并显示每个模型的**积分倍率**；保存后 DSH 模型选择器立即生效 |
| 按模型用量 | 每个模型的倍率、今日 / 累计积分、调用次数、Token |
| 最近调用 | 时间、模型、积分、Token；可清空账本 |
| 连接 | Provider、常驻连接数、模型探测时间、数据目录 |

数据分两类：

- **剩余积分 / 每日积分**：来自 CodeBuddy 官方 billing 接口，凭据直接复用**你已经登录过的
  CodeBuddy CLI 登录态**（`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info`）。
  插件只读取它来发请求，**不复制、不写回、不上报**，插件自己的数据目录里没有任何 token；
  页面拿到的也只是昵称与站点域这类摘要信息。
- **积分用量**：插件自己的记账。每轮 CodeBuddy 跑完，`usage_update` 里的
  `cost.amount` / `_meta.usage.credit` 会累加进 `$DSH_HOME/codebuddy-acp/usage.json`；
  模型策略存在 `$DSH_HOME/codebuddy-acp/settings.json`。

余额查询走（实测 2026-10-28 全部可用）：

```
POST /v2/billing/meter/get-user-resource          额度包与剩余积分
POST /v2/billing/meter/checkin-activity-status    今日签到状态
POST /v2/billing/meter/daily-checkin              领取每日积分（只在页面点按钮时调用）
```

签到**不做后台定时**：插件不会在你看不见的时候替你去领，必须你点「领取每日积分」。
领取会改变账号余额，所以成功后插件会立即清掉余额缓存并重新拉一次。

积分倍率**以账号侧服务端接口为准**：

```
GET /v2/enterprises/personal/models     账号可用模型与真实倍率
```

这一点很关键，因为三个来源的口径并不一致（实测 `deepseek-v4.1-flash`）：

| 来源 | 倍率 |
|---|---|
| 发行版包内 `product.json`（写死的静态表） | `x0.00`（错，会显示成「免费」） |
| ACP `session/new` 的 `availableModels` | `x0.03` |
| **账号侧接口（插件采用）** | **`x0.11`** |

所以插件先用 `product.json` 兜底模型可见集合，再用账号接口返回的倍率覆盖它；
账号接口拿不到时（未登录、断网）安全回落到目录自带倍率，不会丢模型也不会崩。
控制台模型表里倍率单独一列，**DSH 模型选择器里直接跟在模型名后面**（如
`Deepseek-V4.1-Flash ×0.11`；零倍率显示为「免费」）。

接口（同源，POST 需要 `x-dsh-codebuddy-console: 1`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/codebuddy-console/state` | 账号、额度、签到、模型目录、设置、用量汇总 |
| `GET` | `/api/codebuddy-console/rates` | 轻量只读表：`{ 模型 id: 积分倍率 }`，便于脚本核对 |
| `POST` | `/api/codebuddy-console/settings` | body `{ models? }`，保存并立即生效 |
| `POST` | `/api/codebuddy-console/refresh` | 重新探测模型目录 |
| `POST` | `/api/codebuddy-console/reset` | 清空积分账本 |
| `POST` | `/api/codebuddy-console/billing/refresh` | 立即刷新余额与签到状态 |
| `POST` | `/api/codebuddy-console/billing/checkin` | 领取每日积分 |

## 端到端验证（本机实测，2026-10-28）

```
$ dsh --profile cbtest "用一句话回答：3+4等于几？"
3+4等于7。                          ← stdout（最终答复）
dsh: reasoning:
用户问：3+4等于几？用一句话回答。这是简单的数学题，3+4=7。用中文…   ← 思考流
```

链路：profile 组合 → `ctx.llm` 路由 `codebuddy/hy3` → 适配器 → ACP `session/prompt`
→ CodeBuddy 用自己的登录态与额度调用模型 → 流式回传 → DSH 落盘并打印。

## 前置条件

1. 本机已安装 CodeBuddy CLI：

   ```powershell
   codebuddy --version
   ```

2. CLI 已登录过（登录态在 `~/.codebuddy`，插件不读取、不转发任何凭据）：

   ```powershell
   codebuddy        # 进入 TUI 后执行 /login，按提示用浏览器完成授权
   ```

### 关于「不要反复弹登录」

CodeBuddy 的 `authenticate` **不是**「确认一下登录态」，而是一次真正的外部链接登录：
CLI 日志里是 `externalUriOpener.open`，每次调用都会拉起浏览器。所以本插件的策略是**惰性鉴权**：

1. 先 `session/new`；
2. 只有它被 `-32000 / error.data.category === "auth"` 明确拒绝时，才补一次 `authenticate`；
3. 同一进程只补一次。

只要本机登录态还在（CLI 启动时会 restore，日志里 `hasAccessToken=true`），`session/new`
直接通过，**浏览器不会被拉起**。这一点已实测：同一台机器连续多轮对话，除首次需要授权外，
后续 `initialize → session/new → prompt` 全程静默。

真的需要重新授权时，插件会把 CodeBuddy 下发的授权链接一并放进错误提示里，
并可用 `authTimeoutMs` 控制等待时间。

## 安装

先拿到代码（或直接 `git clone` 到任意目录）：

```powershell
git clone https://github.com/EVA09/dsh-codebuddy-acp.git
```

用 `plugin_manager` 的 `install_bundle`，目标是本目录的绝对路径：

```
action: install_bundle
target: <workspace>\plugins\dsh-codebuddy-acp
```

或者用 CLI 装进任意 profile：

```powershell
dsh plugin --profile desktop add <workspace>\plugins\dsh-codebuddy-acp
```

装好后的 Loader 行：

| 行 id | 包 | 作用 |
|---|---|---|
| `codebuddy-acp` | `dsh-codebuddy-acp` | 在 `ctx.llm` 注册 provider 路由 `codebuddy` |

> 装完或改了插件代码后，**重启桌面端应用**才会加载新的 JS 模块（HMR 只对新安装的包生效一次）。

卸载：`plugin_manager` → `remove_bundle` → `dsh-codebuddy-acp`。

## 在界面里怎么用

1. 打开模型选择器，找到 **CodeBuddy** 分组。
2. 选一个模型（首次建议 `deepseek-v4.1-flash`，x0.00 credits，最省）。
3. 正常提问。界面上会看到：
   - 正文：CodeBuddy 的最终回答（流式）；
   - 「思考」区：CodeBuddy 的推理片段（工具活动不再写进这里，它有自己的卡片）；
   - **工具卡片**：每次工具调用一张卡，显示类别（读取/修改/执行/搜索…）、CodeBuddy 的原始标题
     （如 `Read /path/package.json (1 - 3)`）、目标路径（可点击打开）、状态，展开后是
     **工具真实输出**；
   - 用量：从 `usage_update` 映射出来的 input/output token（多轮模型请求**累加**，重复帧去重）。
4. **思考档位**：模型选择器里，CodeBuddy 分组下每个模型旁边可以选 `low / medium / high / …`
   （具体有哪几档由**该模型**决定，见下表）。选定后这一轮就以该档位跑；
   中途换档不需要重开会话，适配器走 `session/set_config_option {configId:"thought_level"}`。
5. 中途换模型：直接在选择器里换。适配器走 `session/set_config_option {configId:"model"}`
   （CodeBuddy 会校验 modelId），**对话上下文保留**，不会重开会话；换模型后档位会按新模型重新校准。

### 思考档位随模型变化（实测 v2.177.1）

| 模型 | 可用档位 |
|---|---|
| `deepseek-v4.1-flash` / `glm-5.3` / `kimi-k2.8-preview` | `low` / `high` / `max` |
| `hy3` / `glm-5.2` / `deepseek-v4-pro` | `low` / `medium` / `high` / `xhigh` |
| `hy4-preview` | `high`（单档） |
| `space-bunny` / `minimax-m3.1-flash` | `low` / `medium` / `high` / `xhigh` / `max` |

权威来源是 `session/new` 的 `models.availableModels[]._meta.effortOptions` 与
`configOptions.thought_level.options`（本进程建过一次会话后即以此为准）；
选择器打开时尚无会话，用 `src/models.js` 里的实测快照兜底。
写进非法档位不会让整轮失败——CodeBuddy 以 -32603 拒绝后适配器记一条 warn 并沿用当前档位。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `codebuddy-acp` 行的 `config`：

```yaml
- id: codebuddy-acp
  name: dsh-codebuddy-acp
  config:
    permissionMode: bypassPermissions
    toolNarration: reasoning
```

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `codebuddy` | `ctx.llm` 上的路由名，也是选择器分组 id |
| `displayName` | `CodeBuddy` | 选择器分组标题 |
| `command` | `codebuddy` | CLI 命令名或绝对路径 |
| `nodePath` | 自动探测 | 用哪个 node 起 JS 入口（桌面端 `process.execPath` 是 Electron，不能直接用） |
| `args` | `['--acp']` | 启动参数 |
| `permissionMode` | `bypassPermissions` | 透传 `--permission-mode`：`default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto` |
| `permissionPolicy` | `allow` | ACP `session/request_permission` 的回应策略：`allow` / `deny` / **`ask`**（弹 DSH 原生审批框） |
| `permissionAskFallback` | `allow` | `permissionPolicy: 'ask'` 但问不到用户时（无审批 UI、被取消、会话策略为 `never`）怎么办：`allow` / `deny` |
| `syncTitle` | `true` | 采用 CodeBuddy 的会话标题（`session_info_update.title` → DSH 标题） |
| `syncPlan` | `true` | 把 CodeBuddy 的任务清单同步成 DSH 待办面板（`todo/write`） |
| `authMethod` | `auto` | 鉴权方式；`auto` 优先 `internal`（微信，静默复用缓存凭据） |
| `authTimeoutMs` | `120000` | 惰性鉴权的最长等待（首次要你在浏览器点授权） |
| `billingAuthFile` | 自动探测 | 指定 CodeBuddy 登录态文件（`*.info`）；留空则按平台默认位置查找。只读取，不写回 |
| `defaultModel` | 空 | 兜底模型 |
| `defaultThoughtLevel` | 空 | DSH 没给 `reasoningEffort` 时用哪个思考档位：`minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `enabled`；留空表示不改写 CodeBuddy 自己的设置 |
| `modelDiscovery` | `both` | `help` / `static` / `both` / `off`：静态目录的来源 |
| `models` | 空 | 只显示这些模型 id，顺序即展示顺序 |
| `showAliases` | `false` | 是否显示 `default-model` 这类角色档位别名（实测走 ACP 切换后拿不到回答，默认关） |
| `useModelsJson` | `true` | 合并 `~/.codebuddy/models.json` 与项目级 `models.json` |
| `contextWindow` | `200000` | 目录没给上下文窗口时的声明值（真实值优先取 `models[]._meta.maxInputTokens`） |
| `maxTokens` | `32000` | 同上，输出上限声明值 |
| `systemPrompt` | `off` | 把 DSH 系统提示词当前言交给 CodeBuddy：`off` / `append` / `full` |
| `toolReplay` | `true` | 把工具调用转成 DSH 原生 `tool-call` 块 + 回放工具（完整调用链）；`false` 退回「文字播报」旧行为 |
| `toolName` | `codebuddy_tool` | 回放工具在 DSH 工具表里的名字（改它要同步改 `client.js` 里的 `TOOL_NAME`） |
| `toolInputLimit` | `4000` | `tool-call` 参数里保留的 rawInput 预算（字符），超出转成预览 |
| `toolOutputLimit` | `12000` | 工具结果在会话里展示的字符上限（完整输出仍保留在工具体里） |
| `toolNarration` | `auto` | 旧模式的工具播报位置：`auto`（回放开启时自动关闭）/ `reasoning` / `text` / `off` |
| `imageInput` | `true` | 是否把 DSH 消息里的图片**真的发给 CodeBuddy**（`{type:'image',data,mimeType}` 内容块）；`false` 退回 `[图片 N：name]` 占位符 |
| `maxImageBytes` | `5242880` | 单张图投递的字节目标（5MB）；附件服务据此降质/降尺寸，也是 `imageRequestTarget` 返回值 |
| `maxImagesPerPrompt` | `10` | 一次 prompt 最多投几张图；超出的只在正文留标号并注明原因 |
| `replayImages` | `latest` | 重放完整历史时投哪些图：`latest`（只投最后一条用户消息）/ `all` / `none` |
| `toolEmit` | `settle` | 什么时候发 `tool-call` 块（**只在 `toolCut: 'turn'` 下生效**）：`settle`（等 CodeBuddy 把这次调用结算完再发）/ `start`（一看到就发，卡片早出现但完成态要等整轮 ACP 结束） |
| `toolCut` | `step` | 一次 ACP turn 怎么切给 DSH 的 step：`step`（**每个工具独占一步**，卡片在轮次中途当场结算，正文留在原位）/ `turn`（一轮一个 step，旧行为，卡片要等整轮结束才结算） |
| `toolCutWaitMs` | `1500` | `toolCut: 'step'` 下回放工具最多等多久来判断「这条 ACP turn 还有没有后续内容」；等不到就按「还有」处理（宁可多走一步也不丢正文） |
| `settleGraceMs` | `250` | `session/prompt` 结算后还允许多久继续接收同一会话的尾帧（实测响应之后仍可能补发最终正文/标题/用量） |
| `proxyFs` | `true` | 把 ACP 的 `fs/read_text_file`、`fs/write_text_file` 代理给 DSH 文件服务（失败回落本机 fs） |
| `proxyTerminal` | `false` | 是否把 ACP 终端代理到本机（关闭时 CodeBuddy 自己执行命令） |
| `startupTimeoutMs` | `60000` | 握手/建会话超时 |
| `turnTimeoutMs` | `0` | 单轮墙钟上限，0 不限 |
| `cancelGraceMs` | `3000` | 用户中断后先发 ACP `session/cancel`，再等 agent 把这一轮结算成 `cancelled` 的最长时间；超时才本地中断（0 = 只发通知不等回执） |
| `disposeGraceMs` | `3000` | 进程退出宽限期（Windows 用 `taskkill /T` 兜底进程树） |
| `env` | `{}` | 追加给子进程的环境变量（如 `CODEBUDDY_API_KEY`） |
| `logLevel` | `warn` | `silent` / `warn` / `info`（`info` 会把每条 ACP 通知打到 Host 日志） |

## 设计说明

- **进程池**：`initialize` ≈1.6s，鉴权按需最坏十几秒，所以按**工作目录**共享一个
  `codebuddy --acp` 进程，进程内每条 DSH 会话各占一条 ACP 会话。进程内多轮 prompt 用
  连接级互斥闸门串行，避免互相打断。
- **一次 `stream()` = 一条 ACP turn 的一个 step**：CodeBuddy 有工具、权限、沙箱和自己的循环，
  所以这里**不把 DSH 的工具表交给它**；但它的每一次工具调用都会转成 DSH 的
  `tool-call` 块，并由回放工具带回真实结果（见上节「调用链」）。
  默认 `toolCut: 'step'` 下，同一条 ACP turn 会跨多个 step 存活（`LiveTurn`），
  step 之间不发任何 ACP 请求。
- **增量投喂**：DSH 每一步都会重发整段历史。适配器为每条消息算签名，比对「已转发前缀」，
  只把新增的用户消息发给已在运行的 ACP 会话；前缀对不上（压缩、回滚）才重放全部历史。
  分段模式下，续段产生的 assistant/tool 消息也记进签名（它们进 DSH 历史但没再发给 CodeBuddy）。
- **换模型不重开**：`session/set_config_option {configId:"model", value}`（有校验），失败才
  退化成「新开 ACP 会话 + 重放历史」。不用 `session/set_model`——它不校验 modelId。
- **思考档位是会话级的**：`thought_level` 与 `model` 一样挂在 ACP 会话上，所以换档位**不重开会话**；
  换模型时档位集合可能变化，因此会强制重新校准一次。`enabled` 是 CodeBuddy 的「跟随模型默认档」，
  不参与 DSH 的档位列表，只作配置兜底值。
- **块编排按时间顺序**：思考串流、正文串流、**每次工具调用独占一个块**，块切换时立刻发
  `block-end`（旧实现把整轮的思考与工具播报塞进一个块、所有 `block-end` 拖到轮末，
  于是界面长时间不动、工具结果完全看不到）。
- **发块即收口**（`toolCut: 'step'`）：工具块一发出就结束当前 step，DSH 立刻执行回放工具、
  卡片当场变成完成态。所以卡片不会再「挂到轮末」；代价是同一轮会出现多条 step 级消息
  （Chat 里每个带正文的 step 各自成段，`foldedReplies` 默认把过程段折叠起来）。
- **占位帧先压住**：实测 CodeBuddy 会先发一条 `kind=other`、标题只有 `Read` 的占位
  `tool_call`，稍后才补一条带绝对路径与正确 `kind` 的同 id `tool_call`。适配器把占位帧
  压在滞留队列里，等补全帧到了再一次性发块——否则卡片上只有 `Read`、没有路径。
  但不能拿 `rawInput` 里的路径当信号：`tool_call_update` 的增量参数会先填上路径，
  那样会提前发块（实测踩过）。
- **`rawInput` 是增量的**：`tool_call_update` 里的 `rawInput` 每帧只带一部分字段，
  必须**合并**而不是覆盖，否则最后一条只剩 `{cwd}` 之类。
- **工具结果保留**：`tool_call_update` 的 `rawOutput` / `content` 进结果桥，
  由回放工具以 `tool/result` 交回 DSH；超长输出按 `toolOutputLimit` 截断。
- **用量按 `messageId` 归并**：一次 ACP prompt 里 CodeBuddy 会跑多轮模型请求，每轮各发一条
  `usage_update` 结算，需要累加；但同一份结算会被**重复推送两次**，简单累加会把 token 翻倍，
  所以以 `messageId` 为键 upsert（后到者为准，因为只有后到的那条带 `cost`）。
- **用量**：`session/prompt` 的结果里没有 usage，真值在 `usage_update` 的
  `_meta.usage`（OpenAI 风格），这里映射成 DSH 的 `inputTokens/outputTokens/reasoningTokens/cacheReadTokens`。
- **辅助调用不占进程**：会话标题、上下文压缩（`purpose: 'session-title' | 'compaction'`）
  用确定性文本应答，不会为标题额外跑一轮 agent。

## 能力链接清单

| CodeBuddy 原生能力 | 接入方式 | 状态 |
|---|---|---|
| 模型选择 | 账号可用模型目录 + `session/set_config_option` | ✅ 实测 |
| **思考档位** | DSH 的 `reasoningEffort` → `session/set_config_option {configId:"thought_level"}`；`resolveModel` 按模型给出可用档位 | ✅ 实测 |
| 账号级模型元数据 | `session/new` 的 `models.availableModels`（含 `maxInputTokens` / `effortOptions`） | ✅ 实测 |
| 流式回答 | `agent_message_chunk` → `text-delta` | ✅ 实测 |
| 思考过程 | `agent_thought_chunk` → `reasoning-delta` | ✅ 实测 |
| **图片输入** | DSH `ImageBlock` → `ctx.attachments` 读字节 → `session/prompt` 的 `{type:'image',data,mimeType}` 内容块 | ✅ 实测 |
| 工具调用可见性 | `tool_call` / `tool_call_update` → **原生 `tool-call` 块 + `codebuddy_tool` 回放工具 + 客户端工具卡片** | ✅ 实测 |
| **工具卡中途结算** | 一次 ACP turn 切成多 step（`toolCut: 'step'`）：每个工具独占一步，卡片在轮次中途变成完成态 | ✅ 实测（真机 + 真 DSH） |
| **会话标题** | `session_info_update.title` → `ctx.sessionTitle.rename()`（钉住标题） | ✅ 实测 |
| **待办计划** | `TaskCreate`/`TaskUpdate` 的 `_meta['codebuddy.ai/rawResponse'].todos` → `todo/write` → DSH 待办面板 | ✅ 实测 |
| 权限模式 | `--permission-mode` | ✅ 实现 |
| **权限请求应答** | `session/request_permission` → `ctx.approval.request()` → 原生审批框 | ✅ 实测（`ask` 模式） |
| 文件读写代理 | `fs/read_text_file` / `fs/write_text_file` → `ctx.fs`（回落 node:fs） | ✅ 可选 |
| 用量与 credits | `usage_update._meta.usage` → DSH token meter | ✅ 实测 |
| 剩余积分 / 每日积分 | `v2/billing/meter/*`（复用本机 CLI 登录态） | ✅ 实测 |
| 模型积分倍率 | 账号侧 `/v2/enterprises/personal/models` → `×0.11` | ✅ 实测 |
| 取消 | `session/cancel`（先通知 agent 再本地收口，见 `cancelGraceMs`） | ✅ 实现 |
| 终端代理 | `terminal/*` | ❌ 默认关闭（CodeBuddy 自己执行命令） |
| 斜杠命令（82 条） | `available_commands_update` 目前只记日志 | ⏳ 未做 |
| 会话恢复（`loadSession`） | 未使用（DSH 侧有自己的持久化） | ⏳ 未做 |
| MCP 注入（`session/new.mcpServers`） | 传空数组，用 CodeBuddy 自己的 MCP 配置 | ✅ 不自建 |

## 安全与隐私

- **不收集、不上传任何凭据**：插件不内置任何 API Key，鉴权完全交给本机 CodeBuddy CLI
  （登录态由 CLI 自己维护在 `~/.codebuddy`）。
- **只读本机登录态**：侧栏控制台要显示真实剩余积分 / 今日签到状态时，`src/billing.js` 会
  **只读**本机 CLI 的 auth 文件取出 `accessToken`，用于向 CodeBuddy 官方接口查询一次余额；
  不写回、不进日志、不转发到其他地址。
- **没有遥测**：会话内容只在你本机 ↔ CodeBuddy 之间流动。
- **仓库不含抓包日志**：`probe/out/` 的原始 ACP 帧含账号标识（userId / 昵称）与本机绝对路径，
  已在 `.gitignore` 中排除；要复现请用 `probe/` 下的探针脚本自己抓。

## 已知限制

- **角色档位别名不可用**：`default-model` / `fast-model` 这类别名通过 ACP 切过去后，
  模型请求会静默返回空结果（已实测），所以默认不展示；`showAliases: true` 可强制打开。
- **角色档位 ≠ 账号模型**：`session/new` 的 `models.availableModels` 才是可用集合，
  `--help` 里那份静态表是发行版本写死的，两者不一致。
- **进程常驻**：每个工作目录一个 CodeBuddy 进程（空闲 30 分钟或超过 4 个空闲连接时回收）。
  子智能体共用同目录的进程。
- **DSH 侧不替 CodeBuddy 执行工具**：ACP 没有「客户端执行工具」的通道，工具永远是 CodeBuddy
  自己跑的。DSH 里看到的工具卡片是一次**回放**（`codebuddy_tool` 只交回结果、结束本轮），
  所以卡片上的「耗时」反映不了 CodeBuddy 的真实执行过程（审批是另一条真实通路，见上）。
- **工具审批要显式开**：默认 `permissionMode: bypassPermissions` + `permissionPolicy: allow`，
  CodeBuddy 根本不问、也直接放行。想要 DSH 审批框必须两件事一起改：
  `permissionMode: default`（让它问）+ `permissionPolicy: ask`（让我们问用户）。
  `ask` 模式下如果这个组合没有审批 UI（`dsh headless`），结果是 `unavailable`，
  按 `permissionAskFallback`（默认 allow）走，不会卡住。
- **待办来自 CodeBuddy 的任务工具**：它不发标准 ACP `plan`，所以待办面板的内容取决于
  模型有没有主动用 `TaskCreate`/`TaskUpdate`。不用这些工具时面板就是空的（正常）。
- **图片要模型自己支持**：能不能传图由模型目录的 `supportsImages` 决定（DSH 据此声明
  `inputModalities`），非视觉模型即使贴图也只会收到占位符；重放历史默认只重发最新一张
  （`replayImages`），所以「重开会话」后很早期的截图不在上下文里。
- **图片走 JSON-RPC 内联 base64**：没有 Files 上传通路，`maxImageBytes`（默认 5MB）是硬上限，
  大图会先被附件服务降质/降尺寸再发，仍超限的会注明「未发送」。
- **上下文压缩是本地确定性摘要**，不是模型生成的摘要；CodeBuddy 侧上下文仍完整。
- **首轮成本偏高**：CodeBuddy 每轮都会带自己的系统提示与工具定义（约 2.7 万 input tokens）。
- **一轮会出现多个 step**：`toolCut: 'step'` 下每个工具一步，所以 Chat 里同一轮会有多条
  step 级消息（默认 `foldedReplies` 会把过程段折叠成「工作 Xs」，会话统计的步数也会变多）。
  这是「卡片当场结算」的代价；想回到「一轮一条消息」就设 `toolCut: 'turn'`。
- **并发工具按结算顺序落地**：CodeBuddy 实测串行执行工具；若将来并行，适配器按**结算顺序**
  逐个发块（每个工具仍独占一步），不会把并行的几个调用塞进同一张卡片。

## 自测

不需要 DSH，直接驱动真实 CodeBuddy：

```powershell
cd plugins\dsh-codebuddy-acp
node test/run.mjs --models                       # 只列模型（不发起对话）
node test/run.mjs "用一句话回答：1+1等于几？"      # 真跑一轮（默认取目录里第一个模型）
$env:CB_MODEL='hy3'; node test/run.mjs "1+1=?"    # 指定模型
$env:CB_LOG='info';  node test/run.mjs "1+1=?"    # 打印每条 ACP 通知
node test/step-cut.live.mjs                       # 分段 step：读两个文件，断言 3 步、卡片终态、只发一次 prompt
node test/step-cut.live.mjs --slow                # 含 5 秒慢命令：验证慢工具那一步不会被提前收口
```

离线测试（不触网、不改变账号状态）：

```powershell
node test/billing.test.mjs               # 登录态解析、余额/签到/领取、失败降级、倍率解析
node test/rate-source.mjs                # 倍率以账号侧为准、覆盖静态表、失败安全回落
node test/reasoning-and-blocks.test.mjs  # 思考档位映射 + 多轮工具调用的块编排（回放实测帧）
node test/tool-replay.test.mjs           # 工具调用转原生块 + 回放工具取回结果 + 历史不回灌
node test/sync-title-plan-approval.test.mjs  # 标题/待办/审批三条同步通路（含 TaskCreate 真实帧）
node test/host-smoke.mjs                 # 控制台接口：state / rates / settings / refresh / reset
node test/client-smoke.mjs               # 浏览器半身：导出、四个槽位注册、整页渲染、工具卡片四态
node test/image-prompt.test.mjs          # 图片真的进 prompt：内容块/去重/上限/降级/签名（假连接，离线）
node test/host-integration.mjs           # 真实装配链路：index.js → 适配器/控制台/工具注册
```

想看 ACP 原始帧（例如确认某个通知到底发不发），用探针脚本直连 CodeBuddy：

```powershell
node probe/capture-frames.mjs --mode plan "请用 TodoWrite 建立任务清单并执行"
# 会打印每条 session/update、每条 agent→client 请求（含 session/request_permission 完整参数）
```

`tool-replay.test.mjs` 用同一份真实帧序列断言「工具调用完整进 DSH」的每一步：
占位帧不抢跑、同一 `toolCallId` 只产生一个块、块的参数结构（`title` 在最前）、
结果进桥并被回放工具取回、`concludeTurn()` 只结算一次、历史投喂不再回灌工具参数与结果。
它还断言**分段 step** 的核心形状：两个工具各自独占一步（`['reasoning','tool-call']` →
`['tool-call']` → `['text']`）、工具块发块时就是终态、夹在工具之间的正文留在原位、
纯工具轮由回放工具 `concludeTurn()` 收口、兼容模式仍然走 `holdAnswer`。
测试里的 `driveSteps()` 就是在模拟 DSH 的 agent loop（每步执行本步的 tool-call 块再决定是否继续）。

`reasoning-and-blocks.test.mjs` 用**假 ACP 连接**回放 2026-10-28 抓到的真实帧序列，
覆盖两个已修复的问题：档位是否真的写进 CodeBuddy（含非法档位不阻断、同档位不重复写）、
以及多轮工具调用的 `block-start`/`block-end` 是否配对且及时收口、工具输出是否保留、
重复 `usage_update` 是否不再翻倍。

`image-prompt.test.mjs` 用假连接 + 假附件服务断言「图片真的进 prompt」的每一步：
image 内容块带规范 base64 与 mimeType、纯图片消息不被丢、没有图片服务时正文注明「未发送」、
读图失败不阻断整轮、上限与去重、换图后签名变化会重新发、压缩省略的图不占编号。

真实图片冒烟（会消耗一次额度，需要本机已登录 CodeBuddy）：

```powershell
node test/image-live.mjs                        # 用 probe/out/red-64x64.png，期望答「红色」
node test/image-live.mjs probe\out\blue-64x64.png   # 期望答「蓝色」（排除瞎猜）
```

真实接口冒烟（只读，用你本机登录态实打实查一次）：

```powershell
node test/billing-live.mjs    # 打印真实剩余积分、额度包与今日签到状态
```

### 端到端（真跑 DSH + 真跑 CodeBuddy 工具）

装好插件后，用装好的运行时把一轮「读文件」任务跑穿，然后看会话日志里的 step 结构：

```powershell
# 1) 建一个专用 profile，并让默认模型走 CodeBuddy
dsh --profile headless --dump-config > $null      # 首次会生成 profile 目录
# $DSH_HOME\profiles\headless\cordis.patch.yml 写入：
#   - id: agent-default-model
#     name: "@deepseek-ai/dsh-agent-default-model"
#     config: { provider: codebuddy, model: deepseek-v4.1-flash }
dsh plugin --profile headless add <本目录绝对路径>

# 2) 跑一轮会触发工具的任务（也可以用 --patch 挂一份临时 overlay，见下）
dsh --profile headless "读取 package.json 和 README.md 的第一行，告诉我各写了什么"

# 3) 期望：每个工具各自一个 step，且 tool/result 出现在该 step 内
```

实测（2026-11-03，CodeBuddy CLI v2.178.1，DSH 0.2.1-rc.5，`toolCut: 'step'`）：

```
turn1 step1  assistant[tool-call Read package.json] → tool/call → tool/result → step/end
turn1 step2  assistant[tool-call Read README.md]    → tool/call → tool/result → step/end
turn1 step3  assistant[text]                        → step/end → turn/end
```

即：**工具卡片在轮次中途就结算完成**，最终正文单独落在最后一步（`latestAnswer` 认得它）。
改造前是「一轮一个 step」，所有工具卡片都要等 turn 结束才一起执行、一起结算。

用临时 overlay 试跑（不改 profile 本体）：

```powershell
dsh headless --patch .\e2e.overlay.yml "任务"   # overlay 内容见上「配置」一节的示例
```

## 参考资料

- `docs/acp-findings.md`：**本机实测**的 CodeBuddy ACP 协议笔记（握手顺序、鉴权四种方式、
  `session/update` 19 种变体、模型/模式/配置项、usage 结构、错误结构与边界行为），
  复跑用的探针脚本在 `probe/`。原始抓包帧（`probe/out/*.jsonl`）含账号标识与本机路径，
  不入仓库；需要时用 `probe/run-probe.mjs` 自己抓一份。
- 官方文档：<https://www.codebuddy.ai/docs/zh/cli/acp>

## 实现备注

本包**不 import 任何 `@deepseek-ai/*` 运行时包**。DSH 以链接方式安装本地 bundle 时这些包
不一定可解析；`ctx.llm.registerAdapter` 用方法调用校验适配器，结构满足 `LlmAdapter` 契约即可。

## 许可证

[MIT](LICENSE)。仓库内含一份 Apache-2.0 的 ACP schema 摘录（`probe/acp-schema-excerpt.json`），
归属与分发声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

