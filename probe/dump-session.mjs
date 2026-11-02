import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
const p = process.argv[2]
const buf = readFileSync(p)
const raw = zlib.zstdDecompressSync(buf).toString('utf8')
const lines = raw.split('\n').filter(Boolean)
console.log('lines', lines.length)
const types = new Map()
for (const line of lines) {
  try { const e = JSON.parse(line); const t = e.type ?? '?'; types.set(t, (types.get(t)??0)+1) } catch {}
}
console.log([...types.entries()].sort((a,b)=>b[1]-a[1]).slice(0,40))
