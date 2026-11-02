/**
 * 插件私有数据仓：模型策略 + 积分用量账本。
 *
 * 两份 JSON 都放在 `$DSH_HOME/codebuddy-acp/` 下（桌面端通常是
 * `C:\Users\<用户>\.dsh\codebuddy-acp\`），与 profile 的 Loader 配置解耦：
 *
 * - `settings.json`：用户在控制台页里调整的模型开关，随时可改；
 * - `usage.json`：从 CodeBuddy 每轮 `usage_update` 里累计出来的积分账本。
 *
 * 这里**刻意不保存任何凭据**：查余额与签到直接用 CLI 自己的登录态
 * （见 `src/billing.js`），token 不会复制进插件目录。
 *
 * 写盘一律「先写临时文件再 rename」，避免桌面端被强杀时留下半截 JSON；
 * 用量记录走 50ms 防抖，连续多轮不会反复刷盘。
 *
 * @module src/store.js
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 默认设置：只保留模型策略（积分预算已下线）。 */
export const DEFAULT_SETTINGS = Object.freeze({
  models: { enabled: null, order: [], defaultModel: undefined },
  updatedAt: 0,
})

/** 最近调用记录最多保留多少条。 */
const RECENT_LIMIT = 60

/** 账本里最多保留多少天。 */
const DAY_LIMIT = 400

/**
 * 把本地时间格式化成 `YYYY-MM-DD`。
 * @param {Date} date 时间。
 * @returns {string} 日期键。
 */
export function dayKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 把本地时间格式化成 `YYYY-MM`。
 * @param {Date} date 时间。
 * @returns {string} 月份键。
 */
export function monthKey(date) {
  return dayKey(date).slice(0, 7)
}

/**
 * 把未知对象收敛成有限非负数。
 * @param {unknown} value 原值。
 * @returns {number} 数字。
 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * 深拷贝普通 JSON（设置只有两层，够用）。
 * @template T
 * @param {T} value 原值。
 * @returns {T} 拷贝。
 */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * 解析设置文件，坏字段逐项回落默认值。
 * @param {unknown} raw 文件内容。
 * @returns {typeof DEFAULT_SETTINGS} 归一化设置。
 */
export function normalizeSettings(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const models = input.models !== null && typeof input.models === 'object' ? input.models : {}
  const enabled = Array.isArray(models.enabled)
    ? models.enabled.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : null
  const order = Array.isArray(models.order)
    ? models.order.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : []
  const defaultModel = typeof models.defaultModel === 'string' && models.defaultModel.trim() !== ''
    ? models.defaultModel.trim()
    : undefined
  return {
    models: {
      enabled: enabled !== null && enabled.length > 0 ? [...new Set(enabled)] : enabled === null ? null : [],
      order: [...new Set(order)],
      ...defaultModel !== undefined ? { defaultModel } : {},
    },
    updatedAt: typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
  }
}

/**
 * 解析账本文件，缺失的桶自动补齐。
 * @param {unknown} raw 文件内容。
 * @returns {{ version: number, days: Record<string, object>, total: object, sessions: Record<string, object>, recent: object[] }} 账本。
 */
export function normalizeUsage(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const days = {}
  if (input.days !== null && typeof input.days === 'object') {
    for (const [key, value] of Object.entries(input.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || value === null || typeof value !== 'object') continue
      days[key] = {
        credits: finiteNumber(value.credits),
        inputTokens: finiteNumber(value.inputTokens),
        outputTokens: finiteNumber(value.outputTokens),
        tokens: finiteNumber(value.tokens),
        calls: finiteNumber(value.calls),
        byModel: value.byModel !== null && typeof value.byModel === 'object' ? cloneJson(value.byModel) : {},
      }
    }
  }
  const sessions = {}
  if (input.sessions !== null && typeof input.sessions === 'object') {
    for (const [key, value] of Object.entries(input.sessions)) {
      if (value === null || typeof value !== 'object') continue
      sessions[key] = {
        credits: finiteNumber(value.credits),
        tokens: finiteNumber(value.tokens),
        calls: finiteNumber(value.calls),
        model: typeof value.model === 'string' ? value.model : undefined,
        at: finiteNumber(value.at),
      }
    }
  }
  const recent = Array.isArray(input.recent) ? input.recent.slice(-RECENT_LIMIT) : []
  const total = input.total !== null && typeof input.total === 'object' ? input.total : {}
  return {
    version: 1,
    days,
    total: {
      credits: finiteNumber(total.credits),
      tokens: finiteNumber(total.tokens),
      calls: finiteNumber(total.calls),
      byModel: total.byModel !== null && typeof total.byModel === 'object' ? cloneJson(total.byModel) : {},
    },
    sessions,
    recent: recent.filter((item) => item !== null && typeof item === 'object'),
  }
}

/**
 * 插件数据仓。
 */
export class CodeBuddyStore {
  /**
   * @param {object} [options] 参数。
   * @param {string} [options.directory] 数据目录；默认为 `$DSH_HOME/codebuddy-acp`。
   * @param {{ info?: Function, warn?: Function }} [options.logger] 日志器。
   */
  constructor({ directory, logger } = {}) {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh')
    this.directory = directory ?? join(home, 'codebuddy-acp')
    this.settingsPath = join(this.directory, 'settings.json')
    this.usagePath = join(this.directory, 'usage.json')
    this.logger = logger
    /** @type {typeof DEFAULT_SETTINGS} */
    this.settings = cloneJson(DEFAULT_SETTINGS)
    this.usage = normalizeUsage(undefined)
    this.pendingWrite = undefined
    this.loaded = false
    /** 设置变更的订阅者（控制台改模型策略时通知页面刷新）。 */
    this.listeners = new Set()
  }

  /** 从磁盘加载两份文件。 */
  async load() {
    await mkdir(this.directory, { recursive: true })
    this.settings = normalizeSettings(await this.#readJson(this.settingsPath))
    this.usage = normalizeUsage(await this.#readJson(this.usagePath))
    this.loaded = true
    this.logger?.info?.(`dsh-codebuddy-acp: 数据目录 ${this.directory}`)
  }

  /**
   * 同步加载：插件激活时用，保证控制台接口一上线就带着真实设置。
   */
  loadSync() {
    try {
      mkdirSync(this.directory, { recursive: true })
    } catch (error) {
      this.logger?.warn?.(`dsh-codebuddy-acp: 无法创建数据目录 ${this.directory}：${error instanceof Error ? error.message : String(error)}`)
    }
    const read = (path) => {
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        return undefined
      }
    }
    this.settings = normalizeSettings(read(this.settingsPath))
    this.usage = normalizeUsage(read(this.usagePath))
    this.loaded = true
  }

  /**
   * 读取 JSON；文件不存在或损坏时返回 undefined。
   * @param {string} path 文件路径。
   * @returns {Promise<unknown>} 解析结果。
   */
  async #readJson(path) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return undefined
    }
    try {
      return JSON.parse(text)
    } catch (error) {
      this.logger?.warn?.(`dsh-codebuddy-acp: ${path} 不是合法 JSON，已忽略：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * 原子写 JSON。
   * @param {string} path 目标文件。
   * @param {unknown} value 内容。
   */
  async #writeJson(path, value) {
    await mkdir(this.directory, { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }

  /** @returns {typeof DEFAULT_SETTINGS} 当前设置的副本。 */
  getSettings() {
    return cloneJson(this.settings)
  }

  /**
   * 合并并持久化设置。
   * @param {object} patch 局部设置。
   * @returns {Promise<typeof DEFAULT_SETTINGS>} 保存后的设置。
   */
  async updateSettings(patch) {
    const merged = {
      models: { ...this.settings.models, ...(patch?.models ?? {}) },
      updatedAt: Date.now(),
    }
    this.settings = normalizeSettings(merged)
    await this.#writeJson(this.settingsPath, this.settings)
    for (const listener of this.listeners) {
      try {
        listener(this.getSettings())
      } catch {
        // 订阅者自己出错不影响保存。
      }
    }
    return this.getSettings()
  }

  /**
   * 订阅设置变更。
   * @param {(settings: typeof DEFAULT_SETTINGS) => void} listener 回调。
   * @returns {() => void} 取消订阅。
   */
  onSettingsChanged(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 记录一轮真实消耗。
   * @param {object} record 记录。
   * @param {string} [record.model] 模型 id。
   * @param {string} [record.sessionId] DSH 会话 id。
   * @param {number} [record.credits] 本轮积分。
   * @param {number} [record.inputTokens] 输入 token。
   * @param {number} [record.outputTokens] 输出 token。
   * @param {number} [record.totalTokens] 总 token。
   * @param {number} [record.at] 时间戳。
   * @returns {Promise<void>} 完成。
   */
  async record(record) {
    const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now()
    const credits = finiteNumber(record.credits)
    const inputTokens = finiteNumber(record.inputTokens)
    const outputTokens = finiteNumber(record.outputTokens)
    const tokens = finiteNumber(record.totalTokens) || inputTokens + outputTokens
    if (credits === 0 && tokens === 0) return

    const date = new Date(at)
    const day = dayKey(date)
    const model = typeof record.model === 'string' && record.model.length > 0 ? record.model : 'unknown'

    const dayBucket = this.usage.days[day] ?? { credits: 0, inputTokens: 0, outputTokens: 0, tokens: 0, calls: 0, byModel: {} }
    dayBucket.credits += credits
    dayBucket.inputTokens += inputTokens
    dayBucket.outputTokens += outputTokens
    dayBucket.tokens += tokens
    dayBucket.calls += 1
    const dayModel = dayBucket.byModel[model] ?? { credits: 0, tokens: 0, calls: 0 }
    dayModel.credits += credits
    dayModel.tokens += tokens
    dayModel.calls += 1
    dayBucket.byModel[model] = dayModel
    this.usage.days[day] = dayBucket

    this.usage.total.credits += credits
    this.usage.total.tokens += tokens
    this.usage.total.calls += 1
    const totalModel = this.usage.total.byModel[model] ?? { credits: 0, tokens: 0, calls: 0 }
    totalModel.credits += credits
    totalModel.tokens += tokens
    totalModel.calls += 1
    this.usage.total.byModel[model] = totalModel

    if (typeof record.sessionId === 'string' && record.sessionId.length > 0) {
      const session = this.usage.sessions[record.sessionId] ?? { credits: 0, tokens: 0, calls: 0, at: 0 }
      session.credits += credits
      session.tokens += tokens
      session.calls += 1
      session.model = model
      session.at = at
      this.usage.sessions[record.sessionId] = session
    }

    this.usage.recent.push({
      at,
      model,
      credits,
      tokens,
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    })
    if (this.usage.recent.length > RECENT_LIMIT) this.usage.recent.splice(0, this.usage.recent.length - RECENT_LIMIT)

    this.#trimDays()
    this.#scheduleWrite()
  }

  /** 只保留最近 DAY_LIMIT 天。 */
  #trimDays() {
    const keys = Object.keys(this.usage.days).sort()
    const overflow = keys.length - DAY_LIMIT
    if (overflow <= 0) return
    for (const key of keys.slice(0, overflow)) delete this.usage.days[key]
  }

  /** 合并 50ms 内的多次写入。 */
  #scheduleWrite() {
    if (this.pendingWrite !== undefined) return
    this.pendingWrite = setTimeout(() => {
      this.pendingWrite = undefined
      this.#writeJson(this.usagePath, this.usage).catch((error) => {
        this.logger?.warn?.(`dsh-codebuddy-acp: 写入用量账本失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, 50)
  }

  /** 立即落盘（插件卸载时调用）。 */
  async flush() {
    if (this.pendingWrite !== undefined) {
      clearTimeout(this.pendingWrite)
      this.pendingWrite = undefined
    }
    await this.#writeJson(this.usagePath, this.usage)
  }

  /**
   * 清空账本（只清用量，不动设置）。
   * @returns {Promise<void>} 完成。
   */
  async resetUsage() {
    this.usage = normalizeUsage(undefined)
    await this.flush()
  }

  /**
   * 汇总视图：页面一次拿齐所有数字。
   * @param {Date} [now] 当前时间。
   * @returns {object} 汇总。
   */
  summary(now = new Date()) {
    const today = dayKey(now)
    const month = monthKey(now)
    const days = this.usage.days
    const sumDays = (predicate) => {
      let credits = 0
      let tokens = 0
      let calls = 0
      for (const [key, bucket] of Object.entries(days)) {
        if (!predicate(key)) continue
        credits += bucket.credits
        tokens += bucket.tokens
        calls += bucket.calls
      }
      return { credits, tokens, calls }
    }

    const todayStats = days[today] ?? { credits: 0, tokens: 0, calls: 0, byModel: {} }
    const monthStats = sumDays((key) => key.startsWith(month))
    const totalStats = {
      credits: this.usage.total.credits,
      tokens: this.usage.total.tokens,
      calls: this.usage.total.calls,
    }

    const series = []
    for (let offset = 13; offset >= 0; offset -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)
      const key = dayKey(date)
      series.push({
        date: key,
        credits: days[key]?.credits ?? 0,
        tokens: days[key]?.tokens ?? 0,
        calls: days[key]?.calls ?? 0,
      })
    }

    const byModel = {}
    const mergeModel = (table) => {
      for (const [id, value] of Object.entries(table ?? {})) {
        byModel[id] = byModel[id] ?? { credits: 0, tokens: 0, calls: 0, todayCredits: 0, todayCalls: 0 }
        byModel[id].credits += finiteNumber(value.credits)
        byModel[id].tokens += finiteNumber(value.tokens)
        byModel[id].calls += finiteNumber(value.calls)
      }
    }
    mergeModel(this.usage.total.byModel)
    for (const [id, value] of Object.entries(todayStats.byModel ?? {})) {
      byModel[id] = byModel[id] ?? { credits: 0, tokens: 0, calls: 0, todayCredits: 0, todayCalls: 0 }
      byModel[id].todayCredits += finiteNumber(value.credits)
      byModel[id].todayCalls += finiteNumber(value.calls)
    }

    return {
      today: { credits: todayStats.credits, tokens: todayStats.tokens, calls: todayStats.calls },
      month: monthStats,
      total: totalStats,
      sessions: Object.entries(this.usage.sessions)
        .sort((left, right) => right[1].at - left[1].at)
        .slice(0, 10)
        .map(([id, value]) => ({ id, ...value })),
      byModel,
      series,
      recent: this.usage.recent.slice(-12).reverse(),
      updatedAt: now.getTime(),
    }
  }
}
