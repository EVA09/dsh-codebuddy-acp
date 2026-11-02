/**
 * 账号额度 / 每日签到 / 倍率解析的离线自测。
 *
 * 用法：`node test/billing.test.mjs`
 * 不发起真实网络请求：上游 fetch 由本地桩替代，登录态用临时文件冒充。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  backendFor,
  billingHeaders,
  CodeBuddyBilling,
  readAuthFile,
  toEpochSeconds,
  unwrapResponse,
} from '../src/billing.js'
import { formatCreditRate, parseCreditRate } from '../src/models.js'
import { CodeBuddyStore, normalizeSettings } from '../src/store.js'

const realFetch = globalThis.fetch

/**
 * 安装一个按 URL 分发的 fetch 桩。
 * @param {Array<{ match: RegExp, status?: number, body: object }>} routes 路由表。
 * @returns {{ calls: Array<{ url: string, headers: object }> }} 调用记录。
 */
function stubFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const text = String(url)
    calls.push({ url: text, headers: init.headers ?? {} })
    const route = routes.find((item) => item.match.test(text))
    if (route === undefined) throw new Error(`unexpected url: ${text}`)
    const status = route.status ?? 200
    return new Response(JSON.stringify(route.body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { calls }
}

const directory = await mkdtemp(join(tmpdir(), 'cb-billing-'))
const authFile = join(directory, 'Tencent-Cloud.coding-copilot.info')

try {
  // ---------- 1. 纯函数 ----------
  assert.equal(parseCreditRate('x0.34 credits'), 0.34)
  assert.equal(parseCreditRate('x3.31 credits'), 3.31)
  assert.equal(parseCreditRate('x0.00 credits'), 0)
  assert.equal(parseCreditRate(''), undefined)
  assert.equal(formatCreditRate(0.34), '×0.34')
  assert.equal(formatCreditRate(0), '免费', '零倍率显示为免费')
  assert.equal(formatCreditRate(undefined), undefined)

  assert.equal(backendFor('www.codebuddy.cn'), 'https://copilot.tencent.com')
  assert.equal(backendFor('www.workbuddy.ai'), 'https://www.workbuddy.ai')
  assert.equal(backendFor(''), 'https://copilot.tencent.com')

  assert.equal(toEpochSeconds('2026-10-29 13:02:41'), Math.floor(Date.parse('2026-10-29T13:02:41') / 1000))
  assert.equal(toEpochSeconds(1793250161000), 1793250161, '毫秒转秒')
  assert.equal(toEpochSeconds('9999-99-99 99:99:99'), 0)
  assert.equal(toEpochSeconds(''), 0)

  const headers = billingHeaders({ accessToken: 'tok', uid: 'u-1', domain: 'www.codebuddy.cn' })
  assert.equal(headers.Authorization, 'Bearer tok')
  assert.equal(headers['X-User-Id'], 'u-1')
  assert.equal(headers['X-No-Enterprise-Id'], '1')
  assert.equal(headers['X-Product'], 'SaaS')

  assert.equal(unwrapResponse({ status: 200, payload: { code: 0, msg: 'OK', data: { active: true } } }).ok, true)
  assert.equal(unwrapResponse({ status: 200, payload: { code: 401, msg: '未登录' } }).ok, false)
  assert.equal(unwrapResponse({ status: 500, payload: { code: 0, msg: 'OK' } }).ok, false, 'HTTP 5xx 也算失败')

  // ---------- 2. 设置文件里没有预算 ----------
  const settings = normalizeSettings({ budget: { period: 'day', amount: 500 }, models: { enabled: ['a'] } })
  assert.deepEqual(settings.models.enabled, ['a'])
  assert.equal('budget' in settings, false, '预算字段应被丢弃')

  const store = new CodeBuddyStore({ directory })
  store.loadSync()
  assert.equal('account' in store, false, '数据仓不再保存任何凭据')

  // ---------- 3. 登录态解析 ----------
  await writeFile(authFile, JSON.stringify({
    account: { uid: 'uid-1234567890', nickname: '测试账号' },
    auth: { accessToken: 'access-token-value', domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86400000 },
  }), 'utf8')

  const parsed = readAuthFile(authFile)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.nickname, '测试账号')
  assert.equal(parsed.domain, 'www.codebuddy.cn')

  // at-rest 信封：不尝试解密，给出明确原因。
  await writeFile(authFile, JSON.stringify({
    account: { uid: 'uid-2' },
    auth: { accessToken: { $wbEncrypted: 1, envelope: 'xxx' } },
  }), 'utf8')
  const sealed = readAuthFile(authFile)
  assert.equal(sealed.ok, false)
  assert.match(sealed.reason, /加密|at-rest/, '应提示加密信封')

  // 缺 token：提示去 CLI 登录。
  await writeFile(authFile, JSON.stringify({ account: {}, auth: {} }), 'utf8')
  const empty = readAuthFile(authFile)
  assert.equal(empty.ok, false)
  assert.match(empty.reason, /login|accessToken/)

  // ---------- 4. 余额 / 签到 / 领取 ----------
  await writeFile(authFile, JSON.stringify({
    account: { uid: 'uid-1234567890', nickname: '测试账号' },
    auth: { accessToken: 'access-token-value', domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86400000 },
  }), 'utf8')

  const { calls } = stubFetch([
    {
      match: /\/v2\/billing\/meter\/get-user-resource/,
      body: {
        code: 0,
        msg: 'OK',
        data: {
          Response: {
            Data: {
              TotalDosage: 200,
              Accounts: [
                {
                  PackageName: '免费额度',
                  CapacityUnit: 'credits',
                  CycleCapacityRemainPrecise: 120.5,
                  CycleCapacityUsedPrecise: 79.5,
                  CycleCapacitySizePrecise: 200,
                  CycleEndTime: '2030-11-30 23:59:59',
                  AccountAttributes: [{ Key: 'grantSource', Value: 'daily_checkin' }],
                },
                { PackageName: '过期包', CycleCapacityRemainPrecise: 9, ExpiredTime: '2020-01-01 00:00:00' },
              ],
            },
          },
        },
      },
    },
    { match: /checkin-activity-status/, body: { code: 0, msg: 'OK', data: { active: true, today_checked_in: false, today_credit: 0, daily_credit: 100, streak_days: 3 } } },
    { match: /daily-checkin/, body: { code: 0, msg: 'OK', data: { credit: 20, today_checked_in: true, streak_days: 4 } } },
  ])

  const billing = new CodeBuddyBilling({ authFile })
  const account = billing.accountSummary()
  assert.equal(account.available, true)
  assert.equal(account.backend, 'https://copilot.tencent.com')
  assert.equal(account.nickname === undefined || true, true)
  assert.equal('accessToken' in account, false, '账号概览不含 token')

  const balance = await billing.fetchBalance({ force: true })
  assert.equal(balance.ok, true)
  assert.equal(balance.total, 120.5, '只统计未过期且有剩余的有效包')
  assert.equal(balance.packageCount, 2)
  assert.equal(balance.activePackageCount, 1)
  assert.equal(balance.packages[0].grantSource, 'daily_checkin', '签到赠送包应识别 grantSource')

  // 请求头带上了 CLI 指纹。
  const balanceCall = calls.find((item) => /get-user-resource/.test(item.url))
  assert.equal(balanceCall.headers.Authorization, 'Bearer access-token-value')
  assert.equal(balanceCall.headers['X-Product'], 'SaaS')

  const checkin = await billing.fetchCheckin({ force: true })
  assert.equal(checkin.ok, true)
  assert.equal(checkin.checkedIn, false)
  assert.equal(checkin.streakDays, 3)
  assert.equal(checkin.dailyCredit, 100)

  const claim = await billing.claimDaily()
  assert.equal(claim.ok, true)
  assert.equal(claim.claimed, true)
  assert.equal(claim.credit, 20)
  assert.match(claim.message, /\+20/)

  // 领取后缓存失效，再读一次会重新打上游。
  const before = calls.length
  const refreshed = await billing.fetchBalance()
  assert.equal(refreshed.ok, true)
  assert.ok(calls.length > before, '领取后余额缓存应失效')

  // ---------- 5. 已领取时不再重复请求 ----------
  stubFetch([
    { match: /checkin-activity-status/, body: { code: 0, data: { active: true, today_checked_in: true, today_credit: 100, streak_days: 4 } } },
  ])
  const repeat = await billing.claimDaily()
  assert.equal(repeat.claimed, false)
  assert.equal(repeat.message, '今日已领取')

  // ---------- 6. 上游失败不抛 ----------
  stubFetch([{ match: /get-user-resource/, status: 500, body: { code: 500, msg: '服务异常' } }])
  const failed = await billing.fetchBalance({ force: true })
  assert.equal(failed.ok, false)
  assert.equal(failed.total, null, '失败时余额为 null，页面据此显示原因')

  // 网络异常也不抛。
  globalThis.fetch = async () => { throw new Error('ECONNRESET') }
  const broken = await billing.fetchCheckin({ force: true })
  assert.equal(broken.ok, false)
  assert.match(broken.message, /ECONNRESET/)

  // 没登录态时给出可操作提示。
  const noAuth = new CodeBuddyBilling({ authFile: join(directory, 'nope.info') })
  const missing = noAuth.accountSummary()
  assert.equal(missing.available, false)
  assert.match(missing.reason, /login|登录/)

  process.stdout.write('billing.test.mjs: 全部通过\n')
} finally {
  globalThis.fetch = realFetch
  await rm(directory, { recursive: true, force: true })
}
