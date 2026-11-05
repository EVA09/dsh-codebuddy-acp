# dsh-codebuddy-acp

> 给 CodeBuddy CLI 套上笼头，然后骑上去。

本机那个 [CodeBuddy Code CLI](https://www.codebuddy.ai/docs/zh/cli/acp)（`@tencent-ai/codebuddy-code`）
挺能干：有自己的模型池、自己的额度、自己的沙箱、自己的工具循环，脾气还挺大。
但它没有像样的界面、没有工具卡片、没有审批框、也不会记住你昨天聊了啥。

DSH 正好反过来：界面齐全，工具卡片、审批、待办、会话记忆都有，就是没额度。

于是这个插件把它们绑一块：**它出体力，你出额度，DSH 出马鞍。**

```
DSH 会话
  └─ ctx.llm 适配器（provider = codebuddy）      ← 骑手
       └─ codebuddy --acp（每工作目录一匹，常驻）  ← 坐骑
            ├─ initialize → session/new → session/prompt
            ├─ session/set_config_option → 换模型 / 换档位
            └─ session/update → 正文、思考、工具调用、用量
```

装好之后，模型选择器里多出 **CodeBuddy** 分组，选中的模型由它用自己的登录态跑，
烧的是你账号里腾讯给的那份额度。

## 它能干什么

| 功能 | 说明 |
|---|---|
| **模型分组** | 分组里是你账号下真实可用的模型（实测 19 个），名字后面直接挂**积分倍率**（`Deepseek-V4.1-Flash ×0.11`）。它自己 `product.json` 里写的 `×0.00` 是骗你的，以账号侧接口为准 |
| **思考档位** | 每个模型可选 `low / medium / high / xhigh / max`，具体几档看模型心情。换档不丢上下文，不用重开会话 |
| **工具卡片** | 它在自己肚子里跑工具，ACP 只肯把过程当通知吐出来。我们把每一条转成 DSH 原生工具卡片：按真实工具名（`Read` / `Bash` / `Edit`…）分家族配色，展开能看**真实输出** |
| **中途结算** | 一轮 ACP 按工具切成多个 step，卡片在轮次中途就当场变完成态，不再挂到轮末罚站。结论单独落在最后一步 |
| **图片输入** | 贴的截图真的以 `{type:'image',data,mimeType}` 发给它，正文里留 `[图片 1：a.png]` 标号。以前那版只是把图压成一行文字，等于让它闭眼猜 |
| **标题同步** | 用它起的会话标题，不是「Generate the session tit…」 |
| **待办面板** | 它嘴上不发标准 ACP `plan`，其实把任务清单偷偷塞在 `TaskCreate` 的 `_meta` 里，我们给挖出来变成 DSH 待办 |
| **原生审批** | `permissionPolicy: 'ask'` 时，它的权限请求变成 DSH 审批框。它想跑命令，得先问你 |
| **控制台** | 侧栏 CodeBuddy 图标：真实剩余积分、领每日积分、模型开关与排序、按模型用量。领积分要你自己点，我们不趁你不在偷偷领 |

想看在它肚子里到底怎么转的（调用链、切 step、图片通路、配置全表、自测脚本），都在
[AGENT.md](AGENT.md)。

## 上马之前

1. 本机有它：`codebuddy --version`
2. 它登录过：`codebuddy` 进 TUI，敲 `/login`，按提示开浏览器授权

插件**不碰任何凭据**，登录态由它自己维护在 `~/.codebuddy`。它登录过的时候 `session/new`
直接放行，浏览器不会没事弹出来——只有它明确喊 `auth` 错误，我们才让它补一次授权，
且同一进程只补一次。它要是每次都喊你扫码，那不是插件干的。

## 安装

```powershell
git clone https://github.com/EVA09/dsh-codebuddy-acp.git
```

用 `plugin_manager`：

```
action: install_bundle
target: <本目录绝对路径>
```

或者 CLI 装进任意 profile：

```powershell
dsh plugin --profile desktop add <本目录绝对路径>
```

装好后的 Loader 行是 `codebuddy-acp` → `dsh-codebuddy-acp`，作用是在 `ctx.llm` 注册 provider
路由 `codebuddy`。

> 装完或改过插件代码，**重启桌面端应用**才认新模块。HMR 只肯给新装的包开一次后门，
> 改代码不算。

卸磨：`plugin_manager` → `remove_bundle` → `dsh-codebuddy-acp`。

## 怎么骑

1. 打开模型选择器，找到 **CodeBuddy** 分组。
2. 选一个模型，正常提问。
3. 中途换模型、换档位都不用重开会话，它的上下文比你想的结实。

## 调教

在 profile 的 `cordis.patch.yml` 里覆盖 `codebuddy-acp` 行的 `config`：

```yaml
- id: codebuddy-acp
  name: dsh-codebuddy-acp
  config:
    permissionMode: bypassPermissions
    toolNarration: reasoning
```

常用几项（完整表在 [AGENT.md](AGENT.md)）：

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` / `displayName` | `codebuddy` / `CodeBuddy` | 路由名与分组标题 |
| `command` | `codebuddy` | CLI 命令名或绝对路径 |
| `permissionMode` | `bypassPermissions` | 透传 `--permission-mode`。默认状态下它谁也不问，闷头就干 |
| `permissionPolicy` | `allow` | 权限请求怎么回。设 `ask` 才会弹 DSH 审批框 |
| `toolCut` | `step` | 每个工具独占一步，卡片中途结算。设 `turn` 退回旧行为，卡片集体在轮末罚站 |
| `imageInput` | `true` | 是否真把图发给它 |
| `logLevel` | `warn` | `silent` / `warn` / `info` |

想要审批框，**两项必须一起改**：`permissionMode: default`（让它开口问）+
`permissionPolicy: ask`（让我们替你问）。只改一项等于白改——它不问，我们也就没得问。

## 它不肯配合的地方

- **工具是它自己跑的，我们只放录像。** ACP 没有「客户端替你执行工具」的通道，DSH 里那张卡片
  是一次回放，所以卡片上的耗时反映不了它真实干活用了多久。审批倒是真的。
- **协议标准它不看。** ACP 有 `plan` 通知，它一条都不发（实测两轮多步任务、54 条
  `session_info_update`，零 plan），自己发明了 `TaskCreate`/`TaskUpdate`，清单藏在
  `_meta['codebuddy.ai/rawResponse'].todos`。待办面板空着不是坏了，是它压根没用那些工具。
- **入场费很贵。** 每轮都带自己的系统提示和工具定义，首轮约 2.7 万 input token。这不是我们的
  中间商差价，是它的行李太重。
- **图片走 JSON-RPC 内联 base64。** 没有文件上传通路，`maxImageBytes`（默认 5MB）是硬上限，
  超了只能降质或标注「未发送」。非视觉模型就算你把图怼到它脸上，它也只收到占位符。
- **角色别名切过去会变哑巴。** `default-model` / `fast-model` 这类别名通过 ACP 切过去，
  模型请求静默返回空结果，它自己都不吭声。所以我们默认不展示。
- **一轮会冒出好几个 step。** 这是「卡片当场结算」的代价：Chat 里同一轮有多条 step 级消息，
  过程段默认折叠成「工作 Xs」。想回到「一轮一条」就设 `toolCut: 'turn'`，然后继续看着卡片罚站。

## 许可证

[MIT](LICENSE)。仓库里夹了一份 Apache-2.0 的 ACP schema 摘录，归属声明见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
