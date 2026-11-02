/**
 * 「标题 / 计划 / 审批」三条 CodeBuddy → DSH 通路的自测。
 *
 * 覆盖三件事：
 *
 * 1. **会话标题**：CodeBuddy 发的 `session_info_update.title` 要变成 DSH 的真实标题，
 *    而不是固定模板 `Generate the session tit…`。旧实现有两个缺口：
 *    ① 标题请求的头一帧是模板文本，直接截断就成了那句固定的废话；
 *    ② 适配器根本没处理 `session_info_update.title`。
 * 2. **计划（待办）**：ACP `plan`（`entries[{content,priority,status}]`）要落成
 *    DSH 的 `todo/write` 快照，状态枚举归一、同一计划不重复写。
 * 3. **审批**：ACP `session/request_permission`（`options[{optionId,know,name}]`）
 *    要问回 DSH 的 `approval` 服务，并把结果映射成「选哪个 option」。
 *
 * 全部用假连接 / 假服务，不联网、不消耗积分、不弹框。
 *
 * 用法：node test/sync-title-plan-approval.test.mjs
 */

import assert from 'node:assert/strict'

import { CodeBuddyAdapter, firstHumanMessage, normalizePlanStatus, resolvePermissionRequest } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { createHostSync } from '../index.js'

// ---------------------------------------------------------------------------
// 第一部分：纯函数
// ---------------------------------------------------------------------------

{
  // 旧实现直接把模板帧截成 24 字 —— 于是标题永远是「Generate the session tit…」。
  const framed = 'Generate the session title from this JSON array of human messages:\n'
    + JSON.stringify([{ seq: 9, text: '搜索一下最近的it局势' }])
  assert.equal(firstHumanMessage([framed]), '搜索一下最近的it局势', '标题请求的模板帧要解出人类消息原文')

  // 不是模板帧就直接用原文。
  assert.equal(firstHumanMessage(['普通消息']), '普通消息', '非模板帧原样返回')

  // 多帧时取最后一条模板帧；坏 JSON 要能回退，不能抛错。
  const broken = 'Generate the session title from this JSON array of human messages:\n[{'
  assert.ok(!firstHumanMessage(['好', broken]).includes('Generate the session'), '坏 JSON 不能把模板当标题')

  // 状态归一：ACP 三态直接通过，其它一律 pending（DSH 只认这三态）。
  assert.equal(normalizePlanStatus('completed'), 'completed')
  assert.equal(normalizePlanStatus('in_progress'), 'in_progress')
  assert.equal(normalizePlanStatus('pending'), 'pending')
  assert.equal(normalizePlanStatus('cancelled'), 'pending', '未知状态降级成 pending，不能写坏整条计划')
  assert.equal(normalizePlanStatus(undefined), 'pending')
}

// ---------------------------------------------------------------------------
// 假 ACP 连接 / 假适配器（复用 tool-replay 的骨架）
// ---------------------------------------------------------------------------

/**
 * @param {object[]} frames 依次回放的 `session/update` 载荷。
 * @param {(method: string, params: object) => Promise<object>} [onRequest] agent 主动请求。
 * @returns {object} 假连接。
 */
function fakeConnection(frames, onRequest) {
  const listeners = new Map()
  const calls = { prompts: [], cancel: 0 }
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
            _meta: { maxInputTokens: 1000000, effortOptions: [{ value: 'low' }, { value: 'high' }] },
          }],
        },
        configOptions: [
          { type: 'select', id: 'thought_level', currentValue: 'enabled', options: [{ value: 'low' }, { value: 'high' }] },
          { type: 'select', id: 'model', currentValue: 'deepseek-v4.1-flash' },
        ],
      }
    },
    async setSessionConfigOption() { return { configOptions: [] } },
    prompt(sessionId, content) {
      calls.prompts.push(content.map((item) => item.text).join(''))
      for (const frame of frames) listeners.get(sessionId)?.(frame)
      return Promise.resolve({ stopReason: 'end_turn' })
    },
    async close() { this.closed = true },
    cancel() { calls.cancel += 1 },
    /** 让测试可以主动模拟 CodeBuddy 发请求（权限询问）。 */
    onRequest,
  }
}

/**
 * @param {object} connection 假连接。
 * @param {object} [options] 选项。
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
    onSessionTitle: options.onSessionTitle,
    onPlan: options.onPlan,
    askPermission: options.askPermission,
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
      this.liveModels = { at: Date.now(), currentId: session.models.currentModelId, list: [] }
      return { sessionId: session.sessionId, model: 'deepseek-v4.1-flash' }
    },
    async trySetModel() { return true },
    async close() { await connection.close() },
    async trySetThoughtLevel() { return true },
  })
  return adapter
}

/**
 * 跑一次 stream，收集 chunk。
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

// ---------------------------------------------------------------------------
// 场景 1：CodeBuddy 的标题变成 DSH 标题
// ---------------------------------------------------------------------------

{
  // 实测帧：CodeBuddy 跑完一轮后发 session_info_update.title。
  const frames = [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的。' } },
    { sessionUpdate: 'session_info_update', title: '搜索最近的 IT 局势', _meta: { timestamp: '2026-10-28T10:31:03Z' } },
  ]
  const titles = []
  const connection = fakeConnection(frames)
  const adapter = adapterWith(connection, { onSessionTitle: (event) => titles.push(event) })
  await collect(adapter)
  assert.equal(titles.length, 1, 'CodeBuddy 发标题时要通知一次')
  assert.equal(titles[0].sessionId, 'session-under-test', '通知要带上 DSH 会话 id')
  assert.equal(titles[0].title, '搜索最近的 IT 局势', '标题原样透传')
  await adapter.dispose()
}

{
  // 同一标题重复推送不去重地反复通知；标题变化要再通知一次。
  const frames = [
    { sessionUpdate: 'session_info_update', title: 'A' },
    { sessionUpdate: 'session_info_update', title: 'A' },
    { sessionUpdate: 'session_info_update', title: 'B' },
  ]
  const titles = []
  const connection = fakeConnection(frames)
  const adapter = adapterWith(connection, { onSessionTitle: (event) => titles.push(event.title) })
  await collect(adapter)
  assert.deepEqual(titles, ['A', 'B'], '同一标题只通知一次，变化时再通知')
  await adapter.dispose()
}

{
  // 标题辅助调用：拿不到 CodeBuddy 标题时，不能把模板帧当成标题。
  const framed = 'Generate the session title from this JSON array of human messages:\n'
    + JSON.stringify([{ seq: 1, text: '帮我查一下最近的新闻' }])
  const connection = fakeConnection([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } }])
  const adapter = adapterWith(connection)
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'codebuddy',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: framed }] }],
    sessionId: 'session-under-test',
    purpose: 'session-title',
  })) chunks.push(chunk)
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.ok(!text.includes('Generate the session'), `标题不能是模板文本：${text}`)
  assert.ok(text.includes('帮我查一下最近的新闻'), `标题要来自人类消息原文：${text}`)
  await adapter.dispose()
}

// ---------------------------------------------------------------------------
// 场景 2：ACP plan → DSH 待办
// ---------------------------------------------------------------------------

{
  // 实测形状：entries[{content, priority, status}]，状态变化时整表重发。
  const plan = (statuses) => ({
    sessionUpdate: 'plan',
    entries: statuses.map((status, index) => ({ content: `任务${index + 1}`, priority: 'medium', status })),
  })
  const frames = [
    plan(['pending', 'pending', 'pending']),
    plan(['in_progress', 'pending', 'pending']),
    plan(['completed', 'in_progress', 'pending']),
  ]
  const plans = []
  const connection = fakeConnection(frames)
  const adapter = adapterWith(connection, { onPlan: (event) => plans.push(event) })
  await collect(adapter)

  assert.equal(plans.length, 3, '每次计划变化都要同步一次')
  assert.deepEqual(plans[0].entries, [
    { content: '任务1', status: 'pending' },
    { content: '任务2', status: 'pending' },
    { content: '任务3', status: 'pending' },
  ], '条目要归一成 DSH 的 content/status 两字段（priority 丢弃）')
  assert.equal(plans[2].entries[0].status, 'completed', '状态要跟进')
  assert.equal(plans[2].sessionId, 'session-under-test')
  await adapter.dispose()
}

{
  // 同一计划重复推送 → 不重复写事件；空计划 / 空条目不写。
  const same = { sessionUpdate: 'plan', entries: [{ content: '只此一步', status: 'pending' }] }
  const frames = [same, same, same, { sessionUpdate: 'plan', entries: [] }]
  const plans = []
  const connection = fakeConnection(frames)
  const adapter = adapterWith(connection, { onPlan: (event) => plans.push(event) })
  await collect(adapter)
  assert.equal(plans.length, 1, '同一份计划只同步一次（避免日志里堆满 todo/write）')
  await adapter.dispose()
}

{
  // 落盘：syncPlan 要真的 append todo/write，且形状符合 todo 投影。
  const appended = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name) => (name === 'agents'
      ? { get: (id) => (id === 's1' ? { session: { append: (type, data) => appended.push({ type, data }) } } : undefined) }
      : undefined),
  }
  const sync = createHostSync({ ctx, config: resolveConfig({}), logger: ctx.logger })
  sync.syncPlan({ sessionId: 's1', entries: [{ content: '第一步', status: 'in_progress' }] })
  assert.equal(appended.length, 1)
  assert.equal(appended[0].type, 'todo/write', '要写 todo/write 事件')
  assert.deepEqual(appended[0].data.todos, [{ content: '第一步', status: 'in_progress' }], '形状要与 todo_write 工具一致')
}

// ---------------------------------------------------------------------------
// 场景 2.5：CodeBuddy 自己的任务工具（实测它不发 ACP plan，只发 TaskCreate/TaskUpdate）
// ---------------------------------------------------------------------------

{
  // 实测帧：任务清单藏在 tool_call_update._meta['codebuddy.ai/rawResponse'].todos。
  const taskFrame = (todos) => ({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'chatcmpl-tool-x',
    status: 'completed',
    rawOutput: { type: 'text', text: 'Task #1 created successfully' },
    _meta: {
      'codebuddy.ai/toolName': 'TaskCreate',
      'codebuddy.ai/rawResponse': { task: { id: '1', subject: 'x' }, todos },
    },
  })
  const frames = [
    // TaskCreate：只有一条
    taskFrame([{ id: '1', content: '列出 plugins 目录', activeForm: '正在列出 plugins 目录', status: 'pending' }]),
    // TaskUpdate #1 完成
    taskFrame([
      { id: '1', content: '列出 plugins 目录', activeForm: '', status: 'completed' },
      { id: '2', content: '统计 .mjs 数量', activeForm: '', status: 'in_progress' },
    ]),
    // 全部完成
    taskFrame([
      { id: '1', content: '列出 plugins 目录', activeForm: '', status: 'completed' },
      { id: '2', content: '统计 .mjs 数量', activeForm: '', status: 'completed' },
    ]),
  ]
  const plans = []
  const connection = fakeConnection(frames)
  const adapter = adapterWith(connection, { onPlan: (event) => plans.push(event) })
  await collect(adapter)

  assert.equal(plans.length, 3, '任务清单每变化一次同步一次')
  assert.deepEqual(plans[2].entries, [
    { content: '列出 plugins 目录', status: 'completed' },
    { content: '统计 .mjs 数量', status: 'completed' },
  ], '任务清单要归一成 DSH 的 content/status')
  assert.equal(plans[0].sessionId, 'session-under-test', '要带 DSH 会话 id')
  await adapter.dispose()
}

{
  // 同一份清单重复推送 → 不重复写；空 todos → 不写。
  const todos = [{ id: '1', content: '唯一一步', status: 'pending' }]
  const frame = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c',
    _meta: { 'codebuddy.ai/rawResponse': { todos } },
  }
  const plans = []
  const connection = fakeConnection([frame, frame, frame, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c2',
    _meta: { 'codebuddy.ai/rawResponse': { todos: [] } },
  }])
  const adapter = adapterWith(connection, { onPlan: (event) => plans.push(event) })
  await collect(adapter)
  assert.equal(plans.length, 1, '同一份清单只同步一次')
  await adapter.dispose()
}

{
  // DSH 侧同意 → 选第一个 allow 类 option（按 kind，不硬编码 optionId）。
  const asked = []
  const ask = async (request) => { asked.push(request); return 'allow' }
  const sessions = new Map([['session-under-test', { key: 'session-under-test', acpSessionId: 'fake-session' }]])
  const outcome = await resolvePermissionRequest({
    sessions,
    ask,
    logger: { info: () => {}, warn: () => {} },
    params: {
      sessionId: 'fake-session',
      toolCall: { toolCallId: 'call_1', title: 'Write a.txt', kind: 'edit' },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  })
  assert.equal(asked.length, 1, '应询问 DSH 一次')
  assert.equal(asked[0].toolName, 'Write a.txt', '问询要带工具标题')
  assert.equal(asked[0].sessionId, 'session-under-test', '问询要带 DSH 会话 id（不是 ACP 的 sessionId）')
  assert.deepEqual(outcome, { outcome: 'selected', optionId: 'allow_once' }, '选第一个 allow 类 option')
}

{
  // DSH 侧拒绝 → 选 reject 类 option；没有 reject 类就回 cancelled。
  const picked = await resolvePermissionRequest({
    sessions: new Map([['s', { key: 's', acpSessionId: 'fake-session' }]]),
    ask: async () => 'deny',
    logger: { info: () => {}, warn: () => {} },
    params: {
      sessionId: 'fake-session',
      toolCall: { toolCallId: 'c', title: 'Bash rm -rf', kind: 'execute' },
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_always', name: 'Never', kind: 'reject_always' },
      ],
    },
  })
  assert.deepEqual(picked, { outcome: 'selected', optionId: 'reject_always' }, '拒绝要选 reject 类 option')

  const noReject = await resolvePermissionRequest({
    sessions: new Map([['s', { key: 's', acpSessionId: 'fake-session' }]]),
    ask: async () => 'deny',
    logger: { info: () => {}, warn: () => {} },
    params: {
      sessionId: 'fake-session',
      toolCall: { toolCallId: 'c2', title: 'Bash x', kind: 'execute' },
      options: [{ optionId: 'only_allow', name: 'Go', kind: 'allow_once' }],
    },
  })
  assert.deepEqual(noReject, { outcome: 'cancelled' }, '没有 reject 类 option 时回 cancelled')

  // 没有 allow 类 option 时选第一个 option（有的 agent 只给一个模糊选项）。
  const fallbackOption = await resolvePermissionRequest({
    sessions: new Map([['s', { key: 's', acpSessionId: 'fake-session' }]]),
    ask: async () => 'allow',
    logger: { info: () => {}, warn: () => {} },
    params: {
      sessionId: 'fake-session',
      toolCall: { toolCallId: 'c3', title: 'x', kind: 'other' },
      options: [{ optionId: 'weird', name: 'OK', kind: 'custom' }],
    },
  })
  assert.deepEqual(fallbackOption, { outcome: 'selected', optionId: 'weird' }, '没有标准 kind 时选第一个 option')
}
{
  // 没有审批钩子（组合里没有 approval 服务）→ 返回 undefined，交回 permissionPolicy。
  const outcome = await resolvePermissionRequest({
    sessions: new Map([['s', { key: 's', acpSessionId: 'fake-session' }]]),
    ask: undefined,
    logger: { info: () => {}, warn: () => {} },
    params: { sessionId: 'fake-session', toolCall: { toolCallId: 'c', title: 'Write a.txt', kind: 'edit' }, options: [] },
  })
  assert.equal(outcome, undefined, '问不了就要交回静态策略')

  // 钩子抛错也不能让整轮挂掉。
  const broken = await resolvePermissionRequest({
    sessions: new Map([['s', { key: 's', acpSessionId: 'fake-session' }]]),
    ask: async () => { throw new Error('审批服务挂了') },
    logger: { info: () => {}, warn: () => {} },
    params: { sessionId: 'fake-session', toolCall: { toolCallId: 'c', title: 'x', kind: 'other' }, options: [] },
  })
  assert.equal(broken, undefined, '审批失败要安全回退')

  // 找不到对应 DSH 会话（例如连接已换）→ 也不问，交回静态策略。
  const orphan = await resolvePermissionRequest({
    sessions: new Map(),
    ask: async () => 'allow',
    logger: { info: () => {}, warn: () => {} },
    params: { sessionId: 'unknown', toolCall: {}, options: [] },
  })
  assert.equal(orphan, undefined, '找不到会话就交回静态策略')
}

{
  // 端到端：permissionPolicy=ask 时真的去问 DSH 审批服务，并读会话策略。
  const requests = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name) => {
      if (name === 'approval') {
        return { request: async (request) => { requests.push(request); return 'allowed-once' } }
      }
      if (name === 'agents') {
        return {
          get: (id) => (id === 's1'
            ? { session: { snapshotEvents: () => [{ type: 'approval/policy', data: { policy: 'ask' } }] } }
            : undefined),
        }
      }
      return undefined
    },
  }
  const sync = createHostSync({ ctx, config: resolveConfig({ permissionPolicy: 'ask' }), logger: ctx.logger })
  const decision = await sync.askPermission({ sessionId: 's1', toolName: 'Write a.txt', reason: '编辑文件' })
  assert.equal(decision, 'allow', 'allowed-once 要映射成 allow')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].toolName, 'Write a.txt')

  // 策略是 never 时不去打扰审批服务（它会直接拒绝，问也白问）。
  const neverCtx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name) => {
      if (name === 'approval') return { request: async () => { throw new Error('不该被调用') } }
      if (name === 'agents') {
        return {
          get: (id) => (id === 's1'
            ? { session: { snapshotEvents: () => [{ type: 'approval/policy', data: { policy: 'never' } }] } }
            : undefined),
        }
      }
      return undefined
    },
  }
  const neverSync = createHostSync({
    ctx: neverCtx,
    config: resolveConfig({ permissionPolicy: 'ask', permissionAskFallback: 'deny' }),
    logger: neverCtx.logger,
  })
  const neverDecision = await neverSync.askPermission({ sessionId: 's1', toolName: 'x' })
  assert.equal(neverDecision, 'deny', 'never 策略下按兜底（这里是 deny）')

  // 没有 approval 服务（如 headless）→ 按兜底，不返回 undefined。
  // 返回 undefined 会让上层用静态 permissionPolicy；但这里已经是 ask 模式，
  // 用户明确要求「问」，拿不到审批方时应当有一个确定的答案。
  const noService = createHostSync({
    ctx: { logger: { info: () => {}, warn: () => {} }, get: (name) => (name === 'agents'
      ? { get: () => ({ session: { snapshotEvents: () => [] } }) }
      : undefined) },
    config: resolveConfig({ permissionPolicy: 'ask', permissionAskFallback: 'allow' }),
    logger: { info: () => {}, warn: () => {} },
  })
  assert.equal(await noService.askPermission({ sessionId: 's1', toolName: 'x' }), 'allow', '没有审批服务时按兜底')

  // 静态策略不问 DSH。
  const staticSync = createHostSync({ ctx, config: resolveConfig({ permissionPolicy: 'allow' }), logger: ctx.logger })
  assert.equal(await staticSync.askPermission({ sessionId: 's1', toolName: 'x' }), undefined, 'allow 策略不问')
}

// ---------------------------------------------------------------------------
// 场景 4：标题写进 DSH（sessionTitle.rename）
// ---------------------------------------------------------------------------

{
  const renames = []
  const session = { id: 's1' }
  // 真实的 sessionTitle.get() 读会话日志折叠值，rename() 之后再 get() 就是新标题。
  let current = '旧标题'
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name) => {
      if (name === 'sessionTitle') {
        return {
          get: () => ({ title: current }),
          rename: (target, title) => {
            renames.push({ target, title })
            current = title
            return { title }
          },
        }
      }
      if (name === 'sessions') return { get: (id) => (id === 's1' ? session : undefined) }
      return undefined
    },
  }
  const sync = createHostSync({ ctx, config: resolveConfig({}), logger: ctx.logger })
  sync.applyTitle({ sessionId: 's1', title: '新标题' })
  assert.equal(renames.length, 1, '要调用一次 rename')
  assert.equal(renames[0].title, '新标题')
  assert.equal(renames[0].target, session)

  // 同一个标题不重复 rename。
  sync.applyTitle({ sessionId: 's1', title: '新标题' })
  assert.equal(renames.length, 1, '同标题不重复写')

  // 服务缺失 / 会话不在 → 安静跳过。
  const emptySync = createHostSync({
    ctx: { logger: { info: () => {}, warn: () => {} }, get: () => undefined },
    config: resolveConfig({}),
    logger: { info: () => {}, warn: () => {} },
  })
  emptySync.applyTitle({ sessionId: 's1', title: 'x' })
  emptySync.syncPlan({ sessionId: 's1', entries: [{ content: 'a', status: 'pending' }] })
  assert.equal(await emptySync.askPermission({ sessionId: 's1', toolName: 't' }), undefined, '没有服务时安静降级')

  // 开关关掉时什么都不做。
  const offSync = createHostSync({ ctx, config: resolveConfig({ syncTitle: false, syncPlan: false }), logger: ctx.logger })
  offSync.applyTitle({ sessionId: 's1', title: '再改一次' })
  assert.equal(renames.length, 1, 'syncTitle=false 时不改标题')
}

process.stdout.write('sync-title-plan-approval: 全部通过\n')
