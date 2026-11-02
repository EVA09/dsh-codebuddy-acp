/**
 * ACP（Agent Client Protocol）客户端连接。
 *
 * ACP 是 Zed 提出的通用智能体协议，CodeBuddy CLI 用 `codebuddy --acp` 启动后，
 * 在 stdin/stdout 上以 **ndjson**（每行一个 JSON-RPC 2.0 消息）通信：
 *
 * - 客户端 → agent：`initialize`、`authenticate`、`session/new`、`session/prompt`、`session/cancel`
 * - agent → 客户端通知：`session/update`（流式文本、思考、工具调用、计划、可用命令…）
 * - agent → 客户端请求：`session/request_permission`、`fs/read_text_file`、`fs/write_text_file`、`terminal/*`
 *
 * 本文件只负责传输与分发，不含 DSH 相关的业务语义。
 *
 * @module src/acp.js
 */

import { spawn } from 'node:child_process'

/** ACP 请求出错时携带的错误类型。 */
export class AcpError extends Error {
  /**
   * @param {string} message 人类可读的消息。
   * @param {{ code?: number | string, data?: unknown, method?: string }} [details] 协议层细节。
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'AcpError'
    this.code = details.code
    this.data = details.data
    this.method = details.method
  }
}

/** 进程输出保留上限（用于诊断）。 */
const STDERR_LIMIT = 16384
const LINE_LIMIT = 32 * 1024 * 1024

/**
 * 一个 ACP 连接：一个 CodeBuddy 子进程 + 一条 ndjson 双向流。
 */
export class AcpConnection {
  /**
   * @param {object} options 连接参数。
   * @param {string[]} options.argv 可执行与参数（含 `--acp`）。
   * @param {NodeJS.ProcessEnv} options.env 子进程环境变量。
   * @param {string} options.cwd 子进程工作目录。
   * @param {(level: 'info' | 'warn', message: string) => void} [options.log] 日志回调。
   */
  constructor({ argv, env, cwd, log }) {
    this.argv = argv
    this.env = env
    this.cwd = cwd
    this.log = log ?? (() => {})

    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.child = undefined
    this.nextId = 1
    /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void, method: string }>} */
    this.pending = new Map()
    /** @type {Map<string, (update: object) => void>} */
    this.updateListeners = new Map()
    /** @type {((method: string, params: object) => Promise<unknown>) | undefined} */
    this.requestHandler = undefined
    /** @type {((reason: string) => void) | undefined} */
    this.exitListener = undefined

    this.stdoutBuffer = ''
    this.stderr = ''
    this.closed = false
    /** 需要浏览器授权时 CodeBuddy 下发的链接（私有扩展 `_codebuddy.ai/authUrl`）。 */
    this.authUrl = undefined
    /** 进程非正常退出时的说明，供上层拼诊断。 */
    this.exitReason = undefined
    this.startedAt = Date.now()
  }

  /**
   * 启动子进程并完成 `initialize` 握手。
   *
   * @param {object} params 握手参数。
   * @param {object} params.clientCapabilities 客户端能力声明。
   * @param {{ name: string, version: string }} params.clientInfo 客户端身份。
   * @param {AbortSignal} [params.signal] 超时/取消信号。
   * @returns {Promise<object>} agent 的 initialize 响应。
   */
  async start({ clientCapabilities, clientInfo, signal }) {
    if (this.child !== undefined) throw new AcpError('ACP 连接已经启动过了')

    this.log('info', `启动 CodeBuddy ACP：${this.argv.join(' ')}（cwd=${this.cwd}）`)
    const child = spawn(this.argv[0], this.argv.slice(1), {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    const startFailure = new Promise((_, reject) => {
      child.once('error', (error) => {
        this.exitReason = `无法启动 codebuddy：${error.message}`
        reject(new AcpError(this.exitReason, { code: 'SPAWN_FAILED' }))
      })
    })
    startFailure.catch(() => {})

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      this.stderr = (this.stderr + text).slice(-STDERR_LIMIT)
      this.log('info', `[codebuddy stderr] ${text.trimEnd()}`)
    })
    child.once('exit', (code, signal) => {
      this.closed = true
      if (this.exitReason === undefined) {
        this.exitReason = signal !== null
          ? `codebuddy 进程被信号 ${signal} 终止`
          : `codebuddy 进程退出（code=${String(code)}）`
      }
      this.#rejectAll(new AcpError(this.exitReason, { code: 'PROCESS_EXITED' }))
      this.exitListener?.(this.exitReason)
    })

    const response = await Promise.race([
      this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities,
        clientInfo,
      }, { signal }),
      startFailure,
    ])
    return response ?? {}
  }

  /**
   * 注册 agent → 客户端请求的处理函数。
   * @param {(method: string, params: object) => Promise<unknown>} handler 处理器。
   */
  setRequestHandler(handler) {
    this.requestHandler = handler
  }

  /**
   * 注册进程退出监听。
   * @param {(reason: string) => void} listener 监听函数。
   */
  setExitListener(listener) {
    this.exitListener = listener
  }

  /**
   * 发起一个 JSON-RPC 请求。
   *
   * @param {string} method 方法名。
   * @param {object} params 参数。
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] 取消与超时。
   * @returns {Promise<any>} 结果。
   */
  request(method, params, options = {}) {
    if (this.closed || this.child === undefined) {
      return Promise.reject(new AcpError(`ACP 连接已关闭，无法发送 ${method}`, { code: 'CLOSED', method }))
    }
    const id = this.nextId
    this.nextId += 1
    const { signal, timeoutMs } = options

    return new Promise((resolve, reject) => {
      /** @type {NodeJS.Timeout | undefined} */
      let timer
      const cleanup = () => {
        this.pending.delete(id)
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new AcpError(`${method} 已取消`, { code: 'ABORTED', method }))
      }
      if (signal?.aborted === true) {
        reject(new AcpError(`${method} 已取消`, { code: 'ABORTED', method }))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup()
          reject(new AcpError(`${method} 超时（${timeoutMs}ms）`, { code: 'TIMEOUT', method }))
        }, timeoutMs)
        timer.unref?.()
      }

      this.pending.set(id, {
        method,
        resolve: (value) => { cleanup(); resolve(value) },
        reject: (error) => { cleanup(); reject(error) },
      })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /**
   * 发送一条通知（无 id，不等回复）。
   * @param {string} method 方法名。
   * @param {object} params 参数。
   */
  notify(method, params) {
    if (this.closed) return
    this.#write({ jsonrpc: '2.0', method, params })
  }

  /**
   * 建立会话。
   *
   * @param {object} params `session/new` 参数。
   * @param {{ signal?: AbortSignal }} [options] 取消信号。
   * @returns {Promise<{ sessionId: string, models?: object, modes?: object, configOptions?: object[] }>} 会话信息。
   */
  async newSession(params, options = {}) {
    const result = await this.request('session/new', params, options)
    if (result === null || typeof result !== 'object' || typeof result.sessionId !== 'string') {
      throw new AcpError('session/new 未返回 sessionId', { code: 'BAD_RESPONSE', method: 'session/new' })
    }
    return result
  }

  /**
   * 完成鉴权。
   *
   * CodeBuddy 的 ACP 实现要求**每个进程**先 `authenticate` 再 `session/new`，
   * 即使本机已有登录凭据也一样（否则 `session/new` 稳定返回 -32000 auth 错误）。
   * `internal`（微信登录）在已登录的机器上会静默复用缓存凭据；其它 method 会拉起浏览器。
   *
   * @param {string} methodId authMethods 里的某个 id。
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] 取消与超时。
   * @returns {Promise<object>} agent 返回的 `_meta`（含 `codebuddy.ai/userinfo`）。
   */
  async authenticate(methodId, options = {}) {
    return (await this.request('authenticate', { methodId }, options)) ?? {}
  }

  /**
   * 修改会话级配置项（CodeBuddy 用它切换模型、思考档位、沙箱等）。
   *
   * 用 `session/set_model` 也能改模型，但它**不校验** modelId（传错也返回 OK），
   * 所以这里统一走 `session/set_config_option`，它会把非法值以 -32602 拒绝。
   *
   * @param {string} sessionId 会话 id。
   * @param {string} configId 配置项 id（如 `model`、`thought_level`）。
   * @param {unknown} value 新值（类型必须与 option 的 type 一致）。
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] 取消与超时。
   * @returns {Promise<{ configOptions?: object[] }>} 更新后的全量配置项。
   */
  async setSessionConfigOption(sessionId, configId, value, options = {}) {
    const result = await this.request(
      'session/set_config_option',
      { sessionId, configId, value },
      options,
    )
    return result ?? {}
  }

  /**
   * 切换会话模式（权限模式）。
   * @param {string} sessionId 会话 id。
   * @param {string} modeId 模式 id（default / acceptEdits / plan / auto / dontAsk / bypassPermissions / fullAccess）。
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] 取消与超时。
   * @returns {Promise<object>} 结果。
   */
  async setSessionMode(sessionId, modeId, options = {}) {
    return (await this.request('session/set_mode', { sessionId, modeId }, options)) ?? {}
  }

  /**
   * 订阅某个会话的流式更新。
   * @param {string} sessionId 会话 id。
   * @param {(update: object) => void} listener 监听函数。
   * @returns {() => void} 取消订阅。
   */
  onUpdate(sessionId, listener) {
    this.updateListeners.set(sessionId, listener)
    return () => {
      if (this.updateListeners.get(sessionId) === listener) this.updateListeners.delete(sessionId)
    }
  }

  /**
   * 对指定会话发一轮 prompt（等它把结果全部说完）。
   *
   * @param {string} sessionId 会话 id。
   * @param {object[]} content ACP 内容块数组。
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] 取消与超时。
   * @returns {Promise<{ stopReason?: string, usage?: object, _meta?: object }>} prompt 结果。
   */
  async prompt(sessionId, content, options = {}) {
    const result = await this.request('session/prompt', { sessionId, prompt: content }, options)
    return result ?? {}
  }

  /**
   * 取消当前轮次（通知，不等回复）。
   * @param {string} sessionId 会话 id。
   */
  cancel(sessionId) {
    this.notify('session/cancel', { sessionId })
  }

  /**
   * 关闭连接：先温和地关 stdin，再确保进程树退出。
   * @param {number} graceMs 等待退出的宽限期。
   * @returns {Promise<void>} 关闭完成。
   */
  async close(graceMs = 3000) {
    const child = this.child
    this.closed = true
    this.#rejectAll(new AcpError('ACP 连接已关闭', { code: 'CLOSED' }))
    if (child === undefined) return
    try {
      child.stdin?.end()
    } catch {
      // stdin 可能已经关闭。
    }
    if (child.exitCode !== null || child.signalCode !== null) return

    const exited = new Promise((resolve) => {
      child.once('exit', () => resolve(true))
      const timer = setTimeout(() => resolve(false), graceMs)
      timer.unref?.()
    })
    try {
      child.kill()
    } catch {
      // 进程可能已退出。
    }
    if (await exited) return

    // Windows 上 kill() 不保证带走子进程树，用 taskkill /T 兜底。
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
        killer.once('exit', () => resolve(undefined))
        killer.once('error', () => resolve(undefined))
      })
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已经退出。
      }
    }
  }

  /** 最近一段 stderr，用于拼诊断信息。 */
  get stderrTail() {
    return this.stderr.trim()
  }

  /**
   * 写入一条 JSON-RPC 消息。
   * @param {object} message 消息体。
   */
  #write(message) {
    const line = `${JSON.stringify(message)}\n`
    try {
      this.child?.stdin?.write(line, 'utf8')
    } catch (error) {
      this.log('warn', `写入 ACP 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 处理 stdout 上的 ndjson 分帧。
   * @param {string} chunk 数据块。
   */
  #onStdout(chunk) {
    this.stdoutBuffer += chunk
    if (this.stdoutBuffer.length > LINE_LIMIT) {
      this.log('warn', 'ACP stdout 缓冲溢出，丢弃旧数据')
      this.stdoutBuffer = ''
      return
    }
    let index = this.stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line.length > 0) this.#onLine(line)
      index = this.stdoutBuffer.indexOf('\n')
    }
  }

  /**
   * 处理一行协议消息。
   * @param {string} line 单行 JSON。
   */
  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      // CodeBuddy 在 ACP 模式下的 stdout 偶有非协议行（告警等），按日志吞掉。
      this.log('info', `[codebuddy stdout] ${line}`)
      return
    }
    if (message === null || typeof message !== 'object') return

    // 响应：有 id 且没有 method。
    if (typeof message.method !== 'string') {
      const id = typeof message.id === 'number' ? message.id : Number(message.id)
      const entry = this.pending.get(id)
      if (entry === undefined) return
      if (message.error !== undefined && message.error !== null) {
        const error = message.error
        entry.reject(new AcpError(
          typeof error.message === 'string' && error.message.length > 0
            ? error.message
            : `${entry.method} 失败`,
          { code: error.code, data: error.data, method: entry.method },
        ))
      } else {
        entry.resolve(message.result)
      }
      return
    }

    // agent → 客户端请求：有 id 且有 method。
    if (message.id !== undefined && message.id !== null) {
      void this.#dispatchRequest(message)
      return
    }

    // 通知。
    if (message.method === 'session/update') {
      const params = message.params ?? {}
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      const listener = this.updateListeners.get(sessionId)
      listener?.(params.update ?? {})
      return
    }
    if (message.method === '_codebuddy.ai/authUrl') {
      // CodeBuddy 的私有扩展：需要用户在浏览器里完成登录时，先把授权链接下发过来。
      const params = message.params ?? {}
      this.authUrl = typeof params.url === 'string'
        ? params.url
        : typeof params.authUrl === 'string' ? params.authUrl : JSON.stringify(params)
      this.log('warn', `CodeBuddy 需要浏览器授权：${this.authUrl}`)
      return
    }
    this.log('info', `[acp 通知] ${message.method}`)
  }

  /**
   * 处理 agent 主动发起的请求。
   * @param {{ id: number, method: string, params?: object }} message 请求消息。
   */
  async #dispatchRequest(message) {
    const handler = this.requestHandler
    if (handler === undefined) {
      this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not supported' } })
      return
    }
    try {
      const result = await handler(message.method, message.params ?? {})
      this.#write({ jsonrpc: '2.0', id: message.id, result: result ?? {} })
    } catch (error) {
      const acpError = error instanceof AcpError ? error : undefined
      this.#write({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: typeof acpError?.code === 'number' ? acpError.code : -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  /**
   * 让所有待决请求立刻失败。
   * @param {Error} error 失败原因。
   */
  #rejectAll(error) {
    for (const entry of [...this.pending.values()]) entry.reject(error)
    this.pending.clear()
  }
}
