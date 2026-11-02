/**
 * 浏览器半身冒烟测试：用假的 ModuleLoader 与最小 React 桩加载 client.js，
 * 断言导出、插槽注册、整页渲染与文案。
 *
 * 用法：node test/client-smoke.mjs
 */

import assert from 'node:assert/strict'

/** 记录 client.js 登记的 factory。 */
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => { loaded = entry },
  },
}

/**
 * 极简 React 桩：只覆盖 client.js 用到的 API。
 *
 * `useState` 按调用序号返回预设值，这样页面直接渲染「已就绪」的数据视图，
 * 不必真的走一遍 fetch。序号在每次渲染前重置。
 */
let hookValues = []
let hookIndex = 0
const reactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? undefined : children },
  }),
  useState: (initial) => {
    const index = hookIndex
    hookIndex += 1
    return [index < hookValues.length ? hookValues[index] : (typeof initial === 'function' ? initial() : initial), () => {}]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
}

globalThis.require = (name) => {
  if (name === 'react') return reactStub
  throw new Error(`client-smoke: 未预期的模块请求 ${name}`)
}

/** fetch 桩：让页面挂载时的首次请求拿到一份完整状态。 */
const sampleState = {
  account: {
    users: [{ userId: 'u-1', userName: '测试用户', authType: 'personal' }],
    connections: 1,
    provider: 'codebuddy',
    displayName: 'CodeBuddy',
    command: 'codebuddy',
    modelsAt: Date.parse('2026-10-28T11:00:00Z'),
    currentModel: 'deepseek-v4.1-flash',
  },
  billing: {
    available: true,
    label: '测试用户',
    uid: 'uid-1234567890',
    domain: 'www.codebuddy.cn',
    backend: 'https://copilot.tencent.com',
    credits: {
      ok: true,
      authorized: true,
      total: 120.5,
      activePackageCount: 1,
      packageCount: 1,
      packages: [{ name: '免费额度', unit: 'credit', remaining: 120.5, used: 79.5, size: 200, expireAt: 0, expiresInDays: null, expired: false }],
      at: Date.parse('2026-10-28T11:00:00Z'),
    },
    checkin: { ok: true, authorized: true, active: true, checkedIn: false, todayCredit: 0, dailyCredit: 100, streakDays: 3, message: '' },
  },
  models: [
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.00 credits', creditRate: 0, contextWindow: 1000000, enabled: true, default: true },
    { id: 'hy3', name: 'Hy3', credits: 'x0.79 credits', creditRate: 0.79, contextWindow: 192000, enabled: true, default: false },
  ],
  selectableModelIds: ['deepseek-v4.1-flash', 'hy3'],
  settings: {
    models: { enabled: ['deepseek-v4.1-flash', 'hy3'], order: [], defaultModel: 'deepseek-v4.1-flash' },
    updatedAt: 0,
  },
  usage: {
    today: { credits: 3.81, tokens: 27119, calls: 1 },
    month: { credits: 3.81, tokens: 27119, calls: 1 },
    total: { credits: 3.81, tokens: 27119, calls: 1 },
    sessions: [],
    byModel: { 'deepseek-v4.1-flash': { credits: 3.81, tokens: 27119, calls: 1, todayCredits: 3.81, todayCalls: 1 } },
    series: [],
    recent: [{ at: Date.parse('2026-10-28T11:00:00Z'), model: 'deepseek-v4.1-flash', credits: 3.81, tokens: 27119 }],
  },
  client: { registered: true, packageId: 'dsh-codebuddy-acp' },
  config: { provider: 'codebuddy', displayName: 'CodeBuddy', command: 'codebuddy', dataDir: 'C:/tmp' },
}

globalThis.document = { baseURI: 'http://localhost:31083/' }
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, data: sampleState }),
})

await import('../client.js')

assert.ok(loaded !== null, 'client.js 应调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-codebuddy-acp', 'bundle id 应为包名')
assert.equal(typeof loaded.factory, 'function')

const exports = loaded.factory(globalThis.require)
assert.equal(typeof exports.apply, 'function', '应导出 apply')
assert.ok(Array.isArray(exports.inject), '应导出 inject 数组')
assert.ok(exports.inject.includes('slots'), 'apply 需要 slots 服务')
assert.ok(exports.inject.includes('locale'), 'apply 需要 locale 服务')

const dictionaries = []
const registered = []
const ctx = {
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject: (name, callback) => { callback() },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
  locale: {
    register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
    bind: (ns) => (key) => (dictionaries[0]?.dicts?.zh ?? {})[key] ?? key,
  },
}

exports.apply(ctx)
assert.equal(dictionaries.length, 1, '应注册一份双语字典')
assert.ok(dictionaries[0].dicts.zh && dictionaries[0].dicts.en, '中英文都要有')
assert.equal(Object.keys(dictionaries[0].dicts.zh).length, Object.keys(dictionaries[0].dicts.en).length, '中英文键数量应一致')
assert.equal(registered.length, 3, '应注册侧栏图标、主面板与工具卡片各一次')

const sidebar = registered.find((entry) => entry.options.name === 'sidebar.panellist')
const main = registered.find((entry) => entry.options.name === 'main')
assert.ok(sidebar !== undefined, '应注册侧栏图标')
assert.ok(main !== undefined, '应注册主面板')
assert.equal(sidebar.options.id, 'codebuddy')
assert.equal(typeof sidebar.options.label, 'function')
assert.equal(sidebar.options.label(), 'CodeBuddy')
assert.equal(typeof sidebar.component, 'function')

const icon = sidebar.component({ size: 18, active: true })
assert.equal(icon.type, 'svg', '侧栏图标应为 SVG')

assert.equal(main.options.name, 'main')
assert.equal(main.options.key, 'codebuddy')

// 整页渲染（hooks 为桩，直接渲染已就绪的数据视图）
// 顺序对应 ConsolePage 里的 useState：state / busy / notice / modelDraft
hookValues = [
  { status: 'ready', data: sampleState, error: null },
  '',
  null,
  { enabled: ['deepseek-v4.1-flash', 'hy3'], order: [], defaultModel: 'deepseek-v4.1-flash' },
]
hookIndex = 0
const tree = main.component({ t: ctx.locale.bind('dsh-codebuddy-acp') })
assert.ok(tree !== null && typeof tree === 'object', '页面应返回元素')

/** 递归收集元素树里的可读文本。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (typeof node === 'object') {
    const props = node.props ?? {}
    if (typeof node.type === 'function') {
      // 函数组件就地展开，才能看到卡片内部的文案。
      collectText(node.type(props), out)
      return out
    }
    collectText(props.children, out)
  }
  return out
}

const text = collectText(tree).join(' ')
for (const expected of ['CodeBuddy', '剩余积分', '账号与积分', '模型管理', '按模型用量', '最近调用', '连接', '×0.79']) {
  assert.ok(text.includes(expected), `页面应包含「${expected}」`)
}

// ---------------------------------------------------------------------------
// 工具卡片：接管 codebuddy_tool 的通用行
// ---------------------------------------------------------------------------

const toolView = registered.find((entry) => entry.options.name === 'tool.call.toolview')
assert.ok(toolView !== undefined, '应注册 CodeBuddy 工具卡片')
assert.equal(toolView.options.key, 'codebuddy_tool', '卡片要按回放工具名接管')
assert.equal(typeof toolView.component, 'function')

const boundT = ctx.locale.bind('dsh-codebuddy-acp')
const toolArgs = JSON.stringify({
  title: 'Read C:\\work\\a.txt (1 - 3)',
  kind: 'read',
  path: 'C:\\work\\a.txt',
  callId: 'call_00',
})

// 完整态：标题、类别、结果输出都要渲染出来。
const settledTree = toolView.component({
  phase: 'result',
  t: boundT,
  cwd: 'C:\\work',
  openFile: () => {},
  block: {
    kind: 'tool-result',
    callId: 'call_00',
    name: 'codebuddy_tool',
    call: { name: 'codebuddy_tool', argsRaw: toolArgs },
    content: [{ type: 'text', text: '✓ Read a.txt\n\n   1→alpha' }],
    isError: false,
    meta: { kind: 'read', status: 'completed', title: 'Read a.txt', path: 'C:\\work\\a.txt' },
  },
})
const settledText = collectText(settledTree).join(' ')
assert.ok(settledText.includes('读取'), `卡片应显示中文类别：${settledText}`)
assert.ok(settledText.includes('Read C:\\work\\a.txt (1 - 3)'), '卡片应显示 CodeBuddy 的调用标题')
assert.ok(settledText.includes('完成'), '完成态要有状态标签')
assert.ok(settledText.includes('输出'), '结果折叠区要有标题')
assert.ok(settledText.includes('1→alpha'), '结果内容要渲染出来')

// 运行中（还没有结果）：不显示空输出提示，也不报错。
const runningTree = toolView.component({
  phase: 'start',
  t: boundT,
  block: { phase: 'start', callId: 'call_01', name: 'codebuddy_tool', argsRaw: toolArgs },
})
const runningText = collectText(runningTree).join(' ')
assert.ok(runningText.includes('执行中'), '运行中要有状态标签')
assert.ok(!runningText.includes('（这次调用没有返回内容）'), '运行中不该提示空输出')

// 失败态：要能看出是失败。
const failedTree = toolView.component({
  phase: 'result',
  t: boundT,
  block: {
    kind: 'tool-result',
    callId: 'call_02',
    name: 'codebuddy_tool',
    call: { name: 'codebuddy_tool', argsRaw: toolArgs },
    content: [{ type: 'text', text: '✗ 失败：拒绝写入' }],
    isError: true,
    meta: { kind: 'edit', status: 'failed', title: 'Edit a.txt' },
  },
})
const failedText = collectText(failedTree).join(' ')
assert.ok(failedText.includes('失败'), '失败态要有状态标签')

// 不同工具要能一眼分开：徽章文案按真实工具名（Read/Bash/Edit…）换，而不是统一写「工具」。
const bashCard = toolView.component({
  phase: 'result',
  t: boundT,
  block: {
    kind: 'tool-result',
    callId: 'call_03',
    name: 'codebuddy_tool',
    call: { name: 'codebuddy_tool', argsRaw: JSON.stringify({ title: '`ls -la`', tool: 'Bash', kind: 'execute', status: 'completed', callId: 'call_03' }) },
    content: [{ type: 'text', text: 'total 0' }],
    isError: false,
    meta: { kind: 'execute', status: 'completed', title: '`ls -la`' },
  },
})
const bashText = collectText(bashCard).join(' ')
assert.ok(bashText.includes('命令'), `Bash 要显示「命令」徽章：${bashText}`)
assert.ok(bashText.includes('ls -la'), '命令本体要出现在主行')

const editCard = toolView.component({
  phase: 'result',
  t: boundT,
  block: {
    kind: 'tool-result',
    callId: 'call_04',
    name: 'codebuddy_tool',
    call: { name: 'codebuddy_tool', argsRaw: JSON.stringify({ title: 'Edit src/a.js', tool: 'Edit', kind: 'edit', status: 'completed', callId: 'call_04', path: 'src/a.js' }) },
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    meta: { kind: 'edit', status: 'completed', title: 'Edit src/a.js', path: 'src/a.js' },
  },
})
const editText = collectText(editCard).join(' ')
assert.ok(editText.includes('修改'), `Edit 要显示「修改」徽章：${editText}`)
assert.ok(!editText.includes('命令'), 'Edit 不能被渲染成命令卡')

// 参数坏掉（截断/非法 JSON）时也不能崩。
const broken = toolView.component({
  phase: 'result',
  t: boundT,
  block: { kind: 'tool-result', call: { name: 'codebuddy_tool', argsRaw: '{"title":"半' }, content: [], isError: false },
})
assert.ok(collectText(broken).join(' ').includes('CodeBuddy 工具调用'), '参数不可解析时回落到默认标题')

console.log('ok  bundle 导出、插槽注册与双语字典')
console.log('ok  整页渲染与文案')
console.log('ok  工具卡片：完整/运行中/失败/坏参数四种状态')
console.log('\nclient-smoke: 全部通过')
