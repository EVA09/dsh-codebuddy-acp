/**
 * 思考档位（thought_level）与多轮工具调用块编排的自测。
 *
 * 覆盖两个已修复的真实问题：
 *
 * 1. **CodeBuddy 不能控制思考维度**：适配器以前完全不读 `reasoningEffort`，
 *    模型选择器里也没有档位可选。现在要把 `reasoningEffort` 映射成
 *    `session/set_config_option {configId:"thought_level"}`，并在 `resolveModel`
 *    里按模型给出可用档位（档位集合**随模型变化**：hy4-preview 只有 high，
 *    deepseek-v4.1-flash 是 low/high/max，hy3 是 low/medium/high/xhigh）。
 *
 * 2. **多轮工具调用等会话状态在 DSH 里显示不正常**：旧的 `#turn` 把整轮的思考与
 *    工具播报塞进同一个 reasoning 块、所有 block-end 拖到轮末，且同一份 usage
 *    结算被重复帧翻倍、工具输出全部丢弃。
 *
 * 这里用**假 ACP 连接**回放真实抓到的帧序列，因此不需要登录、不消耗积分、不联网。
 *
 * 用法：node test/reasoning-and-blocks.test.mjs
 */

import assert from 'node:assert/strict'

import { CodeBuddyAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { describeEfforts, effortsForModel, KNOWN_EFFORTS, DEFAULT_EFFORTS } from '../src/models.js'

// ---------------------------------------------------------------------------
// 第一部分：档位目录（纯函数，无 IO）
// ---------------------------------------------------------------------------

assert.deepEqual(effortsForModel('deepseek-v4.1-flash'), ['low', 'high', 'max'], '档位应按模型给')
assert.deepEqual(effortsForModel('hy4-preview'), ['high'], 'hy4-preview 实测只有 high')
assert.deepEqual(effortsForModel('hy3'), ['low', 'medium', 'high', 'xhigh'], 'hy3 实测四档')
assert.deepEqual(effortsForModel('不存在的模型'), [...DEFAULT_EFFORTS], '未知模型用保守默认档')
assert.deepEqual(
  effortsForModel('deepseek-v4.1-flash', ['low', 'medium', 'max']),
  ['low', 'medium', 'max'],
  '会话侧实测档位应优先于静态快照',
)
assert.deepEqual(
  effortsForModel('hy3', ['enabled']),
  KNOWN_EFFORTS.hy3,
  '只给 enabled 时不覆盖，回落到快照',
)

const described = describeEfforts(['low', 'enabled', 'high', 'high'])
assert.deepEqual(described.map((item) => item.id), ['low', 'high'], 'enabled 不参与档位、重复项要合并')
assert.equal(described[0].name, '低', '档位要有中文展示名')

// ---------------------------------------------------------------------------
// 第二部分：用假连接回放真实帧序列
// ---------------------------------------------------------------------------

/**
 * 造一个假 ACP 连接：只实现适配器真正用到的几个方法。
 *
 * @param {object[]} frames 依次回放的 `session/update` 载荷（数组就是一次 prompt 的完整时序）。
 * @returns {object} 假连接。
 */
function fakeConnection(frames) {
  const listeners = new Map()
  const calls = { setConfig: [], prompt: 0, cancel: 0 }
  return {
    calls,
    closed: false,
    authUrl: undefined,
    get stderrTail() { return '' },
    onUpdate(sessionId, listener) {
      listeners.set(sessionId, listener)
      return () => listeners.delete(sessionId)
    },
    async newSession() {
      return {
        sessionId: 'fake-session',
        models: {
          currentModelId: 'deepseek-v4.1-flash',
          availableModels: [
            {
              modelId: 'deepseek-v4.1-flash',
              name: 'Deepseek-V4.1-Flash',
              _meta: {
                supportsImages: true,
                supportsReasoning: true,
                maxInputTokens: 1000000,
                credits: 'x0.11 credits',
                effortOptions: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
              },
            },
            {
              modelId: 'hy4-preview',
              name: 'Hy4 preview',
              _meta: { effortOptions: [{ value: 'high' }] },
            },
          ],
        },
        configOptions: [
          {
            type: 'select',
            id: 'thought_level',
            currentValue: 'enabled',
            // 实测：hy4-preview 只有 high，切到 deepseek 后变成 low/high/max。
            options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }, { value: 'enabled' }],
          },
          { type: 'select', id: 'model', currentValue: 'deepseek-v4.1-flash' },
        ],
      }
    },
    async setSessionConfigOption(sessionId, configId, value) {
      calls.setConfig.push({ configId, value })
      if (configId === 'thought_level') {
        // 实测：非法值以 -32603 拒绝，并在 data.details 里回带全集。
        const allowed = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'enabled', 'disabled']
        if (value === 'bogus') {
          const error = new Error('Internal error')
          error.code = -32603
          error.data = { details: `Invalid thought_level value: "${value}". Allowed: ${allowed.join(', ')}` }
          throw error
        }
        return {
          configOptions: [
            { type: 'select', id: 'thought_level', currentValue: value, options: [{ value }, { value: 'enabled' }] },
          ],
        }
      }
      return { configOptions: [{ type: 'select', id: configId, currentValue: value }] }
    },
    prompt(sessionId, content) {
      calls.prompt += 1
      const listener = listeners.get(sessionId)
      return (async () => {
        for (const frame of frames) {
          // 让出事件循环，模拟真实串流：适配器必须边收边发，不能等 prompt 返回。
          await new Promise((resolve) => setImmediate(resolve))
          listener?.(frame)
        }
        return { stopReason: 'end_turn' }
      })()
    },
    cancel() { calls.cancel += 1 },
    async authenticate() { return {} },
    async close() { this.closed = true },
  }
}

/**
 * 造一个只吐指定假连接的适配器。
 *
 * @param {object} connection 假连接。
 * @param {object} [configPatch] 配置覆盖。
 * @returns {CodeBuddyAdapter} 适配器。
 */
function adapterWith(connection, configPatch = {}) {
  const config = resolveConfig({ logLevel: 'silent', ...configPatch })
  const cwd = process.cwd()
  const adapter = new CodeBuddyAdapter({
    config,
    launch: { argv: ['codebuddy'], env: {}, note: 'test' },
    host: {
      defaultDirectory: () => cwd,
      resolveCwd: async () => cwd,
      readTextFile: async () => '',
      writeTextFile: async () => {},
    },
    logger: { info: () => {}, warn: () => {} },
    policy: {},
  })
  // 直接塞一条「已就绪」的共享连接，跳过真实的 spawn / initialize / authenticate。
  adapter.connections.set(cwd, {
    cwd,
    config,
    state: 'ready',
    connection,
    lastUsedAt: Date.now(),
    tail: Promise.resolve(),
    authenticated: true,
    authMethods: [],
    async ensure() { return connection },
    async acquire() { return () => {} },
    async createSession() {
      const session = await connection.newSession()
      this.rememberModels(session)
      return { sessionId: session.sessionId, model: 'deepseek-v4.1-flash' }
    },
    rememberModels(session) {
      const list = Array.isArray(session?.models?.availableModels) ? session.models.availableModels : []
      this.liveModels = {
        at: Date.now(),
        currentId: session.models.currentModelId,
        list: list.map((item) => ({
          id: item.modelId,
          name: item.name,
          contextWindow: item._meta?.maxInputTokens,
          supportsImages: item._meta?.supportsImages === true,
          supportsReasoning: item._meta?.supportsReasoning === true,
          credits: item._meta?.credits,
          effortOptions: Array.isArray(item._meta?.effortOptions)
            ? item._meta.effortOptions.map((option) => option.value)
            : undefined,
        })),
      }
      const option = session.configOptions?.find((item) => item.id === 'thought_level')
      if (option !== undefined) {
        this.thoughtLevel = {
          at: Date.now(),
          currentValue: option.currentValue,
          options: (option.options ?? []).map((item) => item.value).filter((value) => value !== 'enabled'),
        }
      }
    },
    async trySetModel() { return true },
    async close() { await connection.close() },
    async trySetThoughtLevel(sessionId, effort, signal) {
      try {
        const result = await connection.setSessionConfigOption(sessionId, 'thought_level', effort, { signal })
        this.rememberThoughtLevel({ configOptions: result.configOptions })
        return true
      } catch {
        return false
      }
    },
    rememberThoughtLevel(session) {
      const option = session?.configOptions?.find((item) => item.id === 'thought_level')
      if (option === undefined) return
      this.thoughtLevel = {
        at: Date.now(),
        currentValue: option.currentValue,
        options: (option.options ?? []).map((item) => item.value).filter((value) => value !== 'enabled'),
      }
    },
  })
  return adapter
}

/**
 * 跑一次 stream，收集全部 chunk。
 *
 * @param {CodeBuddyAdapter} adapter 适配器。
 * @param {object} options 额外 GenerateOptions。
 * @returns {Promise<object[]>} chunk 序列。
 */
async function collect(adapter, options = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'codebuddy',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '读取 a.txt 和 b.txt' }] }],
    sessionId: 'session-under-test',
    ...options,
  })) chunks.push(chunk)
  return chunks
}

// --- 场景 1：思考档位真的被写进 CodeBuddy -------------------------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ])
  const adapter = adapterWith(connection)
  await collect(adapter, { reasoningEffort: 'max' })
  const thoughtWrites = connection.calls.setConfig.filter((call) => call.configId === 'thought_level')
  assert.deepEqual(thoughtWrites, [{ configId: 'thought_level', value: 'max' }], 'reasoningEffort 必须落成 thought_level')
  await adapter.dispose()
}

// --- 场景 2：同一档位不重复写；换档位会再写 ------------------------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ])
  const adapter = adapterWith(connection)
  await collect(adapter, { reasoningEffort: 'high' })
  await collect(adapter, { reasoningEffort: 'high' })
  assert.equal(
    connection.calls.setConfig.filter((call) => call.configId === 'thought_level').length,
    1,
    '同一档位连续两轮只写一次（会话级设置，不必每轮重发）',
  )
  await collect(adapter, { reasoningEffort: 'low' })
  assert.equal(
    connection.calls.setConfig.filter((call) => call.configId === 'thought_level').length,
    2,
    '换档位必须重写',
  )
  await adapter.dispose()
}

// --- 场景 3：非法档位不阻断这一轮 ----------------------------------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '还是能回答' } },
  ])
  const adapter = adapterWith(connection)
  const chunks = await collect(adapter, { reasoningEffort: 'bogus' })
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.equal(finish.reason.kind, 'stop', '档位写入失败不应让整轮失败')
  assert.equal(
    chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''),
    '还是能回答',
  )
  await adapter.dispose()
}

// --- 场景 4：resolveModel 暴露档位 ---------------------------------------

{
  const connection = fakeConnection([])
  const adapter = adapterWith(connection)
  const flash = await adapter.resolveModel('codebuddy', 'deepseek-v4.1-flash')
  assert.deepEqual(flash.reasoning.efforts.map((item) => item.id), ['low', 'high', 'max'])
  assert.equal(flash.reasoning.defaultEffort, 'high', '默认档取 high，而不是最低档')
  assert.match(flash.description, /思考档位：low \/ high \/ max/, '描述里要标出档位')

  const hy4 = await adapter.resolveModel('codebuddy', 'hy4-preview')
  assert.deepEqual(hy4.reasoning.efforts.map((item) => item.id), ['high'], '单档模型只给一档')
  await adapter.dispose()
}

// --- 场景 5：多轮工具调用的块编排 ----------------------------------------

/** 回放实测抓到的时序（2026-10-28，CodeBuddy CLI v2.177.1）。 */
const REAL_FRAMES = [
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'idle' } } },
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'preparing' } } },
  { sessionUpdate: 'usage_update', used: 48419, size: 192000 },
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'model_requesting' } } },
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'model_streaming' } } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '要读两个文件。' } },
  { sessionUpdate: 'tool_call', toolCallId: 'call_00', title: 'Read', kind: 'other', status: 'in_progress' },
  { sessionUpdate: 'tool_call', toolCallId: 'call_01', title: 'Read', kind: 'other', status: 'in_progress' },
  {
    sessionUpdate: 'usage_update',
    used: 27549,
    size: 192000,
    cost: { amount: 0.36, currency: '' },
    _meta: {
      'codebuddy.ai/messageId': 'msg-1',
      usage: { prompt_tokens: 27549, completion_tokens: 113, total_tokens: 27662, completion_tokens_details: { reasoning_tokens: 21 }, prompt_tokens_details: { cached_tokens: 512 } },
    },
  },
  // 实测：**同一份结算会被重复推两条**，简单累加会把 token 翻倍。
  {
    sessionUpdate: 'usage_update',
    used: 27549,
    size: 192000,
    cost: { amount: 0.36, currency: '' },
    _meta: {
      'codebuddy.ai/messageId': 'msg-1',
      usage: { prompt_tokens: 27549, completion_tokens: 113, total_tokens: 27662, completion_tokens_details: { reasoning_tokens: 21 }, prompt_tokens_details: { cached_tokens: 512 } },
    },
  },
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'tool_executing', toolName: 'Read' } } },
  { sessionUpdate: 'tool_call', toolCallId: 'call_00', title: 'Read a.txt', kind: 'read', status: 'pending' },
  { sessionUpdate: 'tool_call', toolCallId: 'call_01', title: 'Read b.txt', kind: 'read', status: 'pending' },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_00',
    status: 'completed',
    rawOutput: { type: 'text', text: '1→alpha' },
  },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_01',
    status: 'completed',
    rawOutput: { type: 'text', text: '1→bravo' },
  },
  {
    sessionUpdate: 'usage_update',
    used: 27739,
    size: 192000,
    cost: { amount: 0.01, currency: '' },
    _meta: {
      'codebuddy.ai/messageId': 'msg-2',
      usage: { prompt_tokens: 27739, completion_tokens: 24, total_tokens: 27763, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 27520 } },
    },
  },
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'model_streaming' } } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '两个文件：' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'alpha 与 bravo。' } },
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'idle' } } },
]

{
  const connection = fakeConnection(REAL_FRAMES)
  const adapter = adapterWith(connection)
  const chunks = await collect(adapter)

  // 1) 块必须严格配对、index 单调递增。
  const opened = []
  const closed = []
  let lastIndex = -1
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') {
      opened.push(chunk.index)
      assert.ok(chunk.index > lastIndex, `block-start index 必须单调递增，收到 ${chunk.index} 在 ${lastIndex} 之后`)
      lastIndex = chunk.index
    }
    if (chunk.type === 'block-end') closed.push(chunk.index)
  }
  assert.deepEqual(closed, opened, '每个 block-start 都必须有配对的 block-end（顺序一致）')

  // 2) block-end 必须在下一个 block-start **之前**发出，不能全拖到轮末。
  //    这是旧实现最致命的地方：界面直到整轮结束才拿到块边界。
  const firstTextStart = chunks.findIndex((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text')
  const firstBlockEnd = chunks.findIndex((chunk) => chunk.type === 'block-end')
  assert.ok(
    firstBlockEnd >= 0 && firstBlockEnd < firstTextStart,
    'reasoning 块应在正文开始前就收口（不能在轮末统一关）',
  )

  // 3) 工具调用必须有独立的播报，且不污染正文。
  const reasoningText = chunks
    .filter((chunk) => chunk.type === 'reasoning-delta' || (chunk.type === 'block-end' && chunk.block.type === 'reasoning'))
    .map((chunk) => chunk.text ?? chunk.block.text)
    .join('')
  assert.match(reasoningText, /▸ Read/, '工具标题应出现在思考流里')
  assert.match(reasoningText, /✓ 1→alpha/, '工具**输出**应出现在思考流里（旧实现把它全丢了）')
  assert.match(reasoningText, /执行工具/, '阶段播报应可见（长工具调用期间界面不会僵住）')

  const answerText = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.ok(answerText.includes('两个文件：alpha 与 bravo。'), '正文必须完整')
  assert.ok(!answerText.includes('▸ Read'), '工具播报不能混进正文')

  // 4) 轮末工具摘要：DSH 的工具面板拿不到 CodeBuddy 的工具，至少给一份文字凭据。
  assert.match(answerText, /<summary>本轮工具调用（2）<\/summary>/, '应有工具调用摘要')
  assert.match(answerText, /Read a\.txt — 1→alpha/, '摘要要带工具结果')

  // 5) 用量：重复帧不能翻倍，多轮请求都要计入。
  const usage = chunks.find((chunk) => chunk.type === 'usage').usage
  assert.equal(usage.inputTokens, 27549 + 27739, '两条不同 messageId 相加；同 messageId 的重复帧只算一次')
  assert.equal(usage.outputTokens, 113 + 24)
  assert.equal(usage.totalTokens, 27662 + 27763)
  assert.equal(usage.reasoningTokens, 21)
  assert.equal(usage.cacheReadTokens, 512 + 27520)

  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.equal(finish.reason.kind, 'stop')

  await adapter.dispose()
}

// --- 场景 6：只有工具、没有正文 → 明确报错，而不是静默通过 --------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'tool_call', toolCallId: 'call_00', title: 'Read', status: 'in_progress' },
  ])
  const adapter = adapterWith(connection)
  const chunks = await collect(adapter)
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  // 摘要补了正文，所以这一轮仍然算「有正文」；真正空轮次另测。
  assert.equal(finish.reason.kind, 'stop', '有工具摘要时不判空')

  const silent = fakeConnection([])
  const quiet = adapterWith(silent)
  const quietChunks = await collect(quiet)
  const quietFinish = quietChunks.find((chunk) => chunk.type === 'finish')
  assert.equal(quietFinish.reason.kind, 'error', '完全没有正文时要明确失败')
  assert.equal(quietFinish.reason.failure.code, 'EMPTY_RESPONSE')
  await adapter.dispose()
  await quiet.dispose()
}

// --- 场景 7：toolNarration=off 时不播报 ---------------------------------

{
  const connection = fakeConnection(REAL_FRAMES)
  const adapter = adapterWith(connection, { toolNarration: 'off' })
  const chunks = await collect(adapter)
  const allText = chunks.map((chunk) => chunk.text ?? '').join('')
  assert.ok(!allText.includes('▸ Read'), 'off 时不播报工具')
  assert.ok(!allText.includes('执行工具'), 'off 时不播报阶段')
  assert.ok(allText.includes('两个文件：alpha 与 bravo。'), '正文不受影响')
  await adapter.dispose()
}

process.stdout.write('reasoning-and-blocks: 全部通过\n')
