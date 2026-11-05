/**
 * 回放工具：让 CodeBuddy 的工具调用在 DSH 里成为**真的工具卡片**。
 *
 * 适配器在模型流里发出 `tool-call` 块后，DSH 的 agent loop 会照常执行这个工具。
 * 本工具不真的干活——它按 `toolCallId` 去 {@link ToolCallBridge} 里取
 * **CodeBuddy 已经执行完的真实结果**，原样交回，然后 `concludeTurn()` 结束这一轮。
 *
 * 因此这里的三条硬约束：
 *
 * 1. **不能重复执行**：工具体内不允许产生任何副作用；
 * 2. **必须结束这一轮**：否则 DSH 会带着工具结果再问一次模型，白烧一次额度；
 * 3. **只在 CodeBuddy 步骤可见**：注册时用 `when` 按 `modelSelection.provider` 过滤，
 *    换成别的模型时它不会出现在工具表和请求里。
 *
 * @module src/tools.js
 */

import { TOOL_KINDS, TOOL_STATUSES } from './tool-bridge.js'

/** 结果里展示的输出上限（字符），超出截断；完整输出仍留在会话的工具体里。 */
const DEFAULT_RESULT_LIMIT = 12000

/** 「这条 ACP turn 还有没有后续内容」的默认等待上限（毫秒）。 */
const DEFAULT_CONTINUATION_WAIT_MS = 1500

/** 状态 → 结果标记。 */
const STATUS_MARKS = Object.freeze({
  completed: '✓',
  failed: '✗',
  pending: '·',
  in_progress: '·',
})

/**
 * 构造工具的输入 JSON Schema。
 *
 * 注意：这里必须是**标准 JSON Schema**（`required` 是字符串数组），因为本包不 import
 * `@deepseek-ai/dsh-tools`，无法使用它的 `defineTool` spec 方言。
 *
 * @returns {object} JSON Schema。
 */
function inputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: { type: 'string', description: '这次调用的人类可读标题（CodeBuddy 的 tool_call.title）' },
      kind: { type: 'string', enum: [...TOOL_KINDS] },
      tool: { type: 'string' },
      callId: { type: 'string' },
      status: { type: 'string', enum: [...TOOL_STATUSES] },
      path: { type: 'string' },
      line: { type: 'integer' },
      command: { type: 'string' },
      input: { type: 'object', additionalProperties: true },
    },
  }
}

/**
 * 构造工具的输出 JSON Schema。
 * @returns {object} JSON Schema。
 */
function outputSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    required: ['status', 'title', 'output'],
    properties: {
      status: { type: 'string' },
      title: { type: 'string' },
      kind: { type: 'string' },
      output: { type: 'string' },
      truncated: { type: 'boolean' },
      path: { type: 'string' },
      line: { type: 'integer' },
      error: { type: 'string' },
    },
  }
}

/**
 * 把工具记录压成模型/界面都能读的一段文本。
 * @param {object} args 调用参数。
 * @param {object} value 规范化输出值。
 * @returns {object[]} content 块。
 */
function renderResult(args, value) {
  const mark = STATUS_MARKS[value.status] ?? '·'
  const header = `${mark} ${value.title}`
  const sections = [header]
  if (typeof value.error === 'string' && value.error !== '') sections.push(`失败原因：${value.error}`)
  if (typeof value.output === 'string' && value.output !== '') sections.push(value.output)
  return [{ type: 'text', text: sections.join('\n\n') }]
}

/**
 * 从参数里推出「这次调用指向哪个文件」，用于 UI 跟随。
 * @param {object} args 调用参数。
 * @returns {object[] | undefined} 位置数组。
 */
function locationsOf(args) {
  if (typeof args?.path !== 'string' || args.path === '') return undefined
  const location = { path: args.path }
  if (Number.isFinite(args.line) && args.line > 0) location.line = Math.floor(args.line)
  return [location]
}

/**
 * 注册回放工具。
 *
 * @param {object} options 参数。
 * @param {object} options.ctx Host 上下文（需要 `tools` 服务）。
 * @param {import('./tool-bridge.js').ToolCallBridge} options.bridge 结果桥。
 * @param {object} options.config 生效配置。
 * @param {{ warn: Function, info: Function }} options.logger 日志器。
 * @returns {() => void} 反注册函数。
 */
export function registerReplayTool({ ctx, bridge, config, logger }) {
  const resultLimit = Number.isFinite(config.toolOutputLimit) && config.toolOutputLimit > 0
    ? config.toolOutputLimit
    : DEFAULT_RESULT_LIMIT
  // 「还有没有后续内容」最多等这么久：等得到就继续下一步，等不到就收口本轮。
  const continuationWaitMs = Number.isFinite(config.toolCutWaitMs) && config.toolCutWaitMs >= 0
    ? config.toolCutWaitMs
    : DEFAULT_CONTINUATION_WAIT_MS

  const definition = {
    name: config.toolName,
    description:
      '由 dsh-codebuddy-acp 注入的**回放工具**：代表 CodeBuddy(ACP) 在自己进程里已经执行完的一次工具调用，'
      + '把真实结果带回 DSH 会话。模型不应主动调用它；它只在选中 CodeBuddy 模型的那一步可见，'
      + '执行时不产生任何副作用，并结束当前轮次。',
    parameters: inputSchema(),
    output: {
      schema: outputSchema(),
      render: renderResult,
      presentationMeta(args, value) {
        const meta = { kind: value.kind, status: value.status, title: value.title }
        if (typeof value.path === 'string' && value.path !== '') meta.path = value.path
        if (Number.isFinite(value.line) && value.line > 0) meta.line = Math.floor(value.line)
        return meta
      },
    },
    timeoutMs: 15000,
    isConcurrencySafe() {
      // 只读桥里的记录，不碰共享可写状态。
      return true
    },
    async execute(args, exec) {
      const callId = typeof args?.callId === 'string' && args.callId !== '' ? args.callId : undefined
      const record = callId === undefined ? undefined : bridge.read(callId)
      // 回放工具本身没有副作用，是否结束本轮取决于「这条 ACP turn 后面还有没有东西要交」：
      //
      // - **还有内容**（`toolCut: 'step'` 下剩下的思考/正文/下一个工具帧）：不结束本轮，
      //   DSH 会照常进入下一个 step，适配器接着把剩余内容交出来。
      // - **确认没有了**（`done`：ACP turn 已收口且队列已空）：立刻结束本轮，省掉一次空的 step。
      // - **不确定**（`unknown`：等超时了）：按「还有」处理——宁可多走一步，也不能把
      //   CodeBuddy 还在生成的最终正文丢掉。
      //
      // 兼容模式（`toolCut: 'turn'`）继续用记录上的 `holdAnswer`：那一轮还有正文攒着，
      // 要让 DSH 再走一步才收得到。
      const more = await bridge.continuationOf(callId, continuationWaitMs)
      if (more === undefined) {
        if (record?.holdAnswer !== true) exec.concludeTurn()
      } else if (more === 'done') {
        exec.concludeTurn()
      }
      if (record === undefined) {
        logger.warn?.(`dsh-codebuddy-acp: 回放工具没找到 callId=${String(callId)} 的记录（可能已被回收）`)
        return {
          status: args?.status === 'failed' ? 'failed' : 'unknown',
          title: typeof args?.title === 'string' ? args.title : '工具调用',
          kind: typeof args?.kind === 'string' ? args.kind : 'other',
          output: '（这次调用由 CodeBuddy 在它自己的进程里执行，DSH 侧没有取到结果）',
        }
      }
      const output = record.output.length > resultLimit
        ? `${record.output.slice(0, resultLimit)}\n…（输出共 ${record.output.length} 字符，已截断）`
        : record.output
      // 只认 completed / failed；其余（既没结果也没失败）说明 CodeBuddy 被中断了，
      // 不能让它一直挂着「执行中」——换成 incomplete 并说明原因。
      const settled = record.status === 'completed' || record.status === 'failed'
      const value = {
        status: settled ? record.status : 'incomplete',
        title: record.title,
        kind: record.kind,
        output: settled
          ? output
          : (output === '' ? '（CodeBuddy 没有回报这次工具调用的结果：可能被取消或中断）' : output),
        truncated: record.outputTruncated || output.length < record.output.length,
      }
      if (record.path !== undefined) value.path = record.path
      if (record.line !== undefined) value.line = record.line
      if (record.error !== undefined) value.error = record.error
      return value
    },
    presentCall(args) {
      const view = {
        card: 'generic',
        title: typeof args?.title === 'string' ? args.title : 'CodeBuddy 工具调用',
        kind: TOOL_KINDS.includes(args?.kind) ? args.kind : 'other',
      }
      const locations = locationsOf(args)
      if (locations !== undefined) view.locations = locations
      if (args?.input !== undefined) view.rawInput = args.input
      return view
    },
    presentResult(args, result) {
      const title = typeof args?.title === 'string' ? args.title : 'CodeBuddy 工具调用'
      return { card: 'generic', title, content: result.content }
    },
  }

  const dispose = ctx.tools.register(definition, {
    // 只有「这一轮的模型是 CodeBuddy」时才让这个工具进入工具表与请求头。
    when: ({ modelSelection }) => modelSelection?.provider === config.provider,
  })
  bridge.ready = true
  logger.info?.(`dsh-codebuddy-acp: 已注册回放工具 "${config.toolName}"（provider=${config.provider} 时启用）`)
  return () => {
    bridge.ready = false
    dispose()
  }
}
