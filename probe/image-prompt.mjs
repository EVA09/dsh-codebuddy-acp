/**
 * 实测：ACP `session/prompt` 里带 `{type:'image', data, mimeType}` 内容块，CodeBuddy 是否接受、
 * 模型是否真的「看见」图片。
 *
 * 背景：src/adapter.js 目前把图片降级成文本占位符 `[图片附件：xxx]`，图片从未到达 CodeBuddy。
 * 本脚本绕过插件，直接用 probe/lib/acp-client.mjs 以「裸客户端」身份发图，取真实协议证据。
 *
 * 用法：
 *   node probe/image-prompt.mjs            # 跑全部场景
 *   node probe/image-prompt.mjs text-first # 只跑某个场景
 *
 * 产出：
 *   probe/out/image-prompt.<scenario>.jsonl      原始双向帧（含 base64 出站帧）
 *   probe/out/image-prompt.summary.json          各场景结论摘要
 *   probe/out/red-64x64.png                      本次使用的纯红色测试图
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { AcpClient } from './lib/acp-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const WORK = path.join(HERE, 'work');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const PROMPT_TIMEOUT = 180_000;
const CLIENT_CAPS = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  auth: { terminal: false },
};
const CLIENT_INFO = { name: 'dsh-acp-image-probe', title: 'ACP Image Probe', version: '0.0.1' };

// ---------------------------------------------------------------------------
// 1) 纯 Node 手写一张 64x64 纯红色 PNG（不依赖任何第三方库 / 系统图形栈）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** @returns {Buffer} 一张 width×height 的纯色 PNG */
function makeSolidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行：1 字节 filter(=0 None) + width*3 字节 RGB
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const base = y * stride;
    raw[base] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = base + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const pngPath = path.join(OUT, 'red-64x64.png');
const pngBuf = makeSolidPng(64, 64, [255, 0, 0]);
fs.writeFileSync(pngPath, pngBuf);
// 规范 base64：无换行、无前缀
const pngB64 = pngBuf.toString('base64');
console.log(`[png] ${pngPath} bytes=${pngBuf.length} base64Len=${pngB64.length}`);

// 蓝色图：用来排除「红色是模型的默认猜测」
const bluePath = path.join(OUT, 'blue-64x64.png');
const blueBuf = makeSolidPng(64, 64, [0, 0, 255]);
fs.writeFileSync(bluePath, blueBuf);
const blueB64 = blueBuf.toString('base64');
console.log(`[png] ${bluePath} bytes=${blueBuf.length} base64Len=${blueB64.length}`);

// 自检：把自己写的 IDAT 解回来，确认像素确实是纯红（防「PNG 写坏了」导致的假阴性）
{
  const idatStart = pngBuf.indexOf(Buffer.from('IDAT', 'ascii')) + 4;
  const idatLen = pngBuf.readUInt32BE(idatStart - 8);
  const inflated = zlib.inflateSync(pngBuf.subarray(idatStart, idatStart + idatLen));
  const px = (x, y) => {
    const base = y * (64 * 3 + 1) + 1 + x * 3;
    return [inflated[base], inflated[base + 1], inflated[base + 2]];
  };
  console.log(
    `[png-selfcheck] inflated=${inflated.length}B px(0,0)=${px(0, 0)} px(32,32)=${px(32, 32)} px(63,63)=${px(63, 63)}`,
  );
}

// ---------------------------------------------------------------------------
// 2) 场景定义
// ---------------------------------------------------------------------------

const QUESTION = '这张图片是什么颜色？只回答一个词。';

const IMAGES = {
  red: { path: pngPath, b64: pngB64, expect: /红|red/i, label: '红' },
  blue: { path: bluePath, b64: blueB64, expect: /蓝|blue/i, label: '蓝' },
};

const imageBlock = (color = 'red') => ({ type: 'image', data: IMAGES[color].b64, mimeType: 'image/png' });
const textBlock = () => ({ type: 'text', text: QUESTION });

const SCENARIOS = [
  {
    name: 'text-then-image',
    desc: 'text 在前、image 在后（插件修好后最可能的顺序）+ 纯红色 64x64',
    image: 'red',
    build: () => [textBlock(), imageBlock('red')],
  },
  {
    name: 'image-then-text',
    desc: 'image 在前、text 在后（对照组）+ 纯红色 64x64',
    image: 'red',
    build: () => [imageBlock('red'), textBlock()],
  },
  {
    name: 'blue-image',
    desc: '换纯蓝色 64x64，排除「红色恰好是默认猜测」',
    image: 'blue',
    build: () => [textBlock(), imageBlock('blue')],
  },
  {
    name: 'text-only-control',
    desc: '阴性对照：完全不带图，同样的问题。若它也说「红色」则说明前面的答案不可信',
    image: null,
    build: () => [textBlock()],
  },
  {
    name: 'image-uri-only',
    desc: '对照探针：只给 uri、不给 data（预期被拒或模型看不见）',
    image: null,
    build: () => [
      textBlock(),
      { type: 'image', uri: new URL(`file:///${pngPath.replace(/\\/g, '/')}`).href },
    ],
  },
];

// ---------------------------------------------------------------------------
// 3) 跑一个场景
// ---------------------------------------------------------------------------

function summarizeUpdates(updates) {
  const byKind = {};
  for (const u of updates) byKind[u.sessionUpdate] = (byKind[u.sessionUpdate] || 0) + 1;
  return byKind;
}

function collectAgentText(updates) {
  return updates
    .filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map((u) => (typeof u.content?.text === 'string' ? u.content.text : ''))
    .join('');
}

function collectThoughtText(updates) {
  return updates
    .filter((u) => u.sessionUpdate === 'agent_thought_chunk')
    .map((u) => (typeof u.content?.text === 'string' ? u.content.text : ''))
    .join('');
}

async function runScenario(scenario) {
  console.log(`\n${'='.repeat(78)}\n== 场景 ${scenario.name}：${scenario.desc}\n${'='.repeat(78)}`);
  const client = new AcpClient({
    outDir: OUT,
    name: `image-prompt.${scenario.name}`,
    cwd: WORK,
    timeout: PROMPT_TIMEOUT,
    permissionPolicy: 'allow_once',
  });

  const result = {
    scenario: scenario.name,
    desc: scenario.desc,
    startedAt: new Date().toISOString(),
    png: { path: pngPath, bytes: pngBuf.length, base64Len: pngB64.length },
  };

  client.start();
  try {
    // ---- initialize ----
    const initReq = { protocolVersion: 1, clientCapabilities: CLIENT_CAPS, clientInfo: CLIENT_INFO };
    const initRes = await client.request('initialize', initReq, { timeout: 60_000 });
    result.initialize = {
      promptCapabilities: initRes?.agentCapabilities?.promptCapabilities,
      authMethods: (initRes?.authMethods ?? []).map((m) => m?.id),
    };
    console.log('[initialize] promptCapabilities =', JSON.stringify(result.initialize.promptCapabilities));

    // ---- session/new（惰性鉴权：只有 -32000 auth 才补 authenticate）----
    let sessionId;
    try {
      const s = await client.request('session/new', { cwd: WORK, mcpServers: [] }, { timeout: 60_000 });
      sessionId = s.sessionId;
      result.sessionNew = { ok: true, sessionId, models: s?.models?.currentModelId ?? s?.models };
    } catch (error) {
      const category = String(error?.rpcError?.data?.category ?? '');
      if (category !== 'auth') throw error;
      const methods = initRes?.authMethods ?? [];
      const internal = methods.find((m) => String(m?.id ?? '').includes('internal')) ?? methods[0];
      console.log(`[session/new] -32000 auth，补 authenticate ${internal?.id} …`);
      await client.request('authenticate', { methodId: internal.id }, { timeout: 180_000 });
      const s = await client.request('session/new', { cwd: WORK, mcpServers: [] }, { timeout: 60_000 });
      sessionId = s.sessionId;
      result.sessionNew = { ok: true, authRetried: true, sessionId };
    }
    console.log(`[session/new] sessionId=${sessionId}`);

    // ---- 收集 session/update ----
    const updates = [];
    const otherNotifications = [];
    client.notifyHandler = (method, params) => {
      if (method !== 'session/update') {
        otherNotifications.push({ method, params });
        return;
      }
      const u = params?.update ?? {};
      updates.push(u);
      const kind = String(u.sessionUpdate);
      if (kind === 'agent_message_chunk') {
        process.stdout.write(u.content?.text ?? '');
      } else if (kind === 'agent_thought_chunk') {
        process.stdout.write(`[think] ${String(u.content?.text ?? '').slice(0, 200)}\n`);
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        process.stdout.write(`\n[tool] ${kind} ${u.toolCallId ?? ''} ${u.title ?? ''}\n`);
      }
    };

    // ---- prompt ----
    const prompt = scenario.build();
    console.log(
      `[prompt] blocks=${JSON.stringify(prompt.map((b) => (b.type === 'image' ? { type: 'image', mimeType: b.mimeType ?? null, hasData: typeof b.data === 'string', dataLen: b.data?.length ?? 0, uri: b.uri ?? null } : { type: b.type, text: b.text })))}`,
    );

    const t0 = Date.now();
    process.stdout.write('\n[agent] ');
    let promptResult = null;
    let promptError = null;
    try {
      promptResult = await client.request(
        'session/prompt',
        { sessionId, prompt },
        { timeout: PROMPT_TIMEOUT },
      );
    } catch (error) {
      promptError = { message: error?.message, rpcError: error?.rpcError ?? null };
    }
    const durationMs = Date.now() - t0;
    process.stdout.write('\n');

    result.prompt = {
      durationMs,
      result: promptResult,
      error: promptError,
      updateKinds: summarizeUpdates(updates),
      agentText: collectAgentText(updates),
      thoughtText: collectThoughtText(updates).slice(0, 2000),
      otherNotifications,
    };

    const answerText = result.prompt.agentText.trim();
    if (promptError) result.verdict = 'REJECTED_BY_PROTOCOL';
    else if (answerText === '') result.verdict = 'ACCEPTED_BUT_EMPTY_TEXT';
    else if (scenario.image === null) result.verdict = 'CONTROL_NO_IMAGE';
    else result.verdict = IMAGES[scenario.image].expect.test(answerText) ? 'SAW_IMAGE' : 'SAW_WRONG_COLOR';

    console.log(`[prompt] ${promptError ? 'ERROR' : 'OK'} durationMs=${durationMs}`);
    if (promptError) console.log(`[prompt] error=${JSON.stringify(promptError)}`);
    else console.log(`[prompt] result=${JSON.stringify(promptResult)}`);
    console.log(`[verdict] ${result.verdict} | agentText=${JSON.stringify(result.prompt.agentText)}`);
  } catch (error) {
    result.fatal = { message: error?.message, rpcError: error?.rpcError ?? null };
    console.error(`[fatal] ${error?.message} ${JSON.stringify(error?.rpcError ?? {})}`);
  } finally {
    await client.stop();
    result.client = client.summary();
  }
  return result;
}

// ---------------------------------------------------------------------------
// 4) 主流程
// ---------------------------------------------------------------------------

const only = process.argv[2];
const selected = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
if (selected.length === 0) {
  console.error(`未知场景 ${only}，可选：${SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

const results = [];
for (const scenario of selected) {
  // 顺序执行：每个场景独立进程 + 独立 session，避免上一个场景污染状态
  results.push(await runScenario(scenario));
}

const summaryPath = path.join(OUT, 'image-prompt.summary.json');
await fsp.writeFile(summaryPath, JSON.stringify({ png: pngPath, scenarios: results }, null, 2), 'utf8');

console.log(`\n${'='.repeat(78)}\n== 总结\n${'='.repeat(78)}`);
for (const r of results) {
  console.log(
    `${r.scenario.padEnd(16)} verdict=${String(r.verdict).padEnd(22)} ` +
      `err=${r.prompt?.error ? JSON.stringify(r.prompt.error.rpcError ?? r.prompt.error) : 'none'} ` +
      `text=${JSON.stringify(r.prompt?.agentText ?? '')}`,
  );
}
console.log(`\n[summary] -> ${summaryPath}`);
