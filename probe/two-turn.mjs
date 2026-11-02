import { readFile } from 'node:fs/promises'
import { CodeBuddyAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { buildEnv, resolveLaunch } from '../src/launch.js'

const host = {
  defaultDirectory: () => process.cwd(),
  resolveCwd: async () => process.cwd(),
  readTextFile: async (p) => readFile(p, 'utf8'),
  writeTextFile: async () => undefined,
}
const config = resolveConfig({ logLevel: 'info' })
const launch = resolveLaunch(config); launch.env = buildEnv(config.env)
const logger = { info: (m) => process.stderr.write(`[info] ${m}\n`), warn: (m) => process.stderr.write(`[warn] ${m}\n`) }
const adapter = new CodeBuddyAdapter({ config, launch, host, logger })
const model = process.env.CB_MODEL ?? (await adapter.listModels(config.provider))[0].id
console.error('model =', model)

const history = []
async function turn(text) {
  history.push({ role: 'user', content: [{ type: 'text', text }] })
  let answer = ''
  let finish
  for await (const chunk of adapter.stream({ provider: config.provider, model, sessionId: 'twoturn-probe', messages: history, signal: undefined })) {
    if (chunk.type === 'text-delta') answer += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
    else if (chunk.type === 'usage') console.error('usage', JSON.stringify(chunk.usage))
  }
  history.push({ role: 'assistant', content: [{ type: 'text', text: answer }] })
  console.error(`\n--- finish: ${JSON.stringify(finish)}\n--- answer(${answer.length}): ${answer.slice(0,200)}`)
  return finish
}

await turn('用一句话回答：1+1等于几？')
console.error('\n=== SECOND TURN ===')
await turn('那 2+2 呢？')
await adapter.dispose()
