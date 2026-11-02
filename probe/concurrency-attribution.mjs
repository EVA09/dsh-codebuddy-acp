/**
 * 决定性实验：同一 CodeBuddy 进程内两条 ACP 会话并发 prompt，回答是否被**正确归属**。
 *
 * 背景：`concurrency-probe.mjs` 观察到可疑现象——会话 C 被要求回答「橙子」，
 * 却收到「苹果」结尾（苹果是会话 A 的问题）。若属实，说明单进程并发会让
 * 回答串到别的会话，那「多对话并发」就不能靠共享进程实现。
 *
 * 本实验把问题设计成**极短、可互斥、必定不同**的回答，从而排除
 * 「模型自己写混了」的可能：只要 A 收到 BBB 或 B 收到 AAA，就是串流。
 *
 * 用法：node probe\concurrency-attribution.mjs
 * 产物：probe\out\attribution.jsonl + probe\out\attribution.console.txt
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AcpClient } from './lib/acp-client.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'out')
const workDir = join(here, 'work')
await mkdir(outDir, { recursive: true })
await mkdir(workDir, { recursive: true })

const log = []
const say = (line) => {
  log.push(line)
  process.stdout.write(`${line}\n`)
}

/**
 * 跑一个场景：同时给 N 条会话发互不相同的问题，收集每个会话的答复正文。
 * @param {string} name 场景名。
 * @param {string[]} tokens 每个会话要模型回答的唯一词。
 * @param {{ cancelAfterMs?: number, cancelIndex?: number }} [options] 取消选项。
 * @returns {Promise<object>} 结果。
 */
async function scenario(name, tokens, options = {}) {
  say(`\n########## ${name} ##########`)
  const client = new AcpClient({
    outDir,
    name: `attribution-${name}`,
    cwd: workDir,
    timeout: 180000,
    permissionPolicy: 'allow_once',
  })
  /** @type {Map<string, { label: string, text: string, updates: number }>} */
  const buckets = new Map()
  let labels = []

  // AcpClient 用 `notifyHandler` 分发通知；`on()` 只注册「服务端→客户端请求」。
  client.notifyHandler = (method, params) => {
    if (method !== 'session/update') return
    const sid = params.sessionId
    const update = params.update ?? {}
    // 只按服务端给的 sessionId 分桶：归属错误就是服务端错误，探针不做任何改写。
    let bucket = buckets.get(sid)
    if (bucket === undefined) {
      bucket = { label: `S?${buckets.size}`, text: '', updates: 0, token: '' }
      buckets.set(sid, bucket)
    }
    bucket.updates += 1
    if (update.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') {
      bucket.text += update.content.text
    }
  }

  try {
    client.start()
    const init = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: false } },
      clientInfo: { name: 'dsh-attribution-probe', title: 'DSH Attribution Probe', version: '0.1.0' },
    })
    const methods = Array.isArray(init.authMethods) ? init.authMethods : []
    const internal = methods.find((item) => item.id === 'internal')
    if (internal !== undefined) {
      try {
        await client.request('authenticate', { methodId: internal.id }, { timeout: 120000 })
        say('authenticate(internal) 成功')
      } catch (error) {
        say(`authenticate(internal) 失败（继续尝试直接建会话）：${error.message}`)
      }
    }

    /** @type {string[]} */
    const sessionIds = []
    for (const token of tokens) {
      const session = await client.request('session/new', { cwd: workDir, mcpServers: [] })
      sessionIds.push(session.sessionId)
      // 复用可能已被 session/new 期间更新创建的桶，再补上期望值与标签。
      const bucket = buckets.get(session.sessionId) ?? { text: '', updates: 0 }
      bucket.label = `S${sessionIds.length - 1}`
      bucket.token = token
      buckets.set(session.sessionId, bucket)
    }
    labels = [...buckets.entries()].map(([sid, bucket]) => `${bucket.label}=${bucket.token} sid=${sid.slice(-12)}`)
    for (const line of labels) say(`  ${line}`)

    // 同时发出：先全部构造请求（同一个 tick 内写 stdin），再一起等。
    const startedAt = Date.now()
    const pending = sessionIds.map((sid, index) => {
      const token = tokens[index]
      const text = `只输出这三个大写字母，不要任何其它字符、不要解释、不要标点：${token}`
      say(`[+${Date.now() - startedAt}ms] → ${buckets.get(sid).label} prompt=${token}`)
      return client.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] }, { timeout: 150000 })
        .then((result) => ({ sid, index, ok: true, result }))
        .catch((error) => ({ sid, index, ok: false, error: error.message }))
    })

    let cancelTimer
    if (typeof options.cancelAfterMs === 'number') {
      cancelTimer = setTimeout(() => {
        const index = options.cancelIndex ?? 0
        say(`[+${Date.now() - startedAt}ms] >>> session/cancel ${buckets.get(sessionIds[index]).label}`)
        client.notify('session/cancel', { sessionId: sessionIds[index] })
      }, options.cancelAfterMs)
    }

    const settled = await Promise.all(pending)
    if (cancelTimer !== undefined) clearTimeout(cancelTimer)

    say('\n结果：')
    const report = []
    for (const item of settled) {
      const bucket = buckets.get(item.sid)
      const answer = bucket.text.trim()
      const expected = tokens[item.index]
      // 归属判定：答复里出现自己的 token 才算「答对了」；出现别人的 token 就是串流。
      const others = tokens.filter((token) => token !== expected)
      const foreign = others.filter((token) => answer.includes(token))
      const verdict = answer === '' ? '空答复'
        : foreign.length > 0 ? `串流(收到 ${foreign.join('/')})`
          : answer.includes(expected) ? '正确归属'
            : '答复不含 token'
      say(`  ${bucket.label}(期望 ${expected}) updates=${bucket.updates} 时长=${item.ok ? 'ok' : 'ERR'} stopReason=${item.ok ? item.result.stopReason : item.error}`)
      say(`     答复=${JSON.stringify(answer.slice(0, 120))}`)
      say(`     判定=${verdict}`)
      report.push({
        session: item.sid,
        label: bucket.label,
        expected,
        answer,
        updates: bucket.updates,
        stopReason: item.ok ? item.result.stopReason : null,
        error: item.ok ? null : item.error,
        verdict,
      })
    }
    return { name, tokens, report }
  } finally {
    await client.stop()
  }
}

const results = []
try {
  // 场景 1：两条并发，答案必须严格互斥。
  results.push(await scenario('two-distinct', ['AAA', 'BBB']))
  // 场景 2：三条并发。
  results.push(await scenario('three-distinct', ['AAA', 'BBB', 'CCC']))
  // 场景 3：串行对照（先跑完 A 再发 B），确认单会话路径本身没有归属问题。
  results.push(await scenario('serial-control', ['AAA', 'BBB'], { serial: true }))
} catch (error) {
  say(`\n实验异常：${error instanceof Error ? error.stack : String(error)}`)
} finally {
  await writeFile(join(outDir, 'attribution.console.txt'), `${log.join('\n')}\n`, 'utf8')
  say(`\n[console] -> ${join(outDir, 'attribution.console.txt')}`)
  const bad = results.flatMap((item) => item.report).filter((row) => row.verdict !== '正确归属')
  say(`\n总结：${bad.length === 0 ? '全部正确归属，未发现串流' : `发现 ${bad.length} 条异常归属`}`)
}
