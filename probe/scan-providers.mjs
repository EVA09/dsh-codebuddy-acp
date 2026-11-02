import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2]
const dirs = readdirSync(root).map((name) => ({ name, path: join(root, name) }))
  .map((d) => ({ ...d, mtime: (() => { try { return statSync(join(d.path, 'session.v4.jsonl.zstd')).mtimeMs } catch { return 0 } })() }))
  .filter((d) => d.mtime > 0)
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, 25)

for (const dir of dirs) {
  let text
  try { text = zstdDecompressSync(readFileSync(join(dir.path, 'session.v4.jsonl.zstd'))).toString('utf8') } catch { continue }
  const providers = new Set()
  let codebuddyTurns = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type === 'request/header' && rec.data?.header?.config?.provider) providers.add(rec.data.header.config.provider)
  }
  console.log(dir.name.slice(0, 46), new Date(dir.mtime).toISOString().slice(0,16), [...providers].join(','))
}
