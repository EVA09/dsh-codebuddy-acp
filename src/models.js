/**
 * CodeBuddy 模型目录。
 *
 * 模型清单有三个来源，按用途分工：
 *
 * 1. **`codebuddy --help`** —— 决定「哪些模型对当前版本/当前产品形态可见」。
 *    不同产品形态（公有版 / 内部版 / iOA / 云托管）会给出不同清单，
 *    所以可见集合以它为准。
 * 2. **包内 `product*.json`** —— 提供每个模型的元数据：展示名、中英文描述、
 *    输入/输出 token 上限、是否支持图片、credits 档位。这些都是选择器里该显示的东西。
 * 3. **`~/.codebuddy/models.json` 与项目级 `models.json`** —— 用户自定义模型与
 *    `availableModels` 白名单，优先级最高。
 *
 * 都拿不到时回落到内置快照，保证选择器不会空着。
 *
 * @module src/models.js
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 内置快照（CodeBuddy CLI 2.177.x 的常见模型 id），只在探测全部失败时使用。 */
export const STATIC_MODELS = Object.freeze([
  'default-model',
  'fast-model',
  'balanced-model',
  'primary-model',
  'deep-model',
  'claude-sonnet-5',
  'claude-sonnet-4.6',
  'claude-opus-5',
  'claude-opus-4.8',
  'gemini-3.1-pro',
  'gemini-3.5-flash',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.3-codex',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'minimax-m3-pay',
  'minimax-m2.7',
  'kimi-k3-2',
  'kimi-k2.8-preview',
  'kimi-k2.7',
  'kimi-k2.6',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
])

/**
 * CodeBuddy 的角色档位别名：它们指向用户在 CodeBuddy 自己那里选定的模型档位，
 * 语义最稳，因此排在选择器最前面。
 */
export const MODEL_ALIASES = Object.freeze({
  'default-model': '自动（默认）',
  'fast-model': '快速',
  'balanced-model': '均衡',
  'primary-model': '主力',
  'deep-model': '深度思考',
})

/** 词元到展示写法的映射，用于把没有元数据的 id 变成人读的名字。 */
const TOKEN_LABELS = Object.freeze({
  claude: 'Claude',
  sonnet: 'Sonnet',
  opus: 'Opus',
  haiku: 'Haiku',
  gpt: 'GPT',
  gemini: 'Gemini',
  glm: 'GLM',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  hy: 'HY',
  deepseek: 'DeepSeek',
  flash: 'Flash',
  flashx: 'FlashX',
  pro: 'Pro',
  preview: 'Preview',
  codex: 'Codex',
  ioa: 'iOA',
  internal: 'Internal',
  turbo: 'Turbo',
  sol: 'Sol',
  terra: 'Terra',
  luna: 'Luna',
  astra: 'Astra',
  echo: 'Echo',
  pay: 'Pay',
  '1m': '1M',
})

/**
 * 思考档位（CodeBuddy 的 `thought_level` 配置项）的展示名。
 *
 * `enabled` 是 CodeBuddy 自己的「跟随模型默认档」语义，不参与 DSH 的档位选择；
 * 其余取值来自实测：`session/set_config_option {configId:"thought_level"}` 接受
 * `minimal / low / medium / high / xhigh / max / enabled`，非法值返回 -32603。
 */
export const THOUGHT_LEVEL_LABELS = Object.freeze({
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  enabled: '默认',
})

/**
 * 首屏兜底用的「模型 → 思考档位」快照（2026-10-28，CodeBuddy CLI v2.177.1 实测）。
 *
 * 为什么要有它：档位集合是**按模型**变化的（`hy4-preview` 只有 `high`，
 * `deepseek-v4.1-flash` 是 `low/high/max`，`hy3` 是 `low/medium/high/xhigh`），
 * 而权威来源是 `session/new` 的 `models.availableModels[]._meta.effortOptions`，
 * 那需要先建一次会话才拿得到。模型选择器打开时还没有会话，所以用这份实测快照兜底；
 * 一旦进程内拿到 live 目录，就以 live 为准覆盖它。
 */
export const KNOWN_EFFORTS = Object.freeze({
  'hy4-preview': ['high'],
  'hy3': ['low', 'medium', 'high', 'xhigh'],
  'hy3-x': ['low', 'medium', 'high', 'xhigh'],
  'deepseek-v4.1-flash': ['low', 'high', 'max'],
  'step-5-preview': ['low', 'medium', 'high'],
  'glm-5.3': ['low', 'high', 'max'],
  'glm-5.3-flash': ['low', 'high', 'max'],
  'glm-5.3-flashx': ['low', 'high', 'max'],
  'glm-5.2': ['low', 'medium', 'high', 'xhigh'],
  'glm-5.1': ['low', 'medium', 'high', 'xhigh'],
  'glm-5v-turbo': ['low', 'medium', 'high', 'xhigh'],
  'space-bunny': ['low', 'medium', 'high', 'xhigh', 'max'],
  'minimax-m3.1-flash': ['low', 'medium', 'high', 'xhigh', 'max'],
  'minimax-m3': ['low', 'medium', 'high', 'xhigh'],
  'minimax-m3-pay': ['low', 'medium', 'high', 'xhigh'],
  'minimax-m2.7': ['low', 'medium', 'high', 'xhigh'],
  'kimi-k3.1-pro': ['low', 'high', 'max'],
  'kimi-k3-1': ['low', 'medium', 'high', 'xhigh'],
  'kimi-k3-2': ['low', 'medium', 'high', 'xhigh'],
  'kimi-k2.8-preview': ['low', 'high', 'max'],
  'kimi-k2.7': ['low', 'medium', 'high', 'xhigh'],
  'kimi-k2.6': ['low', 'medium', 'high', 'xhigh'],
  'deepseek-v4-pro': ['low', 'medium', 'high', 'xhigh'],
  'mimo-v2.6-pro': ['low', 'medium', 'high', 'xhigh'],
})

/** 完全未知的模型用哪几档（刻意保守：这三档几乎每个 CodeBuddy 模型都接受）。 */
export const DEFAULT_EFFORTS = Object.freeze(['low', 'medium', 'high'])

/**
 * 把档位 id 列表规范化成 DSH 需要的 `{ id, name, description }` 形态。
 *
 * @param {string[]} ids 档位 id（按展示顺序）。
 * @returns {Array<{ id: string, name: string, description?: string }>} 档位描述。
 */
export function describeEfforts(ids) {
  const seen = new Set()
  const list = []
  for (const raw of ids) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const id = raw.trim()
    if (id === 'enabled' || seen.has(id)) continue
    seen.add(id)
    const name = THOUGHT_LEVEL_LABELS[id] ?? id
    list.push({ id, name, description: `CodeBuddy thought_level=${id}` })
  }
  return list
}

/**
 * 把一个模型 id 映射到它的思考档位集合。
 *
 * @param {string} id 模型 id。
 * @param {string[] | undefined} live 会话侧实测到的档位（优先）。
 * @returns {string[]} 档位 id 列表。
 */
export function effortsForModel(id, live) {
  if (Array.isArray(live)) {
    const normalized = live.filter((item) => typeof item === 'string' && item !== 'enabled')
    if (normalized.length > 0) return normalized
  }
  // 角色档位别名（auto/fast/balanced…）指向的是 CodeBuddy 里当前选定的真实模型，
  // 档位因此由那个模型决定；用保守的公共档位，避免声称一个具体集合。
  if (MODEL_ALIASES[id] !== undefined) return [...DEFAULT_EFFORTS]
  return KNOWN_EFFORTS[id] ?? [...DEFAULT_EFFORTS]
}


/**
 * 把 `x0.34 credits` 这类倍率文案解析成数字。
 *
 * CodeBuddy 在 `product.json` 与 ACP 的 `_meta.credits` 里用的是同一种写法：
 * 小数倍率 + `credits` 单位（`x0.00 credits` 表示免费档）。
 *
 * @param {unknown} text 原始文案。
 * @returns {number | undefined} 倍率；无文案或无法识别时为 undefined。
 */
export function parseCreditRate(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /([0-9]+(?:\.[0-9]+)?)/.exec(trimmed)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/**
 * 把倍率格式化成展示文案（`×0.34`；零倍率显示「免费」）。
 * @param {number | undefined} rate 倍率。
 * @returns {string | undefined} 展示文案。
 */
export function formatCreditRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return undefined
  if (rate === 0) return '免费'
  const text = rate.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  return `×${text}`
}

/**
 * 把模型 id 变成展示名。
 * @param {string} id 模型 id。
 * @returns {string} 展示名。
 */
export function friendlyModelName(id) {
  return id
    .split('-')
    .map((token) => TOKEN_LABELS[token] ?? (token.length > 0 ? token[0].toUpperCase() + token.slice(1) : token))
    .join(' ')
}

/** `--help` 探测结果缓存：同一进程内避免反复起子进程。 */
const helpCache = new Map()

/**
 * 解析 `--help` 输出里的模型清单。
 * @param {string} text `--help` 的 stdout。
 * @returns {string[]} 模型 id 列表（解析失败为空）。
 */
export function parseSupportedModels(text) {
  const marker = text.indexOf('Currently supported:')
  if (marker < 0) return []
  const start = text.indexOf('(', marker)
  const end = text.indexOf(')', start)
  if (start < 0 || end < 0) return []
  return text
    .slice(start + 1, end)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9._/-]+$/.test(item))
}

/**
 * 起一次子进程读取 `--help` 并解析模型清单。
 *
 * @param {string[]} launch argv 前缀。
 * @param {Record<string, string>} env 额外环境变量。
 * @param {string} cwd 工作目录。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<string[]>} 模型 id 列表。
 */
function discoverFromHelp(launch, env, cwd, timeoutMs = 12000) {
  const key = `${launch.join('\u0000')}\u0000${cwd}`
  const cached = helpCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < 10 * 60 * 1000) return Promise.resolve(cached.models)
  return new Promise((resolve) => {
    execFile(
      launch[0],
      [...launch.slice(1), '--help'],
      { cwd, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve([])
          return
        }
        const models = parseSupportedModels(String(stdout))
        if (models.length > 0) helpCache.set(key, { at: Date.now(), models })
        resolve(models)
      },
    )
  })
}

/**
 * 定位 CodeBuddy 包目录（`product*.json` 所在目录）。
 *
 * @param {string[]} launch argv 前缀：`[node, <entry>]` 或 `[<exe>]`。
 * @returns {string | undefined} 包目录绝对路径。
 */
function resolvePackageDir(launch) {
  const entry = launch.find((item) => /[\\/]@tencent-ai[\\/]codebuddy-code[\\/]/i.test(item))
  if (entry === undefined) return undefined
  const marker = '@tencent-ai'
  const index = entry.replace(/\\/g, '/').indexOf(`${marker}/codebuddy-code/`)
  if (index < 0) return undefined
  const root = entry.replace(/\\/g, '/').slice(0, index).replace(/\//g, '\\')
  const dir = join(root, marker, 'codebuddy-code')
  return existsSync(dir) ? dir : undefined
}

/** 产品形态文件的优先级：越靠前越优先（同名 id 以先出现的为准）。 */
const PRODUCT_FILES = Object.freeze([
  'product.json',
  'product.cloudhosted.json',
  'product.internal.json',
  'product.ioa.json',
  'product.selfhosted.json',
])

/**
 * 读取包内所有 `product*.json` 的模型元数据。
 *
 * @param {string | undefined} packageDir 包目录。
 * @returns {{ order: string[], models: Map<string, object> }} 顺序与元数据。
 */
function readProductModels(packageDir) {
  const order = []
  const models = new Map()
  if (packageDir === undefined) return { order, models }

  for (const file of PRODUCT_FILES) {
    const path = join(packageDir, file)
    if (!existsSync(path)) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    const list = Array.isArray(parsed?.models) ? parsed.models : []
    for (const model of list) {
      if (model === null || typeof model !== 'object' || typeof model.id !== 'string') continue
      if (!models.has(model.id)) order.push(model.id)
      const existing = models.get(model.id) ?? {}
      models.set(model.id, {
        ...existing,
        name: existing.name ?? (typeof model.name === 'string' ? model.name : undefined),
        descriptionZh: existing.descriptionZh ?? model.descriptionZh,
        descriptionEn: existing.descriptionEn ?? model.descriptionEn,
        maxInputTokens: existing.maxInputTokens ?? model.maxInputTokens,
        maxOutputTokens: existing.maxOutputTokens ?? model.maxOutputTokens,
        supportsImages: existing.supportsImages ?? model.supportsImages,
        supportsReasoning: existing.supportsReasoning ?? model.supportsReasoning,
        credits: existing.credits ?? (typeof model.credits === 'string' ? model.credits : undefined),
        isDefault: existing.isDefault ?? model.isDefault,
        // `product.json` 只给「默认档」这一个值（如 `{effort:"high"}`），不是全集，
        // 因此它只能作为「该模型支持推理」的旁证，档位全集仍以 session/new 的
        // `_meta.effortOptions` 和 KNOWN_EFFORTS 为准。
        defaultEffort: existing.defaultEffort
          ?? (typeof model.reasoning?.effort === 'string' ? model.reasoning.effort : undefined),
      })
    }
  }
  return { order, models }
}

/**
 * 读取一个 models.json。
 * @param {string} path 文件路径。
 * @returns {{ models: object[], availableModels?: string[] } | undefined} 解析结果。
 */
function readModelsFile(path) {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const models = Array.isArray(parsed.models)
      ? parsed.models.filter((item) => item !== null && typeof item === 'object')
      : []
    const availableModels = Array.isArray(parsed.availableModels)
      ? parsed.availableModels.filter((item) => typeof item === 'string')
      : undefined
    return { models, availableModels }
  } catch {
    return undefined
  }
}

/**
 * 合并用户级与项目级 models.json。
 * @param {string} cwd 项目目录。
 * @returns {{ models: Map<string, object>, availableModels?: string[] }} 合并结果。
 */
function readModelsJson(cwd) {
  const merged = new Map()
  let availableModels
  const files = [join(homedir(), '.codebuddy', 'models.json'), join(cwd, '.codebuddy', 'models.json')]
  for (const file of files) {
    const parsed = readModelsFile(file)
    if (parsed === undefined) continue
    for (const model of parsed.models) {
      if (typeof model.id === 'string' && model.id.length > 0) merged.set(model.id, model)
    }
    // 项目级完全覆盖用户级。
    if (parsed.availableModels !== undefined) availableModels = parsed.availableModels
  }
  return { models: merged, availableModels }
}

/**
 * 选描述文案：优先中文，其次英文。
 * @param {object} entry 元数据。
 * @returns {string | undefined} 描述。
 */
function pickDescription(entry) {
  const zh = typeof entry.descriptionZh === 'string' ? entry.descriptionZh.trim() : ''
  if (zh !== '') return zh
  const en = typeof entry.descriptionEn === 'string' ? entry.descriptionEn.trim() : ''
  return en === '' ? undefined : en
}

/**
 * 构建模型目录。
 *
 * @param {object} params 参数。
 * @param {import('./config.js').DEFAULT_CONFIG} params.config 生效配置。
 * @param {string[]} params.launch argv 前缀。
 * @param {string} params.cwd 工作目录。
 * @param {{ info?: Function, warn?: Function }} [params.logger] 日志器。
 * @returns {Promise<Array<{ id: string, name: string, description?: string, contextWindow: number, maxTokens: number, supportsImages: boolean }>>}
 *   目录条目（已按配置过滤与排序）。
 */
export async function buildCatalog({ config, launch, cwd, logger }) {
  const packageDir = resolvePackageDir(launch)
  const product = readProductModels(packageDir)

  /** 可见集合：优先 CLI 自报的清单（反映当前产品形态），其次包内目录，最后内置快照。 */
  let visible = []
  if (config.modelDiscovery === 'help' || config.modelDiscovery === 'both' || config.modelDiscovery === 'static') {
    if (config.modelDiscovery !== 'static') {
      visible = await discoverFromHelp(launch, config.env, cwd)
      if (visible.length === 0) {
        logger?.warn?.('dsh-codebuddy-acp: 未能从 codebuddy --help 解析模型清单，改用包内 product.json')
      }
    }
  }
  if (visible.length === 0 && product.order.length > 0) visible = [...product.order]
  if (visible.length === 0) visible = [...STATIC_MODELS]

  /**
   * 角色档位别名（Auto/Fast/Balanced…）不会被 `--help` 的 `--model` 清单列出来。
   * 实测发现：通过 `session/set_config_option` 切到这些别名时服务端**接受**该值，
   * 但随后的模型请求会静默返回空结果；因此默认不展示，只有显式打开 `showAliases`
   * 且接受「可能拿不到回答」时才列出来。
   */
  const productAliases = config.showAliases === true
    ? Object.keys(MODEL_ALIASES).filter((id) => product.models.has(id))
    : []
  if (productAliases.length > 0) {
    visible = [...productAliases, ...visible.filter((id) => !productAliases.includes(id))]
  }

  /** 自定义模型与白名单。 */
  let availableModels
  const customModels = new Map()
  if (config.useModelsJson) {
    const fromFile = readModelsJson(cwd)
    availableModels = fromFile.availableModels
    for (const [id, model] of fromFile.models) customModels.set(id, model)
    if (fromFile.models.size > 0) {
      for (const id of customModels.keys()) {
        if (!visible.includes(id)) visible.push(id)
      }
    }
  }

  /** 决定最终 id 顺序：配置 > 白名单 > 产品顺序（别名在前）> 其余。 */
  let ids
  if (config.models !== undefined) {
    ids = [...config.models]
  } else if (availableModels !== undefined && availableModels.length > 0) {
    ids = [...availableModels]
  } else {
    const visibleSet = new Set(visible)
    const productOrdered = product.order.filter((id) => visibleSet.has(id))
    const leftover = visible.filter((id) => !productOrdered.includes(id))
    ids = [...productOrdered, ...leftover]
    // 角色档位别名永远排最前。
    const aliases = Object.keys(MODEL_ALIASES).filter((id) => ids.includes(id))
    ids = [...aliases, ...ids.filter((id) => !aliases.includes(id))]
  }

  const models = []
  const seen = new Set()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const meta = product.models.get(id) ?? {}
    const custom = customModels.get(id)
    const contextWindow = pickNumber([
      custom?.maxInputTokens,
      meta.maxInputTokens,
      config.contextWindow,
    ])
    const maxTokens = pickNumber([custom?.maxOutputTokens, meta.maxOutputTokens, config.maxTokens])
    const credits = typeof meta.credits === 'string' && meta.credits.trim() !== '' ? meta.credits.trim() : undefined
    models.push({
      id,
      name: (typeof custom?.name === 'string' && custom.name.length > 0 ? custom.name : undefined)
        ?? MODEL_ALIASES[id]
        ?? (typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : undefined)
        ?? friendlyModelName(id),
      description: [
        custom === undefined ? (MODEL_ALIASES[id] !== undefined ? '跟随你在 CodeBuddy 里选定的档位' : pickDescription(meta)) : '自定义模型',
      ].filter(Boolean).join(' · ') || undefined,
      credits,
      creditRate: parseCreditRate(credits),
      contextWindow,
      maxTokens,
      supportsImages: custom?.supportsImages === true || meta.supportsImages === true,
      supportsReasoning: custom?.supportsReasoning === true || meta.supportsReasoning === true,
      effortOptions: effortsForModel(id, undefined),
    })
  }
  return models
}

/**
 * 取第一个有效正数。
 * @param {unknown[]} candidates 候选值。
 * @returns {number} 选中的值。
 */
function pickNumber(candidates) {
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return 200000
}
