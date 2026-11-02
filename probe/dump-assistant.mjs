import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const p = process.argv[2]
const text = zstdDecompressSync(readFileSync(p)).toString('utf8')
const lines = text.split('\n').filter((l) => l.trim() !== '')
const records = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
for (const rec of records) {
  if (rec.type !== 'assistant/message') continue
  const msg = rec.data?.message ?? {}
  const blocks = (msg.content ?? []).map((b) => {
    const text = typeof b.text === 'string' ? b.text.replace(/\s+/g, ' ').slice(0, 140) : ''
    return `${b.type}(${b.blockType ?? ''}${b.name ? ':' + b.name : ''})[${text}]`
  })
  console.log('step', rec.data?.step, 'blocks:', blocks.join(' | ').slice(0, 900))
  console.log('---')
}
