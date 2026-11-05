/**
 * 适配器独立自测：不经过 DSH，直接驱动真实 CodeBuddy CLI（ACP）。
 *
 * 用途：验证 ACP 握手、会话建立、流式转发、用量与终结原因是否按预期映射。
 * 需要本机已安装并登录 CodeBuddy（`codebuddy --version` 可用）。
 *
 * 注意：默认 `toolCut: 'step'`，一次 `stream()` 只是**一个 step**。这里按 DSH 的
 * agent loop 规则循环调用，直到这一轮真正收口；只想看「一条模型流」的话用
 * `--once`（那可能只拿到第一个工具步）。
 *
 * 用法：
 *   node test/run.mjs                 # 默认跑一轮 1+1
 *   node test/run.mjs "帮我看看当前目录有几个文件"
 *   node test/run.mjs --models        # 只列模型，不发起对话
 *   node test/run.mjs --once "1+1=?"  # 只取第一条流（不做多 step 收口）
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { CodeBuddyAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { buildEnv, resolveLaunch } from '../src/launch.js'
import { ToolCallBridge } from '../src/tool-bridge.js'

const args = process.argv.slice(2)
const onlyModels = args.includes('--models')
const once = args.includes('--once')
const prompt = args.filter((item) => !item.startsWith('--'))[0] ?? '用一句话回答：1+1 等于几？'

const host = {
  defaultDirectory: () => process.cwd(),
  resolveCwd: async () => process.cwd(),
  readTextFile: async (path) => readFile(path, 'utf8'),
  writeTextFile: async (path, content) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    return undefined
  },
}

const config = resolveConfig({ logLevel: process.env.CB_LOG ?? 'warn' })
const launch = resolveLaunch(config)
launch.env = buildEnv(config.env)
const logger = {
  info: (message) => process.stderr.write(`[info] ${message}\n`),
  warn: (message) => process.stderr.write(`[warn] ${message}\n`),
}

process.stderr.write(`启动方式：${launch.note}\nargv：${launch.argv.join(' ')}\n`)
// 回放工具要真的「取回结果」才看得到工具卡片；这里用桥 + 自带的续段判断模拟 DSH。
const bridge = new ToolCallBridge({ logger })
bridge.ready = true
const adapter = new CodeBuddyAdapter({ config, launch, host, logger, toolBridge: bridge })

try {
  const models = await adapter.listModels(config.provider)
  process.stderr.write(`模型数量：${models.length}\n`)
  for (const model of models.slice(0, 8)) {
    process.stderr.write(`  - ${model.id} (${model.name}) ${model.description ?? ''}\n`)
  }

  if (!onlyModels) {
    const modelId = args.filter((item) => item.startsWith('--model=')).map((item) => item.slice(8))[0]
      ?? process.env.CB_MODEL
      ?? models[0].id
    const resolved = await adapter.resolveModel(config.provider, modelId)
    process.stderr.write(`测试模型：${resolved.id}（context=${resolved.context.contextWindow}）\n\n`)
    const started = Date.now()
    const controller = new AbortController()
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    let text = ''
    let reasoning = ''
    let finish
    let steps = 0
    // 按 DSH 的 agent loop 走：每步执行本步的 tool-call 块，直到收口。
    while (steps < 12) {
      steps += 1
      const stepStarted = Date.now()
      const blocks = []
      for await (const chunk of adapter.stream({
        provider: config.provider,
        model: modelId,
        sessionId: 'selftest-session',
        messages,
        signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta') {
          text += chunk.text
          process.stdout.write(chunk.text)
        } else if (chunk.type === 'reasoning-delta') {
          reasoning += chunk.text
        } else if (chunk.type === 'block-end') {
          blocks.push(chunk.block)
        } else if (chunk.type === 'finish') {
          finish = chunk.reason
        } else if (chunk.type === 'usage') {
          process.stderr.write(`\n[usage] ${JSON.stringify(chunk.usage)}\n`)
        }
      }
      const calls = blocks.filter((block) => block.type === 'tool-call')
      process.stderr.write(`\n[step ${steps}] 用时 ${Date.now() - stepStarted}ms，工具 ${calls.length}，终止 ${JSON.stringify(finish)}\n`)
      if (once || calls.length === 0) break
      const results = calls.map((call) => {
        const argsOf = JSON.parse(call.arguments)
        const record = bridge.read(argsOf.callId)
        process.stderr.write(`[step ${steps}] 回放 ${argsOf.title} → ${record?.status ?? 'unknown'}\n`)
        return {
          role: 'tool',
          toolCallId: call.id,
          content: [{ type: 'text', text: record?.output ?? '' }],
        }
      })
      messages.push({ role: 'assistant', content: blocks }, ...results)
      const more = await bridge.continuationOf(JSON.parse(calls[calls.length - 1].arguments).callId, config.toolCutWaitMs)
      if (more !== 'more') break
    }
    process.stdout.write('\n')
    process.stderr.write(`\n共 ${steps} 步，用时 ${Date.now() - started}ms\n`)
    process.stderr.write(`回答长度 ${text.length}，思考长度 ${reasoning.length}\n`)
    process.stderr.write(`终结原因 ${JSON.stringify(finish)}\n`)
    if (finish?.kind === 'error') process.exitCode = 1
  }
} finally {
  await adapter.dispose()
}
