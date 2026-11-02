/**
 * 适配器独立自测：不经过 DSH，直接驱动真实 CodeBuddy CLI（ACP）。
 *
 * 用途：验证 ACP 握手、会话建立、流式转发、用量与终结原因是否按预期映射。
 * 需要本机已安装并登录 CodeBuddy（`codebuddy --version` 可用）。
 *
 * 用法：
 *   node test/run.mjs                 # 默认跑一轮 1+1
 *   node test/run.mjs "帮我看看当前目录有几个文件"
 *   node test/run.mjs --models        # 只列模型，不发起对话
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { CodeBuddyAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { buildEnv, resolveLaunch } from '../src/launch.js'

const args = process.argv.slice(2)
const onlyModels = args.includes('--models')
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
const adapter = new CodeBuddyAdapter({ config, launch, host, logger })

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
    let text = ''
    let reasoning = ''
    let finish
    const controller = new AbortController()
    const prepared = await adapter.prepareCall(config.provider, modelId)
    for await (const chunk of prepared.stream({
      provider: config.provider,
      model: modelId,
      sessionId: 'selftest-session',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        process.stdout.write(chunk.text)
      } else if (chunk.type === 'reasoning-delta') {
        reasoning += chunk.text
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
      } else if (chunk.type === 'usage') {
        process.stderr.write(`\n[usage] ${JSON.stringify(chunk.usage)}\n`)
      }
    }
    process.stdout.write('\n')
    process.stderr.write(`\n用时 ${Date.now() - started}ms\n`)
    process.stderr.write(`回答长度 ${text.length}，思考长度 ${reasoning.length}\n`)
    process.stderr.write(`终结原因 ${JSON.stringify(finish)}\n`)
    if (finish?.kind === 'error') process.exitCode = 1
  }
} finally {
  await adapter.dispose()
}
