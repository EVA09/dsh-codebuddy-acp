import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
const p = process.argv[2]
const raw = zlib.zstdDecompressSync(readFileSync(p)).toString('utf8')
for (const line of raw.split('\n')) {
  if (!line) continue
  let e; try { e = JSON.parse(line) } catch { continue }
  if (e.type !== 'request/header') continue
  const s = JSON.stringify(e.data)
  console.log(e.seq, s.slice(0, 600))
}
