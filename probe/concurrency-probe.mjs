// 实测：**单进程** `codebuddy --acp` 的「多会话并发」行为
//
// 结论导向的探针，设计如下：
//   · 每个场景新起一个 codebuddy --acp 进程，场景之间不共享状态。
//   · 惰性鉴权：先 session/new；只有返回 -32000 / data.category==="auth" 才
//     调一次 authenticate({methodId:"internal"})，超时 120s。绝不碰 iOA/external/selfhosted。
//   · 每个会话用**唯一的标记词**（苹果/香蕉/橙子/葡萄），因此可以判定
//     「收到的正文到底属于哪条会话」——这是检验串流最硬的证据。
//   · 除线上帧之外，还按字节偏移量抓取 CLI 自己的日志（Session switched /
//     Executing prompt / Prompt completed），用于交叉验证「是否串行」。
//
// 场景：
//   baseline   1 会话，单 prompt（对照：确认这套 prompt 本身能跑完）
//   multi-seq  A/B/C 三条会话都建好，但**顺序**单发 prompt（对照：排除并发因素）
//   two        A/B 并发 prompt
//   two-cancel A/B 并发，6s 后对 A 发 session/cancel
//   three      A/B/C 三路并发
//
// 用法：node probe/concurrency-probe.mjs
// 产物：probe/out/concurrency.jsonl（合并原始帧，带 scenario 字段）
//       probe/out/concurrency.summary.json（结构化结论）
//       probe/out/concurrency-cli-log.txt（从 CLI 日志抽取的关键行）
//       probe/out/concurrency-<scene>.jsonl（分场景原始帧）
// 安全：只操作本脚本 spawn 的 ACP 进程；每个场景结束 stop()（Windows 用 taskkill /T /F）。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { AcpClient } from './lib/acp-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const WORK = path.join(HERE, 'work');
const NAME = 'concurrency';
fs.mkdirSync(WORK, { recursive: true });

const CLIENT_CAPS = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  auth: { terminal: false },
};
const CLIENT_INFO = { name: 'dsh-concurrency-probe', title: 'DSH Concurrency Probe', version: '0.0.3' };

const AUTH_TIMEOUT = 120000; // 只允许 internal，120s
const BASELINE_TIMEOUT = 90000;
const PROMPT_TIMEOUT = 60000; // 正常应 10~20s 完成；超过即判「未返回」
const CANCEL_DELAY = 6000;
const LIST_N = 150; // 行数：这个模型约 10~20s 才写得完

// 标记词：每条会话一个，用来判定正文归属
const MARK = { A: '苹果', B: '香蕉', C: '橙子', D: '葡萄' };
const MARK_ORDER = ['A', 'B', 'C', 'D'];

function taskText(mark, n = LIST_N) {
  return (
    `请严格逐行输出从 1 到 ${n} 的清单，每行格式固定为「<序号>. ${mark} 累计=<1..序号之和>」，` +
    `例如第 3 行是「3. ${mark} 累计=6」。每个累计值都要真实计算，不许估算。` +
    `必须写全 ${n} 行，不许省略、不许用省略号、不许合并成段落，前后不要加任何解释。`
  );
}

function countCodebuddyProcs() {
  try {
    const outp = execFileSync(
      'powershell',
      ['-NoProfile', '-Command',
        "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*codebuddy*' }; ($p | Measure-Object).Count"],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    ).trim();
    const n = Number(outp);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

/** 找 cwd 对应的 CLI 日志文件：<cwd-basename>__<hash>.log */
function findCliLog() {
  const dir = path.join(process.env.USERPROFILE || '', '.codebuddy', 'logs');
  const today = new Date().toISOString().slice(0, 10);
  const todayDir = path.join(dir, today);
  const candidates = [];
  const scan = (d) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.log')) candidates.push(path.join(d, f));
  };
  scan(todayDir);
  if (!candidates.length) {
    if (!fs.existsSync(dir)) return null;
    for (const sub of fs.readdirSync(dir)) scan(path.join(dir, sub));
  }
  const want = `${path.basename(WORK)}__`;
  const hits = candidates.filter((c) => path.basename(c).startsWith(want));
  const pick = (hits.length ? hits : candidates).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return pick[0] ?? null;
}

const CLI_LINE_RE = /Session switched|Executing prompt|Prompt completed|Ignoring cancel|received cancel request|PromptIterator|Sending request: agent=cli|Stream completed: agent=cli|finish_reason="stop"/;

/** 从 pos 开始读新增日志行，返回关键行 */
function readCliLogDelta(logPath, pos) {
  if (!logPath || !fs.existsSync(logPath)) return { lines: [], newPos: pos };
  const size = fs.statSync(logPath).size;
  if (size <= pos) return { lines: [], newPos: size };
  const fd = fs.openSync(logPath, 'r');
  const len = size - pos;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, pos);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').filter((l) => l.trim() && CLI_LINE_RE.test(l));
  return { lines, newPos: size };
}

// ---------------------------------------------------------------- 排版
function width(s) {
  let n = 0;
  for (const ch of String(s)) {
    n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  }
  return n;
}
function pad(s, n) {
  s = String(s ?? '');
  return s + ' '.repeat(Math.max(0, n - width(s)));
}
const rowCells = (cells, widths) => cells.map((c, i) => pad(c, widths[i])).join(' | ');

// ---------------------------------------------------------------- 场景
class Scene {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.timeout = spec.timeout ?? PROMPT_TIMEOUT;
    this.out = { scenario: name, desc: spec.desc, startedAt: new Date().toISOString(), sessions: [], turns: [], notes: [] };
    this.client = new AcpClient({
      outDir: OUT,
      name: `${NAME}-${name}`,
      cwd: WORK,
      timeout: 120000,
      permissionPolicy: 'allow_once',
      args: ['--acp'],
    });
    this.updates = [];
    this.otherNotifs = [];
    this.afterResult = [];
    this.turns = [];
    this.client.notifyHandler = (m, p) => this.onNotify(m, p);
  }

  onNotify(method, params) {
    const t = this.client.elapsed();
    if (method !== 'session/update') {
      this.otherNotifs.push({ t, method, action: params?.action ?? null, sessionId: params?.sessionId ?? null });
      return;
    }
    const p = params || {};
    const rec = { t, sessionId: p.sessionId ?? null, update: p.update || {} };
    this.updates.push(rec);
    const tr = this.turns.find((x) => !x.done && x.requestSessionId === rec.sessionId);
    const trAny = tr ?? this.turns.find((x) => !x.done);
    if (trAny) {
      trAny.updates.push(rec);
      if (trAny.firstUpdateT === null) trAny.firstUpdateT = t;
      const v = rec.update.sessionUpdate;
      if (trAny.firstContentT === null && (v === 'agent_message_chunk' || v === 'agent_thought_chunk' || v === 'tool_call')) {
        trAny.firstContentT = t;
      }
      trAny.lastUpdateT = t;
    } else {
      this.afterResult.push({ t, sessionId: rec.sessionId, variant: rec.update.sessionUpdate });
    }
  }

  frameT(id, dir) {
    const r = this.client.records;
    for (let i = r.length - 1; i >= 0; i--) {
      const x = r[i];
      if (x.dir !== dir || x.msg?.id !== id) continue;
      if (dir === 'out' && !x.msg.method) continue;
      return x.t;
    }
    return null;
  }

  fire(label, sessionId) {
    const tr = {
      label,
      requestSessionId: sessionId,
      mark: MARK[label],
      sentT: this.client.elapsed(),
      firstUpdateT: null,
      firstContentT: null,
      lastUpdateT: null,
      resultT: null,
      stopReason: null,
      responseSessionId: null,
      error: null,
      updates: [],
      done: false,
      cancelSentT: null,
    };
    this.turns.push(tr);
    const rid = this.client.nextId;
    tr.requestId = rid;
    tr.promise = this.client
      .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: taskText(MARK[label]) }] }, { timeout: this.timeout })
      .then((res) => {
        tr.result = res ?? null;
        tr.stopReason = res?.stopReason ?? null;
        const bg = res?._meta?.baggage;
        const m = typeof bg === 'string' && bg.match(/codebuddy\.session_id=([0-9a-f-]+)/);
        tr.responseSessionId = m ? m[1] : null;
      })
      .catch((e) => (tr.error = { message: e.message, rpcError: e.rpcError ?? null }))
      .finally(() => {
        tr.done = true;
        tr.resultT = this.frameT(rid, 'in');
        const o = this.frameT(rid, 'out');
        if (o != null) tr.sentT = o;
      });
    return tr;
  }

  /** 统计每轮最终文本落在哪个 sessionId 桶里（用标记词判定归属） */
  digest(tr) {
    const variants = {};
    const phases = [];
    let ownChars = 0;
    let thoughtChars = 0;
    let tools = 0;
    for (const x of tr.updates) {
      const u = x.update;
      variants[u.sessionUpdate] = (variants[u.sessionUpdate] || 0) + 1;
      const ph = u._meta?.['codebuddy.ai/agentPhase']?.phase;
      if (ph && phases.at(-1)?.phase !== ph) phases.push({ t: x.t, phase: ph });
      if (u.sessionUpdate === 'agent_message_chunk') {
        const txt = u.content?.text ?? '';
        ownChars += txt.length;
        if (txt.includes(tr.mark)) tr.textHits = (tr.textHits || 0) + 1;
      }
      if (u.sessionUpdate === 'agent_thought_chunk') thoughtChars += (u.content?.text ?? '').length;
      if (u.sessionUpdate === 'tool_call') tools++;
    }
    // 这一轮真正收到的正文里，出现过哪些标记词
    let aggText = '';
    for (const x of tr.updates) {
      if (x.update.sessionUpdate === 'agent_message_chunk') aggText += x.update.content?.text ?? '';
    }
    const markSeen = MARK_ORDER.filter((k) => aggText.includes(MARK[k]));
    return {
      label: tr.label,
      requestedSessionShort: tr.requestSessionId?.slice(-8) ?? null,
      responseSessionShort: tr.responseSessionId?.slice(-8) ?? null,
      misrouted: tr.responseSessionId ? tr.responseSessionId !== tr.requestSessionId : null,
      sentT: tr.sentT,
      firstUpdateT: tr.firstUpdateT,
      firstContentT: tr.firstContentT,
      resultT: tr.resultT,
      durationMs: tr.resultT != null ? tr.resultT - tr.sentT : null,
      firstUpdateDelayMs: tr.firstUpdateT != null ? tr.firstUpdateT - tr.sentT : null,
      stopReason: tr.stopReason,
      returned: tr.resultT != null,
      error: tr.error,
      updateCount: tr.updates.length,
      variants,
      phaseTimeline: phases,
      textChars: ownChars,
      thoughtChars,
      toolCalls: tools,
      expectedMark: tr.mark,
      marksPresentInThisTurn: markSeen,
      ownMarkPresent: markSeen.includes(tr.label),
      receivedForeignMarks: markSeen.filter((k) => k !== tr.label),
      cancelSentT: tr.cancelSentT,
      result: tr.result,
    };
  }

  /** 事后按 sessionId 分桶，看每个桶里出现了哪些标记词（判定串流） */
  bucketMarks() {
    const per = {};
    for (const u of this.updates) {
      const sid = u.sessionId;
      if (!sid) continue;
      const b = (per[sid] ||= { updates: 0, marks: new Set(), ticks: [] });
      b.updates++;
      if (u.update.sessionUpdate === 'agent_message_chunk') {
        const t = u.update.content?.text ?? '';
        for (const k of MARK_ORDER) if (t.includes(MARK[k])) b.marks.add(k);
      }
      b.ticks.push(u.t);
    }
    return Object.fromEntries(
      Object.entries(per).map(([sid, b]) => [
        sid,
        { short: sid.slice(-8), updates: b.updates, marks: [...b.marks], firstT: Math.min(...b.ticks), lastT: Math.max(...b.ticks) },
      ]),
    );
  }

  async run() {
    const c = this.client;
    const o = this.out;
    c.start();
    o.spawnPid = c.child?.pid ?? null;

    const logPath = this.spec.logPath ?? null;
    o.cliLog = logPath ? { path: logPath, startOffset: logPath && fs.existsSync(logPath) ? fs.statSync(logPath).size : 0 } : null;
    const startOffset = o.cliLog?.startOffset ?? 0;

    console.log(`\n\n########## 场景 ${this.name} · ${this.spec.desc} ##########`);
    console.log(`[spawn] codebuddy --acp pid=${o.spawnPid} cwd=${WORK}`);

    const initReq = { protocolVersion: 1, clientCapabilities: CLIENT_CAPS, clientInfo: CLIENT_INFO };
    o.initialize = await c.request('initialize', initReq, { timeout: 180000 });
    console.log(`[+${c.elapsed()}ms] initialize ok`);

    const MK = { cwd: WORK, mcpServers: [] };
    const addSession = async (label) => {
      const s = await c.request('session/new', MK, { timeout: 180000 });
      o.sessions.push({ label, sessionId: s.sessionId, currentModelId: s.models?.currentModelId ?? null, currentModeId: s.modes?.currentModeId ?? null });
      console.log(`[+${c.elapsed()}ms] session/new ${label} → ${s.sessionId}`);
      return s.sessionId;
    };

    // 惰性鉴权
    let sids = {};
    try {
      sids.A = await addSession('A');
    } catch (e) {
      if (e.rpcError?.code !== -32000 && e.rpcError?.data?.category !== 'auth') throw e;
      o.auth = { needed: true, trigger: { code: e.rpcError.code, data: e.rpcError.data } };
      console.log(`[+${c.elapsed()}ms] session/new 需要鉴权 → authenticate({methodId:"internal"})（禁用 iOA/external/selfhosted）`);
      const at = c.elapsed();
      const a = await c.request('authenticate', { methodId: 'internal' }, { timeout: AUTH_TIMEOUT });
      o.auth.internal = { ok: true, durationMs: c.elapsed() - at, userinfo: a?._meta?.['codebuddy.ai/userinfo'] ?? null };
      console.log(`[+${c.elapsed()}ms] authenticate(internal) ok ${JSON.stringify(o.auth.internal.userinfo)}`);
      sids.A = await addSession('A');
    }
    if (!o.auth) o.auth = { needed: false, note: 'session/new 直接成功，未调用 authenticate' };

    for (const l of this.spec.sessions.filter((x) => x !== 'A')) sids[l] = await addSession(l);

    // 发 prompt：sequential = 一条一条等；parallel = 同时发
    const plan = this.spec.plan; // [{label, session, waitPrev}]
    console.log(`[+${c.elapsed()}ms] prompt 计划: ${plan.map((p) => `${p.label}${p.waitPrev ? '(等前一条)' : '(并行)'}`).join(' ')}`);

    const fired = [];
    const started = c.elapsed();
    for (const p of plan) {
      if (p.waitPrev && fired.length) await Promise.all(fired.map((x) => x.promise));
      const tr = this.fire(p.label, sids[p.session]);
      fired.push(tr);
      if (this.spec.cancelLabel && p.label === this.spec.cancelLabel) {
        const self = tr;
        self.cancelPlan = { delayMs: CANCEL_DELAY };
        setTimeout(() => {
          self.cancelSentT = c.elapsed();
          c.notify('session/cancel', { sessionId: self.requestSessionId });
          console.log(`[+${self.cancelSentT}ms] >>> session/cancel {sessionId=${p.session}}（该轮此时 ${self.updates.length} 条 update）`);
        }, CANCEL_DELAY);
      }
    }

    await Promise.all(fired.map((t) => t.promise));
    o.wallMs = c.elapsed() - started;
    o.turns = fired.map((t) => this.digest(t));
    o.bucketMarks = this.bucketMarks();

    // 串流 / 分桶汇总
    const known = new Set(o.sessions.map((s) => s.sessionId));
    const bucketCount = {};
    for (const sid of known) bucketCount[sid.slice(-8)] = 0;
    for (const u of this.updates) if (u.sessionId && bucketCount[u.sessionId.slice(-8)] != null) bucketCount[u.sessionId.slice(-8)]++;
    o.crossStream = {
      totalUpdates: this.updates.length,
      updatesPerSession: bucketCount,
      unknownSessionIdUpdates: this.updates.filter((u) => !u.sessionId || !known.has(u.sessionId)).length,
      bucketsWithMultipleMarks: Object.values(o.bucketMarks).filter((b) => b.marks.length > 1),
      turnsReceivingForeignMarks: o.turns.filter((t) => t.receivedForeignMarks.length),
      updatesAfterAllResults: this.afterResult.length,
      nonUpdateNotifications: this.otherNotifs.map((n) => ({ t: n.t, method: n.method, action: n.action, sessionShort: n.sessionId?.slice(-8) ?? null })),
    };

    // CLI 日志交叉验证
    o.cliLogDelta = readCliLogDelta(logPath, startOffset);
    this.cliLogLines = o.cliLogDelta.lines;
  }
}

// ---------------------------------------------------------------- 主流程
const report = {
  name: NAME,
  startedAt: new Date().toISOString(),
  cli: { command: 'codebuddy --acp', cwd: WORK, version: null },
  authPolicy: '仅 methodId="internal"，惰性触发（仅当 session/new 返回 -32000/auth）',
  marks: MARK,
  promptTemplate: taskText('<mark>'),
  procsBefore: null,
  scenes: {},
  cliLogPath: null,
  cleanup: [],
};

try {
  report.cli.version = execFileSync('codebuddy', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: 'pipe' }).trim();
} catch (e) {
  report.cli.version = null;
  report.cli.versionError = e.message;
}
report.cliLogPath = findCliLog();
report.procsBefore = countCodebuddyProcs();
console.log(`codebuddy --version = ${report.cli.version}`);
console.log(`CLI 日志 = ${report.cliLogPath}`);
console.log(`运行前 codebuddy 相关 node 进程 = ${report.procsBefore}`);

const SCENES = [
  { name: 'baseline', sessions: ['A'], plan: [{ label: 'A', session: 'A' }], timeout: BASELINE_TIMEOUT, desc: '对照：单会话单 prompt' },
  { name: 'multi-seq', sessions: ['A', 'B', 'C'], plan: [{ label: 'A', session: 'A' }, { label: 'B', session: 'B', waitPrev: true }, { label: 'C', session: 'C', waitPrev: true }], timeout: BASELINE_TIMEOUT, desc: '对照：建 3 会话，顺序单发（无并发）' },
  { name: 'two', sessions: ['A', 'B', 'C'], plan: [{ label: 'A', session: 'A' }, { label: 'B', session: 'B' }], desc: 'A/B 两条会话并发' },
  { name: 'two-cancel', sessions: ['A', 'B'], plan: [{ label: 'A', session: 'A' }, { label: 'B', session: 'B' }], cancelLabel: 'A', desc: 'A/B 并发，6s 后 cancel A' },
  { name: 'three', sessions: ['A', 'B', 'C'], plan: [{ label: 'A', session: 'A' }, { label: 'B', session: 'B' }, { label: 'C', session: 'C' }], desc: 'A/B/C 三路并发' },
];

const cliLogDump = [];

for (const spec of SCENES) {
  const scene = new Scene(spec.name, spec);
  scene.spec.logPath = report.cliLogPath;
  let fatal = null;
  try {
    await scene.run();
    scene.out.status = 'completed';
  } catch (e) {
    fatal = { message: e.message, rpcError: e.rpcError ?? null, atMs: scene.client.elapsed() };
    scene.out.status = 'failed';
    scene.out.errors = [fatal];
    console.error(`\n!! 场景 ${spec.name} 失败: ${e.message} ${JSON.stringify(e.rpcError ?? {})}`);
  }
  await scene.client.stop();
  await new Promise((x) => setTimeout(x, 400));
  scene.out.stop = {
    exit: scene.client.exit,
    stderrBytes: scene.client.stderrText.length,
    stdoutPollutedLines: scene.client.stdoutRawNonJson.length,
    procsAfterStop: countCodebuddyProcs(),
    jsonl: scene.client.jsonlPath,
  };
  console.log(`[cleanup] exit=${JSON.stringify(scene.client.exit)} stderr=${scene.out.stop.stderrBytes}B stdout污染=${scene.out.stop.stdoutPollutedLines}B 残留codebuddy进程=${scene.out.stop.procsAfterStop}`);
  report.scenes[spec.name] = scene.out;
  report.cleanup.push({ scenario: spec.name, pid: scene.out.spawnPid, exit: scene.client.exit, procsAfterStop: scene.out.stop.procsAfterStop });

  if (scene.cliLogLines?.length) {
    cliLogDump.push(`\n########## ${spec.name} ##########`);
    for (const l of scene.cliLogLines) cliLogDump.push(l);
  }
}

// ---------------------------------------------------------------- 合并帧 + 落盘
const mergedPath = path.join(OUT, `${NAME}.jsonl`);
fs.writeFileSync(mergedPath, '');
let mergedLines = 0;
for (const spec of SCENES) {
  const f = path.join(OUT, `${NAME}-${spec.name}.jsonl`);
  if (!fs.existsSync(f)) continue;
  const buf = fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.stringify({ scenario: spec.name, ...JSON.parse(l) });
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  fs.appendFileSync(mergedPath, buf.join('\n') + '\n');
  mergedLines += buf.length;
}
const cliLogPathOut = path.join(OUT, `${NAME}-cli-log.txt`);
fs.writeFileSync(cliLogPathOut, cliLogDump.join('\n') + '\n');

// ---------------------------------------------------------------- 结论表
const W = [10, 4, 9, 7, 11, 9, 9, 10, 8, 9, 8, 11];
const HEAD = ['场景', '会话', '发出ms', '请求sid', '响应sid', '首帧ms', 'result', 'stopReason', 'updates', '正文长度', '轮内标记', '别名判定'];

console.log('\n\n================ 结论总表（时刻=进程启动后 ms；所有会话都建好后才发 prompt）================');
for (const spec of SCENES) {
  const sc = report.scenes[spec.name];
  if (!sc) continue;
  console.log(`\n--- ${spec.name}: ${spec.desc} ---`);
  console.log(rowCells(HEAD, W));
  console.log(W.map((n) => '-'.repeat(n)).join('-+'));
  for (const t of sc.turns || []) {
    console.log(
      rowCells(
        [
          spec.name,
          t.label,
          t.sentT ?? '?',
          t.requestedSessionShort ?? '-',
          t.responseSessionShort ?? (t.returned ? '?' : '无响应'),
          t.firstUpdateT ?? '无',
          t.resultT ?? '未返回',
          t.stopReason ?? (t.error ? (t.error.rpcError?.code ?? 'timeout') : 'timeout'),
          t.updateCount,
          t.textChars,
          t.marksPresentInThisTurn.join('') || '无正文',
          t.misrouted === null ? '无法判定' : t.misrouted ? '❌ 请求会话≠响应会话' : 'ok',
        ],
        W,
      ),
    );
  }
  console.log(`  每桶（sessionId 尾8位）收到的 update 数与出现的标记词:`);
  for (const [sid, b] of Object.entries(sc.bucketMarks || {})) {
    console.log(`    ${b.short}: updates=${b.updates} 标记=[${b.marks.join(',') || '-'}] 时间窗=${b.firstT}~${b.lastT}`);
  }
  const cs = sc.crossStream || {};
  console.log(`  串流判定: 一桶多标记=${cs.bucketsWithMultipleMarks?.length ?? 0} 例 ${JSON.stringify(cs.bucketsWithMultipleMarks ?? [])}`);
  if (sc.cliLogDelta?.lines?.length) {
    console.log(`  CLI 日志关键行（共 ${sc.cliLogDelta.lines.length} 条，节选）:`);
    for (const l of sc.cliLogDelta.lines.slice(0, 12)) console.log(`    ${l}`);
  }
  console.log(`  清理: exit=${JSON.stringify(sc.stop?.exit)} 残留codebuddy进程=${sc.stop?.procsAfterStop}`);
}

report.mergedJsonl = { path: mergedPath, lines: mergedLines };
report.cliLogExtract = cliLogPathOut;
report.procsAfterAll = countCodebuddyProcs();
report.finishedAt = new Date().toISOString();
const summaryPath = path.join(OUT, `${NAME}.summary.json`);
fs.writeFileSync(summaryPath, JSON.stringify(report, null, 2));

console.log(`\n================ 清理核对 ================`);
console.log(`运行前=${report.procsBefore} 全部结束=${report.procsAfterAll}（应为同一基线数，多出来即为残留）`);
console.log(`[summary] -> ${summaryPath}`);
console.log(`[jsonl]   -> ${mergedPath} (${mergedLines} 帧)`);
console.log(`[cli-log] -> ${cliLogPathOut}`);
process.exit(0);
