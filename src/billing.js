/**
 * CodeBuddy 账号额度（剩余积分）与每日签到。
 *
 * ACP 协议只回传「本轮消耗」，不给账户余额。真正的余额在 CodeBuddy 自己的
 * billing 接口上，凭据就是 CLI 已经存好的登录态：
 *
 *   POST {base}/v2/billing/meter/get-user-resource        额度包明细（剩余积分）
 *   POST {base}/v2/billing/meter/checkin-activity-status  每日签到状态
 *   POST {base}/v2/billing/meter/daily-checkin            领取每日积分
 *
 * 设计取舍（都是为了让这一层足够简单、不会坏）：
 *
 * - **只读登录态**：只从本机 auth 文件读 accessToken 用于请求，不回写、不上报、
 *   不复制到插件数据目录，因此插件配置文件里没有任何 token。
 * - **不动上游 token**：即使 token 快过期也不主动续期——续期会让 CLI 手里那份失效，
 *   得不偿失；过期时页面直接提示「在终端重新登录一次」。
 * - **无定时任务**：签到只由用户点按钮触发，插件不在后台自动领取。
 * - **失败不阻塞页面**：billing 拿不到时控制台照常显示用量，只是余额位显示原因。
 *
 * @module src/billing.js
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 国内版 billing 网关。 */
const CN_BACKEND = 'https://copilot.tencent.com'
/** 国际版（workbuddy.ai）网关。 */
const INTL_BACKEND = 'https://www.workbuddy.ai'
/** 拼进 User-Agent 的 CLI 版本（上游只做形态校验）。 */
const CLI_VERSION = '2.177.1'
/** 额度查询缓存时长。 */
const RESOURCE_TTL_MS = 60 * 1000
/** 签到状态缓存时长。 */
const CHECKIN_TTL_MS = 5 * 60 * 1000
/** 模型倍率缓存时长（服务端口径变化不快，避免每次打开选择器都打上游）。 */
const RATE_TTL_MS = 5 * 60 * 1000

/**
 * 本机 auth 文件的候选位置。
 * @param {string | undefined} authFile 显式指定的文件。
 * @returns {string[]} 候选路径（目录或文件）。
 */
export function candidateAuthPaths(authFile) {
  if (typeof authFile === 'string' && authFile.trim() !== '') return [authFile.trim()]
  const home = homedir()
  const paths = []
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    paths.push(join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  } else if (process.platform === 'darwin') {
    paths.push(join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  }
  const xdg = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share')
  paths.push(join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  return paths
}

/**
 * 找出所有 `*.info` 登录态文件，按修改时间从新到旧。
 * @param {string | undefined} authFile 显式指定的文件。
 * @returns {Array<{ path: string, mtime: number }>} 文件列表。
 */
export function findAuthFiles(authFile) {
  const found = []
  for (const candidate of candidateAuthPaths(authFile)) {
    if (!existsSync(candidate)) continue
    let info
    try {
      info = statSync(candidate)
    } catch {
      continue
    }
    if (info.isFile()) {
      found.push({ path: candidate, mtime: info.mtimeMs })
      continue
    }
    let names = []
    try {
      names = readdirSync(candidate)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.info')) continue
      const full = join(candidate, name)
      try {
        const stat = statSync(full)
        if (stat.isFile()) found.push({ path: full, mtime: stat.mtimeMs })
      } catch {
        // 单个文件读不到不影响其它候选。
      }
    }
  }
  return found.sort((left, right) => right.mtime - left.mtime)
}

/**
 * 解析 auth 文件里的登录态。
 *
 * 结构：`{ account: { uid, nickname }, auth: { accessToken, domain, expiresAt } }`。
 * 桌面端新版本可能把 token 写成 at-rest 信封（`{$wbEncrypted:1, envelope}`），
 * 那种情况本插件不尝试解密，直接返回明确原因。
 *
 * @param {string} path 文件路径。
 * @returns {{ ok: true, uid: string, nickname: string, accessToken: string, refreshToken: string, domain: string, expiresAt: number }
 *   | { ok: false, reason: string }} 登录态。
 */
export function readAuthFile(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { ok: false, reason: `读取登录态失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: '登录态文件不是 JSON 对象' }
  const account = parsed.account !== null && typeof parsed.account === 'object' ? parsed.account : {}
  const auth = parsed.auth !== null && typeof parsed.auth === 'object' ? parsed.auth : {}
  const token = auth.accessToken
  if (token !== null && typeof token === 'object') {
    return { ok: false, reason: '登录态被桌面端加密（at-rest），请在终端运行 codebuddy 并重新登录一次' }
  }
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: '登录态里没有 accessToken，请在终端运行 codebuddy 并执行 /login' }
  }
  return {
    ok: true,
    uid: typeof account.uid === 'string' ? account.uid : '',
    nickname: typeof account.nickname === 'string' ? account.nickname : '',
    accessToken: token,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    domain: typeof auth.domain === 'string' && auth.domain.length > 0 ? auth.domain : 'www.codebuddy.cn',
    expiresAt: typeof auth.expiresAt === 'number' ? auth.expiresAt : 0,
  }
}

/**
 * 按账号域推导 billing 网关。
 * @param {string} domain 账号域。
 * @returns {string} 网关 origin。
 */
export function backendFor(domain) {
  const host = String(domain ?? '').trim().toLowerCase()
  if (host === 'workbuddy.ai' || host.endsWith('.workbuddy.ai')) return INTL_BACKEND
  return CN_BACKEND
}

/**
 * 组装 billing 请求头（与官方 CLI 一致的指纹；缺信息时用 X-No-* 标记）。
 * @param {{ accessToken: string, uid: string, domain: string }} auth 登录态。
 * @returns {Record<string, string>} 请求头。
 */
export function billingHeaders(auth) {
  const origin = backendFor(auth.domain)
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Product': 'SaaS',
    'User-Agent': `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`,
    Origin: origin,
    Referer: `${origin}/`,
    Authorization: `Bearer ${auth.accessToken}`,
  }
  if (auth.uid !== '') headers['X-User-Id'] = auth.uid
  else headers['X-No-User-Id'] = '1'
  headers['X-No-Enterprise-Id'] = '1'
  headers['X-No-Department-Info'] = '1'
  return headers
}

/**
 * 向 billing 接口发一次 POST。
 * @param {{ accessToken: string, uid: string, domain: string }} auth 登录态。
 * @param {string} path 接口路径。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<{ status: number, payload: any }>} 响应。
 */
async function postBilling(auth, path, timeoutMs = 20000) {
  const response = await fetch(`${backendFor(auth.domain)}${path}`, {
    method: 'POST',
    headers: billingHeaders(auth),
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let payload
  try {
    payload = text.trim() === '' ? undefined : JSON.parse(text)
  } catch {
    payload = undefined
  }
  return { status: response.status, payload }
}

/**
 * 拆出 `{ code, msg, data }` 信封；`data` 不是对象时退回顶层。
 * @param {{ status: number, payload: any }} response 原始响应。
 * @returns {{ ok: boolean, message: string, data: object }} 展开结果。
 */
export function unwrapResponse(response) {
  const payload = response.payload
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, message: `billing 返回了非 JSON 内容（HTTP ${response.status}）`, data: {} }
  }
  const code = payload.code
  const okCode = code === undefined || code === null || code === 0 || code === '0'
  const httpOk = response.status >= 200 && response.status < 300
  const message = String(payload.msg ?? payload.message ?? '') || (okCode ? 'OK' : `code=${String(code)}`)
  const data = payload.data !== null && typeof payload.data === 'object' ? payload.data : payload
  return { ok: httpOk && okCode, message, data }
}

/**
 * 转数字，非法值回落 0。
 * @param {unknown} value 原值。
 * @returns {number} 数字。
 */
function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * 保留两位小数的数字。
 * @param {number} value 数值。
 * @returns {number} 结果。
 */
function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * 把 `x0.11 credits` / `x0.69` 这类倍率文案解析成数字。
 *
 * 账号接口的文案比发行版更松：有的带 `credits`，有的不带；
 * 空文案（如 `auto` / `default` 这类档位）返回 undefined。
 *
 * @param {unknown} text 原始文案。
 * @returns {number | undefined} 倍率；无法识别时为 undefined。
 */
export function parseRateText(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /([0-9]+(?:\.[0-9]+)?)/.exec(trimmed)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/**
 * 从账号侧模型列表响应里抽出 `{ 模型 id: { creditRate, credits } }`。
 * @param {any} payload 上游响应。
 * @returns {Record<string, { creditRate: number | undefined, credits: string }>} 倍率表。
 */
export function parseModelRates(payload) {
  const rows = (() => {
    if (Array.isArray(payload)) return payload
    const data = payload?.data ?? payload
    if (Array.isArray(data)) return data
    if (Array.isArray(data?.models)) return data.models
    if (Array.isArray(payload?.models)) return payload.models
    return []
  })()
  const rates = {}
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id === '') continue
    const raw = row.credits ?? row._meta?.credits
    const credits = typeof raw === 'string' ? raw : ''
    rates[id] = { creditRate: parseRateText(credits), credits }
  }
  return rates
}

/**
 * 把 `2026-10-29 13:02:41` / 毫秒时间戳统一成秒级时间戳。
 * @param {unknown} value 原值。
 * @returns {number} 秒级时间戳；无法识别为 0。
 */
export function toEpochSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value > 1e12 ? value / 1000 : value)
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '' || text.startsWith('9999')) return 0
    if (/^\d+$/.test(text)) {
      const numeric = Number(text)
      return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric)
    }
    const parsed = Date.parse(text.replace(' ', 'T'))
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
  }
  return 0
}

/**
 * 把一个额度包压成页面要用的形状。
 * @param {object} item 上游 `Accounts[]` 元素。
 * @param {number} now 当前秒级时间戳。
 * @returns {object} 额度包摘要。
 */
export function readPackage(item, now) {
  const cycleEnd = item.CycleEndTime ?? item.DeductionEndTime ?? item.ExpiredTime ?? ''
  const expireAt = toEpochSeconds(cycleEnd)
  const remain = number(item.CycleCapacityRemainPrecise) || number(item.CycleCapacityRemain)
    || number(item.CapacityRemainPrecise) || number(item.CapacityRemain)
  const size = number(item.CycleCapacitySizePrecise) || number(item.CycleCapacitySize)
    || number(item.CapacitySizePrecise) || number(item.CapacitySize)
  const used = number(item.CycleCapacityUsedPrecise) || number(item.CycleCapacityUsed)
    || number(item.CapacityUsedPrecise) || number(item.CapacityUsed)
  const attributes = Array.isArray(item.AccountAttributes) ? item.AccountAttributes : []
  const grantSource = String(attributes.find((attr) => attr?.Key === 'grantSource')?.Value ?? '')
  return {
    name: String(item.PackageName ?? item.DealName ?? '额度包'),
    product: String(item.ProductName ?? ''),
    subProduct: String(item.SubProductName ?? ''),
    unit: String(item.CapacityUnit ?? item.OriginUnit ?? 'credits'),
    remaining: round2(remain),
    used: round2(used),
    size: round2(size),
    expireAt,
    expiresInDays: expireAt > 0 ? Math.round((expireAt - now) / 86400) : null,
    expired: expireAt > 0 && expireAt < now,
    grantSource,
  }
}

/**
 * CodeBuddy 额度服务：带缓存的只读查询 + 手动签到。
 */
export class CodeBuddyBilling {
  /**
   * @param {object} [options] 参数。
   * @param {string} [options.authFile] 显式指定登录态文件。
   * @param {{ info?: Function, warn?: Function }} [options.logger] 日志器。
   */
  constructor({ authFile, logger } = {}) {
    this.authFile = authFile
    this.logger = logger
    /** @type {{ at: number, data: object } | undefined} */
    this.resourceCache = undefined
    /** @type {{ at: number, data: object } | undefined} */
    this.checkinCache = undefined
    /** @type {{ at: number, data: object } | undefined} */
    this.rateCache = undefined
    this.label = ''
  }

  /**
   * 读取当前登录态（安全摘要，不含 token）。
   * @returns {{ available: boolean, reason?: string, uid?: string, label?: string, domain?: string, backend?: string, authFile?: string, expiresAt?: number, expired?: boolean }} 概要。
   */
  accountSummary() {
    const files = findAuthFiles(this.authFile)
    if (files.length === 0) {
      return {
        available: false,
        reason: '没找到 CodeBuddy 登录态；先在终端运行 codebuddy 并用 /login 登录一次',
      }
    }
    let lastReason = ''
    for (const file of files) {
      const parsed = readAuthFile(file.path)
      if (!parsed.ok) {
        lastReason = parsed.reason
        continue
      }
      this.label = parsed.nickname !== '' ? parsed.nickname : parsed.uid
      return {
        available: true,
        uid: parsed.uid,
        label: this.label,
        domain: parsed.domain,
        backend: backendFor(parsed.domain),
        authFile: file.path,
        expiresAt: parsed.expiresAt,
        expired: parsed.expiresAt > 0 && parsed.expiresAt < Date.now(),
      }
    }
    return { available: false, reason: lastReason || '登录态不可用' }
  }

  /**
   * 取一份可用登录态（内部使用，含 token）。
   * @returns {{ ok: true, auth: object } | { ok: false, reason: string }} 结果。
   */
  #loadAuth() {
    for (const file of findAuthFiles(this.authFile)) {
      const parsed = readAuthFile(file.path)
      if (parsed.ok) return { ok: true, auth: parsed }
    }
    return { ok: false, reason: this.accountSummary().reason ?? '登录态不可用' }
  }

  /**
   * 拉取账号侧的真实模型倍率表（带 5 分钟缓存）。
   *
   * 这是**倍率的权威来源**。发行版包内的 `product.json` 是写死的静态表，
   * 与账号实际计费口径不一致：实测 `deepseek-v4.1-flash` 静态表写 `x0.00`，
   * 而账号侧接口给的是 `x0.11`。ACP `session/new` 回的又是另一套（`x0.03`），
   * 只有在真正建过会话、且拿到了宿主上报的 `availableModels` 之后才可信。
   * 所以这里以服务端账号接口为准，拿不到时才回落。
   *
   * @param {{ force?: boolean }} [options] 是否忽略缓存。
   * @returns {Promise<{ ok: boolean, rates: Record<string, { creditRate: number | undefined, credits: string }>, message: string, at: number }>} 倍率表。
   */
  async fetchModelRates({ force = false } = {}) {
    if (!force && this.rateCache !== undefined && Date.now() - this.rateCache.at < RATE_TTL_MS) {
      return this.rateCache.data
    }
    const loaded = this.#loadAuth()
    if (!loaded.ok) {
      return { ok: false, rates: {}, message: loaded.reason, at: Date.now() }
    }

    const auth = loaded.auth
    const headers = { ...billingHeaders(auth) }
    // 列表接口是 GET，不需要 Content-Type。
    delete headers['Content-Type']

    let response
    try {
      response = await fetch(`${backendFor(auth.domain)}/v2/enterprises/personal/models`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(20000),
      })
    } catch (error) {
      const message = `请求模型倍率失败：${error instanceof Error ? error.message : String(error)}`
      this.logger?.warn?.(`dsh-codebuddy-acp: ${message}`)
      return { ok: false, rates: {}, message, at: Date.now() }
    }

    const text = await response.text()
    let payload
    try {
      payload = text.trim() === '' ? undefined : JSON.parse(text)
    } catch {
      return { ok: false, rates: {}, message: `模型倍率响应不是 JSON（HTTP ${response.status}）`, at: Date.now() }
    }
    if (response.status < 200 || response.status >= 300) {
      const parsed = unwrapResponse({ status: response.status, payload })
      return { ok: false, rates: {}, message: parsed.message, at: Date.now() }
    }
    const code = payload?.code
    if (code !== undefined && code !== null && code !== 0 && code !== '0') {
      return { ok: false, rates: {}, message: String(payload?.msg ?? `code=${String(code)}`), at: Date.now() }
    }

    const rates = parseModelRates(payload)
    const data = { ok: Object.keys(rates).length > 0, rates, message: '', at: Date.now() }
    if (data.ok) this.rateCache = { at: Date.now(), data }
    return data
  }

  /**
   * 查询剩余积分（带 60 秒缓存）。
   * @param {{ force?: boolean }} [options] 是否忽略缓存。
   * @returns {Promise<object>} 额度视图。
   */
  async fetchBalance({ force = false } = {}) {
    if (!force && this.resourceCache !== undefined && Date.now() - this.resourceCache.at < RESOURCE_TTL_MS) {
      return this.resourceCache.data
    }
    const loaded = this.#loadAuth()
    if (!loaded.ok) return this.#balanceFailure(loaded.reason)

    let response
    try {
      response = await postBilling(loaded.auth, '/v2/billing/meter/get-user-resource')
    } catch (error) {
      return this.#balanceFailure(`请求额度接口失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const parsed = unwrapResponse(response)
    if (!parsed.ok) return this.#balanceFailure(parsed.message, response.status)

    const outer = parsed.data.Response !== null && typeof parsed.data.Response === 'object' ? parsed.data.Response : {}
    const inner = outer.Data !== null && typeof outer.Data === 'object' ? outer.Data : {}
    const rows = Array.isArray(inner.Accounts) ? inner.Accounts : []
    const now = Math.floor(Date.now() / 1000)
    const packages = rows
      .filter((row) => row !== null && typeof row === 'object')
      .map((row) => readPackage(row, now))
    const active = packages.filter((item) => !item.expired && item.remaining > 0)
    const soonest = active
      .filter((item) => item.expireAt > 0)
      .sort((left, right) => left.expireAt - right.expireAt)[0]

    const view = {
      ok: true,
      authorized: true,
      message: '',
      total: round2(active.reduce((sum, item) => sum + item.remaining, 0)),
      totalUsed: round2(packages.reduce((sum, item) => sum + item.used, 0)),
      packageCount: packages.length,
      activePackageCount: active.length,
      nextExpireAt: soonest?.expireAt ?? 0,
      nextExpireDays: soonest?.expiresInDays ?? null,
      nextExpireAmount: soonest?.remaining ?? 0,
      packages: packages.sort((left, right) => {
        if (left.expired !== right.expired) return left.expired ? 1 : -1
        const leftAt = left.expireAt || Number.MAX_SAFE_INTEGER
        const rightAt = right.expireAt || Number.MAX_SAFE_INTEGER
        if (leftAt !== rightAt) return leftAt - rightAt
        return right.remaining - left.remaining
      }),
      at: Date.now(),
    }
    this.resourceCache = { at: Date.now(), data: view }
    return view
  }

  /**
   * 查询每日签到状态（带 5 分钟缓存）。
   * @param {{ force?: boolean }} [options] 是否忽略缓存。
   * @returns {Promise<object>} 签到视图。
   */
  async fetchCheckin({ force = false } = {}) {
    if (!force && this.checkinCache !== undefined && Date.now() - this.checkinCache.at < CHECKIN_TTL_MS) {
      return this.checkinCache.data
    }
    const loaded = this.#loadAuth()
    if (!loaded.ok) return this.#checkinFailure(loaded.reason)

    let response
    try {
      response = await postBilling(loaded.auth, '/v2/billing/meter/checkin-activity-status')
    } catch (error) {
      return this.#checkinFailure(`请求签到状态失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const parsed = unwrapResponse(response)
    if (!parsed.ok) return this.#checkinFailure(parsed.message, response.status)

    const data = parsed.data
    const view = {
      ok: true,
      authorized: true,
      active: data.active === true,
      checkedIn: data.today_checked_in === true,
      streakDays: number(data.streak_days),
      dailyCredit: number(data.daily_credit) || number(data.today_credit),
      todayCredit: number(data.today_credit),
      totalCredits: number(data.total_credits),
      weekCheckedDays: number(data.week_checkin_days),
      activityName: typeof data.activity_name === 'string' ? data.activity_name : '',
      endTime: typeof data.end_time === 'string' ? data.end_time : '',
      message: '',
      at: Date.now(),
    }
    this.checkinCache = { at: Date.now(), data: view }
    return view
  }

  /**
   * 领取今日积分（用户显式触发）。
   * @returns {Promise<object>} 领取结果。
   */
  async claimDaily() {
    const status = await this.fetchCheckin({ force: true })
    if (status.ok !== true) return { ...status, claimed: false }
    if (status.active === false) return { ...status, ok: false, claimed: false, message: '签到活动当前不可用' }
    if (status.checkedIn === true) return { ...status, ok: true, claimed: false, message: '今日已领取' }

    const loaded = this.#loadAuth()
    if (!loaded.ok) return { ...this.#checkinFailure(loaded.reason), claimed: false }

    let response
    try {
      response = await postBilling(loaded.auth, '/v2/billing/meter/daily-checkin', 30000)
    } catch (error) {
      return { ...this.#checkinFailure(`领取请求失败：${error instanceof Error ? error.message : String(error)}`), claimed: false }
    }
    const parsed = unwrapResponse(response)
    if (!parsed.ok) return { ...this.#checkinFailure(parsed.message, response.status), claimed: false }

    const credit = number(parsed.data.credit) || number(parsed.data.today_credit)
    // 领取会改变余额与签到状态，缓存立刻作废。
    this.resourceCache = undefined
    this.checkinCache = undefined
    return {
      ok: true,
      authorized: true,
      claimed: credit > 0,
      alreadyClaimed: credit === 0 && parsed.data.today_checked_in === true,
      credit,
      active: true,
      checkedIn: parsed.data.today_checked_in === true || credit > 0,
      streakDays: number(parsed.data.streak_days),
      todayCredit: credit,
      message: credit > 0 ? `领取成功，+${credit} 积分` : (parsed.message || '领取完成'),
      at: Date.now(),
    }
  }

  /**
   * 额度查询失败视图。
   * @param {string} message 原因。
   * @param {number} [status] HTTP 状态码。
   * @returns {object} 视图。
   */
  #balanceFailure(message, status = 0) {
    this.logger?.warn?.(`dsh-codebuddy-acp: 额度查询失败：${message}`)
    return { ok: false, authorized: true, message, status, total: null, packages: [], at: Date.now() }
  }

  /**
   * 签到查询失败视图。
   * @param {string} message 原因。
   * @param {number} [status] HTTP 状态码。
   * @returns {object} 视图。
   */
  #checkinFailure(message, status = 0) {
    this.logger?.warn?.(`dsh-codebuddy-acp: 签到状态查询失败：${message}`)
    return {
      ok: false,
      authorized: true,
      active: false,
      checkedIn: false,
      streakDays: 0,
      dailyCredit: 0,
      todayCredit: 0,
      message,
      status,
      at: Date.now(),
    }
  }
}
