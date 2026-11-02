/**
 * 控制台页面的 Host 侧 HTTP 接口。
 *
 * 页面本身是 Web 端插件（`client.js`），浏览器与 Host 相对独立，
 * 所以这里用一条同源前缀路由把「模型目录 + 用量 + 账号积分」暴露给页面：
 *
 *   GET  /api/codebuddy-console/state            一次拿齐页面需要的全部数据
 *   POST /api/codebuddy-console/settings         保存模型开关 / 顺序 / 默认模型
 *   POST /api/codebuddy-console/refresh          重新探测模型目录
 *   POST /api/codebuddy-console/reset            清空积分账本
 *   POST /api/codebuddy-console/billing/refresh  立即刷新剩余积分与签到状态
 *   POST /api/codebuddy-console/billing/checkin  领取每日积分
 *
 * 路由挂在同源下，页面直接 `fetch` 即可；POST 要求自定义请求头，
 * 避免其它站点通过表单跨站写入设置或触发签到。
 *
 * @module src/console.js
 */

import { normalizeSettings } from './store.js'

/** 路由前缀。 */
export const CONSOLE_ROUTE = '/api/codebuddy-console'

/** 本包名（Boot 图里的客户端条目 id）。 */
const PKG_NAME = 'dsh-codebuddy-acp'

/** POST 时要求的自定义请求头。 */
const CHANNEL_HEADER = 'x-dsh-codebuddy-console'

/** 请求体上限：设置只有几十个字符串。 */
const MAX_BODY_BYTES = 128 * 1024

/**
 * 写出 JSON 响应。
 * @param {import('node:http').ServerResponse} response 响应。
 * @param {number} status 状态码。
 * @param {object} payload 内容。
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * 读取并解析 JSON 请求体。
 * @param {import('node:http').IncomingMessage} request 请求。
 * @returns {Promise<object>} 解析结果。
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed
}

/**
 * 浏览器半身的加载状态（用于页面自检：是否已被 Boot 图收录）。
 * @param {object} ctx Host 上下文。
 * @returns {{ registered: boolean, packageId: string }} 状态。
 */
function clientStatus(ctx) {
  const clientModules = ctx.get('clientModules')
  if (clientModules?.graph === undefined) return { registered: false, packageId: PKG_NAME }
  try {
    const graph = clientModules.graph()
    const entries = Array.isArray(graph?.entries) ? graph.entries : []
    return { registered: entries.some((entry) => entry?.id === PKG_NAME), packageId: PKG_NAME }
  } catch {
    return { registered: false, packageId: PKG_NAME }
  }
}

/**
 * 校验并归一化页面提交的模型策略。
 * @param {object} input 页面提交值。
 * @returns {{ enabled: string[] | null, order: string[], defaultModel?: string } | undefined} 归一化策略。
 */
function readModelPolicy(input) {
  if (input === undefined) return undefined
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('models 必须是对象')
  const enabled = input.enabled === null || input.enabled === undefined
    ? null
    : Array.isArray(input.enabled)
      ? input.enabled.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
      : undefined
  if (enabled === undefined) throw new Error('models.enabled 必须是字符串数组或 null')
  const order = Array.isArray(input.order)
    ? input.order.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : []
  const defaultModel = input.defaultModel === null || input.defaultModel === undefined || input.defaultModel === ''
    ? undefined
    : typeof input.defaultModel === 'string' ? input.defaultModel.trim() : undefined
  return { enabled, order, ...defaultModel === undefined ? {} : { defaultModel } }
}

/**
 * 把一次 billing 调用包成「永不抛」的形式，页面因此总能拿到快照。
 * @param {() => Promise<object>} operation 调用。
 * @param {object} fallback 失败时的兜底值。
 * @returns {Promise<object>} 结果。
 */
async function safely(operation, fallback) {
  try {
    return await operation()
  } catch (error) {
    return { ...fallback, ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 注册控制台接口。
 *
 * @param {object} options 参数。
 * @param {import('@deepseek-ai/cordis').Context} options.ctx Host 上下文（需已有 `webServer`）。
 * @param {import('./adapter.js').CodeBuddyAdapter} options.adapter 适配器。
 * @param {import('./store.js').CodeBuddyStore} options.store 数据仓。
 * @param {import('./billing.js').CodeBuddyBilling} options.billing 账号额度服务。
 * @param {{ info?: Function, warn?: Function }} options.logger 日志器。
 * @param {object} options.config 生效配置。
 * @returns {() => void} 反注册。
 */
export function registerConsole({ ctx, adapter, store, billing, logger, config }) {
  /**
   * 组装页面状态。
   * @param {{ force?: boolean }} [options] 是否强制刷新额度与签到。
   * @returns {Promise<object>} 状态。
   */
  const snapshot = async (options = {}) => {
    const force = options.force === true
    const settings = store.getSettings()
    let models = []
    try {
      models = await adapter.catalogSnapshot()
    } catch (error) {
      logger.warn?.(`dsh-codebuddy-acp: 读取模型目录失败：${error instanceof Error ? error.message : String(error)}`)
    }
    let selectableModelIds = []
    let selectableError
    try {
      // 与模型选择器同一条路径：确认启用开关真的作用到了 llm.listModels。
      selectableModelIds = (await adapter.listModels(config.provider)).map((model) => model.id)
    } catch (error) {
      selectableError = error instanceof Error ? error.message : String(error)
      logger.warn?.(`dsh-codebuddy-acp: 读取可选模型失败：${selectableError}`)
    }

    const [credits, checkin] = await Promise.all([
      safely(() => billing.fetchBalance({ force }), { total: null, packages: [] }),
      safely(() => billing.fetchCheckin({ force }), { active: false, checkedIn: false, streakDays: 0, dailyCredit: 0 }),
    ])

    return {
      account: adapter.accountInfo(),
      billing: {
        ...billing.accountSummary(),
        credits,
        checkin,
      },
      models,
      selectableModelIds,
      ...selectableError === undefined ? {} : { selectableError },
      client: clientStatus(ctx),
      settings,
      usage: store.summary(),
      config: {
        provider: config.provider,
        displayName: config.displayName,
        command: config.command,
        modelDiscovery: config.modelDiscovery,
        dataDir: store.directory,
      },
    }
  }

  const handler = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(CONSOLE_ROUTE, '').replace(/\/+$/, '') || '/'
    const method = request.method ?? 'GET'
    try {
      if (method === 'GET' && path === '/state') {
        sendJson(response, 200, { ok: true, data: await snapshot() })
        return
      }
      if (method === 'GET' && path === '/rates') {
        // 轻量只读接口：只要「模型 id → 积分倍率」这一张表，便于脚本核对与排查。
        let entries = []
        try {
          entries = await adapter.catalogSnapshot()
        } catch (error) {
          logger.warn?.(`dsh-codebuddy-acp: 读取倍率表失败：${error instanceof Error ? error.message : String(error)}`)
        }
        const rates = {}
        for (const entry of entries) {
          if (entry?.id !== undefined) rates[entry.id] = entry.creditRate ?? null
        }
        sendJson(response, 200, { ok: true, data: { rates, provider: config.provider, displayName: config.displayName } })
        return
      }
      if (method === 'POST') {
        if (request.headers[CHANNEL_HEADER] !== '1') {
          sendJson(response, 403, { ok: false, error: '缺少请求头，请从 CodeBuddy 控制台页面操作' })
          return
        }
        if (path === '/settings') {
          const body = await readJsonBody(request)
          const models = readModelPolicy(body.models)
          if (models === undefined) {
            sendJson(response, 400, { ok: false, error: '没有可保存的设置' })
            return
          }
          const saved = await store.updateSettings({ models })
          adapter.setModelPolicy(saved.models)
          sendJson(response, 200, { ok: true, data: await snapshot() })
          return
        }
        if (path === '/refresh') {
          await adapter.refreshCatalog()
          sendJson(response, 200, { ok: true, data: await snapshot() })
          return
        }
        if (path === '/reset') {
          await store.resetUsage()
          sendJson(response, 200, { ok: true, data: await snapshot() })
          return
        }
        if (path === '/billing/refresh') {
          sendJson(response, 200, { ok: true, data: await snapshot({ force: true }) })
          return
        }
        if (path === '/billing/checkin') {
          const result = await billing.claimDaily()
          sendJson(response, 200, { ok: true, data: { result, snapshot: await snapshot({ force: true }) } })
          return
        }
      }
      sendJson(response, 404, { ok: false, error: `未知接口：${method} ${path}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const syntax = error instanceof SyntaxError
      sendJson(response, syntax ? 400 : 500, { ok: false, error: message })
    }
  }

  const dispose = ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CONSOLE_ROUTE,
    handler,
  }), 'dsh-codebuddy-acp: console api')
  logger.info?.(`dsh-codebuddy-acp: 控制台接口已挂载 ${CONSOLE_ROUTE}`)
  return dispose
}

/**
 * 让设置文件保持可被手工修复的形态（导出给测试/文档引用）。
 * @param {unknown} raw 原始设置。
 * @returns {object} 归一化设置。
 */
export function previewSettings(raw) {
  return normalizeSettings(raw)
}
