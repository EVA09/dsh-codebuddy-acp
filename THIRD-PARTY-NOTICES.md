# 第三方声明（Third-Party Notices）

本仓库整体以 **MIT** 许可发布（见 [`LICENSE`](LICENSE)）。仓库内含下列第三方材料，按各自许可证分发。

## 1. Agent Client Protocol schema 摘录

- **文件**：`probe/acp-schema-excerpt.json`
- **来源**：agent-client-protocol（<https://github.com/agentclientprotocol/agent-client-protocol>，
  文档站 <https://agentclientprotocol.com>）；本文件是从本机安装的 `@agentclientprotocol/sdk`
  附带的 `schema/schema.json` 中**节选**的关键定义。
- **许可证**：Apache License 2.0，全文见 [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt)。
- **修改说明**：仅做字段节选，未改动原文内容。

## 2. 未随仓库分发的第三方材料

以下文件曾用于本次调研，属他人版权作品或含个人账号信息，已由 `.gitignore` 排除；
仓库内只保留链接与自写结论。

| 本地文件 | 内容 | 为何不入库 |
|---|---|---|
| `probe/acp-doc.html`、`probe/acp-doc.txt` | 腾讯 CodeBuddy 官方文档《ACP 协议集成》全文快照 | 官方文档原文，版权归腾讯。需要请看 <https://www.codebuddy.ai/docs/zh/cli/acp> |
| `probe/cli-help.txt`、`probe/cli-acp-help.txt` | `codebuddy --help` / `codebuddy --acp --help` 完整输出 | 同上，属第三方文案 |
| `probe/out/*` | ACP 双向原始帧、摘要与控制台日志 | 含账号 userId、昵称、本机绝对路径与真实会话 ID |

## 3. 商标

CodeBuddy、腾讯云代码助手、DeepSeek Harness 等名称与标识归各自权利人所有。
本项目是第三方社区插件，与腾讯、DeepSeek 均无隶属或背书关系。
