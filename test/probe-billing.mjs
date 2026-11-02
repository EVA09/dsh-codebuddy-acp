/**
 * 探针：直接用本机 CodeBuddy 登录态调用 billing 接口，确认「剩余积分」与「每日领取」是否可用。
 *
 * 只读 auth 文件、不打印 token 全文，仅供开发调试。
 *
 * 用法：
 *   node test/probe-billing.mjs            # 查剩余资源 + 领取状态
 *   node test/probe-billing.mjs --claim    # 额外调用一次领取（真实改变账号状态，慎用）
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const AUTH_FILE = join(
  process.env.LOCALAPPDATA ?? '',
  'CodeBuddyExtension',
  'Data',
  'Public',
  'auth',
  'Tencent-Cloud.coding-copilot.info',
)

const IDE_VERSION = '2.109.2'

function headers(auth, account) {
  const domain = String(auth.domain ?? 'www.codebuddy.cn')
  const origin = domain.includes('workbuddy.ai') ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Product': 'SaaS',
    'User-Agent': `CLI/${IDE_VERSION} CodeBuddy/${IDE_VERSION}`,
    Origin: origin,
    Referer: `${origin}/`,
  }
  if (auth.accessToken) h.Authorization = `Bearer ${auth.accessToken}`
  if (account.uid) h['X-User-Id'] = account.uid
  h['X-No-Enterprise-Id'] = '1'
  h['X-No-Department-Info'] = '1'
  h['X-Requested-With'] = 'XMLHttpRequest'
  return h
}

const raw = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
const account = raw.account ?? {}
const auth = raw.auth ?? {}
if (!auth.accessToken) {
  console.error('没有 accessToken，先登录 codebuddy')
  process.exit(1)
}

const base = 'https://copilot.tencent.com'

async function post(path, body = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: headers(auth, account),
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text }
}

console.log('=== get-user-resource ===')
let result = await post('/v2/billing/meter/get-user-resource')
console.log(result.status)
console.log(result.text.slice(0, 4000))

console.log('\n=== checkin-activity-status ===')
result = await post('/v2/billing/meter/checkin-activity-status')
console.log(result.status)
console.log(result.text.slice(0, 2000))

if (process.argv.includes('--claim')) {
  console.log('\n=== daily-checkin ===')
  result = await post('/v2/billing/meter/daily-checkin')
  console.log(result.status)
  console.log(result.text.slice(0, 2000))
}
