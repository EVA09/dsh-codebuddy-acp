/**
 * ACP 协议层三个缺陷的回归测试（2026-11-01）。
 *
 * 1. **中断要发 `session/cancel`**：旧实现只把本地 request 拒掉，CodeBuddy 那边
 *    毫不知情——它会把这一轮跑完（继续烧额度），而且这条 ACP 会话在它眼里一直是「忙」的。
 * 2. **`allowed-once` 不能变成 `allow_always`**：实测 CodeBuddy 的 options 顺序是
 *    `[allow_always, allow, reject]`，按「第一个 kind 以 allow 开头」选会命中
 *    `allow_always`——用户点了一次「允许」，之后同类工具再也不问。
 * 3. **进程被回收 / 崩溃后要自愈**：旧实现继续拿已失效的 sessionId 发 prompt，
 *    拿到 -32603 Session not found，且**之后每一轮都会失败**。
 *
 * 全部用假连接，不联网、不消耗积分。
 *
 * 用法：node test/cancel-and-recovery.test.mjs
 */

import assert from 'node:assert/strict'

import { CodeBuddyAdapter, resolvePermissionRequest } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { ToolCallBridge } from '../src/tool-bridge.js'

// ---------------------------------------------------------------------------
// 假 ACP 连接
// ---------------------------------------------------------------------------

/**
 * @param {string} sessionId 新建会话返回的 id。
 * @returns {object} 假连接。
 */
function sessionPayload(sessionId) {
  return {
    sessionId,
    models: {
      currentModelId: 'deepseek-v4.1-flash',
      availableModels: [{
        modelId: 'deepseek-v4.1-flash',
        name: 'Deepseek-V4.1-Flash',
        _meta: { maxInputTokens: 1000000, effortOptions: [{ value: 'high' }] },
      }],
    },
    configOptions: [
      { type: 'select', id: 'thought_level', currentValue: 'enabled', options: [{ value: 'high' }] },
      { type: 'select', id: 'model', currentValue: 'deepseek-v4.1-flash' },
    ],
  }
}

/**
 * 一个「只在被 cancel 时才结算」的连接，用来验证中断通路。
 * @returns {object} 假连接。
 */
function cancelableConnection() {
  const listeners = new Map()
  const calls = { prompts: [], cancel: 0, resolvePrompt: undefined }
  return {
    calls,
    closed: false,
    authUrl: undefined,
    get stderrTail() { return '' },
    onUpdate(sessionId, listener) {
      listeners.set(sessionId, listener)
      return () => listeners.delete(sessionId)
    },
    async newSession() { return sessionPayload('sess-cancel') },
    async setSessionConfigOption() { return { configOptions: [] } },
    prompt(sessionId, content, options) {
      calls.prompts.push(content.map((item) => item.text).join(''))
      return new Promise((resolve, reject) => {
        calls.resolvePrompt = resolve
        // 与真实 AcpConnection 一致：请求的 signal 一 abort 就本地拒掉。
        const signal = options?.signal
        const onAbort = () => reject(Object.assign(new Error('session/prompt 已取消'), {
          name: 'AcpError',
          code: 'ABORTED',
        }))
        if (signal?.aborted === true) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    cancel() {
      calls.cancel += 1
      // agent 收到 session/cancel 后把 prompt 结算成 cancelled —— 实测语义。
      calls.resolvePrompt?.({ stopReason: 'cancelled' })
    },
    async close() { this.closed = true },
  }
}

/**
 * @param {object[]} frames 依次回放的 `session/update` 载荷。
 * @param {string} sessionId 新会话 id。
 * @returns {object} 假连接。
 */
function fakeConnection(frames, sessionId) {
  const listeners = new Map()
  const calls = { prompts: [], cancel: 0, newSession: 0 }
  return {
    calls,
    listeners,
    closed: false,
    authUrl: undefined,
    get stderrTail() { return '' },
    onUpdate(id, listener) {
      listeners.set(id, listener)
      return () => listeners.delete(id)
    },
    async newSession() {
      calls.newSession += 1
      return sessionPayload(sessionId)
    },
    async setSessionConfigOption() { return { configOptions: [] } },
    prompt(id, content) {
      calls.prompts.push(content.map((item) => item.text).join(''))
      for (const frame of frames) listeners.get(id)?.(frame)
      return Promise.resolve({ stopReason: 'end_turn' })
    },
    cancel() { calls.cancel += 1 },
    async close() { this.closed = true },
  }
}

/**
 * 把一条假连接装进适配器（模拟一条共享连接）。
 * @param {CodeBuddyAdapter} adapter 适配器。
 * @param {object} connection 假连接。
 * @param {object} [options] 选项。
 * @returns {object} 装进去的 shared 对象。
 */
function installShared(adapter, connection, options = {}) {
  const cwd = process.cwd()
  const shared = {
    cwd,
    config: adapter.config,
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
      this.liveModels = { at: Date.now(), currentId: session.models.currentModelId, list: [] }
      return { sessionId: session.sessionId, model: options.model ?? 'deepseek-v4.1-flash' }
    },
    async trySetModel() { return options.setModel !== false },
    async trySetThoughtLevel() { return true },
    async close() { await connection.close() },
  }
  adapter.connections.set(cwd, shared)
  return shared
}

/**
 * @param {object} [options] 选项。
 * @returns {CodeBuddyAdapter} 适配器。
 */
function newAdapter(options = {}) {
  return new CodeBuddyAdapter({
    config: resolveConfig(options.config ?? {}),
    launch: { argv: [], env: {}, note: 'test' },
    host: {
      defaultDirectory: () => process.cwd(),
      resolveCwd: async () => process.cwd(),
      readTextFile: async () => '',
      writeTextFile: async () => {},
    },
    logger: { info: () => {}, warn: () => {} },
    policy: {},
  })
}

/**
 * @param {CodeBuddyAdapter} adapter 适配器。
 * @param {object} [options] 额外 GenerateOptions。
 * @returns {Promise<object[]>} chunk 序列。
 */
async function collect(adapter, options = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'codebuddy',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '随便聊聊' }] }],
    sessionId: 'session-under-test',
    ...options,
  })) chunks.push(chunk)
  return chunks
}

/**
 * 等到条件成立（避免依赖具体时序）。
 * @param {() => boolean} predicate 条件。
 * @param {number} [limit] 轮数上限。
 * @returns {Promise<void>} 完成。
 */
async function waitFor(predicate, limit = 2000) {
  for (let index = 0; index < limit; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('waitFor 超时')
}

// ---------------------------------------------------------------------------
// 场景 1：中断要发 session/cancel
// ---------------------------------------------------------------------------

{
  const connection = cancelableConnection()
  const adapter = newAdapter()
  installShared(adapter, connection)

  const controller = new AbortController()
  const running = collect(adapter, { signal: controller.signal })
  await waitFor(() => connection.calls.resolvePrompt !== undefined)
  controller.abort()
  const chunks = await running

  assert.equal(connection.calls.cancel, 1, '中断时必须向 agent 发一次 session/cancel')
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.equal(finish?.reason?.kind, 'aborted', '中断要收口成 aborted')
  await adapter.dispose()
}

{
  // 取消发生在 prompt 之前（信号已 abort）→ 仍然要通知 agent，不能只本地放弃。
  const connection = cancelableConnection()
  const adapter = newAdapter()
  installShared(adapter, connection)
  const controller = new AbortController()
  controller.abort()

  const chunks = await collect(adapter, { signal: controller.signal })
  assert.equal(connection.calls.cancel, 1, '已中断的信号也要补一次 session/cancel')
  for (let index = 0; index < 100 && connection.calls.prompts.length === 1; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(chunks.at(-1)?.reason?.kind, 'aborted')
  await adapter.dispose()
}

// ---------------------------------------------------------------------------
// 场景 1b：分段模式（toolCut: 'step'）中途取消 —— 也要通知 agent、并且能接着下一轮
// ---------------------------------------------------------------------------

/**
 * 分段模式下，一次 cut 之后 DSH 可能立刻中断（用户按 Esc）。此时 ACP 侧那一轮**还在跑**，
 * 所以必须：
 *
 * 1. 给 agent 发 `session/cancel`（否则它继续烧额度，而且会话一直「忙」）；
 * 2. 释放连接级闸门（否则之后每一轮都会卡在同一把锁上）；
 * 3. 把这条 live turn 从会话态摘掉，下一轮能正常发新 prompt。
 */
{
  const bridge = new ToolCallBridge()
  bridge.ready = true
  const listeners = new Map()
  const calls = { prompts: [], cancel: 0, resolvePrompt: undefined }
  const connection = {
    calls,
    closed: false,
    authUrl: undefined,
    get stderrTail() { return '' },
    onUpdate(id, listener) {
      listeners.set(id, listener)
      return () => listeners.delete(id)
    },
    async newSession() { return sessionPayload('sess-stepped') },
    async setSessionConfigOption() { return { configOptions: [] } },
    prompt(id, content, options) {
      calls.prompts.push(content.map((item) => item.text).join(''))
      const emit = (frame) => listeners.get(id)?.(frame)
      // 第一个工具立刻结算 → 本 step 收口（cut），但 ACP turn 还没结束。
      emit({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read a.txt', kind: 'read', status: 'in_progress' })
      emit({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { type: 'text', text: 'alpha' } })
      return new Promise((resolve, reject) => {
        calls.resolvePrompt = resolve
        const signal = options?.signal
        const onAbort = () => reject(Object.assign(new Error('session/prompt 已取消'), {
          name: 'AcpError',
          code: 'ABORTED',
        }))
        if (signal?.aborted === true) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    cancel() {
      calls.cancel += 1
      calls.resolvePrompt?.({ stopReason: 'cancelled' })
    },
    async close() { this.closed = true },
  }
  const adapter = new CodeBuddyAdapter({
    config: resolveConfig({}),
    launch: { argv: [], env: {}, note: 'test' },
    host: {
      defaultDirectory: () => process.cwd(),
      resolveCwd: async () => process.cwd(),
      readTextFile: async () => '',
      writeTextFile: async () => {},
    },
    logger: { info: () => {}, warn: () => {} },
    policy: {},
    toolBridge: bridge,
  })
  installShared(adapter, connection)

  const controller = new AbortController()
  const first = await collect(adapter, { signal: controller.signal })
  const toolBlock = first.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(toolBlock !== undefined, '第 1 步必须发出工具块（cut）')
  assert.equal(JSON.parse(toolBlock.block.arguments).status, 'completed', '发块时工具已结算')
  assert.equal(first.find((chunk) => chunk.type === 'finish').reason.kind, 'tool-calls', 'cut 的步用 tool-calls 收口')

  // 此刻 ACP turn 还在跑：中断它。
  controller.abort()
  const record = adapter.sessions.get('session-under-test')
  assert.ok(record?.live !== undefined, 'cut 之后 live turn 仍然在跑')
  assert.equal(calls.cancel, 1, '分段中途中断也必须向 agent 发一次 session/cancel')
  await waitFor(() => record.live === undefined)
  assert.equal(record.live, undefined, '中断后要把 live turn 从会话态摘掉（否则闸门与状态泄漏）')

  // 下一轮必须能正常发新 prompt（闸门已释放、live 已清）。
  const second = await collect(adapter, {
    messages: [{ role: 'user', content: [{ type: 'text', text: '再来一次' }] }],
  })
  assert.equal(calls.prompts.length, 2, '中断后下一轮要能重新发 prompt')
  assert.equal(
    second.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').length,
    1,
    '新一轮仍然照常产出工具块（这条假连接每次 prompt 都会发一次工具调用）',
  )
  assert.equal(second.find((chunk) => chunk.type === 'finish').reason.kind, 'tool-calls', '新一轮的第一步同样是 cut')
  await adapter.dispose()
}

// ---------------------------------------------------------------------------
// 场景 2：allowed-once 必须落到「只放行这一次」的选项
// ---------------------------------------------------------------------------

{
  // 实测 CodeBuddy 的真实顺序：allow_always 在最前，一次性选项的 kind 是 allow。
  const options = [
    { optionId: 'allow_always', name: 'Always Allow', kind: 'allow_always' },
    { optionId: 'allow', name: 'Allow', kind: 'allow' },
    { optionId: 'reject', name: 'Reject', kind: 'reject' },
  ]
  const sessions = new Map([['s', { key: 's', acpSessionId: 'fake-session' }]])
  const logger = { info: () => {}, warn: () => {} }

  const allowed = await resolvePermissionRequest({
    sessions, logger, ask: async () => 'allow',
    params: { sessionId: 'fake-session', toolCall: { toolCallId: 'c', title: 'Bash ls', kind: 'execute' }, options },
  })
  assert.equal(allowed.optionId, 'allow', 'allowed-once 不能落到 allow_always（否则一次授权变成永久放行）')

  const rejected = await resolvePermissionRequest({
    sessions, logger, ask: async () => 'deny',
    params: { sessionId: 'fake-session', toolCall: { toolCallId: 'c', title: 'Bash rm', kind: 'execute' }, options },
  })
  assert.equal(rejected.optionId, 'reject', '拒绝要落到 reject 类选项')

  // 只有「总是允许」时才用它。
  const onlyAlways = await resolvePermissionRequest({
    sessions, logger, ask: async () => 'allow',
    params: {
      sessionId: 'fake-session',
      toolCall: { toolCallId: 'c', title: 'x', kind: 'other' },
      options: [{ optionId: 'allow_always', name: 'Always', kind: 'allow_always' }],
    },
  })
  assert.equal(onlyAlways.optionId, 'allow_always', '没有一次性选项时才退到 allow_always')

  // 规范里的一次性写法（allow_once）优先于 allow_always。
  const spec = await resolvePermissionRequest({
    sessions, logger, ask: async () => 'allow',
    params: {
      sessionId: 'fake-session',
      toolCall: { toolCallId: 'c', title: 'x', kind: 'other' },
      options: [
        { optionId: 'aa', name: 'Always', kind: 'allow_always' },
        { optionId: 'once', name: 'Once', kind: 'allow_once' },
      ],
    },
  })
  assert.equal(spec.optionId, 'once', 'allow_once 优先')
}

// ---------------------------------------------------------------------------
// 场景 3：连接被换掉（进程重启 / 空闲回收）后要自愈
// ---------------------------------------------------------------------------

{
  const first = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '收到' } },
  ], 'sess-1')
  const adapter = newAdapter()
  installShared(adapter, first)

  const history = [{ role: 'user', content: [{ type: 'text', text: '第一问' }] }]
  await collect(adapter, { messages: history })
  assert.equal(first.calls.newSession, 1, '首次建一条会话')

  const second = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第二答' } },
  ], 'sess-2')
  installShared(adapter, second)

  await collect(adapter, {
    messages: [
      ...history,
      { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
      { role: 'user', content: [{ type: 'text', text: '第二问' }] },
    ],
  })

  assert.equal(second.calls.newSession, 1, '连接换掉后必须重开 ACP 会话')
  const prompt = second.calls.prompts.at(-1) ?? ''
  assert.ok(prompt.includes('第一问'), `重开的新会话必须重放完整历史（含第一问）：${prompt}`)
  assert.ok(prompt.includes('第二问'), '重开的会话里也要有本轮新消息')
  await adapter.dispose()
}

{
  // agent 侧报 -32603 Session not found：作废会话、用完整历史重试一次。
  const stale = fakeConnection([], 'sess-stale')
  let attempts = 0
  stale.prompt = function prompt(id, content) {
    this.calls.prompts.push(content.map((item) => item.text).join(''))
    attempts += 1
    if (attempts === 1) {
      return Promise.reject(Object.assign(new Error('Session not found: sess-stale'), {
        name: 'AcpError',
        code: -32603,
        data: { details: 'Session not found: sess-stale' },
      }))
    }
    // 第二次（新会话）正常回答。
    this.listeners.get(id)?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '新回答' } })
    return Promise.resolve({ stopReason: 'end_turn' })
  }
  const adapter = newAdapter()
  installShared(adapter, stale)

  const chunks = await collect(adapter, {
    messages: [
      { role: 'user', content: [{ type: 'text', text: '旧问题' }] },
      { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
      { role: 'user', content: [{ type: 'text', text: '新问题' }] },
    ],
  })

  assert.equal(attempts, 2, 'Session not found 要重试一次')
  assert.equal(stale.calls.newSession, 2, '重试要建一条新的 ACP 会话')
  assert.ok(String(stale.calls.prompts.at(-1)).includes('旧问题'), '重试要用完整历史，不能丢掉前文')
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.notEqual(finish?.reason?.kind, 'error', `Session not found 已自愈，不该把整轮判错：${JSON.stringify(finish?.reason)}`)
  await adapter.dispose()
}

process.stdout.write('cancel-and-recovery: 全部通过\n')
