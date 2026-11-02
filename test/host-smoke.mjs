/**
 * 宿主半身冒烟测试：用最小桩上下文挂载控制台路由，
 * 直接调用 handler 验证 state / settings / refresh / reset 四条路径与校验。
 *
 * 用法：node test/host-smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodeBuddyStore } from '../src/store.js'
import { registerConsole } from '../src/console.js'

const directory = await mkdtemp(join(tmpdir(), 'cb-console-'))
const store = new CodeBuddyStore({ directory })
store.loadSync()

/** 假适配器：只实现控制台用到的四个方法。 */
const adapter = {
  policy: { enabled: null, order: [] },
  calls: [],
  accountInfo: () => ({ users: [{ userId: 'u-1', userName: '测试' }], connections: 1 }),
  catalogSnapshot: async () => [
    { id: 'hy3', name: 'Hy3', credits: 'x0.00 credits', creditRate: 0, contextWindow: 192000, enabled: true, default: false },
    { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79 credits', creditRate: 0.79, contextWindow: 1000000, enabled: true, default: false },
  ],
  listModels: async () => {
    const enabled = adapter.policy.enabled
    const all = [{ id: 'hy3' }, { id: 'glm-5.3' }]
    return enabled === null ? all : all.filter((model) => enabled.includes(model.id))
  },
  setModelPolicy: (policy) => { adapter.policy = policy },
  refreshCatalog: async () => { adapter.calls.push('refresh'); return 2 },
}

/** 捕获注册的 handler。 */
let handler = null
const webCtx = {
  effect: (fn) => { fn(); return () => {} },
  webServer: {
    register: (route) => { handler = route.handler; return () => {} },
  },
  get: () => undefined,
}

const config = {
  provider: 'codebuddy',
  displayName: 'CodeBuddy',
  command: 'codebuddy',
  modelDiscovery: 'both',
}

/** 假账号服务：不触网，返回固定的余额与签到状态。 */
const billing = {
  available: false,
  accountSummary: () => (billing.available
    ? { available: true, uid: 'uid-1234567890', label: '测试', domain: 'www.codebuddy.cn', backend: 'https://copilot.tencent.com', authFile: 'fake.info' }
    : { available: false, reason: '没找到 CodeBuddy 登录态' }),
  fetchBalance: async () => (billing.available
    ? { ok: true, authorized: true, total: 88.5, activePackageCount: 2, packageCount: 2, packages: [{ name: '免费额度', remaining: 88.5, size: 100, used: 11.5, unit: 'credits', expireAt: 0, expiresInDays: null, expired: false }], at: 1, message: '' }
    : { ok: false, authorized: true, message: '没找到 CodeBuddy 登录态', total: null, packages: [] }),
  fetchCheckin: async () => (billing.available
    ? { ok: true, authorized: true, active: true, checkedIn: false, todayCredit: 5, dailyCredit: 100, streakDays: 2, message: '' }
    : { ok: false, authorized: true, active: false, checkedIn: false, streakDays: 0, dailyCredit: 0, message: '没找到 CodeBuddy 登录态' }),
  claimDaily: async () => (billing.available
    ? { ok: true, claimed: true, credit: 5, todayCredit: 5, message: '领取成功，+5 积分' }
    : { ok: false, claimed: false, message: '没找到 CodeBuddy 登录态' }),
}

registerConsole({ ctx: webCtx, adapter, store, billing, logger: {}, config })
assert.equal(typeof handler, 'function', '应注册一条前缀路由')

/**
 * 模拟一次请求。
 * @param {string} method 方法。
 * @param {string} path 路径（含前缀）。
 * @param {object} [options] 选项。
 * @returns {Promise<{ status: number, body: object }>} 结果。
 */
async function call(method, path, options = {}) {
  const headers = options.header === false ? {} : { 'x-dsh-codebuddy-console': '1' }
  const url = `http://localhost:31083/api/codebuddy-console${path}`
  const request = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(JSON.stringify(options.body))
    },
  }
  let status = 0
  let payload = ''
  const response = {
    writeHead: (code) => { status = code },
    end: (chunk) => { payload = chunk ?? '' },
  }
  await handler(request, response)
  return { status, body: payload === '' ? null : JSON.parse(payload) }
}

// 1. GET /state
const state = await call('GET', '/state')
assert.equal(state.status, 200)
assert.equal(state.body.ok, true)
assert.equal(state.body.data.models.length, 2)
assert.equal(state.body.data.billing.available, false, '默认读不到登录态')
assert.equal(state.body.data.billing.credits.ok, false, '读不到登录态时余额不可用')
assert.equal('budget' in state.body.data.settings, false, '预算设置已下线')

// 2. GET /rates：模型选择器用的倍率表
const rates = await call('GET', '/rates')
assert.equal(rates.status, 200)
assert.equal(rates.body.data.provider, 'codebuddy')
assert.equal(rates.body.data.rates.hy3, 0, 'hy3 是免费档')
assert.equal(rates.body.data.rates['glm-5.3'], 0.79, 'glm-5.3 倍率应解析成数字')

// 3. 读到登录态后：余额与签到可用，领取走同一接口
billing.available = true
const online = await call('GET', '/state')
assert.equal(online.body.data.billing.available, true)
assert.equal(online.body.data.billing.label, '测试')
assert.equal(online.body.data.billing.credits.total, 88.5)
assert.equal(online.body.data.billing.checkin.streakDays, 2)

const refreshCredits = await call('POST', '/billing/refresh', { body: {} })
assert.equal(refreshCredits.status, 200)
assert.equal(refreshCredits.body.data.billing.credits.ok, true)

const checkin = await call('POST', '/billing/checkin', { body: {} })
assert.equal(checkin.status, 200)
assert.equal(checkin.body.data.result.claimed, true)
assert.match(checkin.body.data.result.message, /\+5/)

// 4. POST /settings：模型策略写进适配器
const models = await call('POST', '/settings', {
  body: { models: { enabled: ['hy3'], order: ['hy3', 'glm-5.3'], defaultModel: 'hy3' } },
})
assert.equal(models.status, 200)
assert.deepEqual(models.body.data.settings.models.enabled, ['hy3'])
assert.equal(models.body.data.settings.models.defaultModel, 'hy3')
assert.deepEqual(adapter.policy.enabled, ['hy3'], '策略应同步到适配器')
assert.deepEqual(models.body.data.selectableModelIds, ['hy3'], '选择器只剩启用的模型')

// 5. 校验：models 形状错误
const badModels = await call('POST', '/settings', { body: { models: { enabled: 'hy3' } } })
assert.equal(badModels.status, 500)
assert.ok(String(badModels.body.error).includes('models.enabled'))

// 6. 校验：缺请求头与空设置
const forbidden = await call('POST', '/settings', { body: {}, header: false })
assert.equal(forbidden.status, 403)
const empty = await call('POST', '/settings', { body: {} })
assert.equal(empty.status, 400)

// 7. 未知路径
const missing = await call('GET', '/nope')
assert.equal(missing.status, 404)

// 8. POST /refresh 与 /reset
const refresh = await call('POST', '/refresh', { body: {} })
assert.equal(refresh.status, 200)
assert.deepEqual(adapter.calls, ['refresh'])
await store.record({ credits: 12.5, tokens: 1000, model: 'hy3' })
await store.flush()
assert.equal(store.summary().total.credits, 12.5)
const reset = await call('POST', '/reset', { body: {} })
assert.equal(reset.status, 200)
assert.equal(reset.body.data.usage.total.credits, 0, '重置后账本归零')

// 9. 设置会落盘
const reopened = new CodeBuddyStore({ directory })
reopened.loadSync()
assert.deepEqual(reopened.getSettings().models.enabled, ['hy3'])

await rm(directory, { recursive: true, force: true })

console.log('ok  state / rates / settings / refresh / reset')
console.log('ok  余额与签到接口（读不到登录态时不阻塞页面）')
console.log('ok  参数校验与请求头防护')
console.log('ok  设置持久化')
console.log('\nhost-smoke: 全部通过')
