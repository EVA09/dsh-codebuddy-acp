import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const p = process.argv[2]
const raw = readFileSync(p)
const text = zstdDecompressSync(raw).toString('utf8')
const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log('lines', lines.length)
for (const line of lines) {
  const rec = JSON.parse(line)
  const t = rec.type ?? rec.event?.type
  console.log(t, JSON.stringify(rec).slice(0, 120))
}
