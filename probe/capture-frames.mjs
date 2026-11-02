/**
 * 抓 ACP 原始帧：验证 CodeBuddy 到底会不会发 `plan` / `session/request_permission`。
 *
 * 目的：这两个通知很挑条件（plan 要模型自己列步骤、权限要命中它的敏感规则），
 * 用 DSH 的 headless 跑只能看到最终效果，看不到帧。这个脚本直接把 AcpConnection
 * 拉起来，把每一条 `session/update` 和每一条 agent→client 请求原样打出来。
 *
 * 用法：
 *   node probe/capture-frames.mjs "任务描述"
 *   node probe/capture-frames.mjs --mode default "任务描述"
 *   node probe/capture-frames.mjs --mode plan "任务描述"
 */

import { resolveConfig } from '../src/config.js'
import { resolveLaunch, buildEnv } from '../src/launch.js'
import { AcpConnection } from '../src/acp.js'

const argv = process.argv.slice(2)
let permissionMode = 'default'
const words = []
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--mode') {
    permissionMode = argv[index + 1]
    index += 1
    continue
  }
  words.push(argv[index])
}
const task = words.join(' ') || '请先列出三个步骤，再逐步执行：统计当前目录下的 .js 文件数量。'

const config = resolveConfig({
  permissionMode,
  // 我们自己做应答，所以静态策略给 allow；重点是看有没有帧。
  permissionPolicy: 'allow',
  logLevel: 'info',
})
const launch = resolveLaunch(config)
launch.env = buildEnv(config.env)

const cwd = process.cwd()
const connection = new AcpConnection({
  argv: [...launch.argv, ...config.args],
  env: launch.env,
  cwd,
  log: (level, message) => {
    if (level === 'warn' || process.env.PROBE_VERBOSE === '1') process.stderr.write(`[${level}] ${message}\n`)
  },
})

/** 记录 agent→client 的请求。 */
connection.setRequestHandler(async (method, params) => {
  if (method === 'session/request_permission') {
    process.stdout.write(`\n<< PERMISSION ${JSON.stringify(params)}\n`)
    const options = Array.isArray(params?.options) ? params.options : []
    const allow = options.find((option) => String(option?.kind ?? '').startsWith('allow')) ?? options[0]
    // ACP 的回应是**双层** `{outcome:{outcome,optionId}}`；少包一层会被判 PERMISSION_DENIED。
    return allow === undefined
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: allow.optionId } }
  }
  process.stdout.write(`\n<< REQUEST ${method}\n`)
  if (method.startsWith('fs/')) return {}
  throw Object.assign(new Error(`unsupported ${method}`), { code: -32601 })
})

const started = await connection.start({
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
  clientInfo: { name: 'dsh-codebuddy-acp-probe', version: '0.3.0' },
  signal: AbortSignal.timeout(60000),
})
process.stdout.write(`initialize ok: ${JSON.stringify(started).slice(0, 120)}\n`)

// 惰性鉴权：先 session/new，被 -32000 auth 拒绝时才补一次 authenticate。
let session
try {
  session = await connection.newSession({ cwd, mcpServers: [] }, { timeoutMs: 60000 })
} catch (error) {
  if (String(error?.data?.category ?? '') !== 'auth') throw error
  const methods = started?.authMethods ?? []
  const internal = methods.find((entry) => String(entry?.id ?? '').includes('internal')) ?? methods[0]
  if (internal === undefined) throw error
  process.stdout.write(`authenticate ${internal.id} …\n`)
  await connection.authenticate(internal.id, { timeoutMs: 180000 })
  session = await connection.newSession({ cwd, mcpServers: [] }, { timeoutMs: 60000 })
}
const sessionId = session.sessionId
process.stdout.write(`session=${sessionId}\n`)

const seen = new Map()
connection.onUpdate(sessionId, (update) => {
  const kind = String(update?.sessionUpdate)
  seen.set(kind, (seen.get(kind) ?? 0) + 1)
  if (kind === 'plan' || kind === 'session/request_permission') {
    process.stdout.write(`\n<< ${kind} ${JSON.stringify(update, null, 2)}\n`)
    return
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const name = update._meta?.['codebuddy.ai/toolName'] ?? ''
    // TaskCreate / TaskUpdate 的 rawInput 是任务清单的真身，必须打全。
    if (/Task/i.test(String(name)) || /Task/i.test(String(update.title ?? ''))) {
      process.stdout.write(`\n[${kind}] ${JSON.stringify(update, null, 2)}\n`)
      return
    }
    process.stdout.write(`\n[${kind}] ${update.toolCallId} ${name} ${update.title ?? ''} ${update.status ?? ''}\n`)
    return
  }
  if (kind === 'session_info_update') {
    const title = typeof update.title === 'string' ? ` title=${JSON.stringify(update.title)}` : ''
    const phase = update._meta?.['codebuddy.ai/agentPhase']?.phase
    if (title !== '' || phase !== undefined) process.stdout.write(`\n[session_info]${title}${phase === undefined ? '' : ` phase=${phase}`}\n`)
  }
})

const result = await connection.prompt(sessionId, [{ type: 'text', text: task }], { timeoutMs: 300000 })
process.stdout.write(`\n=== prompt done: ${JSON.stringify(result)}\n`)
process.stdout.write('=== 收到的 sessionUpdate 统计:\n')
for (const [kind, count] of seen) process.stdout.write(`  ${kind}: ${count}\n`)

await connection.close(3000).catch(() => {})
