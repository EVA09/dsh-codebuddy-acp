import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
const root = process.argv[2]
const walk=(d,out=[])=>{for(const e of readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p,out);else if(e.name.endsWith('.zstd'))out.push(p)}return out}
for (const f of walk(root)) {
  let raw; try { raw = zlib.zstdDecompressSync(readFileSync(f)).toString('utf8') } catch { continue }
  if (!raw.includes('"provider":"codebuddy"')) continue
  const hits = []
  for (const pat of ['EMPTY_RESPONSE','CodeBuddy 调用失败','UNKNOWN_TOOL','ADAPTER_ERROR','PROCESS_EXITED','PROTOCOL','no pending','空','Error']) {
    const n = (raw.split(pat).length - 1)
    if (n > 0) hits.push(`${pat}×${n}`)
  }
  if (hits.length) console.log(`${path.basename(path.dirname(f))}\t${hits.join(', ')}`)
}
