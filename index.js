/**
 * dsh-codebuddy-acp — Host 半身。
 *
 * 在 `ctx.llm` 上为 provider 路由（默认 `codebuddy`）注册一个 LLM 适配器，
 * 于是模型选择器里出现「CodeBuddy」分组；选中其中任一模型就等于
 * 「这一轮交给本机 CodeBuddy CLI 通过 ACP 跑」，并且直接使用 CodeBuddy 自己的登录态与额度。
 *
 * 侧栏控制台额外读取 CLI 自己的登录态来展示剩余积分与每日签到，
 * 但**不复制、不上报任何凭据**。
 *
 * 本包刻意不 import 任何 `@deepseek-ai/*` 运行时包：本地 bundle 以链接方式安装时，
 * 那些包不一定能被解析；适配器契约是按方法调用校验的，结构满足即可。
 *
 * @module dsh-codebuddy-acp
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { dirname } from 'node:path'

import { CodeBuddyAdapter } from './src/adapter.js'
import { CodeBuddyBilling } from './src/billing.js'
import { resolveConfig } from './src/config.js'
import { registerConsole } from './src/console.js'
import { buildEnv, resolveLaunch } from './src/launch.js'
import { CodeBuddyStore } from './src/store.js'
import { ToolCallBridge } from './src/tool-bridge.js'
import { registerReplayTool } from './src/tools.js'

/** Loader 行名与诊断前缀。 */
export const name = 'codebuddy-acp'

/** 需要的 Host 服务：只有 LLM 适配器注册表是硬依赖，其余按存在与否降级。 */
export const inject = ['llm']

/**
 * 按级别过滤的日志器。
 * @param {object} ctx Host 上下文。
 * @param {string} level 配置的日志级别。
 * @returns {{ info: Function, warn: Function }} 日志器。
 */
function createLogger(ctx, level) {
  const logger = ctx.logger
  const silent = level === 'silent'
  return {
    info: (message) => {
      if (silent || level !== 'info') return
      logger?.info?.(String(message))
    },
    warn: (message) => {
      if (silent) return
      const text = String(message)
      if (logger?.warn !== undefined) logger.warn(text)
      else logger?.info?.(text)
    },
  }
}

/**
 * 建立宿主能力桥：CodeBuddy 需要知道工作目录，并在开启文件代理时读写文件。
 *
 * 这里对每一项能力都做「优先走 DSH 服务、失败回落到本机 fs」的处理：
 * 走 DSH 服务意味着沙箱与观测策略仍然生效；回落保证 CodeBuddy 不会因为
 * 某个服务在当前组合里缺失而整体不可用。
 *
 * @param {object} ctx Host 上下文。
 * @param {{ info: Function, warn: Function }} logger 日志器。
 * @returns {object} 供适配器使用的能力桥。
 */
function createHostBridge(ctx, logger) {
  const defaultDirectory = () => {
    const fromService = ctx.get('workingDirectory')?.defaultDirectory
    if (typeof fromService === 'string' && fromService.length > 0) return fromService
    return process.cwd()
  }

  const resolveCwd = async (sessionId) => {
    const controller = ctx.get('sessionController')
    if (controller?.inspect !== undefined) {
      try {
        const info = await controller.inspect(sessionId)
        const cwd = info?.meta?.cwd
        if (typeof cwd === 'string' && cwd.length > 0) return cwd
      } catch {
        // 会话可能还没落盘，回落到默认目录。
      }
    }
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory?.get !== undefined && workingDirectory?.defaultDirectory !== undefined) {
      try {
        const agent = ctx.get('agents')?.get?.(sessionId)
        if (agent !== undefined) {
          const cwd = workingDirectory.get(agent)
          if (typeof cwd === 'string' && cwd.length > 0) return cwd
        }
      } catch {
        // 忽略，继续回落。
      }
    }
    return defaultDirectory()
  }

  const readTextFile = async (path, cwd) => {
    const fs = ctx.get('fs')
    if (fs?.resolve !== undefined && fs?.readText !== undefined) {
      try {
        const target = await fs.resolve(path, { cwd })
        return await fs.readText(target)
      } catch (error) {
        logger.warn(`dsh-codebuddy-acp: 通过 DSH 文件服务读取失败，回落到本机 fs：${describe(error)}`)
      }
    }
    return readFile(path, 'utf8')
  }

  const writeTextFile = async (path, content, cwd) => {
    const fs = ctx.get('fs')
    if (fs?.resolve !== undefined && fs?.writeText !== undefined) {
      try {
        const target = await fs.resolve(path, { cwd })
        await fs.writeText(target, content)
        return undefined
      } catch (error) {
        logger.warn(`dsh-codebuddy-acp: 通过 DSH 文件服务写入失败，回落到本机 fs：${describe(error)}`)
      }
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    return undefined
  }

  /**
   * 把一张 DSH 图片附件读成 ACP 可以直接发的 base64。
   *
   * 为什么要走 `ctx.attachments` 而不是自己找文件：会话里的图片是**内容寻址的引用**
   * （`{ attachmentId, mediaType, width, height }`），真实字节只有附件服务知道在哪。
   * 优先用 `readImageRequest`——它按我们声明的 `{width,height,maxBytes}` 目标做降质/降尺寸，
   * 于是 `maxImageBytes` 这个上限才有意义；没有这个能力（或失败）时退回 `readImage` 原图。
   *
   * @param {object} ref 图片引用（ImageAttachmentRef）。
   * @param {{ width: number, height: number, maxBytes: number }} target 投递目标。
   * @param {AbortSignal} [signal] 这一轮的取消信号。
   * @returns {Promise<{ data: string, mediaType: string, bytes: number }>} 规范 base64 与类型。
   */
  const readImage = async (ref, target, signal) => {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new Error('当前组合没有挂载图片服务（ctx.attachments）')
    if (typeof attachments.readImageRequest === 'function') {
      try {
        const version = await attachments.readImageRequest(ref, target, signal)
        return {
          data: Buffer.from(version.data).toString('base64'),
          mediaType: typeof version.mediaType === 'string' ? version.mediaType : ref.mediaType,
          bytes: typeof version.bytes === 'number' ? version.bytes : version.data?.byteLength ?? 0,
        }
      } catch (error) {
        if (typeof attachments.readImage !== 'function') throw error
        logger.warn(`dsh-codebuddy-acp: 请求版图片生成失败，回落到原图：${describe(error)}`)
      }
    }
    if (typeof attachments.readImage !== 'function') throw new Error('图片服务不支持读取图片')
    const stored = await attachments.readImage(ref, signal)
    const bytes = stored?.data?.byteLength ?? 0
    return {
      data: Buffer.from(stored.data).toString('base64'),
      mediaType: typeof stored.ref?.mediaType === 'string' ? stored.ref.mediaType : ref.mediaType,
      bytes,
    }
  }

  return { defaultDirectory, resolveCwd, readTextFile, writeTextFile, readImage }
}

/**
 * 把未知抛出物转成一句话。
 * @param {unknown} error 抛出物。
 * @returns {string} 描述。
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 读一个 DSH 会话当前的审批策略（折叠日志里最后一条 `approval/policy`）。
 *
 * 为什么要先读：DSH 的 `approval` 服务在策略为 `never` 时**不弹窗直接拒绝**。
 * 如果 CodeBuddy 的每次权限请求都被这样拒掉，工具会集体失败——所以策略是 `never`
 * 时我们直接走兜底，不去打扰审批服务。
 *
 * @param {object | undefined} agent DSH agent。
 * @returns {'ask' | 'never' | undefined} 策略。
 */
function approvalPolicyOf(agent) {
  let events
  try {
    events = agent?.session?.snapshotEvents?.()
  } catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'approval/policy') continue
    const policy = event.data?.policy
    return policy === 'ask' || policy === 'never' ? policy : undefined
  }
  return undefined
}

/**
 * 建立「CodeBuddy → DSH」的三条同步通路：会话标题、计划（待办）、权限审批。
 *
 * 三者都通过宿主服务完成，服务缺失时安静降级（标题退回本地生成、计划不写、
 * 审批沿用 `permissionPolicy`），不会影响正常对话。
 *
 * @param {object} options 参数。
 * @param {object} options.ctx Host 上下文。
 * @param {object} options.config 生效配置。
 * @param {{ info: Function, warn: Function }} options.logger 日志器。
 * @returns {{ applyTitle: Function, syncPlan: Function, askPermission: Function }} 三个钩子。
 */
export function createHostSync({ ctx, config, logger }) {
  /**
   * 取某个 DSH 会话对应的 live agent。
   * @param {string} sessionId DSH 会话 id。
   * @returns {object | undefined} agent。
   */
  const agentOf = (sessionId) => {
    try {
      return ctx.get('agents')?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * 采用 CodeBuddy 给的会话标题。
   *
   * `sessionTitle.rename()` 会写一条 `source:{kind:'user'}` 的 `session/title`，
   * 从而**钉住**标题（后续用户消息不再触发自动生成），这正是我们要的效果。
   *
   * @param {{ sessionId: string, title: string }} event 事件。
   */
  const applyTitle = ({ sessionId, title }) => {
    if (config.syncTitle !== true) return
    const service = ctx.get('sessionTitle')
    const sessions = ctx.get('sessions')
    if (typeof service?.rename !== 'function' || typeof sessions?.get !== 'function') return
    const session = sessions.get(sessionId)
    if (session === undefined) return
    try {
      const current = service.get?.(session)
      if (current?.title === title) return
      service.rename(session, title)
      logger.info?.(`dsh-codebuddy-acp: 会话标题已采用 CodeBuddy 的「${title}」`)
    } catch (error) {
      logger.warn(`dsh-codebuddy-acp: 采用 CodeBuddy 会话标题失败：${describe(error)}`)
    }
  }

  /**
   * 把 CodeBuddy 的计划写成 DSH 的待办快照（与 `todo_write` 同一套事件与投影）。
   *
   * @param {{ sessionId: string, entries: { content: string, status: string }[] }} event 事件。
   */
  const syncPlan = ({ sessionId, entries }) => {
    if (config.syncPlan !== true) return
    const session = agentOf(sessionId)?.session
    if (typeof session?.append !== 'function') return
    if (!Array.isArray(entries) || entries.length === 0) return
    try {
      session.append('todo/write', { todos: entries })
    } catch (error) {
      logger.warn(`dsh-codebuddy-acp: 写入 DSH 待办失败：${describe(error)}`)
    }
  }

  /**
   * 询问 DSH 审批（`permissionPolicy: 'ask'` 时生效）。
   *
   * @param {object} request 询问内容。
   * @param {string} request.sessionId DSH 会话 id。
   * @param {string} request.toolName 工具/调用标题。
   * @param {string} [request.reason] 为什么要问。
   * @param {AbortSignal} [request.signal] 这一轮的取消信号。
   * @returns {Promise<'allow' | 'deny' | undefined>} 决定；`undefined` 表示交回静态策略。
   */
  const askPermission = async ({ sessionId, toolName, reason, signal }) => {
    if (config.permissionPolicy !== 'ask') return undefined
    const fallback = config.permissionAskFallback === 'deny' ? 'deny' : 'allow'
    const service = ctx.get('approval')
    const agent = agentOf(sessionId)
    if (typeof service?.request !== 'function' || agent === undefined) {
      logger.info?.('dsh-codebuddy-acp: 当前组合没有 approval 服务，权限请求按兜底处理')
      return fallback
    }
    const policy = approvalPolicyOf(agent)
    if (policy === 'never') {
      // 该会话的审批策略是 never：审批服务会直接拒绝，问也白问。
      logger.info?.('dsh-codebuddy-acp: 当前会话审批策略为 never，权限请求按兜底处理')
      return fallback
    }
    try {
      const outcome = await service.request({ agent, toolName, reason, signal })
      if (outcome === 'allowed-once') return 'allow'
      if (outcome === 'rejected') return 'deny'
      // cancelled：用户关掉了审批框 / 这一轮被取消 → 按兜底（默认 allow，避免工具莫名挂掉）。
      // unavailable：这个组合里没有可用的审批方（例如 headless、或 UI 没装上）
      //   → DSH 自己的语义是 fail-closed，但这里**不是** DSH 在决定执行，
      //   而是要把 ACP 的权限结果回给 CodeBuddy；拿不到用户意见时按兜底走，
      //   否则一次界面缺失就会让整轮工具全部失败。
      logger.info?.(`dsh-codebuddy-acp: 审批结果 ${outcome}，按兜底（${fallback}）处理`)
      return fallback
    } catch (error) {
      logger.warn(`dsh-codebuddy-acp: DSH 审批询问失败，按兜底处理：${describe(error)}`)
      return fallback
    }
  }

  return { applyTitle, syncPlan, askPermission }
}

/**
 * 激活插件。
 * @param {object} ctx Host 上下文。
 * @param {Record<string, unknown> | undefined} rawConfig Loader 行配置。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = createLogger(ctx, config.logLevel)
  const launch = resolveLaunch(config)
  launch.env = buildEnv(config.env)
  if (config.logLevel === 'info') logger.info(`dsh-codebuddy-acp: 启动方式 ${launch.note}`)

  const host = createHostBridge(ctx, logger)
  const store = new CodeBuddyStore({ logger })
  store.loadSync()
  const billing = new CodeBuddyBilling({ authFile: config.billingAuthFile, logger })
  // 工具结果桥：适配器往里写 ACP 的工具记录，回放工具从中取结果。
  // 只有在 `ctx.tools` 可用、回放工具注册成功后才置 `ready`，
  // 否则适配器不会发 tool-call 块（发了也没人执行）。
  const toolBridge = new ToolCallBridge({ logger })
  const sync = createHostSync({ ctx, config, logger })
  const adapter = new CodeBuddyAdapter({
    config,
    launch,
    host,
    logger,
    policy: store.getSettings().models,
    onUsage: (record) => store.record(record),
    // 倍率以账号侧服务端为准：发行版 product.json 的倍率与实际计费口径不一致。
    fetchModelRates: (options) => billing.fetchModelRates(options),
    toolBridge,
    // 三条「CodeBuddy → DSH」的通路：标题、计划（待办）、权限审批。
    onSessionTitle: sync.applyTitle,
    onPlan: sync.syncPlan,
    askPermission: sync.askPermission,
  })

  ctx.effect(() => {
    const registration = ctx.llm.registerAdapter([config.provider], adapter)
    logger.info?.(`dsh-codebuddy-acp: 已注册 provider 路由 "${config.provider}"（${config.displayName}）`)
    return async () => {
      try {
        registration()
      } catch (error) {
        logger.warn(`dsh-codebuddy-acp: 反注册适配器失败：${describe(error)}`)
      }
      await adapter.dispose()
      await store.flush().catch((error) => {
        logger.warn(`dsh-codebuddy-acp: 落盘用量账本失败：${describe(error)}`)
      })
    }
  })

  // 回放工具：把 CodeBuddy 已经执行过的工具调用变成 DSH 会话里的原生工具卡片。
  // `tools` 也是可选能力：没有它时只是退回「工具活动纯文本播报」的旧行为。
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.get?.('tools') ?? toolCtx.tools
    if (tools?.register === undefined) {
      logger.warn('dsh-codebuddy-acp: 当前组合没有 tools 服务，工具回放不可用（退化为文字播报）')
      return
    }
    toolCtx.effect(() => {
      const dispose = registerReplayTool({ ctx: toolCtx, bridge: toolBridge, config, logger })
      return () => {
        try {
          dispose()
        } catch (error) {
          logger.warn(`dsh-codebuddy-acp: 反注册回放工具失败：${describe(error)}`)
        }
      }
    })
  })

  // 控制台页面：侧栏入口 + 积分与模型管理接口。webServer 是可选能力，
  // 没有 Web 载体的组合（纯 CLI）只是少了界面，不影响模型路由。
  ctx.inject(['webServer'], (webCtx) => {
    registerConsole({ ctx: webCtx, adapter, store, billing, logger, config })
  })
}

