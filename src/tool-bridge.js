/**
 * CodeBuddy(ACP) 工具调用的「结果桥」。
 *
 * 为什么需要这座桥：
 *
 * - CodeBuddy 的 agent 循环在**它自己的进程里**执行工具。ACP 只把过程作为
 *   `session/update` 通知告诉客户端（`tool_call` / `tool_call_update`），客户端
 *   **无法代替它执行**，也没有「把结果塞回去」的通道。
 * - DSH 的会话里想看到**真的工具卡片**（`tool/call` + `tool/result` 事件），
 *   就必须由 DSH 自己走一遍工具执行管线：模型消息里出现 `tool-call` 块 →
 *   agent loop 调 `tools.execute()` → 落 `tool/call`/`tool/result`。
 *
 * 于是这里的分工是：
 *
 *   适配器（流式）  ──收到 ACP 通知──▶  ToolCallBridge（按 callId 记账）
 *                                            │
 *   DSH 执行回放工具 ──按 callId 取账──────────┘
 *
 * 回放工具拿到的是**CodeBuddy 已经执行完的真实结果**，它只负责把结果原样交回
 * 并 `concludeTurn()` 结束这一轮，因此不会重复执行、也不会多跑一次模型。
 *
 * @module src/tool-bridge.js
 */

/** ACP `tool_call.kind` 的取值（ACP 规范里还有 switch_mode 等，统一归到 other）。 */
export const TOOL_KINDS = Object.freeze([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'think', 'other',
])

/** ACP `tool_call.status` 的取值。 */
export const TOOL_STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'failed'])

/** 单条工具输出保留的最大字符数（超出截断，避免一轮会话被几十 MB 输出撑爆）。 */
const DEFAULT_OUTPUT_LIMIT = 200_000

/** 桥内最多同时保留多少条工具记录（超出按最旧淘汰）。 */
const DEFAULT_MAX_RECORDS = 400

/** 记录保留多久（毫秒）。DSH 在流结束后立刻执行回放工具，这里只是兜底回收。 */
const DEFAULT_TTL_MS = 15 * 60 * 1000

/** 看起来像路径的特征（带分隔符，或「名字.扩展名」）。 */
const PATH_LIKE = /[\\/]|^[^\s]+\.\w{1,8}$/

/**
 * 把未知值收敛成一句话（保留换行）。
 * @param {unknown} value 任意值。
 * @returns {string} 文本。
 */
function toText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return String(value)
}

/**
 * 从 ACP 更新里提取可读的工具输出。
 *
 * 实测 CodeBuddy 的结构是 `rawOutput: { type:'text', text }` 与
 * `content: [{ type:'content', content:{ type:'text', text } }]`，两者内容一致；
 * `rawOutput` 更干净，优先用它。
 *
 * @param {object} update ACP 更新。
 * @returns {string} 纯文本输出。
 */
export function toolOutputText(update) {
  const fromRaw = update?.rawOutput
  if (fromRaw !== null && typeof fromRaw === 'object') {
    if (typeof fromRaw.text === 'string' && fromRaw.text !== '') return fromRaw.text
    if (typeof fromRaw.content === 'string' && fromRaw.content !== '') return fromRaw.content
  }
  if (typeof fromRaw === 'string' && fromRaw !== '') return fromRaw
  const list = Array.isArray(update?.content) ? update.content : []
  const parts = []
  for (const item of list) {
    const inner = item?.content ?? item
    if (inner !== null && typeof inner === 'object' && typeof inner.text === 'string') parts.push(inner.text)
    else if (typeof inner === 'string') parts.push(inner)
    else if (inner !== null && typeof inner === 'object' && inner.type === 'diff') parts.push(diffText(inner))
  }
  return parts.join('\n').trim()
}

/**
 * 把 ACP 的 diff 内容块渲染成一段可读文本（新增/删除行前缀）。
 * @param {object} diff ACP `{ type:'diff', path, oldText, newText }`。
 * @returns {string} 文本。
 */
function diffText(diff) {
  const path = typeof diff.path === 'string' ? diff.path : '文件'
  const oldText = typeof diff.oldText === 'string' ? diff.oldText : ''
  const newText = typeof diff.newText === 'string' ? diff.newText : ''
  const removed = oldText === '' ? [] : oldText.split('\n')
  const added = newText === '' ? [] : newText.split('\n')
  const lines = [`--- ${path}`, ...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)]
  return lines.join('\n')
}

/**
 * 把 `title` 拆成「工具名 + 主语」。
 *
 * 实测 CodeBuddy 的 title 形如 `Read`、`Read C:\a\b.txt`、`Bash ls -la`、
 * `Edit src/a.js`。首词是工具名，其余部分是这次调用的主语（路径/命令）。
 *
 * @param {string} title ACP title。
 * @returns {{ tool: string, subject: string }} 拆分结果。
 */
function splitTitle(title) {
  const flat = String(title).replace(/\s+/g, ' ').trim()
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(flat)
  if (match === null) return { tool: 'Tool', subject: '' }
  return { tool: match[1], subject: (match[2] ?? '').trim() }
}

/**
 * 从 rawInput 里挑出「这次调用指向哪里」（路径 / 命令），给 UI 做跟随与摘要。
 * @param {object | undefined} rawInput ACP rawInput。
 * @returns {{ path?: string, line?: number, command?: string }} 定位信息。
 */
function locate(rawInput) {
  const result = {}
  if (rawInput === null || typeof rawInput !== 'object') return result
  const pathKeys = ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'notebook_path']
  for (const key of pathKeys) {
    const value = rawInput[key]
    if (typeof value === 'string' && value.trim() !== '') {
      result.path = value.trim()
      break
    }
  }
  const commandKeys = ['command', 'cmd', 'script']
  for (const key of commandKeys) {
    const value = rawInput[key]
    if (typeof value === 'string' && value.trim() !== '') {
      result.command = value.trim()
      break
    }
  }
  const lineKeys = ['line', 'offset', 'start_line', 'startLine']
  for (const key of lineKeys) {
    const value = rawInput[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      result.line = Math.floor(value)
      break
    }
  }
  return result
}

/**
 * @typedef {object} ToolCallRecord
 * @property {string} callId ACP toolCallId（也就是 DSH 的 toolCallId）。
 * @property {string} title 人类可读标题（CodeBuddy 原样）。
 * @property {string} tool 工具名（title 首词）。
 * @property {string} subject title 去掉首词后的主语。
 * @property {string} kind ACP kind（归一化到 {@link TOOL_KINDS}）。
 * @property {string} status ACP status。
 * @property {object | undefined} rawInput 原始参数。
 * @property {string | undefined} path 调用目标路径。
 * @property {number | undefined} line 目标行号。
 * @property {string | undefined} command 调用命令。
 * @property {string} output 工具输出（已截断）。
 * @property {boolean} outputTruncated 输出是否被截断。
 * @property {string | undefined} error 失败原因。
 * @property {number} createdAt 首次见到的时间戳。
 * @property {number} updatedAt 最近一次更新的时间戳。
 */

export class ToolCallBridge {
  /** @type {Map<string, ToolCallRecord>} callId → 记录（插入顺序即时间顺序）。 */
  #records = new Map()

  /**
   * @param {object} [options] 选项。
   * @param {{ warn?: Function }} [options.logger] 日志器。
   * @param {number} [options.ttlMs] 记录保留时长。
   * @param {number} [options.maxRecords] 最多保留条数。
   * @param {number} [options.outputLimit] 单条输出截断长度。
   */
  constructor({ logger, ttlMs, maxRecords, outputLimit } = {}) {
    this.logger = logger
    /**
     * 回放工具是否已经注册成功。
     *
     * 这是「能不能发 tool-call 块」的硬前提：块一旦发出去，DSH 就会去执行同名工具，
     * 没注册就是 UNKNOWN_TOOL。所以注册成功才置 true，卸载时置回 false。
     */
    this.ready = false
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS
    this.maxRecords = Number.isFinite(maxRecords) && maxRecords > 0 ? maxRecords : DEFAULT_MAX_RECORDS
    this.outputLimit = Number.isFinite(outputLimit) && outputLimit > 0 ? outputLimit : DEFAULT_OUTPUT_LIMIT
    /**
     * 「这条调用所属的 ACP turn 还有没有后续内容」的探针，由适配器注入。
     *
     * 回放工具需要它来决定是不是 `concludeTurn()`：还有内容就必须让 DSH 进入下一个 step，
     * 否则那些内容（正文/下一个工具）会永远没人取走。
     *
     * @type {((callId: string) => { whenMore: (timeoutMs: number) => Promise<'more' | 'done' | 'unknown'> } | undefined) | undefined}
     */
    this.liveProbe = undefined
  }

  /**
   * 注入续段探针（适配器在构造时调用一次）。
   * @param {(callId: string) => object | undefined} probe 探针。
   */
  setLiveProbe(probe) {
    this.liveProbe = probe
  }

  /**
   * 问「这次工具调用之后，ACP turn 还有没有内容要交给 DSH」。
   *
   * @param {string} callId 工具调用 id。
   * @param {number} timeoutMs 最多等多久（毫秒）。
   * @returns {Promise<'more' | 'done' | 'unknown' | undefined>} 判断结果；
   *   `undefined` 表示没有探针（兼容模式，调用方按旧规则处理）。
   */
  async continuationOf(callId, timeoutMs) {
    if (this.liveProbe === undefined) return undefined
    const live = this.liveProbe(callId)
    if (live === undefined) return undefined
    return await live.whenMore(timeoutMs)
  }

  /**
   * 收到 `tool_call`（同一 id 可能来两次：先 `kind=other` 的占位，再带路径的完整版）。
   * @param {object} update ACP 更新。
   * @returns {ToolCallRecord} 合并后的记录。
   */
  begin(update) {
    const callId = typeof update?.toolCallId === 'string' && update.toolCallId !== ''
      ? update.toolCallId
      : `cb-${this.#records.size + 1}-${Date.now()}`
    const existing = this.#records.get(callId)
    const record = existing ?? this.#create(callId)
    this.#absorb(record, update)
    // 第二次 `tool_call` 是标题补全：长标题更可信，不要被短的覆盖。
    if (existing !== undefined && typeof update?.title === 'string' && update.title.trim() !== ''
      && update.title.trim().length > existing.title.length) {
      this.#applyTitle(record, update.title)
    }
    this.#touch(record)
    return record
  }

  /**
   * 收到 `tool_call_update`：状态、输出、标题、kind 都可能变。
   * @param {object} update ACP 更新。
   * @returns {ToolCallRecord | undefined} 记录（未知 id 时登记一条）。
   */
  settle(update) {
    const callId = typeof update?.toolCallId === 'string' ? update.toolCallId : ''
    if (callId === '') return undefined
    const record = this.#records.get(callId) ?? this.#create(callId)
    this.#absorb(record, update)
    if (typeof update.title === 'string' && update.title.trim() !== '') this.#applyTitle(record, update.title)
    this.#touch(record)
    return record
  }

  /**
   * 按 callId 取记录（回放工具执行时调用）。
   * @param {string} callId 调用 id。
   * @returns {ToolCallRecord | undefined} 记录。
   */
  read(callId) {
    return this.#records.get(callId)
  }

  /** 清空全部记录（插件卸载或账号切换时）。 */
  clear() {
    this.#records.clear()
  }

  /** @returns {number} 当前记录数。 */
  get size() {
    return this.#records.size
  }

  /**
   * 新建一条空记录。
   * @param {string} callId 调用 id。
   * @returns {ToolCallRecord} 记录。
   */
  #create(callId) {
    const now = Date.now()
    /** @type {ToolCallRecord} */
    const record = {
      callId,
      title: '工具调用',
      tool: 'Tool',
      subject: '',
      kind: 'other',
      status: 'pending',
      rawInput: undefined,
      path: undefined,
      line: undefined,
      command: undefined,
      output: '',
      outputTruncated: false,
      error: undefined,
      createdAt: now,
      updatedAt: now,
    }
    this.#records.set(callId, record)
    this.#evict()
    return record
  }

  /**
   * 吸收一条 ACP 更新里的公共字段。
   * @param {ToolCallRecord} record 记录。
   * @param {object} update ACP 更新。
   */
  #absorb(record, update) {
    if (update === null || typeof update !== 'object') return
    if (typeof update.title === 'string' && record.subject === '' && String(record.title) === '工具调用') {
      this.#applyTitle(record, update.title)
    }
    if (typeof update.kind === 'string' && update.kind !== 'other') {
      record.kind = TOOL_KINDS.includes(update.kind) ? update.kind : 'other'
    }
    if (typeof update.status === 'string' && TOOL_STATUSES.includes(update.status)) {
      record.status = update.status
    }
    if (update.rawInput !== null && typeof update.rawInput === 'object') {
      record.rawInput = mergeInput(record.rawInput, update.rawInput)
      const located = locate(record.rawInput)
      if (located.path !== undefined) record.path = located.path
      if (located.line !== undefined) record.line = located.line
      if (located.command !== undefined) record.command = located.command
    }
    const locations = Array.isArray(update.locations) ? update.locations : []
    if (record.path === undefined && locations.length > 0 && typeof locations[0]?.path === 'string') {
      record.path = locations[0].path
      if (typeof locations[0].line === 'number' && locations[0].line > 0) record.line = Math.floor(locations[0].line)
    }
    const output = toolOutputText(update)
    if (output !== '') this.#applyOutput(record, output)
    if (update.status === 'failed') {
      const reason = toText(update.error?.['codebuddy.ai/detail'] ?? update.error ?? update.rawOutput?.text)
      record.error = reason === '' ? '工具执行失败' : reason
    }
    // 有些工具只在 title 里给路径（没有 rawInput）：从主语里补一次。
    if (record.path === undefined && record.subject !== '' && PATH_LIKE.test(record.subject)) {
      record.path = record.subject
    }
  }

  /**
   * 写入标题并同步派生字段。
   * @param {ToolCallRecord} record 记录。
   * @param {string} title 新标题。
   */
  #applyTitle(record, title) {
    const flat = String(title).replace(/\s+/g, ' ').trim()
    if (flat === '') return
    record.title = flat
    // 实测 Bash 的标题是 `` `命令` ``（整体反引号包住），此时主语就是整条命令。
    const quoted = /^`([\s\S]*)`$/.exec(flat)
    if (quoted !== null) {
      const { tool } = splitTitle(quoted[1])
      record.tool = tool
      record.subject = quoted[1].trim()
      return
    }
    const { tool, subject } = splitTitle(flat)
    record.tool = tool.replace(/^`+|`+$/g, '') || tool
    record.subject = subject
  }

  /**
   * 写入工具输出（超长截断）。
   * @param {ToolCallRecord} record 记录。
   * @param {string} output 输出文本。
   */
  #applyOutput(record, output) {
    if (output.length > this.outputLimit) {
      record.output = `${output.slice(0, this.outputLimit)}\n…（输出共 ${output.length} 字符，已截断）`
      record.outputTruncated = true
      return
    }
    record.output = output
    record.outputTruncated = false
  }

  /**
   * 更新时间戳。
   * @param {ToolCallRecord} record 记录。
   */
  #touch(record) {
    record.updatedAt = Date.now()
  }

  /** 按条数与 TTL 淘汰旧记录。 */
  #evict() {
    if (this.#records.size <= this.maxRecords) {
      this.#pruneExpired()
      return
    }
    for (const [callId, record] of this.#records) {
      if (this.#records.size <= this.maxRecords) break
      // 只淘汰已经结算过的记录，避免把正要执行的调用扔掉。
      if (record.status === 'completed' || record.status === 'failed') this.#records.delete(callId)
    }
    this.#pruneExpired()
  }

  /** 删除超过 TTL 的记录。 */
  #pruneExpired() {
    if (this.#records.size === 0) return
    const deadline = Date.now() - this.ttlMs
    for (const [callId, record] of this.#records) {
      if (record.updatedAt < deadline) this.#records.delete(callId)
    }
  }
}

/**
 * 合并两次 rawInput（CodeBuddy 会**增量**下发参数）。
 * @param {object | undefined} previous 旧值。
 * @param {object} next 新值。
 * @returns {object} 合并结果。
 */
function mergeInput(previous, next) {
  return { ...(previous ?? {}), ...next }
}
