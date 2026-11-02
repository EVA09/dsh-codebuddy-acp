/**
 * 真实接口冒烟：用本机 CodeBuddy CLI 登录态实打实调一次 billing，确认字段都对得上。
 *
 * 只读，不领取。用法：`node test/billing-live.mjs`
 */

import { CodeBuddyBilling } from '../src/billing.js'

const logger = { warn: (message) => console.warn('warn:', message) }
const billing = new CodeBuddyBilling({ logger })

const account = billing.accountSummary()
console.log('账号：', account.available
  ? `${account.label} @ ${account.domain} → ${account.backend}`
  : `不可用（${account.reason}）`)
if (account.available !== true) process.exit(0)

const balance = await billing.fetchBalance({ force: true })
if (balance.ok === true) {
  console.log(`剩余积分：${balance.total}（有效包 ${balance.activePackageCount} / 共 ${balance.packageCount}）`)
  console.log(`已用合计：${balance.totalUsed}，最近到期：${balance.nextExpireDays} 天后剩 ${balance.nextExpireAmount}`)
  for (const item of balance.packages.slice(0, 6)) {
    console.log(`  - ${item.name}｜剩 ${item.remaining}/${item.size}｜${item.expiresInDays === null ? '无期限' : `${item.expiresInDays} 天`}${item.grantSource ? `｜${item.grantSource}` : ''}`)
  }
} else {
  console.log(`余额读取失败：${balance.message}`)
}

const checkin = await billing.fetchCheckin({ force: true })
if (checkin.ok === true) {
  console.log(`签到：今日${checkin.checkedIn ? '已领取' : '未领取'}，连续 ${checkin.streakDays} 天，日额度 ${checkin.dailyCredit}，活动「${checkin.activityName}」`)
} else {
  console.log(`签到读取失败：${checkin.message}`)
}
