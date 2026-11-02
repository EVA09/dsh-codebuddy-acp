/**
 * 真实链路验证：直接问运行中的 Host 要 codebuddy 的模型目录，
 * 确认每个模型名后面确实带了积分倍率。
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:56871'

const state = await fetch(`${BASE}/api/codebuddy-console/state`, { cache: 'no-store' }).then((r) => r.json())
if (state.ok !== true) {
  console.error('读取 state 失败：', state)
  process.exit(1)
}

const models = state.data.models ?? []
console.log(`目录 ${models.length} 个模型：`)
for (const model of models) {
  console.log(`  ${String(model.name).padEnd(28)} rate=${model.creditRate ?? '—'}  id=${model.id}`)
}

const selectable = state.data.selectableModelIds ?? []
console.log(`\n选择器可选 ${selectable.length} 个`)

// 名字里应该带 ×倍率 或 免费 的标记。
const withRate = models.filter((model) => /×|免费/.test(String(model.name ?? '')))
console.log(`\n名字里带倍率的：${withRate.length} / ${models.length}`)
for (const model of withRate.slice(0, 8)) console.log(`  ${model.name}`)
