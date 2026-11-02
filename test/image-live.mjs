/**
 * 真实链路自测：**改好的适配器** + 真实 CodeBuddy CLI + 真实 PNG 字节。
 *
 * 与 `test/image-prompt.test.mjs`（离线、假连接）的区别：这里真的把
 * `adapter.stream()` 跑通，让 CodeBuddy 自己去回答，验证「图片真的到了模型眼前」。
 * 需要本机已安装并登录 CodeBuddy（`codebuddy --version` 可用），会消耗一次额度。
 *
 * 用法：
 *   node test/image-live.mjs                     # 默认用 probe/out/red-64x64.png
 *   node test/image-live.mjs <png 路径>          # 换一张图
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { CodeBuddyAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { buildEnv, resolveLaunch } from '../src/launch.js'

const pngPath = process.argv.slice(2).find((item) => !item.startsWith('--'))
  ?? resolve('probe/out/red-64x64.png')
const bytes = await readFile(pngPath)
const base64 = Buffer.from(bytes).toString('base64')

process.stderr.write(`图片：${pngPath}（${bytes.length} 字节）\n`)

/**
 * 假附件服务：真实适配器会通过 `host.readImage(ref, target, signal)` 来要字节，
 * 这里把它映射到磁盘上的 PNG——相当于 `ctx.attachments` 的最小替身。
 */
const ref = {
  attachmentId: `sha256:live-${bytes.length}`,
  mediaType: 'image/png',
  bytes: bytes.length,
  width: 64,
  height: 64,
  name: 'live.png',
}
const reads = []
const host = {
  defaultDirectory: () => process.cwd(),
  resolveCwd: async () => process.cwd(),
  readTextFile: async () => '',
  writeTextFile: async () => {},
  readImage: async (requested, target) => {
    reads.push({ attachmentId: requested.attachmentId, target })
    return { data: base64, mediaType: 'image/png', bytes: bytes.length }
  },
}

const config = resolveConfig({ logLevel: process.env.CB_LOG ?? 'warn' })
const launch = resolveLaunch(config)
launch.env = buildEnv(config.env)
const adapter = new CodeBuddyAdapter({
  config,
  launch,
  host,
  logger: {
    info: (message) => process.stderr.write(`[info] ${message}\n`),
    warn: (message) => process.stderr.write(`[warn] ${message}\n`),
  },
})

const modelId = process.env.CB_MODEL ?? 'deepseek-v4.1-flash'

try {
  const started = Date.now()
  let text = ''
  for await (const chunk of adapter.stream({
    provider: config.provider,
    model: modelId,
    sessionId: `image-live-${Date.now()}`,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图片是什么颜色？只回答一个词。' },
        { type: 'image', attachment: ref },
      ],
    }],
  })) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      process.stdout.write(chunk.text)
    } else if (chunk.type === 'finish') {
      process.stderr.write(`\n终结原因 ${JSON.stringify(chunk.reason)}\n`)
      if (chunk.reason?.kind === 'error') process.exitCode = 1
    }
  }
  process.stdout.write('\n')
  process.stderr.write(`用时 ${Date.now() - started}ms，读图次数 ${reads.length}\n`)
  process.stderr.write(`投递目标 ${JSON.stringify(reads[0]?.target)}\n`)
  const answer = text.trim()
  // 期望色从文件名推（red-64x64.png → 红），这样换图不必改脚本。
  const EXPECT = {
    red: /红|red/i, blue: /蓝|blue/i, green: /绿|green/i,
    yellow: /黄|yellow/i, black: /黑|black/i, white: /白|white/i,
  }
  const wanted = Object.entries(EXPECT).find(([key]) => pngPath.toLowerCase().includes(key))?.[1]
  const sawImage = wanted === undefined ? answer.length > 0 : wanted.test(answer)
  process.stderr.write(`答案「${answer.slice(0, 40)}」→ ${sawImage ? '✅ 模型真的看见了图里的颜色' : '❌ 模型没看见图'}\n`)
  if (!sawImage) process.exitCode = 1
} finally {
  await adapter.dispose()
}
