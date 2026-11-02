import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
const root = process.argv[2]
const walk=(d,out=[])=>{for(const e of readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p,out);else if(e.name.endsWith('.zstd'))out.push(p)}return out}
for (const f of walk(root)) {
  let raw; try { raw = zlib.zstdDecompressSync(readFileSync(f)).toString('utf8') } catch { continue }
  if (!raw.includes('"provider":"codebuddy"')) continue
  const lines = raw.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)
  const users = lines.filter(l=>l.type==='user/message' && l.data?.source?.kind==='user')
  const ends = lines.filter(l=>l.type==='turn/end')
  const err = ends.filter(e=>e.data?.reason?.kind==='error' || e.data?.reason?.kind==='aborted')
  console.log(`\n== ${path.basename(path.dirname(f))}  用户消息=${users.length} turn/end=${ends.length}`)
  for (const e of ends) console.log(`   turn ${e.data?.turn}: ${JSON.stringify(e.data?.reason).slice(0,220)}`)
}
