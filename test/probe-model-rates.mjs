/**
 * 探针：验证账号侧模型列表接口能否给出「真实倍率」。
 *
 * 这是倍率的权威来源：发行版 product.json 是写死的静态表，
 * 与账号实际计费口径不一致（实测 deepseek-v4.1-flash 静态 x0.00、账号侧 x0.03）。
 */

import { CodeBuddyBilling } from '../src/billing.js'

const billing = new CodeBuddyBilling({})
const loaded = billing.accountSummary()
if (loaded.available !== true) {
  console.error('登录态不可用：', loaded.reason)
  process.exit(1)
}

// 复用 billing 里的私有登录态读取：直接内联同样的路径。
const { findAuthFiles, readAuthFile, billingHeaders, backendFor } = await import('../src/billing.js')
let auth
for (const file of findAuthFiles(undefined)) {
  const parsed = readAuthFile(file.path)
  if (parsed.ok) { auth = parsed; break }
}

const headers = { ...billingHeaders(auth) }
delete headers['Content-Type']
const url = `${backendFor(auth.domain)}/v2/enterprises/personal/models`
const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(20000) })
const text = await response.text()
console.log(`HTTP ${response.status}  ${url}`)

let payload
try { payload = JSON.parse(text) } catch { console.log(text.slice(0, 500)); process.exit(1) }

const rows = (() => {
  if (Array.isArray(payload)) return payload
  const data = payload?.data ?? payload
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.models)) return data.models
  if (Array.isArray(payload?.models)) return payload.models
  return []
})()

console.log(`模型数：${rows.length}`)
for (const row of rows) {
  const credits = row?.credits ?? row?._meta?.credits ?? row?.description ?? ''
  if (/deepseek|glm-5\.3$|hy3$/.test(String(row?.id))) {
    console.log(`  ${row.id}  credits=${JSON.stringify(credits)}  name=${row.name}`)
  }
}
console.log('\n全部模型：')
for (const row of rows) console.log(`  ${String(row?.id).padEnd(28)} ${row?.credits ?? row?._meta?.credits ?? ''}`)
