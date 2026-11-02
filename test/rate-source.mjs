/**
 * 倍率来源验证：确认适配器用的是账号侧权威倍率，而不是发行版静态表。
 *
 * 用法：node test/rate-source.mjs
 */

import assert from 'node:assert/strict'

import { CodeBuddyBilling, parseModelRates, parseRateText } from '../src/billing.js'
import { CodeBuddyAdapter } from '../src/adapter.js'

// ---- 纯函数 ----
assert.equal(parseRateText('x0.11 credits'), 0.11)
assert.equal(parseRateText('x0.69'), 0.69, '有的文案不带 credits')
assert.equal(parseRateText('x0.00 credits'), 0)
assert.equal(parseRateText(''), undefined, 'auto / default 这类档位没有倍率')
assert.equal(parseRateText(undefined), undefined)

const parsed = parseModelRates({
  data: {
    models: [
      { id: 'deepseek-v4.1-flash', credits: 'x0.11 credits' },
      { id: 'glm-5.3', credits: 'x0.69' },
      { id: 'auto' },
    ],
  },
})
assert.equal(parsed['deepseek-v4.1-flash'].creditRate, 0.11)
assert.equal(parsed['glm-5.3'].creditRate, 0.69)
assert.equal(parsed.auto.creditRate, undefined, '无倍率档位不应被当成 0')

console.log('ok  倍率文案解析（含不带 credits 的写法）')

// ---- 适配器：账号倍率覆盖静态表 ----
/** 构造一个只依赖静态目录的适配器。 */
function makeAdapter({ rates }) {
  const adapter = new CodeBuddyAdapter({
    config: {
      provider: 'codebuddy',
      displayName: 'CodeBuddy',
      contextWindow: 200000,
      maxTokens: 32000,
      modelDiscovery: 'off',
      useModelsJson: false,
      showAliases: false,
    },
    launch: { argv: ['codebuddy'], env: {}, note: 'stub' },
    host: { defaultDirectory: () => '.', resolveCwd: async () => '.', readTextFile: async () => '', writeTextFile: async () => {} },
    logger: {},
    policy: { enabled: null, order: [] },
    fetchModelRates: async () => rates(),
  })
  // 绕过真实目录探测：直接放一份「发行版静态表」进去。
  adapter.staticCatalog = [
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.00 credits', creditRate: 0, contextWindow: 1000000, maxTokens: 32000, supportsImages: true },
    { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79 credits', creditRate: 0.79, contextWindow: 1000000, maxTokens: 32000, supportsImages: false },
    { id: 'space-bunny', name: 'Space Bunny', credits: '', creditRate: undefined, contextWindow: 200000, maxTokens: 32000, supportsImages: false },
  ]
  adapter.staticCatalogAt = Date.now()
  return adapter
}

// 1) 账号侧报 x0.11：必须覆盖静态表的 x0.00
const account = makeAdapter({
  rates: () => ({
    ok: true,
    rates: {
      'deepseek-v4.1-flash': { creditRate: 0.11, credits: 'x0.11 credits' },
      'glm-5.3': { creditRate: 0.69, credits: 'x0.69' },
    },
  }),
})
const models = await account.listModels('codebuddy')
const flash = models.find((model) => model.id === 'deepseek-v4.1-flash')
const glm = models.find((model) => model.id === 'glm-5.3')
const bunny = models.find((model) => model.id === 'space-bunny')
assert.equal(flash.name, 'Deepseek-V4.1-Flash ×0.11', '应以账号侧 x0.11 为准，而不是静态表的 x0.00')
assert.equal(glm.name, 'GLM-5.3 ×0.69', '账号侧 x0.69 覆盖静态表的 x0.79')
assert.equal(bunny.name, 'Space Bunny', '账号侧没有的模型保留原样')

const snapshot = await account.catalogSnapshot()
const flashEntry = snapshot.find((entry) => entry.id === 'deepseek-v4.1-flash')
assert.equal(flashEntry.creditRate, 0.11, '控制台拿到的倍率也应是账号侧的值')
assert.equal(flashEntry.rateSource, 'account')

console.log('ok  账号侧倍率覆盖发行版静态表（deepseek-v4.1-flash → ×0.11）')

// 2) 账号侧不可用：回落到目录自带倍率，不能崩
const offline = makeAdapter({ rates: () => ({ ok: false, rates: {} }) })
const fallback = await offline.listModels('codebuddy')
assert.equal(fallback.find((model) => model.id === 'deepseek-v4.1-flash').name, 'Deepseek-V4.1-Flash 免费')
assert.equal(fallback.find((model) => model.id === 'glm-5.3').name, 'GLM-5.3 ×0.79')

// 3) 抛错也不影响目录
const broken = makeAdapter({ rates: () => { throw new Error('ECONNRESET') } })
const survived = await broken.listModels('codebuddy')
assert.equal(survived.length, 3, '取倍率失败不应丢模型')

console.log('ok  账号侧不可用时安全回落')

// ---- 真实登录态下的端到端核对 ----
const live = new CodeBuddyBilling({})
const summary = live.accountSummary()
if (summary.available === true) {
  const table = await live.fetchModelRates({ force: true })
  if (table.ok === true) {
    const realFlash = table.rates['deepseek-v4.1-flash']
    console.log(`ok  真实账号倍率：deepseek-v4.1-flash = ${realFlash?.credits || '(无)'}，共 ${Object.keys(table.rates).length} 个模型`)
    assert.ok(realFlash !== undefined, '真实接口应包含 deepseek-v4.1-flash')
  } else {
    console.log(`跳过真实核对：${table.message}`)
  }
} else {
  console.log(`跳过真实核对：${summary.reason}`)
}

process.stdout.write('rate-source: 全部通过\n')
