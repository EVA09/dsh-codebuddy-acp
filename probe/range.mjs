import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
const p = process.argv[2]
const from = Number(process.argv[3]); const to = Number(process.argv[4])
const raw = zlib.zstdDecompressSync(readFileSync(p)).toString('utf8')
for (const line of raw.split('\n')) {
  if (!line) continue
  let e; try { e = JSON.parse(line) } catch { continue }
  if (e.seq < from || e.seq > to) continue
  const s = JSON.stringify(e)
  console.log(`${e.seq} ${e.type}: ${s.length>500?s.slice(0,500)+'…('+s.length+')':s}`)
}
