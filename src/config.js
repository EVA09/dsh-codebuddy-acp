/**
 * 配置归一化与校验。
 *
 * Loader 行配置只有在插件激活时才校验；这里把每个字段收敛成适配器可以直接使用的形态，
 * 非法值一律抛错（而不是静默降级），这样配置错误能在插件页的行状态里立刻看到。
 *
 * @module src/config.js
 */

/** CodeBuddy 的 npm 包名与可执行入口。 */
export const CODEBUDDY_PACKAGE = '@tencent-ai/codebuddy-code'
export const CODEBUDDY_BIN = 'codebuddy'

/** 权限策略：CodeBuddy 通过 ACP 请求权限时客户端如何回应。 */
const PERMISSION_POLICIES = ['allow', 'deny', 'ask']

/** `permissionPolicy: 'ask'` 问不到用户时怎么办。 */
const PERMISSION_FALLBACKS = ['allow', 'deny']

/** CodeBuddy 侧允许透传的权限模式（与 CLI `--permission-mode` 取值一致）。 */
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']

/** 工具调用播报方式：写进推理块（reasoning）或完全不播报。 */
const NARRATION_MODES = ['reasoning', 'off']

/** 重放完整历史时怎么处理图片（见 README 的 `replayImages`）。 */
const REPLAY_IMAGE_MODES = ['latest', 'all', 'none']

/**
 * 工具调用播报方式：`auto`（回放模式下自动关闭，否则写推理块）、写进推理块、
 * 写进正文或完全不播报。
 */
const NARRATION_ALL = ['auto', 'reasoning', 'text', 'off']

/** DSH 工具名允许的字符集（与 DSH 的工具注册校验保持一致）。 */
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * CodeBuddy 的思考档位取值（`session/set_config_option {configId:"thought_level"}`）。
 *
 * 实测 v2.177.1 接受：`minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `enabled`；
 * 非法值以 -32603 拒绝并在 `data.details` 里回带全集。
 * `enabled` 是「跟随模型默认档」，不参与 DSH 的档位列表，但可当作配置兜底值。
 */
const THOUGHT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'enabled']

/**
 * 默认配置。
 *
 * 默认值的取向：**尽量让 CodeBuddy 用自己完整的能力跑完整轮次**。
 * 因此默认 bypassPermissions（不弹它自己的确认），并且把它的工具活动写进推理块，
 * 这样界面上能看见它在做什么，同时不污染最终回答。
 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 在 `ctx.llm` 上注册的 provider 路由名，也是模型选择器里分组的 id。 */
  provider: 'codebuddy',
  /** 模型选择器里分组标题。 */
  displayName: 'CodeBuddy',
  /** 可执行文件：命令名或绝对路径。 */
  command: CODEBUDDY_BIN,
  /** 显式指定 node 可执行文件；留空则自动探测。 */
  nodePath: undefined,
  /** ACP 启动参数（一般不需要改）。 */
  args: ['--acp'],
  /** 透传给 CodeBuddy 的权限模式。 */
  permissionMode: 'bypassPermissions',
  /** ACP 权限请求的回应策略：`allow` / `deny` / `ask`（问 DSH 审批框）。 */
  permissionPolicy: 'allow',
  /** `permissionPolicy: 'ask'` 问不到用户时（无审批方、被取消、策略为 never）的兜底。 */
  permissionAskFallback: 'allow',
  /** 是否采用 CodeBuddy 的会话标题（`session_info_update.title` → DSH 标题）。 */
  syncTitle: true,
  /** 是否把 CodeBuddy 的 `plan` 同步成 DSH 待办面板（`todo/write`）。 */
  syncPlan: true,
  /** 鉴权方式：`auto` 优先用 internal（微信，静默复用缓存凭据）。 */
  authMethod: 'auto',
  /**
   * 指定 CodeBuddy 登录态文件（`*.info`）的路径。
   * 留空则自动探测 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth` 等默认位置。
   * 插件只读取它来查余额与签到，不会写回或复制。
   */
  billingAuthFile: undefined,
  /** 鉴权超时（毫秒）：冷启动时可能要等用户点浏览器授权，给足时间。 */
  authTimeoutMs: 120000,
  /** 覆盖默认模型（对应 CodeBuddy 的 `--model`）。 */
  defaultModel: undefined,
  /**
   * DSH 侧没给 `reasoningEffort` 时用哪个思考档位。
   * 留空表示不改写 CodeBuddy 自己的档位（跟随 `thought_level=enabled`）。
   */
  defaultThoughtLevel: undefined,
  /** 模型发现方式：help（解析 `--help` 的模型清单）/ static（内置快照）/ both。 */
  modelDiscovery: 'both',
  /** 覆盖可见模型列表；非空时只显示这些 id（顺序即展示顺序）。 */
  models: undefined,
  /** 是否显示 default-model / fast-model 这类角色档位别名（实测走 ACP 时无效，默认关闭）。 */
  showAliases: false,
  /** 是否合并 `~/.codebuddy/models.json` 与项目级 models.json 里的自定义模型。 */
  useModelsJson: true,
  /** 每个模型声明的上下文窗口（CodeBuddy 不通过 ACP 暴露时使用）。 */
  contextWindow: 200000,
  /** 单次 maxTokens 上限。 */
  maxTokens: 32000,
  /** 首次进入会话时，是否把 DSH 的系统提示词作为前言交给 CodeBuddy。 */
  systemPrompt: 'off',
  /**
   * 是否把 CodeBuddy 的工具调用**完整转换成 DSH 的原生工具调用**：
   * 发真实 `tool-call` 块 + 注册回放工具，于是界面上出现工具卡片与工具结果，
   * 会话里留下 `tool/call` / `tool/result` 事件。
   *
   * 关闭后退回旧行为：工具活动只作为文字播报进推理块。
   */
  toolReplay: true,
  /** 回放工具在 DSH 工具表里的名字。 */
  toolName: 'codebuddy_tool',
  /** tool-call 参数里保留的 rawInput 预算（字符），超出转成预览。 */
  toolInputLimit: 4000,
  /**
   * 什么时候把 CodeBuddy 的工具调用发成 DSH 的 `tool-call` 块：
   *
   * - `settle`（默认）：等 CodeBuddy 把这次调用结算（`completed` / `failed`）再发。
   *   卡片一出现就是终态，不会出现「工具早就跑完了、卡片还挂着执行中」；
   *   多个工具按结算顺序逐个出现，不会一坨堆在一起。
   * - `start`：一看到调用就发。好处是工具在跑的几十秒里界面上有卡片在动，
   *   代价是这张卡片的完成态要等**整轮 ACP 结束**（DSH 只在模型流结束后才执行回放工具），
   *   期间一直显示「执行中」。
   *
   * 只在 `toolCut: 'turn'` 时有意义：`step` 模式必须等结算（否则卡片一出现就是未完成态）。
   */
  toolEmit: 'settle',
  /**
   * 一次 ACP turn 怎么切给 DSH 的 step。
   *
   * - `step`（默认）：**每个工具调用独占一个 step**。DSH 只在一步的模型流结束后才执行
   *   这一步的 `tool-call` 块，所以「一轮 = 一步」会让整轮的工具卡片都挂到轮末才一起结算。
   *   切成多步之后，工具一结算就在自己那一步里落地、当场变成完成态，助手正文也留在它
   *   真正出现的那个位置。step 之间不发任何 ACP 请求，不会多花额度。
   * - `turn`：一轮一个 step（旧行为）。工具卡片要等整轮 ACP 跑完才结算。
   */
  toolCut: 'step',
  /**
   * `toolCut: 'step'` 下，回放工具最多等多久来判断「这条 ACP turn 还有没有后续内容」。
   *
   * 等得到后续内容就继续下一个 step；等不到（已经收口且没有剩余帧）就 `concludeTurn()`
   * 结束这一轮，省掉一次空的 step。超时按「还有」处理，宁可多走一步也不丢内容。
   */
  toolCutWaitMs: 1500,
  /**
   * `session/prompt` 结算之后，还允许多久继续接收同一会话的帧（毫秒）。
   *
   * 实测 CodeBuddy 在 `PromptResponse` 之后仍可能补发帧（最终正文、标题、用量）。
   * 一到结算就关掉通知队列会把它们丢掉，于是「最后那段正文」凭空消失。
   * 这个窗口就是给尾帧留的时间；窗口结束后才真正收口。
   */
  settleGraceMs: 250,
  /** 工具结果在会话里展示的字符上限（完整输出仍保留在工具体里）。 */
  toolOutputLimit: 12000,
  /** 工具活动播报方式（`auto` = 回放模式下关闭）。 */
  toolNarration: 'auto',
  /**
   * 是否把 DSH 消息里的图片**真的发给 CodeBuddy**。
   *
   * 开启时图片作为 ACP `{type:'image',data,mimeType}` 内容块随 `session/prompt` 发出去
   * （实测 CodeBuddy 会真的「看见」，见 README「图片」一节）；
   * 关闭时退回旧行为：正文里只留 `[图片 N：name]` 占位符。
   */
  imageInput: true,
  /** 单张图片的字节上限；超过时由附件服务按需要降质/降尺寸后再发。 */
  maxImageBytes: 5 * 1024 * 1024,
  /** 一次 prompt 最多投递几张图（超出部分只在正文里留标号并注明原因）。 */
  maxImagesPerPrompt: 10,
  /** 重放完整历史时投递哪些图片：`latest`（只投最后一条用户消息）/ `all` / `none`。 */
  replayImages: 'latest',
  /** 是否把 ACP 的 fs 读写代理到 DSH 的文件系统服务（CodeBuddy 的文件工具会走 DSH 沙箱）。 */
  proxyFs: true,
  /** 是否把 ACP 的终端代理到本机（关闭时 CodeBuddy 自己执行命令）。 */
  proxyTerminal: false,
  /** 启动/握手超时（毫秒）。 */
  startupTimeoutMs: 60000,
  /** 单轮 prompt 的墙钟上限，0 表示不限制。 */
  turnTimeoutMs: 0,
  /**
   * 用户中断（Esc）后，等 CodeBuddy 把 `session/prompt` 结算成 `cancelled` 的宽限期（毫秒）。
   *
   * 中断时必须先发 ACP `session/cancel` 通知，让 agent 自己停下模型请求；
   * 不发的后果是它继续烧额度，而且这条 ACP 会话会一直处于「忙」状态。
   * 宽限期过后仍没结算就本地中断，避免界面卡住。0 表示立刻本地中断（只发通知不等回执）。
   */
  cancelGraceMs: 3000,
  /** 进程退出宽限期（毫秒）。 */
  disposeGraceMs: 3000,
  /** 额外环境变量。 */
  env: {},
  /** 诊断日志级别：silent / warn / info。 */
  logLevel: 'warn',
})

/**
 * 校验字符串字段。
 * @param {string} prefix 诊断前缀。
 * @param {string} field 字段名。
 * @param {unknown} value 配置值。
 * @returns {string} 去空白后的字符串。
 */
function requireNonEmptyString(prefix, field, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${prefix}: ${field} 必须是非空字符串`)
  }
  return value.trim()
}

/**
 * 校验非负整数。
 * @param {string} prefix 诊断前缀。
 * @param {string} field 字段名。
 * @param {unknown} value 配置值。
 * @returns {number} 校验通过的值。
 */
function requireNonNegativeInteger(prefix, field, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${prefix}: ${field} 必须是非负整数`)
  }
  return value
}

/**
 * 校验正有限数。
 * @param {string} prefix 诊断前缀。
 * @param {string} field 字段名。
 * @param {unknown} value 配置值。
 * @returns {number} 校验通过的值。
 */
function requirePositiveFinite(prefix, field, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${prefix}: ${field} 必须是正有限数`)
  }
  return value
}

/**
 * 归一化配置。
 * @param {Record<string, unknown> | undefined} raw Loader 行配置。
 * @returns {typeof DEFAULT_CONFIG & { env: Record<string, string> }} 生效配置。
 */
export function resolveConfig(raw) {
  const prefix = 'dsh-codebuddy-acp'
  const merged = { ...DEFAULT_CONFIG, ...(raw ?? {}) }

  const provider = requireNonEmptyString(prefix, 'provider', merged.provider)
  const displayName = requireNonEmptyString(prefix, 'displayName', merged.displayName)
  const command = requireNonEmptyString(prefix, 'command', merged.command)

  if (!PERMISSION_MODES.includes(merged.permissionMode)) {
    throw new Error(`${prefix}: permissionMode 必须是 ${PERMISSION_MODES.join(' / ')} 之一`)
  }
  if (!PERMISSION_POLICIES.includes(merged.permissionPolicy)) {
    throw new Error(`${prefix}: permissionPolicy 必须是 ${PERMISSION_POLICIES.join(' / ')} 之一`)
  }
  if (!PERMISSION_FALLBACKS.includes(merged.permissionAskFallback)) {
    throw new Error(`${prefix}: permissionAskFallback 必须是 ${PERMISSION_FALLBACKS.join(' / ')} 之一`)
  }
  if (typeof merged.syncTitle !== 'boolean') {
    throw new Error(`${prefix}: syncTitle 必须是布尔值`)
  }
  if (typeof merged.syncPlan !== 'boolean') {
    throw new Error(`${prefix}: syncPlan 必须是布尔值`)
  }
  if (!NARRATION_ALL.includes(merged.toolNarration)) {
    throw new Error(`${prefix}: toolNarration 必须是 ${NARRATION_ALL.join(' / ')} 之一`)
  }
  if (merged.toolEmit !== 'start' && merged.toolEmit !== 'settle') {
    throw new Error(`${prefix}: toolEmit 必须是 start / settle 之一`)
  }
  if (merged.toolCut !== 'step' && merged.toolCut !== 'turn') {
    throw new Error(`${prefix}: toolCut 必须是 step / turn 之一`)
  }
  if (typeof merged.toolReplay !== 'boolean') {
    throw new Error(`${prefix}: toolReplay 必须是布尔值`)
  }
  if (typeof merged.imageInput !== 'boolean') {
    throw new Error(`${prefix}: imageInput 必须是布尔值`)
  }
  if (!REPLAY_IMAGE_MODES.includes(merged.replayImages)) {
    throw new Error(`${prefix}: replayImages 必须是 ${REPLAY_IMAGE_MODES.join(' / ')} 之一`)
  }
  if (typeof merged.toolName !== 'string' || !TOOL_NAME_PATTERN.test(merged.toolName)) {
    throw new Error(`${prefix}: toolName 必须是合法工具名（字母或下划线开头，仅含字母数字下划线连字符）`)
  }
  if (!['help', 'static', 'both', 'off'].includes(merged.modelDiscovery)) {
    throw new Error(`${prefix}: modelDiscovery 必须是 help / static / both / off 之一`)
  }
  if (!['off', 'append', 'full'].includes(merged.systemPrompt)) {
    throw new Error(`${prefix}: systemPrompt 必须是 off / append / full 之一`)
  }
  if (!['silent', 'warn', 'info'].includes(merged.logLevel)) {
    throw new Error(`${prefix}: logLevel 必须是 silent / warn / info 之一`)
  }
  if (!Array.isArray(merged.args) || merged.args.some((item) => typeof item !== 'string')) {
    throw new Error(`${prefix}: args 必须是字符串数组`)
  }
  if (merged.models !== undefined && merged.models !== null
    && (!Array.isArray(merged.models) || merged.models.some((item) => typeof item !== 'string' || item.trim() === ''))) {
    throw new Error(`${prefix}: models 必须是非空字符串数组（或省略）`)
  }
  if (merged.defaultThoughtLevel !== undefined && merged.defaultThoughtLevel !== null
    && merged.defaultThoughtLevel !== ''
    && !THOUGHT_LEVELS.includes(merged.defaultThoughtLevel)) {
    throw new Error(`${prefix}: defaultThoughtLevel 必须是 ${THOUGHT_LEVELS.join(' / ')} 之一（或省略）`)
  }
  if (typeof merged.env !== 'object' || Array.isArray(merged.env)) {
    throw new Error(`${prefix}: env 必须是字符串字典`)
  }
  const authMethod = requireNonEmptyString(prefix, 'authMethod', merged.authMethod)

  return {
    ...merged,
    provider,
    displayName,
    command,
    authMethod,
    billingAuthFile: typeof merged.billingAuthFile === 'string' && merged.billingAuthFile.trim() !== ''
      ? merged.billingAuthFile.trim()
      : undefined,
    authTimeoutMs: requirePositiveFinite(prefix, 'authTimeoutMs', merged.authTimeoutMs),
    nodePath: typeof merged.nodePath === 'string' && merged.nodePath.trim() !== ''
      ? merged.nodePath.trim()
      : undefined,
    defaultModel: typeof merged.defaultModel === 'string' && merged.defaultModel.trim() !== ''
      ? merged.defaultModel.trim()
      : undefined,
    defaultThoughtLevel: typeof merged.defaultThoughtLevel === 'string' && merged.defaultThoughtLevel.trim() !== ''
      ? merged.defaultThoughtLevel.trim()
      : undefined,
    models: Array.isArray(merged.models) ? merged.models.map((item) => item.trim()) : undefined,
    contextWindow: requirePositiveFinite(prefix, 'contextWindow', merged.contextWindow),
    maxTokens: requirePositiveFinite(prefix, 'maxTokens', merged.maxTokens),
    toolInputLimit: requirePositiveFinite(prefix, 'toolInputLimit', merged.toolInputLimit),
    toolOutputLimit: requirePositiveFinite(prefix, 'toolOutputLimit', merged.toolOutputLimit),
    toolCutWaitMs: requireNonNegativeInteger(prefix, 'toolCutWaitMs', merged.toolCutWaitMs),
    settleGraceMs: requireNonNegativeInteger(prefix, 'settleGraceMs', merged.settleGraceMs),
    maxImageBytes: requirePositiveFinite(prefix, 'maxImageBytes', merged.maxImageBytes),
    maxImagesPerPrompt: requireNonNegativeInteger(prefix, 'maxImagesPerPrompt', merged.maxImagesPerPrompt),
    startupTimeoutMs: requirePositiveFinite(prefix, 'startupTimeoutMs', merged.startupTimeoutMs),
    turnTimeoutMs: requireNonNegativeInteger(prefix, 'turnTimeoutMs', merged.turnTimeoutMs),
    cancelGraceMs: requireNonNegativeInteger(prefix, 'cancelGraceMs', merged.cancelGraceMs),
    disposeGraceMs: requirePositiveFinite(prefix, 'disposeGraceMs', merged.disposeGraceMs),
    env: Object.fromEntries(Object.entries(merged.env).map(([key, value]) => [key, String(value)])),
    narrationModes: NARRATION_MODES,
    thoughtLevels: THOUGHT_LEVELS,
  }
}
