/**
 * 图片真的发给 CodeBuddy 的自测（离线，不联网、不消耗积分）。
 *
 * 修的 bug：`contentToText()` 把图片压成 `[图片附件：name]` 文本，图片**从未**真的发给
 * CodeBuddy，于是「贴张截图问一句」等于让模型凭空猜。修法是把图片作为 ACP
 * `session/prompt` 的 `{ type:'image', data:<canonical base64>, mimeType }` 内容块发出去。
 *
 * 协议依据（真实实测，见 probe/image-prompt.mjs 与 probe/out/image-prompt.summary.json）：
 * - `{type:'image', data, mimeType}` 被接受，模型真的「看见」图（红色/蓝色都答对）；
 * - 图片块放在 text 之前或之后都可以；
 * - **只给 `uri` 不给 `data` 会被 -32602 Invalid params 拒绝**，所以 data 是必填的。
 *
 * 用法：node test/image-prompt.test.mjs
 */

import assert from 'node:assert/strict'

import { CodeBuddyAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import {
  collectImageRefs,
  imageMarker,
  imageRefOf,
  latestUserImageIndexes,
  OFFLOADED_IMAGE_TEXT,
  selectImageIndexes,
} from '../src/image-input.js'

// ---------------------------------------------------------------------------
// 第一部分：纯函数（收集、选择、标号）
// ---------------------------------------------------------------------------

const pngRef = {
  attachmentId: 'sha256:aaaa',
  mediaType: 'image/png',
  bytes: 132,
  width: 64,
  height: 64,
  name: 'red.png',
}

assert.equal(imageRefOf({ type: 'image', attachment: pngRef })?.attachmentId, 'sha256:aaaa', '正常图片块要能被认出')
assert.equal(imageRefOf({ type: 'image', attachment: pngRef, offloaded: true }), undefined, '被省略的图没有字节可读')
assert.equal(
  imageRefOf({ type: 'image', attachment: { ...pngRef, mediaType: 'image/svg+xml' } }),
  undefined,
  'ACP 不支持的格式（svg）不能当图片块发',
)
assert.equal(imageRefOf({ type: 'text', text: 'hi' }), undefined, '文本块不是图片')

const messages = [
  { role: 'user', content: [{ type: 'image', attachment: { ...pngRef, attachmentId: 'sha256:old' } }, { type: 'text', text: '第一张' }] },
  { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
  { role: 'user', content: [{ type: 'text', text: '第二张：' }, { type: 'image', attachment: pngRef }] },
]
const collected = collectImageRefs(messages)
assert.deepEqual(collected.refs.map((ref) => ref.attachmentId), ['sha256:old', 'sha256:aaaa'], '按渲染顺序收集')
assert.deepEqual(collected.groups, [[0], [], [1]], '分组要能定位到消息')
assert.deepEqual(latestUserImageIndexes(messages, collected.groups), [1], 'latest 只取最后一条用户消息')

// 增量投喂：新消息里的图全部投；重放历史：默认只投最新的那张。
assert.deepEqual(selectImageIndexes({ messages, groups: collected.groups, replay: false, mode: 'latest' }), [0, 1])
assert.deepEqual(selectImageIndexes({ messages, groups: collected.groups, replay: true, mode: 'latest' }), [1])
assert.deepEqual(selectImageIndexes({ messages, groups: collected.groups, replay: true, mode: 'all' }), [0, 1])
assert.deepEqual(selectImageIndexes({ messages, groups: collected.groups, replay: true, mode: 'none' }), [])

assert.equal(imageMarker(pngRef, 1, undefined), '[图片 1：red.png]', '标号要带编号与文件名')
assert.equal(imageMarker(pngRef, 2, '未发送：宿主没有提供图片服务'), '[图片 2：red.png（未发送：宿主没有提供图片服务）]')
assert.equal(imageMarker(undefined, undefined, undefined), '[图片附件]', '退化形态与旧文案一致')

// ---------------------------------------------------------------------------
// 第二部分：假 ACP 连接（记录真正发出去的 prompt 内容块）
// ---------------------------------------------------------------------------

/**
 * 造一个假 ACP 连接：只实现适配器用到的方法，并把 prompt 的 content 原样记下来。
 *
 * @param {object[]} frames 依次回放的 `session/update` 载荷。
 * @returns {object} 假连接。
 */
function fakeConnection(frames) {
  const listeners = new Map()
  const calls = { prompts: [] }
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
        models: { currentModelId: 'deepseek-v4.1-flash', availableModels: [{ modelId: 'deepseek-v4.1-flash' }] },
        configOptions: [],
      }
    },
    async setSessionConfigOption(_sessionId, configId, value) {
      return { configOptions: [{ type: 'select', id: configId, currentValue: value }] }
    },
    prompt(sessionId, content) {
      // 关键断言素材：适配器到底发了什么。
      calls.prompts.push(content)
      const listener = listeners.get(sessionId)
      return (async () => {
        for (const frame of frames) {
          await new Promise((resolve) => setImmediate(resolve))
          listener?.(frame)
        }
        return { stopReason: 'end_turn' }
      })()
    },
    cancel() {},
    async authenticate() { return {} },
    async close() { this.closed = true },
  }
}

/**
 * 造适配器，并塞一条「已就绪」的共享连接（跳过真实 spawn / initialize）。
 *
 * @param {object} connection 假连接。
 * @param {object} options 参数。
 * @param {object} [options.configPatch] 配置覆盖。
 * @param {object} [options.hostPatch] 宿主桥覆盖（例如注入 readImage）。
 * @returns {CodeBuddyAdapter} 适配器。
 */
function adapterWith(connection, { configPatch = {}, hostPatch = {} } = {}) {
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
      ...hostPatch,
    },
    logger: { info: () => {}, warn: () => {} },
    policy: {},
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
    rememberModels() {},
    async trySetModel() { return true },
    async close() { await connection.close() },
    async trySetThoughtLevel() { return true },
    rememberThoughtLevel() {},
  })
  return adapter
}

/**
 * 跑一轮 stream，收集全部 chunk。
 *
 * @param {CodeBuddyAdapter} adapter 适配器。
 * @param {object[]} messageList 消息序列。
 * @param {object} [extra] 额外 GenerateOptions。
 * @returns {Promise<object[]>} chunk 序列。
 */
async function collect(adapter, messageList, extra = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'codebuddy',
    model: 'deepseek-v4.1-flash',
    messages: messageList,
    sessionId: 'session-under-test',
    ...extra,
  })) chunks.push(chunk)
  return chunks
}

/** 假附件服务：把引用换成固定 base64，并记录读过哪些。 */
function fakeImageHost(images = {}) {
  const reads = []
  return {
    reads,
    readImage: async (ref, target) => {
      reads.push({ attachmentId: ref.attachmentId, target })
      const found = images[ref.attachmentId]
      if (found === undefined) throw new Error('附件不存在')
      return found
    },
  }
}

const RED_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAA'

// --- 场景 1：图片真的进 prompt（这是这个 bug 的核心） ---------------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '红色' } },
  ])
  const host = fakeImageHost({ 'sha256:aaaa': { data: RED_PNG_BASE64, mediaType: 'image/png', bytes: 132 } })
  const adapter = adapterWith(connection, { hostPatch: host })

  const chunks = await collect(adapter, [
    { role: 'user', content: [{ type: 'text', text: '这张图是什么颜色？' }, { type: 'image', attachment: pngRef }] },
  ])

  const prompt = connection.calls.prompts.at(-1)
  assert.ok(Array.isArray(prompt), 'prompt 必须是内容块数组')
  const imageBlocks = prompt.filter((block) => block.type === 'image')
  assert.equal(imageBlocks.length, 1, '必须真的发了一个 image 内容块（旧实现这里是 0）')
  assert.equal(imageBlocks[0].data, RED_PNG_BASE64, 'image 块要带规范 base64')
  assert.equal(imageBlocks[0].mimeType, 'image/png', 'image 块要带 mimeType')
  assert.equal(prompt[0].type, 'text', '正文在前、图片在后（实测两种顺序都可以，这里取惯例）')
  assert.ok(prompt[0].text.includes('[图片 1：red.png]'), '正文里要留编号标号，和图片顺序对应')
  assert.equal(host.reads.length, 1, '同一张图只读一次')
  assert.deepEqual(host.reads[0].target, { width: 64, height: 64, maxBytes: 5 * 1024 * 1024 }, '投递目标要与 imageRequestTarget 一致')

  assert.equal(
    chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''),
    '红色',
    '这一轮照常收正文',
  )
  await adapter.dispose()
}

// --- 场景 2：只有图片、没有文字，不能被丢掉 -----------------------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '看到了' } },
  ])
  const host = fakeImageHost({ 'sha256:aaaa': { data: RED_PNG_BASE64, mediaType: 'image/png' } })
  const adapter = adapterWith(connection, { hostPatch: host })
  const chunks = await collect(adapter, [{ role: 'user', content: [{ type: 'image', attachment: pngRef }] }])

  assert.equal(connection.calls.prompts.length, 1, '纯图片消息也必须发出 prompt（旧实现直接 finish）')
  assert.deepEqual(
    connection.calls.prompts[0].filter((block) => block.type === 'image').length,
    1,
    '纯图片消息里必须带 image 块',
  )
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').at(-1).reason.kind, 'stop')
  await adapter.dispose()
}

// --- 场景 3：没有图片服务 → 退回占位符，但要说清「没发送」 ----------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '我看不到图' } },
  ])
  // 不给 host.readImage：等价于这个组合没有挂载 ctx.attachments。
  const adapter = adapterWith(connection)
  await collect(adapter, [
    { role: 'user', content: [{ type: 'text', text: '这是什么？' }, { type: 'image', attachment: pngRef }] },
  ])

  const prompt = connection.calls.prompts.at(-1)
  assert.equal(prompt.filter((block) => block.type === 'image').length, 0, '没有图片服务时不能声称发了图')
  assert.ok(prompt[0].text.includes('[图片 1：red.png（未发送：'), '正文要注明这张图没发出去')
  await adapter.dispose()
}

// --- 场景 4：读图失败不阻断整轮 -----------------------------------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '还是能回答' } },
  ])
  const host = fakeImageHost({}) // 任何 attachmentId 都会抛「附件不存在」
  const adapter = adapterWith(connection, { hostPatch: host })
  const chunks = await collect(adapter, [
    { role: 'user', content: [{ type: 'text', text: '这是什么？' }, { type: 'image', attachment: pngRef }] },
  ])
  assert.equal(chunks.find((chunk) => chunk.type === 'finish').reason.kind, 'stop', '读图失败不能让整轮失败')
  assert.ok(connection.calls.prompts[0][0].text.includes('（未发送：附件不存在）'), '失败原因要写进正文标号')
  await adapter.dispose()
}

// --- 场景 5：一次最多投 N 张 -------------------------------------------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ])
  const many = [1, 2, 3].map((index) => ({
    type: 'image',
    attachment: { ...pngRef, attachmentId: `sha256:${index}`, name: `${index}.png` },
  }))
  const host = fakeImageHost({
    'sha256:1': { data: RED_PNG_BASE64, mediaType: 'image/png' },
    'sha256:2': { data: RED_PNG_BASE64, mediaType: 'image/png' },
    'sha256:3': { data: RED_PNG_BASE64, mediaType: 'image/png' },
  })
  const adapter = adapterWith(connection, { hostPatch: host, configPatch: { maxImagesPerPrompt: 2 } })
  await collect(adapter, [{ role: 'user', content: many }])
  assert.equal(connection.calls.prompts[0].filter((block) => block.type === 'image').length, 2, '上限生效')
  assert.ok(connection.calls.prompts[0][0].text.includes('图片 3：3.png（未发送：一次最多 2 张图）'), '超限的图要注明')
  await adapter.dispose()
}

// --- 场景 6：imageInput: false 退回旧行为 ---------------------------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ])
  const host = fakeImageHost({ 'sha256:aaaa': { data: RED_PNG_BASE64, mediaType: 'image/png' } })
  const adapter = adapterWith(connection, { hostPatch: host, configPatch: { imageInput: false } })
  await collect(adapter, [
    { role: 'user', content: [{ type: 'text', text: '这是什么？' }, { type: 'image', attachment: pngRef }] },
  ])
  assert.equal(connection.calls.prompts[0].filter((block) => block.type === 'image').length, 0, '关闭后不发图片块')
  assert.equal(host.reads.length, 0, '关闭后连读都不读')
  await adapter.dispose()
}

// --- 场景 7：被压缩省略的图片要有占位说明，且不会被当图片发 -------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ])
  const host = fakeImageHost({})
  const adapter = adapterWith(connection, { hostPatch: host })
  await collect(adapter, [
    { role: 'user', content: [{ type: 'text', text: '刚才那张图' }, { type: 'image', attachment: pngRef, offloaded: true }] },
  ])
  assert.equal(connection.calls.prompts[0].filter((block) => block.type === 'image').length, 0)
  assert.ok(connection.calls.prompts[0][0].text.includes(OFFLOADED_IMAGE_TEXT), '被省略的图要留固定说明')
  assert.equal(host.reads.length, 0, '没有字节可读的图不去读')
  await adapter.dispose()
}

// --- 场景 8：同一张图出现两次只发一份（附件是内容寻址的） -----------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ])
  const host = fakeImageHost({ 'sha256:aaaa': { data: RED_PNG_BASE64, mediaType: 'image/png' } })
  const adapter = adapterWith(connection, { hostPatch: host })
  await collect(adapter, [
    { role: 'user', content: [{ type: 'image', attachment: pngRef }, { type: 'image', attachment: { ...pngRef } }] },
  ])
  assert.equal(connection.calls.prompts[0].filter((block) => block.type === 'image').length, 1, '重复图片去重')
  assert.equal(host.reads.length, 1)
  await adapter.dispose()
}

// --- 场景 9：签名要认图片身份（换一张图必须重新发） ---------------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ])
  const host = fakeImageHost({
    'sha256:aaaa': { data: RED_PNG_BASE64, mediaType: 'image/png' },
    'sha256:bbbb': { data: RED_PNG_BASE64, mediaType: 'image/png' },
  })
  const adapter = adapterWith(connection, { hostPatch: host })
  const first = [{ role: 'user', content: [{ type: 'text', text: '这是什么？' }, { type: 'image', attachment: pngRef }] }]
  await collect(adapter, first)
  // 同一句话、换一张图：旧签名只算文本，会认为「已转发过」而不发新图。
  const second = [
    { role: 'user', content: [{ type: 'text', text: '这是什么？' }, { type: 'image', attachment: { ...pngRef, attachmentId: 'sha256:bbbb', name: 'blue.png' } }] },
  ]
  const chunks = await collect(adapter, second)
  assert.equal(chunks.find((chunk) => chunk.type === 'finish').reason.kind, 'stop')
  assert.equal(connection.calls.prompts.length, 2, '换图后必须重新发一轮')
  const lastPrompt = connection.calls.prompts.at(-1)
  assert.equal(lastPrompt.filter((block) => block.type === 'image').length, 1, '新图要真的发出去')
  assert.ok(lastPrompt[0].text.includes('blue.png'), '新图的名字要出现')
  await adapter.dispose()
}

// --- 场景 10：重放历史默认只重发最新一张图 -------------------------------

{
  const connection = fakeConnection([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ])
  const host = fakeImageHost({
    'sha256:old': { data: RED_PNG_BASE64, mediaType: 'image/png' },
    'sha256:aaaa': { data: RED_PNG_BASE64, mediaType: 'image/png' },
  })
  const adapter = adapterWith(connection, { hostPatch: host })
  // 第一条消息先建会话，第二条触发重放（recreated 分支只在真重开时走，这里用 attempt 路径模拟：
  // 直接喂完整历史并让共享连接返回 recreated=true 不便构造，因此这里验证「增量只发新图」）。
  await collect(adapter, [
    { role: 'user', content: [{ type: 'image', attachment: { ...pngRef, attachmentId: 'sha256:old', name: 'old.png' } }] },
  ])
  await collect(adapter, [
    { role: 'user', content: [{ type: 'image', attachment: { ...pngRef, attachmentId: 'sha256:old', name: 'old.png' } }] },
    { role: 'assistant', content: [{ type: 'text', text: '看到了' }] },
    { role: 'user', content: [{ type: 'image', attachment: pngRef }] },
  ])
  const lastPrompt = connection.calls.prompts.at(-1)
  assert.equal(lastPrompt.filter((block) => block.type === 'image').length, 1, '增量只发这一轮的新图')
  assert.ok(lastPrompt[0].text.includes('[图片 1：red.png]'), '新消息的标号从 1 开始')
  await adapter.dispose()
}

// ---------------------------------------------------------------------------

process.stdout.write('image-prompt.test.mjs 全部通过\n')
