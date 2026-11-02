/**
 * 离线分析：从已落盘的 ACP 原始帧里判定「单进程多会话并发」的真实行为。
 *
 * 不启动任何进程、不联网、不触发登录 —— 只读 probe\out 下已存在的 jsonl。
 *
 * 判定要点：
 * 1. 每个 session/update 是否被服务端正确标注了它自己的 sessionId（归属正确性）；
 * 2. 同一会话的回答正文里是否混入了**别的会话**的提问关键词（跨会话串流）；
 * 3. prompt 是否被并发受理（首帧延迟 vs 第一条的结束时刻）。
 *
 * 用法：node probe\analyze-concurrency.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'out')

/**
 * 读一份 jsonl，返回帧数组。
 * @param {string} name 文件名。
 * @returns {object[]} 帧。
 */
function loadFrames(name) {
  const path = join(outDir, name)
  if (!existsSync(path)) return []
  const frames = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      frames.push(JSON.parse(line))
    } catch {
      // 坏行忽略。
    }
  }
  return frames
}

/** 关键词（探针用水果名区分会话）。 */
const KEYWORDS = ['苹果', '香蕉', '橙子', '梨', '葡萄']

/**
 * 从 prompt 文本里取关键词。
 * @param {string} text prompt 文本。
 * @returns {string | undefined} 关键词。
 */
function keywordOf(text) {
  return KEYWORDS.find((word) => text.includes(word))
}

/**
 * 分析一份场景文件。
 * @param {string} name 文件名。
 * @returns {object | undefined} 分析结果。
 */
function analyze(name) {
  const frames = loadFrames(name)
  if (frames.length === 0) return undefined

  /** @type {Map<string, { updates: number, text: string, firstAt?: number, lastAt?: number }>} */
  const sessions = new Map()
  /** @type {{ id: number, sid: string, at: number, keyword?: string }[]} */
  const prompts = []
  /** @type {Map<number, { at: number, stopReason?: string }>} */
  const results = new Map()

  for (const frame of frames) {
    const msg = frame.msg
    if (msg === undefined) continue

    if (frame.dir === 'out' && msg.method === 'session/prompt') {
      prompts.push({
        id: msg.id,
        sid: msg.params.sessionId,
        at: frame.t,
        keyword: keywordOf(msg.params.prompt?.[0]?.text ?? ''),
      })
      continue
    }
    if (frame.dir === 'in' && msg.method !== undefined && msg.params?.update !== undefined) {
      const sid = msg.params.sessionId
      const update = msg.params.update
      let bucket = sessions.get(sid)
      if (bucket === undefined) {
        bucket = { updates: 0, text: '' }
        sessions.set(sid, bucket)
      }
      bucket.updates += 1
      bucket.firstAt ??= frame.t
      bucket.lastAt = frame.t
      if (update.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') {
        bucket.text += update.content.text
      }
      continue
    }
    if (frame.dir === 'in' && msg.method === undefined && typeof msg.id === 'number') {
      results.set(msg.id, { at: frame.t, stopReason: msg.result?.stopReason, error: msg.error?.message })
    }
  }

  // prompt 与 session 对应起来（同一个 sessionId 只发一次 prompt 时才能直接配）。
  const rows = []
  for (const prompt of prompts) {
    const bucket = sessions.get(prompt.sid)
    const result = results.get(prompt.id)
    const own = prompt.keyword
    const expected = own === undefined ? '' : own
    const foreign = own === undefined ? [] : KEYWORDS.filter((word) => word !== own && (bucket?.text ?? '').includes(word))
    const verdict = bucket === undefined || (bucket.text === '' && bucket.updates === 0) ? '无输出'
      : foreign.length > 0 ? `串流:出现 ${foreign.join('/')}`
        : expected === '' ? '无可判定关键词'
          : bucket.text.includes(expected) ? '归属正确'
            : '答复不含关键词'
    rows.push({
      sid: prompt.sid,
      promptAt: prompt.at,
      expected,
      updates: bucket?.updates ?? 0,
      firstUpdateAt: bucket?.firstAt,
      resultAt: result?.at,
      duration: result?.at === undefined ? undefined : result.at - prompt.at,
      stopReason: result?.stopReason ?? (result?.error === undefined ? undefined : `ERR:${result.error}`),
      textLength: bucket?.text.length ?? 0,
      foreign,
      verdict,
    })
  }

  // 并发性判定：后发的 prompt 是否在「第一条结束之前」就收到了自己的首帧。
  const byStart = rows.slice().sort((left, right) => left.promptAt - right.promptAt)
  let concurrent = null
  if (byStart.length >= 2) {
    const first = byStart[0]
    const others = byStart.slice(1)
    concurrent = others.some((row) => row.firstUpdateAt !== undefined
      && (first.resultAt === undefined || row.firstUpdateAt < first.resultAt))
  }

  return { name, rows, concurrent }
}

const files = readdirSync(outDir).filter((file) => file.endsWith('.jsonl') && file.startsWith('concurrency'))
const reports = []
for (const file of files) {
  const report = analyze(file)
  if (report !== undefined && report.rows.length > 0) reports.push(report)
}

for (const report of reports) {
  process.stdout.write(`\n===== ${report.name} =====\n`)
  for (const row of report.rows) {
    process.stdout.write(`  会话 ${row.sid.slice(18, 24)} 期望=${row.expected || '-'} 首帧=${row.firstUpdateAt ?? '-'} 结束=${row.resultAt ?? '-'} 时长=${row.duration ?? '-'}ms 帧数=${row.updates} 正文=${row.textLength} 判定=${row.verdict}\n`)
  }
  process.stdout.write(`  并发性: ${report.concurrent === null ? '单会话，不适用' : report.concurrent ? '是（后发者未等前者结束就有输出）' : '否（后发者被阻塞到前者结束）'}\n`)
}

const bad = reports.flatMap((report) => report.rows).filter((row) => row.verdict.startsWith('串流'))
process.stdout.write(`\n结论：${bad.length === 0 ? '未发现跨会话串流' : `发现 ${bad.length} 条跨会话串流`}\n`)
