/**
 * 「工具调用完整进 DSH」的自测。
 *
 * 目标行为（本文件逐条断言）：
 *
 * 1. CodeBuddy 的每次工具调用在模型流里变成**真正的 `tool-call` 块**
 *    （block-start + tool-call-delta + block-end），而不是塞进思考流的一行文字；
 * 2. 同一 `toolCallId` 会收到两次 `tool_call`（占位 → 标题补全），**只产出一个块**，
 *    且用补全后的标题与 kind；
 * 3. 工具结果落到 `ToolCallBridge`，DSH 执行回放工具时能按 callId 取回；
 * 4. 回放工具只在「模型是 CodeBuddy」的步骤可见，执行时 `concludeTurn()`，
 *    不产生任何副作用；
 * 5. 历史投喂不再把工具调用参数/工具结果拼成文本喂回 CodeBuddy。
 *
 * 全部用假 ACP 连接回放 2026-10-28 抓到的真实帧序列，不联网、不消耗积分。
 *
 * 用法：node test/tool-replay.test.mjs
 */

import assert from 'node:assert/strict'

import { CodeBuddyAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { ToolCallBridge } from '../src/tool-bridge.js'
import { registerReplayTool } from '../src/tools.js'

// ---------------------------------------------------------------------------
// 假 ACP 连接
// ---------------------------------------------------------------------------

/**
 * @param {object[]} frames 依次回放的 `session/update` 载荷。
 * @returns {object} 假连接。
 */
function fakeConnection(frames) {
  const listeners = new Map()
  const calls = { setConfig: [], prompts: [], cancel: 0 }
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
          availableModels: [{
            modelId: 'deepseek-v4.1-flash',
            name: 'Deepseek-V4.1-Flash',
            _meta: { maxInputTokens: 1000000, effortOptions: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] },
          }],
        },
        configOptions: [
          { type: 'select', id: 'thought_level', currentValue: 'enabled', options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }, { value: 'enabled' }] },
          { type: 'select', id: 'model', currentValue: 'deepseek-v4.1-flash' },
        ],
      }
    },
    async setSessionConfigOption(sessionId, configId, value) {
      calls.setConfig.push({ configId, value })
      return { configOptions: [] }
    },
    prompt(sessionId, content) {
      calls.prompts.push(content.map((item) => item.text).join(''))
      const listener = listeners.get(sessionId)
      for (const frame of frames) listener?.(frame)
      return Promise.resolve({ stopReason: 'end_turn' })
    },
    async close() { this.closed = true },
    cancel() { calls.cancel += 1 },
  }
}

/**
 * 造一个已经「连上」的适配器，跳过真实 spawn / initialize。
 *
 * @param {object} connection 假连接。
 * @param {object} [options] 选项。
 * @param {ToolCallBridge} [options.bridge] 工具记录桥（给了就走回放模式）。
 * @param {object} [options.config] 配置覆盖。
 * @returns {CodeBuddyAdapter} 适配器。
 */
function adapterWith(connection, options = {}) {
  const config = resolveConfig(options.config ?? {})
  const cwd = process.cwd()
  const adapter = new CodeBuddyAdapter({
    config,
    launch: { argv: [], env: {}, note: 'test' },
    host: {
      defaultDirectory: () => cwd,
      resolveCwd: async () => cwd,
      readTextFile: async () => '',
      writeTextFile: async () => {},
    },
    logger: { info: () => {}, warn: () => {} },
    policy: {},
    toolBridge: options.bridge,
  })
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
          effortOptions: Array.isArray(item._meta?.effortOptions)
            ? item._meta.effortOptions.map((option) => option.value)
            : undefined,
        })),
      }
    },
    async trySetModel() { return true },
    async close() { await connection.close() },
    async trySetThoughtLevel() { return true },
  })
  return adapter
}

/**
 * 跑一次 stream，收集全部 chunk。
 *
 * @param {CodeBuddyAdapter} adapter 适配器。
 * @param {object} [options] 额外 GenerateOptions。
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

/** 从 chunk 序列里重建块列表（模拟 DSH 的 BlockAssembler）。 */
function blocksOf(chunks) {
  const blocks = []
  for (const chunk of chunks) {
    if (chunk.type === 'block-end') blocks.push(chunk.block)
  }
  return blocks
}

// ---------------------------------------------------------------------------
// 真实帧序列（实测 2026-10-28，CodeBuddy CLI v2.177.1）
// ---------------------------------------------------------------------------

const REAL_FRAMES = [
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'idle' } } },
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'model_streaming' } } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '要读两个文件。' } },
  // 占位帧：只有工具名，没有路径，kind=other。
  { sessionUpdate: 'tool_call', toolCallId: 'call_00', title: 'Read', kind: 'other', status: 'in_progress' },
  { sessionUpdate: 'tool_call', toolCallId: 'call_01', title: 'Read', kind: 'other', status: 'in_progress' },
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'tool_executing', toolName: 'Read' } } },
  // 补全帧：同 id，带路径与正确 kind。
  { sessionUpdate: 'tool_call', toolCallId: 'call_00', title: 'Read a.txt', kind: 'read', status: 'pending' },
  { sessionUpdate: 'tool_call', toolCallId: 'call_01', title: 'Read b.txt', kind: 'read', status: 'pending' },
  { sessionUpdate: 'tool_call_update', toolCallId: 'call_00', status: 'completed', rawOutput: { type: 'text', text: 'RESULT-ONLY-IN-TOOL-A' } },
  { sessionUpdate: 'tool_call_update', toolCallId: 'call_01', status: 'completed', rawOutput: { type: 'text', text: 'RESULT-ONLY-IN-TOOL-B' } },
  {
    sessionUpdate: 'usage_update',
    used: 27549,
    size: 192000,
    cost: { amount: 0.36, currency: '' },
    _meta: {
      'codebuddy.ai/messageId': 'msg-1',
      usage: { prompt_tokens: 27549, completion_tokens: 113, total_tokens: 27662 },
    },
  },
  // 同一份结算被重复推送两次，不能翻倍。
  {
    sessionUpdate: 'usage_update',
    used: 27549,
    size: 192000,
    cost: { amount: 0.36, currency: '' },
    _meta: {
      'codebuddy.ai/messageId': 'msg-1',
      usage: { prompt_tokens: 27549, completion_tokens: 113, total_tokens: 27662 },
    },
  },
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'model_streaming' } } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '两个文件都读完了。' } },
  { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'idle' } } },
]

/**
 * 造一个「桥上已就绪」的环境。
 * @param {object} [configExtra] 配置覆盖。
 * @returns {{ adapter: CodeBuddyAdapter, bridge: ToolCallBridge, connection: object }}
 */
function replayAdapter(configExtra = {}) {
  const connection = fakeConnection(REAL_FRAMES)
  const bridge = new ToolCallBridge()
  bridge.ready = true
  const adapter = adapterWith(connection, { bridge, config: configExtra })
  return { adapter, bridge, connection }
}

// ---------------------------------------------------------------------------
// 场景 1：工具调用变成原生 tool-call 块
// ---------------------------------------------------------------------------

{
  const { adapter, bridge } = replayAdapter()
  const chunks = await collect(adapter)

  const starts = chunks.filter((chunk) => chunk.type === 'block-start')
  const toolStarts = starts.filter((chunk) => chunk.blockType === 'tool-call')
  assert.equal(toolStarts.length, 2, '两次工具调用必须各有一个 tool-call 块')
  assert.equal(
    starts.length,
    chunks.filter((chunk) => chunk.type === 'block-end').length,
    'block-start / block-end 必须严格配对',
  )

  // 每个 tool-call 块都要带 delta（界面才能在结果回来前先画出来）与完整 block。
  for (const start of toolStarts) {
    const delta = chunks.find((chunk) => chunk.type === 'tool-call-delta' && chunk.index === start.index)
    const end = chunks.find((chunk) => chunk.type === 'block-end' && chunk.index === start.index)
    assert.ok(delta !== undefined, 'tool-call 块必须有 tool-call-delta')
    assert.ok(end !== undefined, 'tool-call 块必须收口')
    assert.equal(delta.name, 'codebuddy_tool', '块里的工具名必须是回放工具')
    assert.equal(end.block.type, 'tool-call')
    assert.equal(end.block.arguments, delta.argumentsDelta, 'delta 与 block-end 的参数必须一致')
  }

  // 块顺序：思考 → 工具A → 工具B（正文不再跟着它们，见场景 1b）。
  const order = blocksOf(chunks).map((block) => block.type === 'tool-call'
    ? `tool:${JSON.parse(block.arguments).title}`
    : block.type)
  assert.deepEqual(order, ['reasoning', 'tool:Read a.txt', 'tool:Read b.txt'], `块顺序不对：${order.join(' → ')}`)

  // 参数结构：title 必须是第一个键（客户端通用行取第一个字符串做摘要）。
  const first = JSON.parse(blocksOf(chunks).find((block) => block.type === 'tool-call').arguments)
  assert.equal(Object.keys(first)[0], 'title', 'title 必须排在参数对象的第一个键')
  assert.equal(first.title, 'Read a.txt', '标题要用补全后的版本')
  assert.equal(first.kind, 'read', 'kind 要用补全后的版本')
  assert.equal(first.callId, 'call_00')
  assert.equal(first.tool, 'Read')

  // 工具结果进了桥，且拿到了真实输出。
  const recorded = bridge.read('call_00')
  assert.equal(recorded.status, 'completed')
  assert.equal(recorded.output, 'RESULT-ONLY-IN-TOOL-A')
  assert.equal(bridge.read('call_01').output, 'RESULT-ONLY-IN-TOOL-B')
  // 这一轮确实有正文：记录上要打 `holdAnswer`，回放工具据此不结束本轮。
  assert.equal(recorded.holdAnswer, true, '有正文的轮次，工具记录必须带 holdAnswer')
  assert.equal(bridge.read('call_01').holdAnswer, true)

  // 思考流不再被工具播报污染。
  const reasoning = chunks
    .filter((chunk) => chunk.type === 'reasoning-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.ok(!reasoning.includes('▸'), '回放模式下不应再往思考流里塞工具播报')
  assert.ok(!reasoning.includes('执行工具'), '回放模式下不应再播报阶段')

  // 本轮不再流出正文：它被整体攒住，等下一个 step 单独交出（见场景 1b）。
  const answer = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.equal(answer, '', '有工具调用的轮次不再当场流出正文')

  // 用量：重复帧不翻倍。
  const usage = chunks.find((chunk) => chunk.type === 'usage').usage
  assert.equal(usage.inputTokens, 27549)
  assert.equal(usage.outputTokens, 113)

  assert.equal(chunks.find((chunk) => chunk.type === 'finish').reason.kind, 'stop')
  await adapter.dispose()
}

// ---------------------------------------------------------------------------
// 场景 1b：结论落到**独立的下一段**（DSH 才不会把它当过程折叠掉）
// ---------------------------------------------------------------------------

/**
 * DSH 的 Chat 只把「最后一个 step 中不含 tool-call 块的 assistant 回复」认作最终答案
 * （ui-chat `latestAnswer`）。所以这一轮正文必须整段攒住、在**下一个 step**单独交出，
 * 而回放工具在那一步之前不能 `concludeTurn()` 结束本轮。
 */
{
  const { adapter, bridge } = replayAdapter()
  const first = await collect(adapter)
  // 第一段（工具段）：没有正文，但工具记录都带 holdAnswer。
  assert.equal(first.filter((chunk) => chunk.type === 'text-delta').length, 0)
  assert.equal(bridge.read('call_00').holdAnswer, true)

  // 第二段（结论段）：DSH 不带新用户消息地再问一次，适配器应直接交出暂存正文。
  const second = await collect(adapter, {
    messages: [{ role: 'user', content: [{ type: 'text', text: '读取 a.txt 和 b.txt' }] }],
  })
  const textBlocks = blocksOf(second).filter((block) => block.type === 'text')
  assert.equal(textBlocks.length, 1, '结论段必须正好一段正文')
  assert.equal(textBlocks[0].text, '两个文件都读完了。', '交出的是 CodeBuddy 的原文')
  assert.equal(
    blocksOf(second).some((block) => block.type === 'tool-call'),
    false,
    '结论段里不能再出现 tool-call 块（否则又会被当过程内容折叠）',
  )
  assert.equal(second.find((chunk) => chunk.type === 'finish').reason.kind, 'stop')
  await adapter.dispose()
}

// ---------------------------------------------------------------------------
// 场景 2：回放工具（注册 + 门控 + 取回结果 + 结束本轮）
// ---------------------------------------------------------------------------

{
  const registrations = []
  const bridge = new ToolCallBridge()
  const fakeCtx = {
    tools: {
      register(definition, options) {
        registrations.push({ definition, options })
        return () => {}
      },
    },
  }
  const config = resolveConfig({})
  const dispose = registerReplayTool({
    ctx: fakeCtx,
    bridge,
    config,
    logger: { info: () => {}, warn: () => {} },
  })
  assert.equal(registrations.length, 1, '应该注册一个回放工具')
  assert.equal(bridge.ready, true, '注册成功后桥才允许发 tool-call 块')

  const { definition, options } = registrations[0]
  assert.equal(definition.name, 'codebuddy_tool')
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.required, ['title'], 'parameters 必须是标准 JSON Schema（required 是数组）')

  // when 只看模型选择：CodeBuddy 步骤可见，其它 provider 不可见。
  assert.equal(options.when({ modelSelection: { provider: 'codebuddy', model: 'x' } }), true)
  assert.equal(options.when({ modelSelection: { provider: 'deepseek', model: 'x' } }), false)

  // 先把一条真实记录喂进桥。
  bridge.settle({ toolCallId: 'call_00', title: 'Read a.txt', kind: 'read', status: 'completed', rawOutput: { type: 'text', text: 'alpha' } })

  let concluded = 0
  const exec = { concludeTurn() { concluded += 1 } }
  const value = await definition.execute(
    { title: 'Read a.txt', kind: 'read', callId: 'call_00', status: 'pending' },
    exec,
  )
  assert.equal(concluded, 1, '回放工具必须结束本轮（否则会多跑一次模型请求）')
  assert.equal(value.status, 'completed', '结果状态要取桥里的真实状态')
  assert.equal(value.output, 'alpha', '结果要带回 CodeBuddy 的真实工具输出')
  assert.equal(value.title, 'Read a.txt')

  // 未知 callId 也不能让整轮失败。
  const missing = await definition.execute({ title: 'Read x', callId: 'nope' }, { concludeTurn() { concluded += 1 } })
  assert.equal(missing.status, 'unknown')
  assert.match(missing.output, /没有取到结果/)

  // 只发了 tool_call、始终没有结果（被取消/中断）：不能一直挂着「执行中」。
  bridge.begin({ toolCallId: 'call_09', title: 'Bash ls', kind: 'execute' })
  const incomplete = await definition.execute({ title: 'Bash ls', callId: 'call_09' }, { concludeTurn() {} })
  assert.equal(incomplete.status, 'incomplete', '没收到的结果要标成 incomplete')
  assert.match(incomplete.output, /没有回报/)

  // 输出必须符合自己声明的 schema 形状。
  for (const key of definition.output.schema.required) {
    assert.ok(Object.hasOwn(value, key), `输出缺少必填字段 ${key}`)
  }

  // 呈现：标题来自参数，类别跟随 kind。
  const call = definition.presentCall({ title: 'Read a.txt', kind: 'read', path: 'a.txt', line: 3 })
  assert.equal(call.card, 'generic')
  assert.equal(call.title, 'Read a.txt')
  assert.equal(call.kind, 'read')
  assert.deepEqual(call.locations, [{ path: 'a.txt', line: 3 }])

  const rendered = definition.output.render({}, value)
  assert.match(rendered[0].text, /✓ Read a\.txt/, '结果渲染要有状态标记与标题')
  assert.match(rendered[0].text, /alpha/, '结果渲染要带输出')

  dispose()
  assert.equal(bridge.ready, false, '反注册后桥要关掉，避免发出没人执行的 tool-call')
}

// ---------------------------------------------------------------------------
// 场景 3：历史投喂不再回灌工具调用与工具结果
// ---------------------------------------------------------------------------

{
  const { adapter, connection } = replayAdapter()
  // 第一轮：吃 USER-1，记录签名。
  await collect(adapter)
  // 第二轮：DSH 会重发整段历史（含上一轮的助手消息与工具结果）。
  const history = [
    { role: 'user', content: [{ type: 'text', text: '读取 a.txt 和 b.txt' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '要读两个文件。' },
        { type: 'tool-call', id: 'call_00', name: 'codebuddy_tool', arguments: '{"title":"Read a.txt"}' },
        { type: 'text', text: '两个文件都读完了。' },
      ],
    },
    { role: 'tool', toolCallId: 'call_00', content: [{ type: 'text', text: 'RESULT-ONLY-IN-TOOL-A' }] },
    { role: 'user', content: [{ type: 'text', text: 'USER-SECOND-TURN' }] },
  ]
  await collect(adapter, { messages: history })
  const last = connection.calls.prompts.at(-1)
  assert.ok(last.includes('USER-SECOND-TURN'), '新的用户消息必须投喂')
  assert.ok(!last.includes('RESULT-ONLY-IN-TOOL-A'), '工具结果不能回灌给 CodeBuddy')
  assert.ok(!last.includes('codebuddy_tool'), '回放工具的参数不能回灌给 CodeBuddy')
  assert.ok(!last.includes('"callId"'), '工具调用 JSON 不能回灌给 CodeBuddy')
  await adapter.dispose()
}

// ---------------------------------------------------------------------------
// 场景 4：没有工具的一轮，结构保持原样
// ---------------------------------------------------------------------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一想。' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '答案是 7。' } },
  ])
  const bridge = new ToolCallBridge()
  bridge.ready = true
  const adapter = adapterWith(connection, { bridge })
  const chunks = await collect(adapter)
  assert.equal(chunks.filter((chunk) => chunk.blockType === 'tool-call').length, 0, '没有工具时不应有 tool-call 块')
  assert.deepEqual(blocksOf(chunks).map((block) => block.type), ['reasoning', 'text'])
  assert.equal(chunks.find((chunk) => chunk.type === 'finish').reason.kind, 'stop')
  await adapter.dispose()
}

// ---------------------------------------------------------------------------
// 场景 5：桥的边界（增量 rawInput、失败、截断、未知 id）
// ---------------------------------------------------------------------------

{
  const bridge = new ToolCallBridge({ outputLimit: 32 })

  // rawInput 是**增量**下发的：两次 update 要合并，不能后一次覆盖前一次。
  bridge.begin({ toolCallId: 'c1', title: 'Bash', kind: 'execute' })
  bridge.settle({ toolCallId: 'c1', rawInput: { command: 'npm test' } })
  bridge.settle({ toolCallId: 'c1', rawInput: { cwd: 'C:\\x' }, status: 'completed', rawOutput: { type: 'text', text: 'ok' } })
  const merged = bridge.read('c1')
  assert.deepEqual(merged.rawInput, { command: 'npm test', cwd: 'C:\\x' }, 'rawInput 必须合并')
  assert.equal(merged.command, 'npm test', '命令要能被识别出来')
  assert.equal(merged.kind, 'execute')

  // 失败状态要留下原因。
  bridge.begin({ toolCallId: 'c2', title: 'Edit a.js', kind: 'edit' })
  bridge.settle({ toolCallId: 'c2', status: 'failed', rawOutput: { type: 'text', text: '拒绝写入' } })
  const failed = bridge.read('c2')
  assert.equal(failed.status, 'failed')
  assert.ok(failed.error.length > 0, '失败要有原因')

  // 超长输出要截断，且标记 truncated。
  bridge.begin({ toolCallId: 'c3', title: 'Read big.txt', kind: 'read' })
  bridge.settle({ toolCallId: 'c3', status: 'completed', rawOutput: { type: 'text', text: 'x'.repeat(200) } })
  const big = bridge.read('c3')
  assert.equal(big.outputTruncated, true)
  assert.ok(big.output.length < 200)

  // 未知 id 只返回 undefined，不抛错。
  assert.equal(bridge.read('nope'), undefined)
}

// ---------------------------------------------------------------------------
// 场景 6：`toolEmit` 决定工具块的发出时机
// ---------------------------------------------------------------------------

/**
 * DSH 只在**模型流结束后**才执行回放工具，所以卡片从「出现」到「完成」之间隔着整轮 ACP。
 * `start` 模式一看到调用就发块，卡片会在 CodeBuddy 早已跑完之后还挂着「执行中」；
 * `settle` 模式等结算再发，卡片一出现就是终态。
 *
 * 用块参数里的 `status` 可以直接验证这一点（发块时快照的就是记录的状态）。
 */
{
  const settled = replayAdapter({ toolEmit: 'settle' })
  const settledBlocks = blocksOf(await collect(settled.adapter))
  const settledTool = settledBlocks.find((block) => block.type === 'tool-call')
  assert.equal(JSON.parse(settledTool.arguments).status, 'completed', 'settle 模式发块时工具必须已经结算')
  await settled.adapter.dispose()

  const started = replayAdapter({ toolEmit: 'start' })
  const startedBlocks = blocksOf(await collect(started.adapter))
  const startedTool = startedBlocks.find((block) => block.type === 'tool-call')
  assert.notEqual(JSON.parse(startedTool.arguments).status, 'completed', 'start 模式发块时工具还没结算（这正是问题所在）')
  await started.adapter.dispose()
}

{
  // 思考流插在「工具开始」和「工具结算」之间：settle 模式不能被它挤得提前发块。
  const interleaved = [
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash', kind: 'other', status: 'in_progress' },
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash `ls -la`', kind: 'execute', status: 'in_progress' },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '等它跑完…' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { type: 'text', text: 'total 0' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '跑完了' } },
  ]
  const bridge = new ToolCallBridge()
  bridge.ready = true
  const adapter = adapterWith(fakeConnection(interleaved), { bridge, config: { toolEmit: 'settle' } })
  const toolBlock = blocksOf(await collect(adapter)).find((block) => block.type === 'tool-call')
  assert.equal(JSON.parse(toolBlock.arguments).status, 'completed', '思考流不能让还没结算的工具提前落地')
  await adapter.dispose()
}

process.stdout.write('tool-replay: 全部通过\n')
