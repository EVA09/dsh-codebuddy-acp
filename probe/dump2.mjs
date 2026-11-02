import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
const p = process.argv[2]
const filter = process.argv[3]
const raw = zlib.zstdDecompressSync(readFileSync(p)).toString('utf8')
for (const line of raw.split('\n')) {
  if (!line) continue
  let e
  try { e = JSON.parse(line) } catch { continue }
  const t = e.type
  if (filter && t !== filter) continue
  const s = JSON.stringify(e)
  console.log(s.length > 400 ? s.slice(0, 400) + `…(${s.length})` : s)
}
