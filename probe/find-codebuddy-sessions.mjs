import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const root = process.argv[2]
const walk = (d, out=[]) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.zstd')) out.push(p)
  }
  return out
}
const files = walk(root)
console.log('files', files.length)
for (const f of files) {
  let raw
  try { raw = zlib.zstdDecompressSync(readFileSync(f)).toString('utf8') } catch { continue }
  const m = raw.match(/"provider":"codebuddy"/g)
  const hasCodebuddy = m ? m.length : 0
  const um = (raw.match(/"type":"user\/message"/g) ?? []).length
  if (hasCodebuddy > 0) console.log(`${hasCodebuddy}\tusers=${um}\t${statSync(f).mtime.toISOString()}\t${f}`)
}
