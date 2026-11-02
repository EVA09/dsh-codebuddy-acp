/**
 * 把 CodeBuddy CLI（ACP）适配成 DSH 的 LLM 适配器。
 *
 * 语义映射是这个文件的核心，先把它说清楚：
 *
 * - **一个 CodeBuddy 进程（每个工作目录一个）= 一条 ACP 连接**，连接里可以开多条 ACP 会话；
 *   一条 DSH 会话就对应其中一条 ACP 会话。之所以共享进程，是因为
 *   `initialize`(≈1.6s) + `authenticate`(≈10s) 的固定开销太大，按会话起进程不可接受。
 * - **一次 `stream()` = CodeBuddy 自己跑完一轮 agent 循环**。它有工具、权限、沙箱，
 *   所以这里**不把 DSH 的工具表交给它**，也不产出 `tool-call` 块，让它原生产出最终答复。
 * - **增量投喂**：DSH 每一步都会重发整段历史，这里比对「已转发消息签名」，只把新增的
 *   用户消息发给已在运行的 ACP 会话；前缀对不上（压缩、回滚）才重放全部历史。
 * - **换模型不重开会话**：走 `session/set_config_option {configId:'model'}`（带校验），
 *   对话上下文因此得以保留；只有切到账号不可用的模型才会退化成「新开 ACP 会话 + 重放历史」。
 * - **用量来自 `usage_update` 通知**：`session/prompt` 的结果里没有 usage 字段。
 *
 * 协议事实来自 `docs/acp-findings.md`（本机实测，v2.177.1）。
 *
 * @module src/adapter.js
 */

import { AcpConnection, AcpError } from './acp.js'
import {
  OFFLOADED_IMAGE_TEXT,
  collectImageRefs,
  imageMarker,
  imageRefOf,
  selectImageIndexes,
} from './image-input.js'
import { toolOutputText } from './tool-bridge.js'
import {
  buildCatalog,
  describeEfforts,
  effortsForModel,
  formatCreditRate,
  friendlyModelName,
  parseCreditRate,
} from './models.js'

/** 客户端身份（会出现在 CodeBuddy 日志里）。 */
const CLIENT_INFO = Object.freeze({ name: 'dsh-codebuddy-acp', version: '0.5.0' })

/** 同时保留的空闲连接上限。 */
const MAX_IDLE_CONNECTIONS = 4

/** 空闲连接回收时间（毫秒）。 */
const IDLE_TTL_MS = 30 * 60 * 1000

/**
 * 32 位字符串散列，用于快速比对消息前缀。
 * @param {string} text 输入文本。
 * @returns {string} 十六进制散列。
 */
function hashString(text) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}`
}

/**
 * 把消息内容块压成纯文本（图片/文件降级为占位符）。
 *
 * 图片**不再是**一段无信息的 `[图片附件：name]`：真正的字节会由
 * {@link CodeBuddyAdapter#deliverImages} 读出来、作为 ACP image 内容块随 prompt 发出去，
 * 这里只负责在正文里留一个**带编号**的标号，让模型知道「第 N 张图对应哪句话」。
 * 没能发出去的图（没有图片服务、读取失败、超过本次上限）会在标号后面注明原因。
 *
 * @param {readonly object[] | undefined} content 内容块数组。
 * @param {Map<string, string>} [notes] 图片附注（attachmentId → 未投递原因）。
 * @param {object[]} [images] 传出参数：按渲染顺序收集到的图片引用。
 * @returns {string} 纯文本。
 */
function contentToText(content, notes, images) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        parts.push(typeof block.text === 'string' ? block.text : '')
        break
      case 'reasoning':
        // 别人的思考过程不回灌：它会被当成用户输入。
        break
      case 'image': {
        if (block.offloaded === true) {
          parts.push(OFFLOADED_IMAGE_TEXT)
          break
        }
        // 只有「可投递」的图才占编号：ACP 没有通路（例如 svg）或引用残缺时，
        // 它不该出现在投递顺序里，否则正文标号与 prompt 里的 image 块会错位。
        const ref = imageRefOf(block)
        if (ref === undefined) {
          parts.push(imageMarker(block.attachment, undefined, '未发送：不是可投递的位图格式'))
          break
        }
        if (images !== undefined) images.push(ref)
        const note = notes?.get(ref.attachmentId)
        parts.push(imageMarker(ref, images === undefined ? undefined : images.length, note))
        break
      }
      case 'file':
        parts.push(`[文件附件${typeof block.attachment?.name === 'string' ? `：${block.attachment.name}` : ''}]`)
        break
      case 'tool-call':
        // 回放工具的调用/结果是我们自己写进会话的（CodeBuddy 早已执行过），
        // 不要再拼成文本喂回给它，否则它会以为还有一批工具要重复执行。
        break
      default:
        if (typeof block.text === 'string') parts.push(block.text)
        break
    }
  }
  const joined = parts.join('\n')
  return joined.trim() === '' ? '' : joined
}

/**
 * 计算一条消息的签名。
 *
 * 图片要按**引用身份**参与签名：只看文本的话，同一句话换一张截图（甚至同一张图重新上传）
 * 算出来的签名一模一样，适配器会认为「这条消息已经转发过」而不把新图发过去。
 *
 * @param {object} message 请求消息。
 * @returns {string} 签名。
 */
function signatureOf(message) {
  const role = typeof message?.role === 'string' ? message.role : 'unknown'
  const images = []
  const content = contentToText(message?.content, undefined, images)
  const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : ''
  const imageKeys = images
    .map((ref) => (typeof ref?.attachmentId === 'string' ? ref.attachmentId : ''))
    .filter((id) => id !== '')
    .join(',')
  const imagePart = imageKeys === '' ? '' : `:${hashString(imageKeys)}`
  return `${role}:${callId}:${content.length}:${hashString(content)}${imagePart}`
}

/**
 * 把消息序列渲染成投喂给 CodeBuddy 的文本。
 *
 * 图片在这里只留编号标号；真正的字节由 {@link CodeBuddyAdapter#deliverImages}
 * 追加成 ACP image 内容块（顺序与标号一致）。
 *
 * @param {readonly object[]} messages 待渲染的消息。
 * @param {{ first: boolean, notes?: Map<string, string> }} options 是否全量重放 + 图片附注。
 * @returns {string} 渲染结果。
 */
function renderMessages(messages, options) {
  const labels = { user: '用户', assistant: '助手', tool: '工具结果', system: '系统说明', developer: '系统说明' }
  const sections = []
  const notes = options?.notes
  // 标号必须与真正投递的图片顺序一致，所以这里也走同一个收集口径（跳过工具结果消息，
  // 与 `collectImageRefs` 的过滤规则保持一致，否则两边编号会错位）。
  const images = []
  for (const message of messages) {
    const role = typeof message?.role === 'string' ? message.role : 'user'
    // 工具结果不回灌：CodeBuddy 自己执行过这些工具，把结果再喂一遍会让它重复劳动。
    if (role === 'tool') continue
    const text = contentToText(message?.content, notes, images)
    if (text === '') continue
    if (role === 'user' && !options.first) {
      sections.push(text)
      continue
    }
    sections.push(`【${labels[role] ?? role}】\n${text}`)
  }
  return sections.join('\n\n').trim()
}

/**
 * 这一批消息里有没有值得发给 CodeBuddy 的内容（正文或图片）。
 *
 * 早期返回能避免「只有工具结果」时白开一条 ACP 会话；
 * 纯图片消息（用户只贴图不打字）必须算有内容，否则它会被静默丢弃。
 *
 * @param {readonly object[]} messages 待投喂消息。
 * @returns {boolean} 是否有内容。
 */
function hasDeliverable(messages) {
  if (collectImageRefs(messages).refs.length > 0) return true
  return renderMessages(messages, { first: true }) !== ''
}

/**
 * 把 ACP 的 stopReason 映射成 DSH 的终结原因。
 * @param {string | undefined} stopReason ACP 结果里的 stopReason。
 * @param {boolean} aborted 是否已被本地取消。
 * @returns {object} DSH 终结原因。
 */
function mapStopReason(stopReason, aborted) {
  if (aborted) {
    return { kind: 'aborted', failure: { message: 'CodeBuddy 轮次已取消', code: 'ABORTED' } }
  }
  switch (stopReason) {
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted', failure: { message: 'CodeBuddy 轮次已取消', code: 'ABORTED' } }
    case 'refusal':
      return { kind: 'error', failure: { message: 'CodeBuddy 拒绝了这次请求', code: 'REFUSAL' } }
    default:
      return { kind: 'stop' }
  }
}

/**
 * 把用量累加进一个累计值。
 *
 * 一次 ACP `session/prompt` 里 CodeBuddy 会跑多轮模型请求（思考→工具→再思考），
 * 每轮各发一条带 `_meta.usage` 的 `usage_update`，所以要相加而不是取最后一条。
 *
 * @param {object | undefined} total 累计值。
 * @param {object} next 本次值。
 * @returns {object} 新的累计值。
 */
function addUsage(total, next) {
  if (total === undefined) return { ...next }
  const merged = {
    ...total,
    inputTokens: (total.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (next.outputTokens ?? 0),
  }
  const optional = ['totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']
  for (const key of optional) {
    const left = typeof total[key] === 'number' ? total[key] : undefined
    const right = typeof next[key] === 'number' ? next[key] : undefined
    if (left === undefined && right === undefined) continue
    merged[key] = (left ?? 0) + (right ?? 0)
  }
  return merged
}

/**
 * 一轮 prompt 里各次模型请求的用量账本。
 *
 * 为什么需要按 messageId 归并而不是简单累加：
 *
 * - 一次 ACP `session/prompt` 里 CodeBuddy 会跑**多轮**模型请求（思考→工具→再思考），
 *   每次都发一条带 `_meta.usage` 的 `usage_update`，所以要全部计入；
 * - 但**同一份结算会被重复推送**（实测同一 `messageId` 连发两条，token 与 cost 完全一致），
 *   简单累加会把 inputTokens 翻倍（实测 27549 的两条 → 110524）。
 *
 * 因此以 `messageId`（缺失时退回 `requestId`，再退回序号）为主键 upsert，
 * 同一条帧重复到来时以**后到者为准**（后到的那条才带 `cost`）。
 */
class UsageLedger {
  constructor() {
    /** @type {Map<string, { usage?: object, cost?: number }>} */
    this.entries = new Map()
    this.fallback = 0
  }

  /**
   * 记一条 `usage_update`。
   * @param {object} update ACP 的 `usage_update`。
   */
  record(update) {
    const meta = update?._meta ?? {}
    const mapped = mapUsage(meta.usage)
    const cost = typeof update?.cost?.amount === 'number' && Number.isFinite(update.cost.amount)
      ? update.cost.amount
      : undefined
    const credit = typeof meta.usage?.credit === 'number' && Number.isFinite(meta.usage.credit)
      ? meta.usage.credit
      : undefined
    const consumed = cost ?? credit
    if (mapped === undefined && (consumed === undefined || consumed <= 0)) return

    const messageId = typeof meta['codebuddy.ai/messageId'] === 'string'
      ? meta['codebuddy.ai/messageId']
      : typeof meta['codebuddy.ai/requestId'] === 'string' ? `req:${meta['codebuddy.ai/requestId']}` : undefined
    const key = messageId ?? `frame:${this.fallback}`
    if (messageId === undefined) this.fallback += 1

    const previous = this.entries.get(key)
    this.entries.set(key, {
      usage: mapped ?? previous?.usage,
      // 后到的帧带 cost；先到的不带，所以要保留较大的那个值而不是相加。
      cost: consumed !== undefined && consumed > 0
        ? Math.max(previous?.cost ?? 0, consumed)
        : previous?.cost,
    })
  }

  /**
   * 汇总本轮用量。
   * @returns {{ usage?: object, credits: number }} 汇总结果。
   */
  total() {
    /** @type {object | undefined} */
    let usage
    let credits = 0
    for (const entry of this.entries.values()) {
      if (entry.usage !== undefined) usage = addUsage(usage, entry.usage)
      if (entry.cost !== undefined && entry.cost > 0) credits += entry.cost
    }
    return { usage, credits }
  }
}

/**
 * 一轮 prompt 的块编排器。
 *
 * DSH 的 `StreamChunk` 要求 `block-end` 与 `block-start` 严格配对、且 `index` 单调。
 * 旧实现把整轮的正文与思考各塞进一个块，所有 `block-end` 拖到最后才发，
 * 于是：
 *
 * - 工具调用播报被追加进 reasoning 块，与模型思考混成一坨，读起来像流水账；
 * - 工具真正执行时（可能几十秒）界面上没有任何东西在动；
 * - 工具结果（`tool_call_update` 的 `rawOutput`）完全丢弃，DSH 里看不到「用了什么、拿到什么」。
 *
 * 这里改成**按时间顺序**编排：思考串流、正文串流、每次工具调用独占一个块，
 * 且**块切换时立刻收口**上一个块（DSH 才能在界面上分段渲染）。
 *
 * 工具块的**发出时机**由 `emitOn` 决定（见 `config.toolEmit`）：`start` 是「一看到就发」
 * （卡片早出现，但完成态要等整轮 ACP 结束），`settle` 是「结算完再发」（卡片一出现就是终态）。
 */
class TurnEmitter {
  /**
   * @param {ChunkQueue} queue 输出队列。
   * @param {object} [options] 选项。
   * @param {import('./tool-bridge.js').ToolCallBridge} [options.bridge] 工具记录桥。
   * @param {string} [options.toolName] 回放工具名（tool-call 块里的 `name`）。
   * @param {boolean} [options.replay] 是否走「原生工具块 + 回放工具」模式。
   * @param {'text' | 'reasoning' | 'off'} [options.narration] 旧模式下的播报位置。
   * @param {'start' | 'settle'} [options.emitOn] 何时发 tool-call 块（见 config.toolEmit）。
   */
  constructor(queue, options = {}) {
    this.queue = queue
    this.bridge = options.bridge
    this.toolName = options.toolName ?? 'codebuddy_tool'
    this.replay = options.replay !== false && options.bridge !== undefined
    this.narration = options.narration ?? 'reasoning'
    this.emitOn = options.emitOn === 'start' ? 'start' : 'settle'
    /** tool-call 参数里保留的 rawInput 预算（字符），超出转成预览。 */
    this.inputLimit = Number.isFinite(options.inputLimit) && options.inputLimit > 0 ? options.inputLimit : 4000
    /**
     * 工具更新的旁路回调（适配器用来同步 CodeBuddy 的任务清单）。
     * @type {((sessionId: string | undefined, update: object) => void) | undefined}
     */
    this.onToolUpdate = options.onToolUpdate
    /** 下一个可用的块下标（单调递增）。 */
    this.nextIndex = 0
    /** 当前打开的块：`{ index, kind }`。 */
    this.open = undefined
    /** 已关闭的块文本，用于补 block-end 之外的一致性校验。 */
    this.answerChars = 0
    /** 旧模式的工具记录（播报用）。 */
    /** @type {Map<string, { id: string, title: string, kind?: string, status: string, text: string }>} */
    this.tools = new Map()
    /** 已发过 tool-call 块的调用 id。 */
    this.emitted = new Set()
    /** 已见到但还「不够像样」的调用（等标题补全），保持插入顺序。 */
    this.held = []
    /** 已播报过的阶段，避免同一阶段反复刷屏。 */
    this.lastPhase = undefined
    /** 当前是否有正文块被打开过。 */
    this.answerIndexes = []
    /** 每个块已累计的文本（收口时写进 block-end）。 */
    this.texts = new Map()
    /** 队列关闭之后攒下的 chunk，由 {@link close} 交回调用方直接 yield。 */
    this.tail = []
    /** 本轮是否发出过工具调用块。 */
    this.toolCallCount = 0
    /**
     * 回放模式下暂存的**最终正文**（等下一个 step 再交给 DSH），以及
     * 已经真流出去的正文字符数（用来判断还能不能干净地暂存）。
     *
     * 见 {@link TurnEmitter.pushText} 与 `CodeBuddyAdapter#run` 的说明：
     * 正文和 tool-call 块若落进同一条 assistant 消息，DSH 就不把它当最终答案。
     */
    this.heldText = ''
    this.streamedTextChars = 0
  }

  /**
   * 输出一个 chunk：队列还开着就入队，已经收口就攒进 tail。
   * @param {object} chunk chunk。
   */
  #output(chunk) {
    if (this.queue.ended) this.tail.push(chunk)
    else this.queue.push(chunk)
  }

  /**
   * 打开（或复用）一个块。
   * @param {'text' | 'reasoning'} kind 块类型。
   * @returns {number} 块下标。
   */
  #open(kind) {
    if (this.open?.kind === kind) return this.open.index
    // 有滞留的工具调用先发出去：块顺序必须与时间顺序一致。
    // `start` 模式用强制模式——已经开始写正文/思考了，说明工具调用一定发生在它之前。
    // `settle` 模式不能强制：思考流随时可能插进来，强制会把还没结算的工具提前发掉，
    // 卡片又会变成「挂着执行中」。
    this.#flushHeld(this.emitOn === 'start')
    this.#close()
    const index = this.nextIndex
    this.nextIndex += 1
    this.open = { index, kind }
    if (kind === 'text') this.answerIndexes.push(index)
    this.texts.set(index, '')
    this.#output({ type: 'block-start', index, blockType: kind })
    return index
  }

  /**
   * 收口当前块（如果有）。
   */
  #close() {
    const open = this.open
    if (open === undefined) return
    this.open = undefined
    const text = this.texts.get(open.index) ?? ''
    this.texts.delete(open.index)
    this.#output({
      type: 'block-end',
      index: open.index,
      block: open.kind === 'reasoning' ? { type: 'reasoning', text } : { type: 'text', text },
    })
  }

  /**
   * 发一个**独占的** tool-call 块：块一开始就带着完整参数收口，工具结果随后由
   * 回放工具在 DSH 侧补上（`tool/result` 事件），因此这里不需要保持打开。
   * @param {import('./tool-bridge.js').ToolCallRecord} record 工具记录。
   */
  #emitToolBlock(record) {
    this.#close()
    const index = this.nextIndex
    this.nextIndex += 1
    const args = buildToolCallArgs(record, this.inputLimit)
    const raw = JSON.stringify(args)
    this.#output({ type: 'block-start', index, blockType: 'tool-call' })
    this.#output({
      type: 'tool-call-delta',
      index,
      id: record.callId,
      name: this.toolName,
      argumentsDelta: raw,
    })
    this.#output({
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: record.callId, name: this.toolName, arguments: raw },
    })
    this.emitted.add(record.callId)
    this.toolCallCount += 1
  }

  /**
   * 判断一条记录现在能不能发块。
   *
   * `start` 模式：信息够就发（标题补全、kind 明确），让卡片尽早出现；
   * `settle` 模式：等 CodeBuddy 把这次调用结算掉再发——卡片一出现就是终态。
   *
   * 为什么 `settle` 更接近用户的直觉：DSH 只在**模型流结束后**才执行回放工具，
   * 所以卡片从「出现」到「完成」之间隔着整轮 ACP。CodeBuddy 早就把 Bash 跑完了，
   * 界面上却还挂着「执行中」，看起来就是「工具结束了自己不会结束」。
   *
   * @param {object} record 工具记录。
   * @returns {boolean} 是否可发块。
   */
  #ready(record) {
    if (this.emitOn === 'start') return isInformative(record)
    return record.status === 'completed' || record.status === 'failed'
  }

  /**
   * 把滞留的调用按顺序发出去。
   *
   * - `start` 模式只发「连续且已够信息量」的前缀：实测两个工具会依次补全标题，
   *   若一次全发，后一个会带着占位标题（只有 `Read`、没有路径）落地。
   * - `settle` 模式「谁先结算谁先出」：慢工具不该把已经完成的快工具一起拖住。
   *
   * @param {boolean} [force] 收口时强制全部发出（不再等标题补全 / 等结算）。
   */
  #flushHeld(force = false) {
    if (this.held.length === 0) return
    const prefixOnly = this.emitOn === 'start'
    const remaining = []
    let blocked = false
    for (const callId of this.held) {
      if (this.emitted.has(callId)) continue
      const record = this.bridge?.read(callId)
      if (record === undefined) continue
      if (!blocked && (force || this.#ready(record))) {
        this.#emitToolBlock(record)
        continue
      }
      // start 模式下前一个还没补全：它后面的也不能抢跑，否则块顺序会乱。
      if (prefixOnly) blocked = true
      remaining.push(callId)
    }
    this.held = remaining
  }

  /**
   * 跟踪一条工具记录：够格就发块，不够先压着。
   * @param {object} record 工具记录。
   */
  #track(record) {
    if (record === undefined || this.emitted.has(record.callId)) return
    if (!this.held.includes(record.callId)) this.held.push(record.callId)
    this.#flushHeld()
  }

  /**
   * 追加正文。
   *
   * **回放模式且本轮已有工具调用时**，正文不再当场流出去，而是攒进 {@link heldText}：
   * 这些正文会和 tool-call 块落进同一条 assistant 消息，DSH 的 `latestAnswer` 便不认它
   * 是最终答案，整轮折叠后结论就消失了。攒下来的正文由适配器在**下一个 step**单独交出。
   *
   * 若正文在工具调用**之前**就已经流出去了（CodeBuddy 有时先给一句「我先看看…」），
   * 那部分无法收回，就整轮照旧走「同 step + concludeTurn」的老路径，保证不出现
   * 「半个答案在这条消息、半个在下一个 step」的撕裂。
   *
   * @param {string} delta 增量。
   */
  pushText(delta) {
    if (typeof delta !== 'string' || delta === '') return
    if (this.replay && this.toolCallCount > 0 && this.streamedTextChars === 0) {
      // 本轮已经发过工具块、而且还没有任何正文流出去：整段正文先攒住，交给下一个 step。
      this.heldText += delta
      return
    }
    this.streamedTextChars += delta.length
    const index = this.#open('text')
    this.texts.set(index, (this.texts.get(index) ?? '') + delta)
    this.answerChars += delta.length
    this.#output({ type: 'text-delta', index, text: delta })
  }

  /**
   * 是否把整段正文都攒住了（可以改到下一个 step 单独交出）。
   * @returns {boolean} 是否暂存了整段正文。
   */
  get holdsAnswer() {
    return this.heldText.trim() !== '' && this.streamedTextChars === 0
  }

  /**
   * 追加思考。
   * @param {string} delta 增量。
   */
  pushReasoning(delta) {
    if (typeof delta !== 'string' || delta === '') return
    const index = this.#open('reasoning')
    this.texts.set(index, (this.texts.get(index) ?? '') + delta)
    this.#output({ type: 'reasoning-delta', index, text: delta })
  }

  /**
   * 往某个流里追加「活动播报」（工具/计划/阶段）。
   * @param {'text' | 'reasoning'} kind 目标块类型。
   * @param {string} line 播报内容。
   * @returns {boolean} 是否真的写了（块类型不同 → 需要先收口，交由调用方处理）。
   */
  pushActivity(kind, line) {
    if (typeof line !== 'string' || line === '') return false
    const target = kind === 'text' ? 'text' : 'reasoning'
    const index = this.#open(target)
    this.texts.set(index, (this.texts.get(index) ?? '') + line)
    this.#output({ type: target === 'text' ? 'text-delta' : 'reasoning-delta', index, text: line })
    return true
  }

  /**
   * 处理 `tool_call`（既可能是新的工具，也可能是同一 id 的标题更新）。
   *
   * 回放模式：写入记录桥，等信息够完整时发一个原生 `tool-call` 块；
   * 旧模式：把「▸ 标题」播报进推理块。
   *
   * @param {object} update ACP 更新。
   */
  toolCall(update) {
    if (this.replay) {
      this.#track(this.bridge.begin(update))
      return
    }
    if (this.narration === 'off') return
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : `tool-${this.tools.size}`
    const title = typeof update.title === 'string' && update.title.length > 0
      ? update.title.trim()
      : typeof update.kind === 'string' ? update.kind : '工具'
    const existing = this.tools.get(id)
    if (existing !== undefined) {
      // 同一 id 二次 `tool_call`：实测是「标题从 Read 变成 Read <路径>」的补全，
      // 不重复开块，只更新记录里的标题（最终摘要用得到）。
      if (title.length > existing.title.length) existing.title = title
      if (typeof update.kind === 'string' && update.kind !== 'other') existing.kind = update.kind
      return
    }
    this.tools.set(id, {
      id,
      title,
      kind: typeof update.kind === 'string' ? update.kind : undefined,
      status: typeof update.status === 'string' ? update.status : 'pending',
      text: '',
    })
    this.pushActivity(this.narration === 'text' ? 'text' : 'reasoning', `\n▸ ${title}\n`)
  }

  /**
   * 处理 `tool_call_update`：更新记录桥里的状态与输出。
   *
   * 回放模式下结果不再写进思考流——它会在 DSH 执行回放工具时以 `tool/result`
   * 的形式落到会话里，界面上就是工具卡片自己的结果区。
   *
   * 另外顺手把 CodeBuddy 自己的任务清单（`TaskCreate` / `TaskUpdate` 的
   * `_meta['codebuddy.ai/rawResponse'].todos`）同步成 DSH 待办。
   *
   * @param {object} update ACP 更新。
   * @param {string} [sessionId] DSH 会话键（任务清单同步用）。
   */
  toolUpdate(update, sessionId) {
    this.onToolUpdate?.(sessionId, update)
    if (this.replay) {
      this.#track(this.bridge.settle(update))
      return
    }
    if (this.narration === 'off') return
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : ''
    const tool = this.tools.get(id)
    if (tool === undefined) return
    if (typeof update.title === 'string' && update.title.length > 0) tool.title = update.title.trim()
    if (typeof update.kind === 'string' && update.kind !== 'other') tool.kind = update.kind
    if (typeof update.status === 'string') tool.status = update.status
    const output = toolOutputText(update)
    if (output !== '') tool.text = output
    if (update.status === 'failed') {
      this.pushActivity('reasoning', `  ✗ 失败${tool.text === '' ? '' : `：${firstLine(tool.text, 120)}`}\n`)
      return
    }
    if (update.status === 'completed' && tool.text !== '') {
      this.pushActivity('reasoning', `  ✓ ${firstLine(tool.text, 160)}\n`)
    }
  }

  /**
   * 播报 CodeBuddy 的阶段机（工具执行时界面不会「僵住」）。
   * @param {string} phase 阶段名。
   * @param {string} [toolName] 正在执行的工具。
   * @param {string} [streamingToolName] 正在流式生成的工具。
   */
  phase(phase, toolName, streamingToolName) {
    const label = PHASE_LABELS[phase]
    if (label === undefined) return
    const detail = toolName ?? streamingToolName
    const key = `${phase}:${detail ?? ''}`
    if (this.lastPhase === key) return
    this.lastPhase = key
    this.pushActivity('reasoning', `  · ${label}${detail === undefined ? '' : `（${detail}）`}\n`)
  }

  /** @returns {boolean} 本轮是否产出过正文。 */
  hasAnswerText() {
    return this.answerChars > 0
  }

  /** @returns {boolean} 本轮是否发出过工具调用块。 */
  hasToolCalls() {
    return this.toolCallCount > 0
  }

  /**
   * 把「本轮还有正文待发」这个事实写到本轮每条工具记录上。
   *
   * 为什么走记录桥而不是 tool-call 块的参数：块参数在流式期间就已固定下发，
   * 而「这一轮到底有没有正文」要等整轮结束才知道。回放工具是按 `callId`
   * 从桥里取记录的，所以把标记写在记录上最精确——同进程并发的其它会话不受影响。
   */
  markHeldAnswer() {
    if (!this.replay || this.bridge === undefined) return
    for (const callId of this.emitted) {
      const record = this.bridge.read(callId)
      if (record !== undefined) record.holdAnswer = true
    }
  }

  /**
   * 收口所有仍未关闭的块：先把滞留的工具调用发掉，再关当前块。
   * @returns {object[]} 需要 yield 的 chunk。
   */
  close() {
    this.#flushHeld(true)
    this.#close()
    const out = this.tail
    this.tail = []
    return out
  }

  /**
   * 旧模式专用：补一份「本轮工具调用摘要」。
   *
   * 回放模式下不再需要它——工具已经是原生卡片，各带自己的结果。
   *
   * @returns {object[]} 需要 yield 的 chunk。
   */
  summary() {
    if (this.replay) return []
    const tools = [...this.tools.values()].filter((tool) => tool.text !== '' || tool.status !== 'pending')
    if (tools.length === 0) return []
    const lines = tools.map((tool) => {
      const mark = tool.status === 'completed' ? '✓' : tool.status === 'failed' ? '✗' : '·'
      const detail = tool.text === '' ? '' : ` — ${firstLine(tool.text, 100)}`
      return `${mark} ${tool.title}${detail}`
    })
    const body = `\n\n<details><summary>本轮工具调用（${tools.length}）</summary>\n\n${lines.join('\n')}\n\n</details>\n`
    const index = this.nextIndex
    this.nextIndex += 1
    const out = [
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text: body },
      { type: 'block-end', index, block: { type: 'text', text: body } },
    ]
    this.answerChars += body.length
    return out
  }
}

/**
 * 判断一条工具记录是否「够信息量可以发块」。
 *
 * 实测 CodeBuddy 会先发一条 `kind=other`、标题只有 `Read` 的占位 `tool_call`，
 * 稍后才补一条带绝对路径与正确 `kind` 的同 id `tool_call`。占位帧先压住不发，
 * 等补全帧到了再一次性发出去，卡片上就有正确的标题与类别。
 *
 * 注意**不能**拿 `path` 当信号：`tool_call_update` 里的增量 `rawInput` 会先把路径填上，
 * 那样会拿着占位标题提前发块（实测就是这样拿到 `Read` 而不是 `Read <路径>`）。
 *
 * @param {object} record 工具记录。
 * @returns {boolean} 是否可直接发块。
 */
function isInformative(record) {
  if (record === undefined) return false
  if (record.status === 'completed' || record.status === 'failed') return true
  if (record.kind !== 'other') return true
  return record.subject !== '' && record.subject !== undefined
}

/**
 * 把工具记录投影成 tool-call 块的参数 JSON。
 *
 * 键顺序有意义：客户端通用工具行在没有专门卡片时，取**第一个字符串值**做摘要，
 * 所以 `title` 必须排在最前面。
 *
 * @param {object} record 工具记录。
 * @param {number} inputLimit rawInput 预算（字符）。
 * @returns {object} 参数对象。
 */
function buildToolCallArgs(record, inputLimit) {
  const args = {
    title: record.title,
    kind: record.kind,
    tool: record.tool,
    callId: record.callId,
    status: record.status,
  }
  if (record.path !== undefined && record.path !== '') args.path = record.path
  if (record.line !== undefined) args.line = record.line
  if (record.command !== undefined && record.command !== '') args.command = firstLine(record.command, 400)
  if (record.rawInput !== undefined) args.input = previewInput(record.rawInput, inputLimit)
  return args
}

/**
 * 把可能很大的 rawInput 压成预览（参数要进会话日志，不能无限膨胀）。
 * @param {object} rawInput 原始参数。
 * @param {number} limit 字符预算。
 * @returns {object} 预览对象。
 */
function previewInput(rawInput, limit) {
  let json
  try {
    json = JSON.stringify(rawInput)
  } catch {
    return { preview: '（参数无法序列化）' }
  }
  if (typeof json !== 'string' || json.length <= limit) return rawInput
  return { truncated: true, bytes: json.length, preview: `${json.slice(0, limit)}…` }
}

/**
 * 为审批提示生成一句人类可读的工具描述。
 *
 * 实测 CodeBuddy 的 `session/request_permission` 里 `toolCall` **没有 title**，
 * 只有 `_meta['codebuddy.ai/toolName']`（如 `Bash`）与 `rawInput`
 * （如 `{command, description}`）。直接拿 `title` 会得到一句「CodeBuddy 工具」，
 * 用户根本不知道要批准什么。所以按「工具名 + 最关键的参数」拼一条。
 *
 * @param {object} toolCall ACP 的 `toolCall`（ToolCallUpdate 形态）。
 * @returns {string} 描述。
 */
export function describePermissionTool(toolCall) {
  const raw = toolCall?.rawInput
  const name = typeof toolCall?._meta?.['codebuddy.ai/toolName'] === 'string'
    ? toolCall._meta['codebuddy.ai/toolName']
    : typeof toolCall?.kind === 'string' && toolCall.kind !== 'other' ? toolCall.kind : '工具'
  if (typeof toolCall?.title === 'string' && toolCall.title !== '') {
    return toolCall.title
  }
  const detail = typeof raw?.description === 'string' && raw.description !== ''
    ? raw.description
    : typeof raw?.command === 'string' && raw.command !== ''
      ? raw.command
      : typeof raw?.file_path === 'string' && raw.file_path !== ''
        ? raw.file_path
        : undefined
  if (detail === undefined) return name
  const flat = detail.replace(/\s+/g, ' ').trim()
  return `${name}: ${flat.length <= 160 ? flat : `${flat.slice(0, 160)}…`}`
}

/**
 * 在 ACP 的 `options` 里挑一个与 DSH 决定相符的选项。
 *
 * 关键点：**不能只按 `kind` 前缀找第一个**。实测 CodeBuddy 下发的顺序是
 * `[{kind:'allow_always'}, {kind:'allow'}, {kind:'reject'}]`，
 * `find(kind.startsWith('allow'))` 会命中 `allow_always`——于是用户在 DSH 里点
 * 「允许一次」，CodeBuddy 那边却被永久放行，之后同类工具**再也不问**。
 *
 * 所以这里按「一次性优先」排序：先精确匹配 `allow_once` / `allow`，
 * 都找不到才退到 `allow_always`（前缀匹配）。拒绝同理，`reject_once` 优先。
 *
 * @param {object[]} options ACP 的 `options`。
 * @param {'allow' | 'deny'} decision DSH 的决定。
 * @returns {object | undefined} 选中的选项。
 */
function pickPermissionOption(options, decision) {
  const kindOf = (option) => String(option?.kind ?? '').toLowerCase()
  if (decision === 'allow') {
    // 一次性放行的各种写法（不同 agent 用词不同），按精确值优先。
    for (const kind of ['allow_once', 'allow', 'accept_once', 'accept']) {
      const hit = options.find((option) => kindOf(option) === kind)
      if (hit !== undefined) return hit
    }
    // 没有一次性选项时才退到「总是允许」/任意 allow 类，最后退第一个。
    return options.find((option) => kindOf(option).startsWith('allow'))
      ?? options.find((option) => kindOf(option).startsWith('accept'))
      ?? options[0]
  }
  for (const kind of ['reject_once', 'reject', 'deny']) {
    const hit = options.find((option) => kindOf(option) === kind)
    if (hit !== undefined) return hit
  }
  return options.find((option) => kindOf(option).startsWith('reject'))
}

/**
 * 把 ACP 权限请求映射成 DSH 的审批决定，再翻译回 ACP 的 outcome。
 *
 * 两边语义并不一样，所以映射是显式的：
 *
 * | DSH 审批结果 | ACP 回应 |
 * |---|---|
 * | `allowed-once`（→ `allow`） | 选第一个 `kind` 以 `allow` 开头的 option（没有就选第一个 option） |
 * | `rejected`（→ `deny`） | 选第一个 `kind` 以 `reject` 开头的 option；一个都没有就回 `cancelled` |
 * | `cancelled` / `unavailable` / 问不到 | 交回静态策略（`undefined`），由 `permissionPolicy` 兜底 |
 *
 * 注意 `optionId` 的取值**由 agent 决定**（实测 `allow_once` / `allow_always` /
 * `reject_once`），不能硬编码，只能按 `kind` 选。
 *
 * @param {object} options 参数。
 * @param {Map<string, object>} options.sessions 适配器的会话运行态表。
 * @param {Function | undefined} options.ask DSH 审批询问钩子。
 * @param {{ info?: Function, warn?: Function }} options.logger 日志器。
 * @param {object} options.params ACP 请求参数。
 * @returns {Promise<object | undefined>} ACP outcome；`undefined` 表示交回静态策略。
 */
export async function resolvePermissionRequest({ sessions, ask, logger, params }) {
  if (typeof ask !== 'function') return undefined
  const acpSessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  let record
  for (const candidate of sessions.values()) {
    if (candidate.acpSessionId === acpSessionId) {
      record = candidate
      break
    }
  }
  if (record === undefined) return undefined
  const toolCall = params?.toolCall ?? {}
  const toolName = describePermissionTool(toolCall)
  let decision
  try {
    decision = await ask({
      sessionId: record.key,
      toolName,
      reason: typeof toolCall._meta?.['codebuddy.ai/toolName'] === 'string'
        ? `CodeBuddy 请求执行 ${toolCall._meta['codebuddy.ai/toolName']}`
        : undefined,
      options: Array.isArray(params?.options) ? params.options : [],
      signal: record.currentSignal,
    })
  } catch (error) {
    logger?.warn?.(`dsh-codebuddy-acp: 审批询问失败，交回 permissionPolicy：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  if (decision !== 'allow' && decision !== 'deny') return undefined
  const options = Array.isArray(params?.options) ? params.options : []
  const chosen = pickPermissionOption(options, decision)
  if (chosen === undefined) return { outcome: 'cancelled' }
  return { outcome: 'selected', optionId: chosen.optionId }
}

/**
 * 取多行文本的第一行（摘要用）。
 * @param {string} text 原文。
 * @param {number} limit 最长字符。
 * @returns {string} 单行摘要。
 */
function firstLine(text, limit) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * 把 ACP 计划条目的状态归一成 DSH 待办的三态。
 *
 * ACP 侧实测/规范取值：`pending` / `in_progress` / `completed`；
 * DSH 的 `todo/write` 只认这三个（`pending` / `in_progress` / `completed`），
 * 其它（含未见过的新值、`cancelled`）一律降级成 `pending`，避免整条计划写不进去。
 *
 * @param {unknown} status ACP 状态。
 * @returns {'pending' | 'in_progress' | 'completed'} DSH 状态。
 */
export function normalizePlanStatus(status) {
  switch (status) {
    case 'completed':
    case 'done':
      return 'completed'
    case 'in_progress':
    case 'in-progress':
    case 'active':
    case 'running':
      return 'in_progress'
    default:
      return 'pending'
  }
}

/** CodeBuddy `agentPhase` 的中文说明（只列实测出现过的阶段）。 */
const PHASE_LABELS = Object.freeze({
  preparing: '准备中',
  model_requesting: '模型请求中',
  model_streaming: '生成中',
  model_done: '模型返回',
  tool_executing: '执行工具',
  idle: '空闲',
})

/**
 * 把 CodeBuddy 的 OpenAI 风格用量映射成 DSH 的 TokenUsage。
 *
 * 真实结构在 `usage_update` 的 `_meta.usage` 里：
 * `{prompt_tokens, completion_tokens, total_tokens, completion_tokens_details:{reasoning_tokens},
 *   prompt_tokens_details:{cached_tokens}}`。
 *
 * @param {object | undefined} usage `_meta.usage`。
 * @returns {object | undefined} DSH 用量。
 */
function mapUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const read = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)
  const inputTokens = read(usage.prompt_tokens) ?? read(usage.inputTokens) ?? 0
  const outputTokens = read(usage.completion_tokens) ?? read(usage.outputTokens) ?? 0
  if (inputTokens === 0 && outputTokens === 0) return undefined
  const mapped = {
    inputTokens,
    outputTokens,
    totalTokens: read(usage.total_tokens) ?? inputTokens + outputTokens,
  }
  const reasoning = read(usage.completion_tokens_details?.reasoning_tokens)
  if (reasoning !== undefined) mapped.reasoningTokens = reasoning
  const cached = read(usage.prompt_tokens_details?.cached_tokens)
  if (cached !== undefined) mapped.cacheReadTokens = cached
  return mapped
}

/**
 * 归一化模型策略。
 *
 * @param {{ enabled?: string[] | null, order?: string[], defaultModel?: string } | undefined} policy 原始策略。
 * @returns {{ enabled: string[] | null, order: string[], defaultModel?: string }} 归一化策略。
 */
export function normalizePolicy(policy) {
  if (policy === undefined || policy === null) return { enabled: null, order: [] }
  const enabled = Array.isArray(policy.enabled)
    ? [...new Set(policy.enabled.filter((item) => typeof item === 'string' && item.length > 0))]
    : null
  const order = Array.isArray(policy.order)
    ? [...new Set(policy.order.filter((item) => typeof item === 'string' && item.length > 0))]
    : []
  const defaultModel = typeof policy.defaultModel === 'string' && policy.defaultModel.length > 0
    ? policy.defaultModel
    : undefined
  return { enabled, order, ...defaultModel === undefined ? {} : { defaultModel } }
}

/**
 * 极简异步队列：把事件回调里的 chunk 变成可 `for await` 的序列。
 */
class ChunkQueue {
  constructor() {
    this.items = []
    this.waiters = []
    this.ended = false
  }

  /**
   * 入队。
   * @param {object} item chunk。
   */
  push(item) {
    if (this.ended) return
    const waiter = this.waiters.shift()
    this.items.push(item)
    waiter?.(undefined)
  }

  /** 结束。 */
  end() {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }

  /** @returns {AsyncIterableIterator<object>} 迭代器。 */
  [Symbol.asyncIterator]() {
    let closed = false
    const self = this
    return {
      async next() {
        while (true) {
          if (self.items.length > 0) return { value: self.items.shift(), done: false }
          if (self.ended || closed) return { value: undefined, done: true }
          await new Promise((resolve) => self.waiters.push(() => resolve(undefined)))
        }
      },
      async return() {
        closed = true
        return { value: undefined, done: true }
      },
    }
  }
}

/**
 * 一条共享连接：一个 CodeBuddy 进程 + 若干 ACP 会话。
 */
class SharedConnection {
  /**
   * @param {object} options 参数。
   * @param {string} options.cwd 工作目录。
   * @param {object} options.config 生效配置。
   * @param {{ argv: string[], env: Record<string, string> }} options.launch 启动信息。
   * @param {object} options.host 宿主能力桥。
   * @param {{ info?: Function, warn?: Function }} options.logger 日志器。
   */
  constructor({ cwd, config, launch, host, logger }) {
    this.cwd = cwd
    this.config = config
    this.launch = launch
    this.host = host
    this.logger = logger
    /** @type {AcpConnection | undefined} */
    this.connection = undefined
    this.state = 'new'
    this.starting = undefined
    this.deadReason = undefined
    this.userinfo = undefined
    this.authMethods = []
    /** 本进程是否已经完成过鉴权（鉴权会拉起浏览器，所以只做一次）。 */
    this.authenticated = false
    /** @type {{ list: object[], currentId?: string, at: number } | undefined} */
    this.liveModels = undefined
    /** @type {{ currentValue?: string, options: string[], at: number } | undefined} */
    this.thoughtLevel = undefined
    this.lastUsedAt = Date.now()
    /** 连接级串行闸门：同一进程内的多轮 prompt 不能并发。 */
    this.tail = Promise.resolve()
    /**
     * 权限请求的 DSH 侧询问钩子，由适配器注入。
     * 返回 ACP outcome，或 `undefined` 表示「问不了，交回 permissionPolicy」。
     * @type {((params: object) => Promise<object | undefined>) | undefined}
     */
    this.onPermission = undefined
  }

  /**
   * 取连接级互斥闸门：同一个 CodeBuddy 进程里的多条会话不能并发跑 prompt。
   * @returns {Promise<() => void>} 释放函数。
   */
  async acquire() {
    const previous = this.tail
    let release
    this.tail = new Promise((resolve) => { release = resolve })
    await previous.catch(() => {})
    let done = false
    return () => {
      if (done) return
      done = true
      release()
    }
  }

  /**
   * 确保连接已就绪（spawn + initialize + authenticate）。
   * @param {AbortSignal | undefined} signal 取消信号。
   * @returns {Promise<AcpConnection>} 就绪的连接。
   */
  async ensure(signal) {
    if (this.state === 'ready' && this.connection !== undefined) return this.connection
    if (this.state === 'dead') {
      throw new AcpError(this.deadReason ?? 'CodeBuddy 连接已断开', { code: 'PROCESS_EXITED' })
    }
    if (this.starting !== undefined) {
      await this.starting
      if (this.connection === undefined) throw new AcpError('CodeBuddy 连接启动失败', { code: 'SPAWN_FAILED' })
      return this.connection
    }
    this.starting = this.#bootstrap(signal)
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
    if (this.connection === undefined) throw new AcpError('CodeBuddy 连接启动失败', { code: 'SPAWN_FAILED' })
    return this.connection
  }

  /**
   * 启动并完成握手与鉴权。
   * @param {AbortSignal | undefined} signal 取消信号。
   * @returns {Promise<void>} 完成。
   */
  async #bootstrap(signal) {
    this.state = 'starting'
    const connection = new AcpConnection({
      argv: [...this.launch.argv, ...this.config.args],
      env: this.launch.env,
      cwd: this.cwd,
      log: (level, message) => {
        if (level === 'warn') this.logger.warn?.(message)
        else if (this.config.logLevel === 'info') this.logger.info?.(message)
      },
    })
    connection.setRequestHandler((method, params) => this.#handleAgentRequest(method, params))
    connection.setExitListener((reason) => {
      this.state = 'dead'
      this.deadReason = reason
      this.connection = undefined
      this.logger.warn?.(`dsh-codebuddy-acp: ${reason}`)
    })

    const capabilities = {}
    if (this.config.proxyFs) capabilities.fs = { readTextFile: true, writeTextFile: true }
    capabilities.terminal = this.config.proxyTerminal === true

    try {
      const init = await connection.start({
        clientCapabilities: capabilities,
        clientInfo: CLIENT_INFO,
        signal: withTimeout(signal, this.config.startupTimeoutMs),
      })
      const methods = Array.isArray(init.authMethods) ? init.authMethods : []
      this.authMethods = methods.map((method) => ({
        id: typeof method?.id === 'string' ? method.id : String(method?.id ?? ''),
        name: typeof method?.name === 'string' ? method.name : '',
      })).filter((method) => method.id !== '')

      this.connection = connection
      this.state = 'ready'
    } catch (error) {
      this.state = 'dead'
      this.deadReason = error instanceof Error ? error.message : String(error)
      await connection.close(this.config.disposeGraceMs).catch(() => {})
      throw error
    }
  }

  /**
   * 按需完成鉴权。
   *
   * 关键取舍：CodeBuddy 的 `authenticate` **不是**「确认一下登录态」，而是一次真正的
   * 外部链接登录 —— CLI 日志里是 `externalUriOpener.open`，即每次调用都会拉起浏览器。
   * 因此这里不主动鉴权，只在 `session/new` 明确被 `-32000 / data.category=auth` 拒绝时
   * 才补一次，并且同一个进程只补一次。本机已有登录态时 `session/new` 直接通过，浏览器不会被拉起。
   *
   * @param {AbortSignal | undefined} signal 取消信号。
   * @returns {Promise<boolean>} 是否执行过鉴权。
   */
  async authenticateIfNeeded(signal) {
    const connection = this.connection
    if (connection === undefined) throw new AcpError('ACP 连接尚未建立', { code: 'CLOSED' })
    if (this.authenticated === true) return false

    const method = pickAuthMethod(this.authMethods, this.config.authMethod)
    if (method === undefined) {
      this.authenticated = true
      return false
    }
    this.logger.info?.(`dsh-codebuddy-acp: CodeBuddy 要求鉴权（methodId=${method.id}），若弹出浏览器请在页面上完成授权`)
    try {
      const auth = await connection.authenticate(method.id, {
        signal: withTimeout(signal, this.config.authTimeoutMs),
      })
      this.userinfo = auth?._meta?.['codebuddy.ai/userinfo']
      if (this.userinfo?.userName !== undefined) {
        this.logger.info?.(`dsh-codebuddy-acp: 已登录为 ${String(this.userinfo.userName)}`)
      }
      this.authenticated = true
      return true
    } catch (error) {
      throw new AcpError(
        connection.authUrl === undefined
          ? `CodeBuddy 鉴权没有完成（${error instanceof Error ? error.message : String(error)}）。请先在终端运行 codebuddy 并执行 /login，或把 authTimeoutMs 调大后在浏览器里完成授权`
          : `CodeBuddy 需要在浏览器里完成登录授权，请打开这个链接：${connection.authUrl}`,
        { code: 'UNAUTHENTICATED' },
      )
    }
  }

  /**
   * 新建一条 ACP 会话，并按需把模型设成期望值。
   *
   * @param {string | undefined} model 期望模型 id。
   * @param {AbortSignal | undefined} signal 取消信号。
   * @returns {Promise<{ sessionId: string, model?: string }>} 会话信息。
   */
  async createSession(model, signal) {
    const connection = await this.ensure(signal)
    const params = { cwd: this.cwd, mcpServers: [] }
    const options = { signal: withTimeout(signal, this.config.startupTimeoutMs) }

    let session
    try {
      session = await connection.newSession(params, options)
    } catch (error) {
      // 只有明确的鉴权拒绝才补鉴权；其它错误（cwd 非法、参数错）直接上抛。
      if (!isAuthError(error)) throw error
      await this.authenticateIfNeeded(signal)
      session = await connection.newSession(params, options)
    }
    this.rememberModels(session)
    this.lastUsedAt = Date.now()

    if (model === undefined || model === '') return { sessionId: session.sessionId }

    const current = this.liveModels?.currentId
    if (current === model) return { sessionId: session.sessionId, model }

    const applied = await this.trySetModel(session.sessionId, model, signal)
    return { sessionId: session.sessionId, model: applied === true ? model : undefined }
  }
  /**
   * 尝试切换会话模型。
   * @param {string} sessionId 会话 id。
   * @param {string} model 模型 id。
   * @param {AbortSignal | undefined} signal 取消信号。
   * @returns {Promise<boolean>} 是否切换成功。
   */
  async trySetModel(sessionId, model, signal) {
    const connection = this.connection
    if (connection === undefined) return false
    try {
      const result = await connection.setSessionConfigOption(sessionId, 'model', model, {
        signal: withTimeout(signal, this.config.startupTimeoutMs),
      })
      const option = Array.isArray(result.configOptions)
        ? result.configOptions.find((item) => item?.id === 'model')
        : undefined
      if (this.liveModels !== undefined && typeof option?.currentValue === 'string') {
        this.liveModels.currentId = option.currentValue
      }
      this.logger.info?.(`dsh-codebuddy-acp: 会话模型已切到 ${String(option?.currentValue ?? model)}`)
      return true
    } catch (error) {
      this.logger.warn?.(`dsh-codebuddy-acp: 切换模型 ${model} 失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * 记录会话返回的账号可用模型（比静态目录权威）。
   * @param {{ models?: object }} session session/new 的响应。
   */
  rememberModels(session) {
    const models = session?.models
    const list = Array.isArray(models?.availableModels) ? models.availableModels : []
    if (list.length === 0) return
    this.liveModels = {
      at: Date.now(),
      currentId: typeof models?.currentModelId === 'string' ? models.currentModelId : undefined,
      list: list
        .filter((item) => item !== null && typeof item === 'object' && typeof item.modelId === 'string')
        .map((item) => ({
          id: item.modelId,
          name: typeof item.name === 'string' ? item.name : undefined,
          description: typeof item.description === 'string' ? item.description : undefined,
          contextWindow: typeof item._meta?.maxInputTokens === 'number' ? item._meta.maxInputTokens : undefined,
          supportsImages: item._meta?.supportsImages === true,
          supportsReasoning: item._meta?.supportsReasoning === true,
          credits: typeof item._meta?.credits === 'string' ? item._meta.credits : undefined,
          // 档位全集：`_meta.effortOptions` 是 CodeBuddy 扩展，实测随模型变化。
          effortOptions: Array.isArray(item._meta?.effortOptions)
            ? item._meta.effortOptions
              .map((option) => (typeof option?.value === 'string' ? option.value : undefined))
              .filter((value) => value !== undefined)
            : undefined,
        })),
    }
    this.rememberThoughtLevel(session)
  }

  /**
   * 记住会话当前可写的 `thought_level` 档位（以 configOptions 为准，比 effortOptions 更权威）。
   * @param {{ configOptions?: object[] }} session session/new 的响应。
   */
  rememberThoughtLevel(session) {
    const option = Array.isArray(session?.configOptions)
      ? session.configOptions.find((item) => item?.id === 'thought_level')
      : undefined
    if (option === undefined) return
    this.thoughtLevel = {
      at: Date.now(),
      currentValue: typeof option.currentValue === 'string' ? option.currentValue : undefined,
      options: Array.isArray(option.options)
        ? option.options
          .map((item) => (typeof item?.value === 'string' ? item.value : undefined))
          .filter((value) => value !== undefined && value !== 'enabled')
        : [],
    }
  }

  /**
   * 把会话的思考档位写成期望值。
   *
   * CodeBuddy 的档位是**会话级**的（`session/set_config_option {configId:"thought_level"}`），
   * 实测接受 `minimal/low/medium/high/xhigh/max/enabled`，非法值以 -32603 拒绝并回带全集；
   * 而且档位集合随模型变化，切模型后档位可能不在新模型允许范围内，所以要允许失败并且只记日志。
   *
   * @param {string} sessionId 会话 id。
   * @param {string} effort DSH 的 `reasoningEffort`。
   * @param {AbortSignal | undefined} signal 取消信号。
   * @returns {Promise<boolean>} 是否写成功。
   */
  async trySetThoughtLevel(sessionId, effort, signal) {
    const connection = this.connection
    if (connection === undefined) return false
    try {
      const result = await connection.setSessionConfigOption(sessionId, 'thought_level', effort, {
        signal: withTimeout(signal, this.config.startupTimeoutMs),
      })
      this.rememberThoughtLevel({ configOptions: result.configOptions })
      this.logger.info?.(`dsh-codebuddy-acp: 思考档位已切到 ${effort}`)
      return true
    } catch (error) {
      this.logger.warn?.(`dsh-codebuddy-acp: 思考档位 ${effort} 不被接受，沿用 CodeBuddy 当前档位：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * 处理 agent 主动发来的请求（权限、文件代理）。
   * @param {string} method 方法名。
   * @param {object} params 参数。
   * @returns {Promise<object>} 响应结果。
   */
  async #handleAgentRequest(method, params) {
    switch (method) {
      case 'session/request_permission': {
        // 先问 DSH（用户在 DSH 里点批准/拒绝）；问不了再退回配置的静态策略。
        const asked = await this.onPermission?.(params)
        if (asked !== undefined) return { outcome: asked }
        return { outcome: permissionOutcome(params, this.config.permissionPolicy) }
      }
      case 'fs/read_text_file': {
        if (!this.config.proxyFs) throw new AcpError('未启用文件代理', { code: -32601 })
        const path = requirePath(params)
        const content = await this.host.readTextFile(path, this.cwd)
        return { content: sliceLines(content, params) }
      }
      case 'fs/write_text_file': {
        if (!this.config.proxyFs) throw new AcpError('未启用文件代理', { code: -32601 })
        const path = requirePath(params)
        if (typeof params.content !== 'string') throw new AcpError('fs/write_text_file 缺少 content', { code: -32602 })
        await this.host.writeTextFile(path, params.content, this.cwd)
        return {}
      }
      default:
        throw new AcpError(`不支持的 ACP 请求：${method}`, { code: -32601, method })
    }
  }

  /**
   * 关闭连接（含进程树）。
   * @returns {Promise<void>} 完成。
   */
  async close() {
    const connection = this.connection
    this.connection = undefined
    this.state = 'dead'
    this.deadReason = '插件已卸载'
    if (connection !== undefined) await connection.close(this.config.disposeGraceMs).catch(() => {})
  }
}

/**
 * 判断一个 ACP 错误是否是「需要鉴权」。
 *
 * 只认 `error.data.category === 'auth'`（官方建议），message 文案仅作兜底。
 *
 * @param {unknown} error 抛出物。
 * @returns {boolean} 是否需要鉴权。
 */
function isAuthError(error) {
  const category = error?.data?.category
  if (category === 'auth') return true
  const code = error?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === -32000 && /auth/i.test(message)) return true
  return /authentication required|not logged in|login required/i.test(message)
}

/**
 * 判断一次失败是不是「这条 ACP 会话已经不存在了」。
 *
 * 实测 CodeBuddy 对未知 sessionId 的 `session/prompt` 回
 * `-32603` + `data.details: "Session not found: <id>"`；进程整体退出时
 * 连接层给的是 `PROCESS_EXITED`。两种都意味着旧 sessionId 作废、需要重开会话。
 *
 * @param {unknown} error 抛出物。
 * @returns {boolean} 会话是否已失效。
 */
function isSessionGone(error) {
  const code = error?.code
  if (code === 'PROCESS_EXITED') return true
  const details = typeof error?.data?.details === 'string' ? error.data.details : ''
  if (/session\s+not\s+found/i.test(details)) return true
  const message = error instanceof Error ? error.message : String(error)
  return /session\s+not\s+found/i.test(message)
}

/**
 * 挑选鉴权方式。
 *
 * `internal`（微信登录）在已登录的机器上会静默复用缓存凭据；`iOA`/`external`/`selfhosted`
 * 会拉起浏览器并阻塞等待用户操作，在无人值守的 Host 里不能默认选它们。
 *
 * @param {{ id: string, name: string }[]} methods 可选方式。
 * @param {string} configured 配置里指定的方式（`auto` 表示自动）。
 * @returns {{ id: string, name: string } | undefined} 选中的方式。
 */
function pickAuthMethod(methods, configured) {
  if (methods.length === 0) return undefined
  if (configured !== 'auto') {
    return methods.find((method) => method.id === configured) ?? methods[0]
  }
  const exact = methods.find((method) => method.id === 'internal')
  if (exact !== undefined) return exact
  const byName = methods.find((method) => /微信|wechat|internal/i.test(`${method.id} ${method.name}`))
  if (byName !== undefined) return byName
  const silent = methods.find((method) => !/ioa|external|selfhosted/i.test(`${method.id} ${method.name}`))
  return silent ?? methods[0]
}

/**
 * 按配置回应权限请求。
 * @param {object} params `session/request_permission` 参数。
 * @param {string} policy `allow` / `deny`。
 * @returns {{ outcome: string, optionId?: string }} ACP outcome。
 */
function permissionOutcome(params, policy) {
  const options = Array.isArray(params.options) ? params.options : []
  const pick = (kinds, words) => {
    for (const kind of kinds) {
      const hit = options.find((option) => option?.kind === kind)
      if (hit !== undefined) return hit
    }
    for (const word of words) {
      const hit = options.find((option) => typeof option?.name === 'string' && word.test(option.name))
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (policy === 'deny') {
    const rejected = pick(['reject_once', 'reject_always'], [/拒绝/, /deny/i, /reject/i])
    return rejected === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: rejected.optionId }
  }
  const allowed = pick(['allow_always', 'allow_once'], [/允许/, /总是允许/, /allow/i, /accept/i])
  if (allowed !== undefined) return { outcome: 'selected', optionId: allowed.optionId }
  if (options.length > 0) return { outcome: 'selected', optionId: options[0].optionId }
  return { outcome: 'cancelled' }
}

/**
 * 一条 DSH 会话的运行态。
 */
class SessionRecord {
  /**
   * @param {string} key DSH 会话键。
   * @param {string} cwd 工作目录。
   */
  constructor(key, cwd) {
    this.key = key
    this.cwd = cwd
    /** @type {SharedConnection | undefined} */
    this.shared = undefined
    this.acpSessionId = undefined
    this.model = undefined
    /** 已写入 CodeBuddy 的思考档位（`undefined` 表示未知，需重新校准）。 */
    this.effort = undefined
    /** 已转发消息的签名。 */
    this.signatures = []
    this.lastUsedAt = Date.now()
    /** CodeBuddy 自己给的会话标题（来自 `session_info_update.title`）。 */
    this.codeBuddyTitle = undefined
    /** 当前这一轮的取消信号（权限询问要能被中断）。 */
    this.currentSignal = undefined
    /**
     * 暂存的**最终正文**，等下一个 step 才交给 DSH。
     *
     * 为什么不能和工具调用一起发：DSH 的 Chat 只把「最后一个 step 中不含 tool-call 块的
     * assistant 回复」认作最终答案（见 ui-chat 的 `latestAnswer`）。同一个 step 里既有
     * tool-call 块又有正文时，正文会被判定成过程内容，整轮一折叠结论就看不见了。
     *
     * 所以这一轮只要发生过工具调用，正文就先存在这里；回放工具因为参数里带了
     * `holdAnswer` 而**不结束本轮**，DSH 于是自然进入下一个 step，那一步只交出这段正文，
     * 它便落在一个干净的、不含 tool-call 块的消息里，整轮折叠也不会再把它收走。
     *
     * 只有「DSH 这次调用没有带新的用户消息」时才会交割（见 {@link CodeBuddyAdapter#run}），
     * 所以用户中途发新消息不会拿到一句过期的旧结论。
     */
    this.heldAnswer = undefined
  }
}

/**
 * CodeBuddy 的 LLM 适配器。
 *
 * 结构上满足 `LlmAdapter` 契约（宿主用方法调用做校验，不用 instanceof），
 * 因此不需要 import 任何 `@deepseek-ai/*` 运行时包。
 */
export class CodeBuddyAdapter {
  /**
   * @param {object} options 适配器依赖。
   * @param {object} options.config 生效配置。
   * @param {{ argv: string[], env: Record<string, string>, note: string }} options.launch 启动信息。
   * @param {object} options.host 宿主能力桥（见 index.js）。
   * @param {{ info?: Function, warn?: Function }} options.logger 日志器。
   * @param {{ enabled: string[] | null, order: string[], defaultModel?: string }} [options.policy]
   *   控制台页面维护的模型策略：启用集合、展示顺序、默认模型。
   * @param {(record: object) => Promise<void>} [options.onUsage] 每轮真实消耗的回调（写积分账本）。
   * @param {(options?: { force?: boolean }) => Promise<{ ok: boolean, rates: Record<string, any> }>} [options.fetchModelRates]
   *   账号侧权威倍率表。发行版 `product.json` 的倍率与账号实际计费口径不一致
   *   （实测 `deepseek-v4.1-flash` 静态表 `x0.00`、账号侧 `x0.11`），所以有它时优先用它。
   * @param {import('./tool-bridge.js').ToolCallBridge} [options.toolBridge]
   *   工具记录桥。给了它就走「原生 tool-call 块 + 回放工具」模式：
   *   CodeBuddy 的每次工具调用都会变成 DSH 会话里真正的工具卡片与工具结果。
   */
  constructor({ config, launch, host, logger, policy, onUsage, fetchModelRates, toolBridge, askPermission, onSessionTitle, onPlan }) {
    this.config = config
    this.launch = launch
    this.host = host
    this.logger = logger
    this.policy = normalizePolicy(policy)
    this.onUsage = onUsage
    this.fetchModelRates = fetchModelRates
    this.toolBridge = toolBridge
    /** @type {Map<string, string>} 按 DSH 会话分桶的计划指纹（避免同一份清单反复写事件）。 */
    this.lastPlanKeys = new Map()
    /**
     * 权限询问钩子：由 index.js 接到 `ctx.approval`。
     * @type {((request: object) => Promise<'allow' | 'deny' | undefined>) | undefined}
     */
    this.askPermission = askPermission
    /**
     * 会话标题钩子：CodeBuddy 发布标题时调用，由 index.js 接到 `ctx.sessionTitle.rename`。
     * @type {((event: { sessionId: string, title: string }) => void) | undefined}
     */
    this.onSessionTitle = onSessionTitle
    /**
     * 计划钩子：CodeBuddy 发 `plan` 时调用，由 index.js 映射成 DSH 的 `todo/write`。
     * @type {((event: { sessionId: string, entries: object[] }) => void) | undefined}
     */
    this.onPlan = onPlan
    /** @type {Map<string, SessionRecord>} */
    this.sessions = new Map()
    /** @type {Map<string, SharedConnection>} */
    this.connections = new Map()
    this.staticCatalog = undefined
    this.staticCatalogAt = 0
    /** 每个 DSH 会话的串行闸门。 */
    this.tails = new Map()
  }

  /**
   * 更新模型策略（控制台保存后立即生效，无需重启插件）。
   * @param {{ enabled?: string[] | null, order?: string[], defaultModel?: string }} policy 新策略。
   */
  setModelPolicy(policy) {
    this.policy = normalizePolicy(policy)
  }

  /**
   * 账号与连接快照：供控制台页面展示「当前是哪位用户、几个模型」。
   * @returns {object} 快照。
   */
  accountInfo() {
    const users = []
    let authMethods = []
    let modelsAt
    let currentModel
    for (const shared of this.connections.values()) {
      const user = shared.userinfo
      if (user !== null && typeof user === 'object' && typeof user.userId === 'string'
        && !users.some((item) => item.userId === user.userId)) {
        users.push(user)
      }
      if (authMethods.length === 0 && Array.isArray(shared.authMethods)) authMethods = shared.authMethods
      const live = shared.liveModels
      if (live !== undefined && (modelsAt === undefined || live.at > modelsAt)) {
        modelsAt = live.at
        currentModel = live.currentId
      }
    }
    return {
      users,
      authMethods,
      modelsAt,
      currentModel,
      connections: this.connections.size,
      provider: this.config.provider,
      displayName: this.config.displayName,
      command: this.config.command,
      launch: this.launch.note,
    }
  }

  /**
   * 完整模型目录（不受启用开关过滤，页面用它渲染全部可勾选项）。
   * @returns {Promise<object[]>} 目录条目，含 `enabled` / `default` / `credits`。
   */
  async catalogSnapshot() {
    const live = this.#liveCatalog()
    const entries = live !== undefined && live.length > 0 ? live : await this.#catalog()
    const enabled = this.policy.enabled
    return entries.map((entry) => ({
      ...entry,
      creditRate: entry.creditRate ?? parseCreditRate(entry.credits),
      enabled: enabled === null ? true : enabled.includes(entry.id),
      default: entry.id === this.policy.defaultModel,
    }))
  }

  /**
   * 让下一次模型列表重新读一遍 `codebuddy --help` 与产品目录。
   * @returns {Promise<number>} 重新探测到的模型数量。
   */
  async refreshCatalog() {
    this.staticCatalog = undefined
    this.staticCatalogAt = 0
    const catalog = await this.#catalog()
    return catalog.length
  }

  /** @returns {{ id: string, name: string }} provider 分组信息。 */
  providerInfo(provider) {
    return { id: provider, name: this.config.displayName }
  }

  /** @returns {object} 已解析的重试策略。 */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: Object.freeze(['SPAWN_FAILED', 'PROCESS_EXITED', 'TRANSPORT', 'TIMEOUT']),
      initialDelayMs: 800,
      maxDelayMs: 4000,
      jitterRatio: 0.2,
    })
  }

  /** @returns {undefined} 不做图片计价（额度制）。 */
  imageRequestPricing() {
    return undefined
  }

  /**
   * 声明这一路「发给 CodeBuddy 的图片」的尺寸与字节目标。
   *
   * 语义与 DSH 适配器契约一致：这里返回的必须就是**真正投递时用的那份目标**
   * （见 {@link CodeBuddyAdapter#imageTarget}）。CodeBuddy 侧不做缩放，
   * 所以尺寸沿用归一化后的原图，只把字节上限压到 `maxImageBytes`，
   * 让附件服务按需要降质量/降尺寸，而不是把超大图原样塞进 JSON-RPC。
   *
   * @param {string} _provider 路由名。
   * @param {string} _model 模型 id。
   * @param {{ width: number, height: number, bytes?: number }} image 图片引用。
   * @returns {{ width: number, height: number, maxBytes: number }} 投递目标。
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: this.config.maxImageBytes }
  }

  /**
   * 列出当前可选的 CodeBuddy 模型。
   *
   * 模型名后面拼上积分倍率（`×0.34`）：DSH 的模型选择器只渲染 `name`，
   * 这样不用改 DSH 的界面就能在每个模型旁边看到它消耗几倍积分。
   *
   * @param {string} provider 路由名。
   * @returns {Promise<object[]>} 模型信息。
   */
  async listModels(provider) {
    const catalog = this.#applyPolicy(await this.#catalog())
    return catalog.map((entry) => ({
      provider,
      id: entry.id,
      name: this.#decorateName(entry),
      description: this.#describeEntry(entry),
      inputModalities: entry.supportsImages ? ['text', 'image'] : ['text'],
    }))
  }

  /**
   * 拼模型描述：原有描述 + 思考档位概览。
   *
   * DSH 的模型选择器只渲染 `name`，`description` 会作为副标题出现，
   * 在这里标出档位能让用户在选模型前就知道这个模型支持几档思考。
   *
   * @param {{ description?: string, effortOptions?: string[] }} entry 目录条目。
   * @returns {string | undefined} 描述。
   */
  #describeEntry(entry) {
    const efforts = Array.isArray(entry.effortOptions) ? entry.effortOptions.filter((id) => id !== 'enabled') : []
    const suffix = efforts.length === 0 ? undefined : `思考档位：${efforts.join(' / ')}`
    return [entry.description, suffix].filter((item) => typeof item === 'string' && item !== '').join(' · ') || undefined
  }

  /**
   * 解析模型元数据。
   * @param {string} provider 路由名。
   * @param {string} model 模型 id。
   * @returns {Promise<object>} 已解析的模型信息。
   */
  async resolveModel(provider, model) {
    const catalog = await this.#catalog()
    const entry = catalog.find((candidate) => candidate.id === model)
    const efforts = this.#effortsFor(model, entry)
    return {
      provider,
      id: model,
      name: entry === undefined ? friendlyModelName(model) : this.#decorateName(entry),
      description: entry === undefined ? undefined : this.#describeEntry(entry),
      inputModalities: entry?.supportsImages ? ['text', 'image'] : ['text'],
      context: { contextWindow: entry?.contextWindow ?? this.config.contextWindow },
      defaultMaxTokens: entry?.maxTokens ?? this.config.maxTokens,
      // DSH 用这一项决定模型选择器里能不能选思考档位（缺了就只有模型本身可选）。
      reasoning: efforts.length === 0
        ? undefined
        : {
          efforts,
          defaultEffort: this.#defaultEffort(model, efforts),
        },
    }
  }

  /**
   * 取某个模型可用的思考档位（DSH 形态）。
   *
   * 三路来源按可信度排序：会话侧 `thought_level.options`（本进程实测） >
   * 会话侧 `models.availableModels[]._meta.effortOptions` > 目录快照 `KNOWN_EFFORTS`。
   *
   * @param {string} model 模型 id。
   * @param {object | undefined} entry 目录条目。
   * @returns {Array<{ id: string, name: string, description?: string }>} 档位描述。
   */
  #effortsFor(model, entry) {
    let live
    for (const shared of this.connections.values()) {
      // 档位集合随模型变化，只有「当前会话模型就是这个模型」时 thought_level 才可信。
      const thought = shared.thoughtLevel
      if (thought === undefined || thought.options.length === 0) continue
      if (shared.liveModels?.currentId !== model && shared.liveModels?.currentId !== undefined) continue
      live = thought.options
      break
    }
    if (live === undefined && Array.isArray(entry?.effortOptions)) live = entry.effortOptions
    return describeEfforts(effortsForModel(model, live))
  }

  /**
   * 选默认档位：优先 CodeBuddy 自己记着的当前值，其次取「高」档（存在时），最后取末档。
   *
   * 为什么不取第一档：CodeBuddy 的档位列表是**由低到高**排的，
   * 取第一档等于把每个新会话都悄悄降成最省的模式，用户会以为「思考变弱了」。
   *
   * @param {string} model 模型 id。
   * @param {Array<{ id: string }>} efforts 档位列表。
   * @returns {string | undefined} 默认档位 id。
   */
  #defaultEffort(model, efforts) {
    const ids = efforts.map((item) => item.id)
    for (const shared of this.connections.values()) {
      const thought = shared.thoughtLevel
      if (thought?.currentValue === undefined || thought.currentValue === 'enabled') continue
      if (shared.liveModels?.currentId !== undefined && shared.liveModels.currentId !== model) continue
      if (ids.includes(thought.currentValue)) return thought.currentValue
    }
    if (ids.includes('high')) return 'high'
    return ids[ids.length - 1]
  }

  /**
   * 在模型名后拼积分倍率。
   * @param {{ name: string, creditRate?: number }} entry 目录条目。
   * @returns {string} 展示名。
   */
  #decorateName(entry) {
    const rate = formatCreditRate(entry.creditRate)
    return rate === undefined ? entry.name : `${entry.name} ${rate}`
  }

  /**
   * 按控制台的启用集合与顺序过滤模型目录。
   *
   * `enabled === null` 表示「全部启用」；空数组表示「全部关闭」。
   * 关闭的模型只是不出现在选择器里，仍可通过历史记录解析名字。
   *
   * @param {object[]} entries 原始目录。
   * @returns {object[]} 过滤并排序后的目录。
   */
  #applyPolicy(entries) {
    const enabled = this.policy.enabled
    let list = enabled === null ? entries.slice() : entries.filter((entry) => enabled.includes(entry.id))
    const order = this.policy.order
    if (order.length > 0) {
      const rank = new Map(order.map((id, index) => [id, index]))
      list = list
        .map((entry, index) => ({ entry, index }))
        .sort((left, right) => {
          const leftRank = rank.get(left.entry.id) ?? Number.MAX_SAFE_INTEGER
          const rightRank = rank.get(right.entry.id) ?? Number.MAX_SAFE_INTEGER
          return leftRank === rightRank ? left.index - right.index : leftRank - rightRank
        })
        .map((item) => item.entry)
    }
    return list
  }

  /**
   * 绑定一次调用。
   * @param {string} provider 路由名。
   * @param {string} model 模型 id。
   * @returns {Promise<{ model: object, stream: (options: object) => AsyncIterable<object> }>} 准备好的调用。
   */
  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      stream: (options) => this.stream({ ...options, provider, model }),
    }
  }

  /**
   * 流式产生一轮结果。
   * @param {object} options `GenerateOptions`。
   * @returns {AsyncIterable<object>} `StreamChunk` 序列。
   */
  stream(options) {
    const generator = this.#run(options)
    return {
      [Symbol.asyncIterator]() { return this },
      next: (value) => generator.next(value),
      return: (value) => generator.return(value),
      throw: (error) => generator.throw(error),
    }
  }

  /**
   * 卸载：关闭所有连接。
   * @returns {Promise<void>} 完成。
   */
  async dispose() {
    const connections = [...this.connections.values()]
    this.connections.clear()
    this.sessions.clear()
    await Promise.all(connections.map((shared) => shared.close()))
  }

  /**
   * 取模型目录：优先用「本进程已经见过」的账号可用模型，其次读包内 product.json。
   *
   * 倍率一律**以账号侧服务端为准**：包内 `product.json` 是发行版写死的静态表，
   * 与账号实际计费口径不一致（实测 `deepseek-v4.1-flash` 静态表 `x0.00`、
   * 账号侧 `x0.11`），只信它会显示出错误的「免费」。
   *
   * @returns {Promise<object[]>} 目录。
   */
  async #catalog() {
    const live = this.#liveCatalog()
    if (live !== undefined && live.length > 0) return this.#applyRates(live)

    const now = Date.now()
    if (this.staticCatalog !== undefined && now - this.staticCatalogAt < 10 * 60 * 1000) {
      // 缓存里已含账号侧倍率；但账号倍率可能先拿不到、后拿到，这里再补一次覆盖。
      return await this.#applyRates(this.staticCatalog)
    }
    const catalog = await buildCatalog({
      config: this.config,
      launch: this.launch.argv,
      cwd: this.host.defaultDirectory(),
      logger: this.logger,
    })
    // 先用静态目录兜底，再让账号侧的真实倍率覆盖它。
    const merged = await this.#applyRates(catalog.length > 0 ? catalog : [{
      id: this.config.defaultModel ?? 'default',
      name: this.config.defaultModel ?? 'CodeBuddy 默认模型',
      description: 'CodeBuddy 默认模型',
      contextWindow: this.config.contextWindow,
      maxTokens: this.config.maxTokens,
      supportsImages: false,
    }])
    this.staticCatalog = merged
    this.staticCatalogAt = now
    return this.staticCatalog
  }

  /**
   * 用账号侧倍率覆盖目录里的倍率；服务端没有该模型时保留原值。
   * @param {object[]} entries 目录条目。
   * @returns {Promise<object[]>} 覆写后的条目。
   */
  async #applyRates(entries) {
    if (this.fetchModelRates === undefined) return entries
    let table
    try {
      table = await this.fetchModelRates()
    } catch (error) {
      this.logger.warn?.(`dsh-codebuddy-acp: 读取账号倍率失败，沿用模型目录自带倍率：${error instanceof Error ? error.message : String(error)}`)
      return entries
    }
    const rates = table?.ok === true && table.rates !== null && typeof table.rates === 'object' ? table.rates : undefined
    if (rates === undefined) return entries
    return entries.map((entry) => {
      const hit = rates[entry.id]
      if (hit === undefined || typeof hit.creditRate !== 'number' || !Number.isFinite(hit.creditRate)) return entry
      return {
        ...entry,
        creditRate: hit.creditRate,
        credits: typeof hit.credits === 'string' && hit.credits !== '' ? hit.credits : entry.credits,
        rateSource: 'account',
      }
    })
  }

  /**
   * 汇总所有连接上报过的账号可用模型（最近一次为准）。
   * @returns {object[] | undefined} 目录条目。
   */
  #liveCatalog() {
    /** @type {{ list: object[], at: number } | undefined} */
    let newest
    for (const shared of this.connections.values()) {
      const live = shared.liveModels
      if (live === undefined) continue
      if (newest === undefined || live.at >= newest.at) newest = live
    }
    if (newest === undefined) return undefined
    let list = newest.list
    if (this.config.models !== undefined) {
      const order = new Map(this.config.models.map((id, index) => [id, index]))
      list = list.filter((entry) => order.has(entry.id)).sort((left, right) => order.get(left.id) - order.get(right.id))
    }
    return list.map((entry) => ({
      id: entry.id,
      name: entry.name ?? friendlyModelName(entry.id),
      description: entry.description,
      credits: entry.credits,
      creditRate: parseCreditRate(entry.credits),
      contextWindow: entry.contextWindow ?? this.config.contextWindow,
      maxTokens: this.config.maxTokens,
      supportsImages: entry.supportsImages === true,
      supportsReasoning: entry.supportsReasoning === true,
      effortOptions: Array.isArray(entry.effortOptions) && entry.effortOptions.length > 0
        ? entry.effortOptions
        : effortsForModel(entry.id, undefined),
    }))
  }

  /**
   * 取（或建立）某个工作目录的共享连接。
   * @param {string} cwd 工作目录。
   * @returns {SharedConnection} 连接。
   */
  #shared(cwd) {
    let shared = this.connections.get(cwd)
    if (shared !== undefined && shared.state !== 'dead') {
      shared.lastUsedAt = Date.now()
      return shared
    }
    if (shared !== undefined) this.connections.delete(cwd)
    shared = new SharedConnection({
      cwd,
      config: this.config,
      launch: this.launch,
      host: this.host,
      logger: this.logger,
    })
    // 权限请求要能问回 DSH（见 #askPermission）；闭包捕获适配器，连接本身不关心 DSH 概念。
    shared.onPermission = (params) => this.#askPermission(params)
    this.connections.set(cwd, shared)
    this.#evictIdle(cwd)
    return shared
  }

  /**
   * 从 CodeBuddy 的任务工具结果里捞任务清单，同步给 DSH。
   *
   * @param {string} sessionId DSH 会话键（用于去重分桶）。
   * @param {object} update `tool_call_update` 载荷。
   */
  #absorbTodos(sessionId, update) {
    if (this.config.syncPlan !== true || typeof this.onPlan !== 'function') return
    const todos = update?._meta?.['codebuddy.ai/rawResponse']?.todos
    if (!Array.isArray(todos) || todos.length === 0) return
    const list = []
    for (const item of todos) {
      const content = typeof item?.content === 'string' && item.content.trim() !== ''
        ? item.content.trim()
        : typeof item?.subject === 'string' ? item.subject.trim() : ''
      if (content === '') continue
      list.push({ content, status: normalizePlanStatus(item?.status) })
    }
    if (list.length === 0) return
    this.#emitPlan({ sessionId, entries: list })
  }

  /**
   * 计划去重 + 转发（主通路：CodeBuddy 自己的任务清单）。
   * @param {{ entries: { content: string, status: string }[] }} plan 计划。
   */
  #emitPlan(plan) {
    const forward = this.onPlan
    if (typeof forward !== 'function' || plan.entries.length === 0) return
    const key = plan.entries.map((item) => `${item.status}:${item.content}`).join('|')
    const sessionId = plan.sessionId
    // 指纹按会话记：不同 DSH 会话的同构清单不该互相压掉。
    if (this.lastPlanKeys.get(sessionId) === key) return
    this.lastPlanKeys.set(sessionId, key)
    forward({ sessionId, entries: plan.entries })
  }

  /**
   * 把 CodeBuddy 的计划转给 DSH（由 index.js 落成 `todo/write`）。
   *
   * 两种来源走同一套去重与转发：
   *
   * - **主通路**：`TaskCreate` / `TaskUpdate` 的 `_meta['codebuddy.ai/rawResponse'].todos`
   *   （见 {@link #absorbTodos}）——实测 CodeBuddy 只走这条；
   * - **兼容通路**：标准 ACP `sessionUpdate:"plan"` 通知——实测从不发，但留着。
   *
   * 去重指纹走 {@link #emitPlan} 的**按会话**分桶（`lastPlanKeys`）：
   * 旧实现用一个全局 `lastPlanKey`，多个会话并发时后到的计划会把前一个的指纹覆盖掉，
   * 于是「同构清单」要么被误压、要么重复写事件。
   *
   * @param {SessionRecord} record 会话运行态。
   * @param {object[]} entries ACP `plan.entries`。
   */
  #forwardPlan(record, entries) {
    const list = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      const content = typeof entry?.content === 'string' ? entry.content.trim() : ''
      if (content === '') continue
      list.push({ content, status: normalizePlanStatus(entry?.status) })
    }
    if (list.length === 0) return
    try {
      this.#emitPlan({ sessionId: record.key, entries: list })
    } catch (error) {
      this.logger.warn?.(`dsh-codebuddy-acp: 同步计划到 DSH 待办失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 把 ACP 的 `session/request_permission` 转成 DSH 的审批询问。
   *
   * @param {object} params ACP 请求参数。
   * @returns {Promise<object | undefined>} ACP outcome（`undefined` 表示交回旧策略）。
   */
  async #askPermission(params) {
    return resolvePermissionRequest({
      sessions: this.sessions,
      ask: this.askPermission,
      logger: this.logger,
      params,
    })
  }

  /**
   * 回收空闲连接。
   * @param {string} keepCwd 必须保留的目录。
   */
  #evictIdle(keepCwd) {
    const now = Date.now()
    const entries = [...this.connections.entries()].filter(([cwd]) => cwd !== keepCwd)
    for (const [cwd, shared] of entries) {
      if (now - shared.lastUsedAt <= IDLE_TTL_MS) continue
      this.connections.delete(cwd)
      void shared.close()
    }
    const alive = [...this.connections.entries()].filter(([cwd]) => cwd !== keepCwd)
    if (alive.length <= MAX_IDLE_CONNECTIONS) return
    alive
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
      .slice(0, alive.length - MAX_IDLE_CONNECTIONS)
      .forEach(([cwd, shared]) => {
        this.connections.delete(cwd)
        void shared.close()
      })
  }

  /**
   * 按会话串行执行。
   * @param {string} key 会话键。
   * @returns {Promise<() => void>} 释放函数。
   */
  async #acquire(key) {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const chained = previous.then(() => gate)
    this.tails.set(key, chained)
    await previous.catch(() => {})
    return () => {
      release()
      if (this.tails.get(key) === chained) this.tails.delete(key)
    }
  }

  /**
   * 主流程。
   * @param {object} options `GenerateOptions`。
   * @returns {AsyncGenerator<object>} chunk 序列。
   */
  async *#run(options) {
    if (options.purpose !== undefined) {
      yield* this.#auxiliary(options, options.purpose)
      return
    }

    const messages = Array.isArray(options.messages) ? options.messages : []
    if (messages.length === 0) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const sessionKey = typeof options.sessionId === 'string' && options.sessionId.length > 0
      ? options.sessionId
      : 'anonymous'
    const model = typeof options.model === 'string' && options.model.length > 0
      ? options.model
      : this.policy.defaultModel ?? this.config.defaultModel
    // DSH 的 `reasoningEffort` 直接映射成 CodeBuddy 的 `thought_level`。
    // 它是**会话级**设置，所以在 #ensureSession 里写、在每轮开始前校准。
    const effort = typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0
      ? options.reasoningEffort
      : this.config.defaultThoughtLevel
    const cwd = await this.host.resolveCwd(sessionKey)

    let record = this.sessions.get(sessionKey)
    if (record !== undefined && record.cwd !== cwd) {
      this.sessions.delete(sessionKey)
      record = undefined
    }
    if (record === undefined) {
      record = new SessionRecord(sessionKey, cwd)
      this.sessions.set(sessionKey, record)
    }

    const plan = this.#plan(record, messages)
    let pending = plan.pending
    // 上一轮攒下、还没交出去的正文（见 SessionRecord#heldAnswer）：
    // 若这次新增的消息里**没有新的用户输入**（只有上一段留下的 assistant/tool 消息），
    // 说明 DSH 是被回放工具推动着进入下一个 step，正是交割时机；
    // 用户真的发了新消息则丢掉旧结论，免得拿过期内容当回答。
    if (record.heldAnswer !== undefined && !pending.some((message) => message?.role === 'user')) {
      const answer = record.heldAnswer
      record.heldAnswer = undefined
      // 这段正文就是「这一轮的最终结论」：不再向 CodeBuddy 发 prompt，直接交出。
      yield* this.#deliverHeldAnswer(record, answer, pending)
      return
    }
    record.heldAnswer = undefined
    if (pending.length === 0) {
      const lastUser = [...messages].reverse().find((message) => message?.role === 'user')
      pending = lastUser === undefined ? [] : [lastUser]
    }
    if (pending.length === 0) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const release = await this.#acquire(sessionKey)
    try {
      yield* this.#turn({
        record,
        model,
        effort,
        pending,
        all: messages,
        first: plan.reset,
        signal: options.signal,
      })
    } finally {
      release()
    }
  }

  /**
   * 判断消息前缀是否与已转发的一致。
   * @param {SessionRecord} record 运行态。
   * @param {readonly object[]} messages 本次请求的完整消息。
   * @returns {{ pending: object[], reset: boolean }} 投喂计划。
   */
  #plan(record, messages) {
    if (record.acpSessionId === undefined) return { pending: messages.slice(), reset: true }
    if (record.signatures.length > messages.length) return { pending: messages.slice(), reset: true }
    for (let index = 0; index < record.signatures.length; index += 1) {
      if (signatureOf(messages[index]) !== record.signatures[index]) {
        return { pending: messages.slice(), reset: true }
      }
    }
    return { pending: messages.slice(record.signatures.length), reset: false }
  }

  /**
   * 确保 ACP 会话存在，并把模型调整到期望值。
   * @param {SessionRecord} record 运行态。
   * @param {string | undefined} model 期望模型。
   * @param {string | undefined} effort 思考档位。
   * @param {AbortSignal | undefined} signal 取消信号。
   * @returns {Promise<{ shared: SharedConnection, sessionId: string, recreated: boolean }>}
   *   连接与会话；`recreated` 表示这条 ACP 会话是**这一轮才新建**的（上下文是空的，
   *   调用方必须用完整历史重放，而不是只投喂增量）。
   */
  async #ensureSession(record, model, effort, signal) {
    const shared = this.#shared(record.cwd)
    await shared.ensure(signal)
    let recreated = false

    // 连接被换掉了（进程崩溃重启、空闲回收、超过空闲上限被淘汰）：旧 ACP 会话已经不存在，
    // 继续拿旧 sessionId 发 prompt 只会拿到 -32603 Session not found，而且**之后每一轮都会失败**。
    // 这里主动作废会话，让下面的分支走「新建会话 + 重放历史」。
    if (record.acpSessionId !== undefined && record.shared !== undefined && record.shared !== shared) {
      this.logger.warn?.('dsh-codebuddy-acp: CodeBuddy 进程已更换，ACP 会话失效，将重开会话并重放历史')
      record.acpSessionId = undefined
      record.signatures = []
      record.effort = undefined
      record.heldAnswer = undefined
    }

    if (record.acpSessionId === undefined) {
      const created = await shared.createSession(model, signal)
      record.shared = shared
      record.acpSessionId = created.sessionId
      record.model = created.model ?? model
      record.signatures = []
      record.effort = undefined
      recreated = true
      this.logger.info?.(`dsh-codebuddy-acp: 已建立 ACP 会话 ${created.sessionId}（cwd=${record.cwd}）`)
    } else if (model !== undefined && record.model !== model) {
      const applied = await shared.trySetModel(record.acpSessionId, model, signal)
      if (applied) {
        record.model = model
        // 换模型后档位集合可能变了，强制重新校准一次。
        record.effort = undefined
      } else {
        // 账号不支持这个模型：新开一条 ACP 会话并重放历史，避免把上下文丢在旧会话里。
        const created = await shared.createSession(model, signal)
        record.acpSessionId = created.sessionId
        record.model = created.model ?? model
        record.effort = undefined
        record.signatures = []
        recreated = true
        this.logger.warn?.(`dsh-codebuddy-acp: 模型 ${model} 无法在当前会话切换，已新开会话 ${created.sessionId}`)
      }
    }

    // 思考档位：CodeBuddy 侧是会话级设置，且档位集合随模型变化，
    // 因此每次与上次写入值不同时才发一次 set_config_option（失败只记日志，不阻断这一轮）。
    if (effort !== undefined && record.effort !== effort) {
      const ok = await shared.trySetThoughtLevel(record.acpSessionId, effort, signal)
      record.effort = ok ? effort : undefined
    }

    record.shared = shared
    return { shared, sessionId: record.acpSessionId, recreated }
  }

  /**
   * 把消息里的图片读成 ACP 的 image 内容块。
   *
   * 为什么不能只靠提示词：ACP 的 `session/prompt` 支持
   * `{ type:'image', data:<canonical base64>, mimeType }`（`promptCapabilities.image = true`），
   * 图片走内容块才是**真的把像素交给模型**；写成 `[图片附件：a.png]` 等于让模型凭空猜。
   *
   * 三条设计约束：
   * - **不阻断这一轮**：没有图片服务、读失败、超上限，都只把原因记进 `notes`，
   *   正文标号会显示「（未发送：原因）」，模型因此不会以为自己看见了图。
   * - **不重发历史截图**：重放完整历史时按 `replayImages` 决定投哪些图，
   *   默认只投最后一条用户消息的图（`latest`），避免每次重开会话都重发一遍历史截图。
   * - **去重**：附件是内容寻址的，同一张图出现两次只发一份。
   *
   * @param {readonly object[]} messages 本轮要投喂的消息。
   * @param {{ replay: boolean, signal: AbortSignal | undefined }} options 是否重放 + 取消信号。
   * @returns {Promise<{ blocks: object[], notes: Map<string, string> }>} ACP 图片内容块与未投递原因。
   */
  async #deliverImages(messages, options) {
    /** @type {object[]} */
    const blocks = []
    /** @type {Map<string, string>} */
    const notes = new Map()
    const { refs, groups } = collectImageRefs(messages)
    if (refs.length === 0) return { blocks, notes }

    /** 整批都不能发的原因（例如根本没挂载图片服务）：所有图共用一个附注。 */
    const failAll = (reason) => {
      for (const ref of refs) notes.set(ref.attachmentId, reason)
      return { blocks, notes }
    }

    if (this.config.imageInput !== true) return failAll('未发送：本组合关闭了图片投递')
    const reader = typeof this.host?.readImage === 'function' ? this.host.readImage : undefined
    if (reader === undefined) return failAll('未发送：宿主没有提供图片服务')

    const selected = new Set(selectImageIndexes({
      messages,
      groups,
      replay: options.replay === true,
      mode: this.config.replayImages,
    }))
    // 没被选中的图（重放时被策略裁掉的历史图）在正文里说清「没重放」，而不是假装发过。
    for (let index = 0; index < refs.length; index += 1) {
      if (!selected.has(index)) notes.set(refs[index].attachmentId, '历史图片未重放')
    }

    const limit = this.config.maxImagesPerPrompt
    const seen = new Set()
    let delivered = 0
    for (let index = 0; index < refs.length; index += 1) {
      if (!selected.has(index)) continue
      const ref = refs[index]
      if (seen.has(ref.attachmentId)) continue
      if (delivered >= limit) {
        notes.set(ref.attachmentId, `未发送：一次最多 ${limit} 张图`)
        continue
      }
      try {
        const image = await reader(ref, this.#imageTarget(ref), options.signal)
        if (image === undefined || typeof image.data !== 'string' || image.data === '') {
          throw new Error('图片服务返回空数据')
        }
        const mediaType = typeof image.mediaType === 'string' ? image.mediaType : ref.mediaType
        blocks.push({ type: 'image', data: image.data, mimeType: mediaType })
        seen.add(ref.attachmentId)
        delivered += 1
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        notes.set(ref.attachmentId, `未发送：${reason}`)
        this.logger.warn?.(`dsh-codebuddy-acp: 读取图片失败（${ref.attachmentId}）：${reason}`)
      }
    }
    return { blocks, notes }
  }

  /**
   * 取某张图这一轮要投递的目标尺寸与字节上限。
   * @param {object} ref 图片引用。
   * @returns {{ width: number, height: number, maxBytes: number }} 投递目标。
   */
  #imageTarget(ref) {
    const width = Number.isFinite(ref?.width) ? ref.width : 0
    const height = Number.isFinite(ref?.height) ? ref.height : 0
    return { width, height, maxBytes: this.config.maxImageBytes }
  }

  /**
   * 一轮完整 prompt。
   * @param {object} params 参数。
   * @param {SessionRecord} params.record 运行态。
   * @param {string | undefined} params.model 模型。
   * @param {string | undefined} params.effort 思考档位。
   * @param {object[]} params.pending 待投喂消息。
   * @param {readonly object[]} params.all 本次请求的完整历史（会话失效重试时用它重放）。
   * @param {boolean} params.first 是否全量重放。
   * @param {AbortSignal | undefined} params.signal 取消信号。
   * @param {number} [params.attempt] 第几次尝试（0 表示首次；会话失效只重试一次）。
   * @returns {AsyncGenerator<object>} chunk 序列。
   */
  async *#turn({ record, model, effort, pending, all, first, signal, attempt = 0 }) {
    // 空内容（例如只有工具结果）直接结束，不必白开一条 ACP 会话。
    // 纯图片消息（用户只贴图不打字）必须算「有内容」，否则会被静默丢弃。
    if (!hasDeliverable(pending)) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    let shared
    let sessionId
    // 这一轮实际投喂了哪些消息（重建会话时要换成完整历史，签名也要按它记）。
    let sent = pending
    // 会话是这一轮才建的 → 它那边上下文是空的，只投喂增量等于让模型失忆。
    // 这种情况（首次、进程重建、换模型降级重开）必须用完整历史重放。
    let replaying = false
    try {
      const ensured = await this.#ensureSession(record, model, effort, signal)
      shared = ensured.shared
      sessionId = ensured.sessionId
      if (ensured.recreated && Array.isArray(all) && all.length > pending.length) {
        sent = all
        replaying = true
      }
    } catch (error) {
      yield* fail(this.#explain(error))
      return
    }

    // 图片：先把这一轮要投递的图片读成 base64，再渲染正文（标号要跟实际投递顺序一致），
    // 最后拼成 ACP 的 `[{type:'text'}, {type:'image'}…]`。任何一张读不出来都不阻断这一轮，
    // 只是把原因写进正文标号，模型因此不会以为自己看见了那张图。
    const images = await this.#deliverImages(sent, { replay: replaying, signal })
    const text = renderMessages(sent, { first: replaying || first, notes: images.notes })
    if (text.trim() === '' && images.blocks.length === 0) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const promptContent = []
    if (text.trim() !== '') promptContent.push({ type: 'text', text })
    for (const block of images.blocks) promptContent.push(block)

    const connection = shared.connection
    if (connection === undefined) {
      yield* fail(new AcpError('CodeBuddy 连接在建立会话后立即断开', { code: 'PROCESS_EXITED' }))
      return
    }

    const queue = new ChunkQueue()
    const replay = this.config.toolReplay !== false && this.toolBridge?.ready === true
    const narration = replay ? 'off' : (this.config.toolNarration === 'auto' ? 'reasoning' : this.config.toolNarration)
    const emitter = new TurnEmitter(queue, {
      bridge: this.toolBridge,
      toolName: this.config.toolName,
      replay,
      narration,
      emitOn: this.config.toolEmit,
      inputLimit: this.config.toolInputLimit,
      onToolUpdate: (sessionKey, update) => this.#absorbTodos(sessionKey, update),
    })
    const ledger = new UsageLedger()
    let settled = false
    // 权限询问要能被这一轮的取消打断。
    record.currentSignal = signal
    const unsubscribe = connection.onUpdate(sessionId, (update) => {
      if (update === null || typeof update !== 'object') return
      if (this.config.logLevel === 'info') {
        this.logger.info?.(`[acp update] ${String(update.sessionUpdate)} ${JSON.stringify(update).slice(0, 600)}`)
      }
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const content = update.content
          if (content?.type === 'text' && typeof content.text === 'string') emitter.pushText(content.text)
          break
        }
        case 'agent_thought_chunk': {
          const content = update.content
          if (content?.type === 'text' && typeof content.text === 'string') emitter.pushReasoning(content.text)
          break
        }
        case 'tool_call':
          emitter.toolCall(update)
          break
        case 'tool_call_update':
          emitter.toolUpdate(update, record.key)
          break
        case 'plan': {
          const entries = Array.isArray(update.entries) ? update.entries : []
          // 新：把 CodeBuddy 的计划同步成 DSH 的待办（todo/write），界面直接出待办面板。
          this.#forwardPlan(record, entries)
          if (narration === 'off') break
          const summary = entries
            .map((entry) => `${entry?.status === 'completed' ? '✓' : '●'} ${entry?.content ?? ''}`)
            .join('\n')
          if (summary !== '') emitter.pushActivity(narration === 'text' ? 'text' : 'reasoning', `[计划]\n${summary}\n`)
          break
        }
        case 'usage_update': {
          // 两种形态：只带 used/size 的是上下文占用；带 _meta.usage 的是**某一轮模型请求**的结算。
          // 交给账本按 messageId 归并，既避免重复帧翻倍，又不丢多轮请求的用量。
          ledger.record(update)
          break
        }
        case 'session_info_update': {
          // 标题：CodeBuddy 会在跑完第一轮后发布自己的会话标题，这里直接接管 DSH 的标题。
          const title = typeof update.title === 'string' ? update.title.trim() : ''
          if (title !== '' && record.codeBuddyTitle !== title) {
            record.codeBuddyTitle = title
            this.onSessionTitle?.({ sessionId: record.key, title })
          }
          // 阶段机：把 CodeBuddy 的 agentPhase 变成一行状态。
          // 只在「还没有正文」时播报：答案已经开始输出后再刷状态就是纯噪声。
          const phase = update._meta?.['codebuddy.ai/agentPhase']
          if (narration !== 'off' && typeof phase?.phase === 'string' && !emitter.hasAnswerText()) {
            emitter.phase(phase.phase, phase.toolName, phase.streamingToolName)
          }
          break
        }
        case 'current_mode_update':
          if (this.config.logLevel === 'info') this.logger.info?.(`[acp update] mode=${String(update.currentModeId)}`)
          break
        default:
          if (this.config.logLevel === 'info') {
            this.logger.info?.(`[acp update] ${String(update.sessionUpdate)}`)
          }
          break
      }
    })

    let stopReason
    let failure
    let releaseGate
    try {
      releaseGate = await shared.acquire()
    } catch (error) {
      unsubscribe()
      yield* fail(this.#explain(error))
      return
    }

    // 用户中断时必须**先告诉 agent**：只本地放弃请求的话，CodeBuddy 会继续把这一轮
    // 跑完（继续烧额度），而且在它眼里这条 ACP 会话一直是「忙」的，下一轮可能被拒或串行等待。
    // ACP 的取消是通知 `session/cancel`，agent 收到后会把 `session/prompt` 结算成
    // `stopReason: "cancelled"`。所以这里发通知后给一小段宽限期等它体面收尾，
    // 超时才本地中断（`cancelGraceMs`，0 表示只发通知不等回执）。
    const abortController = typeof AbortController === 'function' ? new AbortController() : undefined
    /** @type {NodeJS.Timeout | undefined} */
    let cancelTimer
    const sendCancel = () => {
      try {
        connection.cancel(sessionId)
      } catch {
        // 连接可能已断开。
      }
    }
    const onAbort = () => {
      sendCancel()
      if (abortController === undefined) return
      const grace = this.config.cancelGraceMs
      if (!(grace > 0)) {
        abortController.abort()
        return
      }
      cancelTimer = setTimeout(() => abortController.abort(), grace)
      cancelTimer.unref?.()
    }
    const requestSignal = abortController?.signal ?? signal
    if (signal?.aborted === true) {
      // 信号在发请求前就已经中断：通知一下 agent，然后立刻本地放弃，没必要等宽限期。
      sendCancel()
      abortController?.abort()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const completion = connection
        .prompt(sessionId, promptContent, {
          signal: requestSignal,
          timeoutMs: this.config.turnTimeoutMs > 0 ? this.config.turnTimeoutMs : undefined,
        })
        .then((result) => {
          settled = true
          stopReason = result.stopReason
          if (result.usage !== undefined) {
            // PromptResponse 实测不带 usage；这条分支只在未来协议变化时才有意义。
            // 用固定键，避免与 usage_update 的 messageId 撞车而重复计数。
            ledger.record({ _meta: { 'codebuddy.ai/messageId': 'promptResult', usage: result.usage } })
          }
        })
        .catch((error) => {
          settled = true
          failure = error
        })
        .finally(() => {
          if (cancelTimer !== undefined) clearTimeout(cancelTimer)
          signal?.removeEventListener('abort', onAbort)
          unsubscribe()
          record.lastUsedAt = Date.now()
          queue.end()
        })

      // 先把流式更新边到边发出去，再等 prompt 收口。
      for await (const chunk of queue) yield chunk
      await completion
    } finally {
      if (cancelTimer !== undefined) clearTimeout(cancelTimer)
      signal?.removeEventListener('abort', onAbort)
      if (!settled) {
        // 宿主提前关闭迭代器（例如用户中断）：让 CodeBuddy 结束这一轮。
        try {
          connection.cancel(sessionId)
        } catch {
          // 连接可能已断开。
        }
        unsubscribe()
        queue.end()
      }
      releaseGate?.()
      record.currentSignal = undefined
    }

    const { usage, credits: turnCredits } = ledger.total()

    if (this.onUsage !== undefined && (turnCredits > 0 || usage !== undefined)) {
      try {
        await this.onUsage({
          sessionId: record.key,
          model: record.model ?? model,
          credits: turnCredits,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          totalTokens: usage?.totalTokens,
          at: Date.now(),
        })
      } catch (error) {
        this.logger.warn?.(`dsh-codebuddy-acp: 记录积分用量失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (signal?.aborted !== true && failure === undefined) {
      record.signatures = [...record.signatures, ...sent.map((message) => signatureOf(message))]
    }

    // 收口：先把滞留的工具调用发出去，再关掉还开着的块。
    // 回放模式下不再补「本轮工具调用」摘要——工具已经是原生卡片，各带自己的结果。
    for (const chunk of emitter.close()) yield chunk
    for (const chunk of emitter.summary()) yield chunk

    // 正文被整体暂存了（这一轮既有工具调用、正文又全部攒住）：把它留给下一个 step。
    // 同时给本轮的每条工具记录打上 `holdAnswer`，回放工具据此**不结束本轮**，
    // DSH 于是自然再走一步来收这段正文（见 {@link #markHeldAnswer}）。
    if (signal?.aborted !== true && failure === undefined && emitter.holdsAnswer) {
      record.heldAnswer = emitter.heldText
      emitter.heldText = ''
      emitter.markHeldAnswer()
    }

    if (signal?.aborted === true) {
      yield { type: 'finish', reason: mapStopReason(stopReason, true) }
      return
    }
    // 会话在 agent 侧已经不存在（进程被回收/重启、会话被关掉），而这一轮**还没吐出任何块**：
    // 作废会话态，用完整历史在新会话上重放一次。不重试的话，这条 DSH 会话之后每一轮都会失败。
    if (failure !== undefined && attempt === 0 && isSessionGone(failure) && emitter.nextIndex === 0) {
      this.logger.warn?.(`dsh-codebuddy-acp: ACP 会话已失效（${failure instanceof Error ? failure.message : String(failure)}），重开会话并重放历史后重试`)
      record.acpSessionId = undefined
      record.shared = undefined
      record.signatures = []
      record.effort = undefined
      record.heldAnswer = undefined
      yield* this.#turn({
        record,
        model,
        effort,
        pending: all,
        all,
        first: true,
        signal,
        attempt: 1,
      })
      return
    }
    if (failure !== undefined) {
      yield* fail(this.#explain(failure), usage)
      return
    }

    // 正文留给下一个 step 时，这一轮**不算**「没有返回正文」：工具卡片本身就是输出，
    // 结论会在下一个 step 到达。只有既没工具、又没正文（含攒住的正文）才是空响应。
    if (record.heldAnswer === undefined && !emitter.hasAnswerText() && !emitter.hasToolCalls()) {
      yield* fail(new AcpError(
        'CodeBuddy 这一轮没有返回正文（可能被账号额度或权限策略拦下了；也可以先在终端跑一次 codebuddy 确认登录态）',
        { code: 'EMPTY_RESPONSE' },
      ), usage)
      return
    }

    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: mapStopReason(stopReason, false) }
  }

  /**
   * 把上一轮攒下的正文**单独**作为这一段的结果交出（不再向 CodeBuddy 发 prompt）。
   *
   * 为什么需要这一步：DSH 的 Chat 只把「最后一个 step 中不含 tool-call 块的 assistant
   * 回复」当作最终答案。上一轮为了让工具卡片落地，模型消息里必然带着 tool-call 块；
   * 把结论放在**紧随其后的另一段**（同一个 Turn 的下一个 step）里，它才不会随整轮折叠
   * 一起被收起。正文本身早已由 CodeBuddy 生成完毕，这里只是搬运，不产生新的费用。
   *
   * @param {SessionRecord} record 运行态。
   * @param {string} text 暂存的正文。
   * @param {object[]} pending 这次新增的消息（要记进已转发签名，否则下一轮会被判成前缀不一致而重放历史）。
   * @returns {AsyncGenerator<object>} chunk 序列。
   */
  async *#deliverHeldAnswer(record, text, pending) {
    // 这些消息并没有真的发给 CodeBuddy（它早已跑完这一轮），但 DSH 会把它们继续算进
    // 下一轮的历史；不记签名的话，下一轮 `#plan` 会认为前缀对不上，从而重放全部历史。
    record.signatures = [...record.signatures, ...(pending ?? []).map((message) => signatureOf(message))]
    const body = text.trim() === '' ? '' : text
    if (body === '') {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    record.lastUsedAt = Date.now()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /**
   * 辅助调用（会话标题、上下文压缩）的确定性应答。
   * @param {object} options GenerateOptions。
   * @param {'compaction' | 'session-title'} purpose 用途。
   * @returns {AsyncGenerator<object>} chunk 序列。
   */
  async *#auxiliary(options, purpose) {
    const messages = Array.isArray(options.messages) ? options.messages : []
    const sessionKey = typeof options.sessionId === 'string' ? options.sessionId : undefined
    const record = sessionKey === undefined ? undefined : this.sessions.get(sessionKey)
    const users = messages
      .filter((message) => message?.role === 'user')
      .map((message) => {
        // 标题/压缩摘要只需要文本：图片在这里按标号出现，不必（也不该）去读字节。
        const images = []
        return contentToText(message.content, undefined, images)
      })
      .filter((text) => text !== '')

    let text
    if (purpose === 'session-title') {
      // 首选 CodeBuddy 自己的标题：它是模型对整轮对话起的名字，比本地截断准得多。
      // （DSH 侧还有一条 `session_info_update.title → sessionTitle.rename` 的通路；
      //   这里兜住「rename 没跑到」的情况，例如没有 sessionTitle 服务的组合。）
      const owned = typeof record?.codeBuddyTitle === 'string' ? record.codeBuddyTitle.trim() : ''
      text = owned !== '' ? owned : buildTitle(firstHumanMessage(users))
    } else {
      text = buildCompactionSummary(users)
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /**
   * 把异常翻译成用户能看懂并据此行动的失败信息。
   * @param {unknown} error 抛出物。
   * @returns {AcpError} 归一化错误。
   */
  #explain(error) {
    const message = error instanceof Error ? error.message : String(error)
    const category = typeof error?.data?.category === 'string' ? error.data.category : undefined
    if (category === 'auth' || /authentication|not logged in|login required|unauthorized|未登录|请先登录/i.test(message)) {
      return new AcpError(
        'CodeBuddy 未登录：请先在终端运行 codebuddy 并执行 /login 完成授权（或在插件配置的 env 里提供 CODEBUDDY_API_KEY）',
        { code: 'UNAUTHENTICATED' },
      )
    }
    if (error instanceof AcpError) return error
    if (/ENOENT|not found|spawn .* ENOENT/i.test(message)) {
      return new AcpError(`找不到 CodeBuddy CLI，请先安装并确认 codebuddy --version 可用：${message}`, { code: 'MISSING_CLI' })
    }
    return new AcpError(message, { code: 'ADAPTER_ERROR' })
  }
}

/**
 * 生成一个可安全咽下的失败 chunk 序列。
 * @param {AcpError} error 失败原因。
 * @param {object} [usage] 已产生的用量。
 * @returns {AsyncGenerator<object>} chunk 序列。
 */
async function* fail(error, usage) {
  const text = error.message
  yield { type: 'block-start', index: 99, blockType: 'text' }
  yield { type: 'text-delta', index: 99, text: `\n\n**CodeBuddy 调用失败**：${text}` }
  yield { type: 'block-end', index: 99, block: { type: 'text', text: `\n\n**CodeBuddy 调用失败**：${text}` } }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'error', failure: { message: text, code: String(error.code ?? 'ERROR') } } }
}

/**
 * 给一个 promise 套一层超时信号。
 * @param {AbortSignal | undefined} signal 原信号。
 * @param {number} timeoutMs 超时毫秒。
 * @returns {AbortSignal | undefined} 组合信号。
 */
function withTimeout(signal, timeoutMs) {
  if (typeof AbortSignal.timeout !== 'function') return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  try {
    return AbortSignal.any([signal, timeout])
  } catch {
    return signal
  }
}

/**
 * 校验 ACP 文件请求里的 path。
 * @param {object} params 请求参数。
 * @returns {string} 路径。
 */
function requirePath(params) {
  if (typeof params.path !== 'string' || params.path.length === 0) {
    throw new AcpError('文件请求缺少 path', { code: -32602 })
  }
  return params.path
}

/**
 * 按 ACP 的 line/limit 约定切分文本（line 从 1 开始）。
 * @param {string} content 全文。
 * @param {{ line?: number, limit?: number }} params 请求参数。
 * @returns {string} 切片。
 */
function sliceLines(content, params) {
  const line = typeof params.line === 'number' && params.line > 1 ? Math.floor(params.line) : 1
  if (line === 1 && typeof params.limit !== 'number') return content
  const lines = content.split('\n')
  const start = line - 1
  const end = typeof params.limit === 'number' ? start + Math.max(1, Math.floor(params.limit)) : undefined
  return lines.slice(start, end).join('\n')
}

/**
 * 由用户首条消息推导会话标题。
 * @param {string} text 用户消息。
 * @returns {string} 标题。
 */
function buildTitle(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return 'CodeBuddy 会话'
  return flat.length <= 24 ? flat : `${flat.slice(0, 24)}…`
}

/** 标题请求把人类消息包在 JSON 数组里投喂（见 session-title-first-prompt-llm）。 */
const TITLE_FRAME = /human messages:\s*(\[[\s\S]*\])\s*$/
/** 模板帧的前缀：JSON 解不出来时要把这段剥掉，绝不能让它变成标题。 */
const TITLE_FRAME_PREFIX = /^[\s\S]*?human messages:\s*/

/**
 * 从「标题请求」的消息里还原**真正的第一条人类消息**。
 *
 * 已知坑：`session-title-first-prompt-llm` 发的不是原始用户消息，而是
 * `Generate the session title from this JSON array of human messages:\n[{...}]`
 * 这样的模板帧。旧实现直接截这条模板，于是标题永远变成
 * `Generate the session tit…`。这里把 JSON 数组解出来取第一条的 `text`；
 * 万一 JSON 解不出来，至少把模板前缀剥掉，不会把指令句当标题。
 *
 * @param {string[]} users 请求里的用户消息文本（按顺序）。
 * @returns {string} 人类消息原文（还原失败时退回最后一条，并剥掉模板前缀）。
 */
export function firstHumanMessage(users) {
  for (let index = users.length - 1; index >= 0; index -= 1) {
    const match = TITLE_FRAME.exec(users[index])
    if (match === null) continue
    try {
      const list = JSON.parse(match[1])
      if (!Array.isArray(list) || list.length === 0) continue
      const text = typeof list[0]?.text === 'string' ? list[0].text : ''
      if (text.trim() !== '') return text
    } catch {
      // 解不出来就继续往前找，最后退回原文本。
    }
  }
  const last = users[users.length - 1] ?? ''
  return last.replace(TITLE_FRAME_PREFIX, '').trim() === '' ? last : stripFrame(last)
}

/**
 * 剥掉模板帧前缀，只留人类消息的可读残段。
 * @param {string} text 原始文本。
 * @returns {string} 去掉模板后的文本。
 */
function stripFrame(text) {
  const stripped = text.replace(TITLE_FRAME_PREFIX, '').replace(/^\[|\]$/g, '').trim()
  return stripped === '' ? text : stripped
}

/**
 * 生成确定性的压缩摘要（避免为压缩再起一个 agent）。
 * @param {string[]} users 用户消息序列。
 * @returns {string} 摘要。
 */
function buildCompactionSummary(users) {
  const recent = users.slice(-24)
  const lines = recent.map((text, index) => {
    const flat = text.replace(/\s+/g, ' ').trim()
    return `${index + 1}. ${flat.length <= 160 ? flat : `${flat.slice(0, 160)}…`}`
  })
  return [
    '【对话要点（由 dsh-codebuddy-acp 本地生成，CodeBuddy 侧仍保留完整上下文）】',
    ...lines,
  ].join('\n')
}
