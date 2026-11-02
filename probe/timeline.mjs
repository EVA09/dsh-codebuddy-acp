import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
const p = process.argv[2]
const raw = zlib.zstdDecompressSync(readFileSync(p)).toString('utf8')
for (const line of raw.split('\n')) {
  if (!line) continue
  let e; try { e = JSON.parse(line) } catch { continue }
  const t = e.type
  if (!['turn/start','turn/end','step/start','step/end','user/message','assistant/message','tool/call','tool/result','session/title','session/end-seed','request/header'].includes(t)) continue
  let brief = ''
  if (t === 'user/message') brief = (e.data?.content ?? []).map(c => c.text ?? '').join('').replace(/\n/g,' ').slice(0, 90)
  if (t === 'assistant/message') brief = JSON.stringify(e.data?.content ?? e.data).slice(0, 120)
  if (t === 'tool/call') brief = `${e.data?.name} ${JSON.stringify(e.data?.arguments ?? '').slice(0,110)}`
  if (t === 'turn/end') brief = JSON.stringify(e.data).slice(0,200)
  if (t === 'step/end') brief = JSON.stringify(e.data).slice(0,150)
  console.log(`${String(e.seq).padStart(4)} ${t}: ${brief}`)
}
