/**
 * Host 半身集成测试：用最小 Cordis 上下文真实加载 `index.js` 的 apply()，
 * 验证适配器注册、控制台路由挂载、接口返回形状与卸载清理。
 *
 * 与 host-smoke 的区别：这里跑的是**真实装配链路**（index.js → adapter/billing/console），
 * 只把网络与 CodeBuddy 子进程换成桩。
 *
 * 用法：node test/host-integration.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const realFetch = globalThis.fetch

/** 收集注册结果的最小上下文。 */
function createContext() {
  const state = {
    adapters: [],
    routes: [],
    disposers: [],
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name) => (name === 'workingDirectory' ? { defaultDirectory: process.cwd() } : undefined),
    effect: (fn) => {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : () => {}
      state.disposers.push(wrapped)
      return wrapped
    },
    inject: (names, callback) => {
      // 测试里 webServer 一定存在。
      callback(ctx)
      return () => {}
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        state.adapters.push({ providers, adapter })
        const handle = () => { state.adapters = state.adapters.filter((item) => item.adapter !== adapter) }
        handle.replace = () => {}
        return handle
      },
    },
    webServer: {
      register: (route) => {
        state.routes.push(route)
        return () => { state.routes = state.routes.filter((item) => item !== route) }
      },
    },
  }
  return { ctx, state }
}

const directory = await mkdtemp(join(tmpdir(), 'cb-host-'))
const authFile = join(directory, 'auth.info')

try {
  await writeFile(authFile, JSON.stringify({
    account: { uid: 'uid-1234567890', nickname: '集成测试账号' },
    auth: { accessToken: 'token-abc', domain: 'www.codebuddy.cn', expiresAt: Date.now() + 3600000 },
  }), 'utf8')

  // 桩：model 目录来自真实 product.json 太长，这里只回放两条。
  // `checkedIn` 随领取动作翻转，模拟真实接口的状态迁移。
  const remote = { checkedIn: false, streak: 7 }
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (/get-user-resource/.test(text)) {
      return new Response(JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          Response: {
            Data: {
              TotalDosage: 300,
              Accounts: [
                { PackageName: '签到包', CycleCapacityRemainPrecise: 99.25, CycleCapacitySizePrecise: 100, CycleCapacityUsedPrecise: 0.75, CycleEndTime: '2030-01-01 00:00:00', AccountAttributes: [{ Key: 'grantSource', Value: 'daily_checkin' }] },
              ],
            },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/checkin-activity-status/.test(text)) {
      return new Response(JSON.stringify({
        code: 0,
        data: { active: true, today_checked_in: remote.checkedIn, today_credit: remote.checkedIn ? 100 : 0, daily_credit: 100, streak_days: remote.streak },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/daily-checkin/.test(text)) {
      remote.checkedIn = true
      remote.streak += 1
      return new Response(JSON.stringify({ code: 0, data: { credit: 100, today_checked_in: true, streak_days: remote.streak } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch: ${text}`)
  }

  const { ctx, state } = createContext()

  // 用真实 index.js 的 apply 装一遍；环境变量指向临时 DSH_HOME，
  // 避免把测试写入真实数据目录。
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  try {
    const plugin = await import('../index.js')
    assert.equal(plugin.name, 'codebuddy-acp')
    assert.deepEqual(plugin.inject, ['llm'])

    plugin.apply(ctx, {
      provider: 'codebuddy',
      displayName: 'CodeBuddy',
      logLevel: 'silent',
      billingAuthFile: authFile,
    })

    assert.equal(state.adapters.length, 1, '应注册一个 LLM 适配器')
    assert.deepEqual(state.adapters[0].providers, ['codebuddy'], 'provider 路由应为 codebuddy')
    assert.equal(state.routes.length, 1, '应挂载一条控制台路由')
    assert.equal(state.routes[0].path, '/api/codebuddy-console')
    assert.equal(state.routes[0].kind, 'prefix')

    const handler = state.routes[0].handler

    /**
     * 模拟一次 HTTP 请求。
     * @param {string} method 方法。
     * @param {string} path 路径（含前缀）。
     * @param {object} [options] 选项。
     * @returns {Promise<{ status: number, body: any }>} 结果。
     */
    async function call(method, path, options = {}) {
      const headers = options.header === false ? {} : { 'x-dsh-codebuddy-console': '1' }
      const request = {
        method,
        url: `http://localhost:49810/api/codebuddy-console${path}`,
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

    // 适配器契约：宿主按方法调用校验，不靠 instanceof。
    const adapter = state.adapters[0].adapter
    for (const method of ['listModels', 'resolveModel', 'prepareCall', 'stream', 'providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'imageRequestTarget']) {
      assert.equal(typeof adapter[method], 'function', `适配器应实现 ${method}`)
    }

    const state0 = await call('GET', '/state')
    assert.equal(state0.status, 200)
    assert.equal(state0.body.ok, true)
    const data = state0.body.data
    assert.equal(data.billing.available, true, '应读到临时登录态')
    assert.equal(data.billing.label, '集成测试账号')
    assert.equal(data.billing.credits.ok, true, '余额应可读')
    assert.equal(data.billing.credits.total, 99.25, '有效额度包剩余应被统计')
    assert.equal(data.billing.checkin.checkedIn, false)
    assert.equal(data.billing.checkin.streakDays, 7)
    assert.equal('budget' in data.settings, false, '预算已下线')
    assert.equal('account.json' in data.config, false)
    assert.equal(data.config.dataDir, join(directory, 'codebuddy-acp'), '数据目录跟随 DSH_HOME')

    // 领取：只走 POST + 自定义头。
    const claimed = await call('POST', '/billing/checkin', { body: {} })
    assert.equal(claimed.status, 200)
    assert.equal(claimed.body.data.result.claimed, true)
    assert.equal(claimed.body.data.result.credit, 100)
    assert.equal(claimed.body.data.snapshot.billing.checkin.checkedIn, true, '领取后快照应反映已签')

    const denied = await call('POST', '/billing/checkin', { body: {}, header: false })
    assert.equal(denied.status, 403, '缺自定义头应被拒绝')

    // 倍率接口
    const rates = await call('GET', '/rates')
    assert.equal(rates.status, 200)
    assert.equal(rates.body.data.provider, 'codebuddy')
    assert.equal(typeof rates.body.data.rates, 'object')

    // 卸载：路由与适配器都应被清理。
    for (const dispose of state.disposers) await dispose()
    assert.equal(state.routes.length, 0, '卸载后路由应移除')
    assert.equal(state.adapters.length, 0, '卸载后适配器应反注册')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }

  process.stdout.write('host-integration: 全部通过\n')
} finally {
  globalThis.fetch = realFetch
  await rm(directory, { recursive: true, force: true })
}
