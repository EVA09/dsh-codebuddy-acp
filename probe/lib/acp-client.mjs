// 极简 ACP 客户端（零第三方依赖）
// 传输：ndjson —— 每行一个 JSON-RPC 2.0 消息，无 Content-Length 头。
// 用途：以「客户端」身份驱动 `codebuddy --acp`，并把双向原始帧落盘成 JSONL。
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const iso = () => new Date().toISOString();

/** 把 argv 拼成一条 Windows cmd 可执行的命令行（供 cmd.exe /c 使用） */
function toCmdLine(cmd, args) {
  const q = (s) => (/[\s"^&|<>]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return [cmd, ...args].map(q).join(' ');
}

export class AcpClient {
  /**
   * @param {object} o
   * @param {string} o.outDir      原始输出目录
   * @param {string} o.name        本次运行名（用于文件名）
   * @param {string} [o.cmd]       启动命令，默认 codebuddy
   * @param {string[]} [o.args]    启动参数，默认 ['--acp']
   * @param {string} [o.cwd]       子进程 cwd
   * @param {string} [o.permissionPolicy] 'allow_once' | 'allow_always' | 'reject'
   * @param {number} [o.timeout]   默认请求超时 ms
   */
  constructor(o) {
    this.outDir = o.outDir;
    this.name = o.name || 'run';
    this.cmd = o.cmd || process.env.CODEBUDDY_ACP_CMD || 'codebuddy';
    this.args = o.args || ['--acp'];
    this.cwd = o.cwd || process.cwd();
    this.extraEnv = o.env || {};
    this.permissionPolicy = o.permissionPolicy || 'allow_once';
    this.defaultTimeout = o.timeout || 90000;

    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.terminals = new Map();
    this.records = [];
    this.stderrText = '';
    this.stdoutRawNonJson = [];
    this.exit = null;
    this.child = null;
    this.t0 = Date.now();

    this.jsonlPath = path.join(this.outDir, `${this.name}.jsonl`);
    this.stderrPath = path.join(this.outDir, `${this.name}.stderr.log`);
    this.stdoutRawPath = path.join(this.outDir, `${this.name}.stdout-raw.log`);
    fs.mkdirSync(this.outDir, { recursive: true });
    this.fd = fs.openSync(this.jsonlPath, 'w');
    fs.writeFileSync(this.stderrPath, '');
    fs.writeFileSync(this.stdoutRawPath, '');
  }

  elapsed() {
    return Date.now() - this.t0;
  }

  record(dir, payload) {
    const rec = { ts: iso(), t: this.elapsed(), dir, ...payload };
    this.records.push(rec);
    fs.writeSync(this.fd, JSON.stringify(rec) + '\n');
    return rec;
  }

  send(msg) {
    this.record('out', { msg });
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params, opts = {}) {
    const id = this.nextId++;
    const timeout = opts.timeout ?? this.defaultTimeout;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TIMEOUT ${method} after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** 原样写入一行（用于测试畸形帧），不自动加换行 */
  raw(text) {
    this.record('out-raw', { text });
    this.child.stdin.write(text);
  }

  /** 用指定 id 发请求（测试字符串 id 是否被接受） */
  requestWithId(id, method, params, opts = {}) {
    const timeout = opts.timeout ?? this.defaultTimeout;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TIMEOUT ${method} after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  on(method, fn) {
    this.handlers.set(method, fn);
  }

  start() {
    const useShell = process.platform === 'win32';
    const file = useShell ? 'cmd.exe' : '/bin/sh';
    const argv = useShell
      ? ['/d', '/s', '/c', toCmdLine(this.cmd, this.args)]
      : ['-c', toCmdLine(this.cmd, this.args)];
    this.record('spawn', { file, argv, cwd: this.cwd });
    this.child = spawn(file, argv, {
      cwd: this.cwd,
      env: { ...process.env, ...this.extraEnv },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this._onStdoutLine(line));

    this.child.stderr.on('data', (buf) => {
      const s = buf.toString('utf8');
      this.stderrText += s;
      fs.appendFileSync(this.stderrPath, s);
      this.record('stderr', { text: s });
    });

    this.child.on('exit', (code, signal) => {
      this.exit = { code, signal, atMs: this.elapsed() };
      this.record('exit', this.exit);
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`PROCESS_EXIT code=${code} signal=${signal} while waiting ${p.method}`));
        this.pending.delete(id);
      }
    });
    this.child.on('error', (e) => this.record('spawn-error', { message: e.message }));
    return this;
  }

  _onStdoutLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // 非 JSON 行 = stdout 被污染（日志/banner）。原样记录，便于判断 stdout 是否干净。
      this.stdoutRawNonJson.push(trimmed);
      fs.appendFileSync(this.stdoutRawPath, trimmed + '\n');
      this.record('stdout-nonjson', { line: trimmed });
      return;
    }
    this.record('in', { msg });
    this.dispatch(msg);
  }

  dispatch(msg) {
    const hasId = msg.id !== undefined && msg.id !== null;
    const hasMethod = typeof msg.method === 'string';

    if (hasMethod && hasId) {
      // 服务端 → 客户端请求
      this._handleServerRequest(msg);
      return;
    }
    if (hasMethod && !hasId) {
      this.notifyHandler?.(msg.method, msg.params ?? {}, msg);
      return;
    }
    if (hasId) {
      const p = this.pending.get(msg.id);
      if (!p) return this.record('orphan-response', { msg });
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(`RPC_ERROR ${p.method}: ${msg.error.message}`), { rpcError: msg.error }));
      else p.resolve(msg.result);
    }
  }

  async _handleServerRequest(msg) {
    const { id, method, params } = msg;
    const h = this.handlers.get(method);
    try {
      const result = h ? await h(params, msg) : this._defaultHandler(method, params);
      this.send({ jsonrpc: '2.0', id, result: result ?? {} });
    } catch (e) {
      this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e && e.message) } });
    }
  }

  _defaultHandler(method, params) {
    switch (method) {
      // ---- 文件系统代理 ----
      case 'fs/read_text_file': {
        let content = fs.readFileSync(params.path, 'utf8');
        if (params.line != null || params.limit != null) {
          const lines = content.split('\n');
          const start = Math.max(0, (params.line ?? 1) - 1);
          const end = params.limit != null ? start + params.limit : lines.length;
          content = lines.slice(start, end).join('\n');
        }
        return { content };
      }
      case 'fs/write_text_file': {
        fs.mkdirSync(path.dirname(params.path), { recursive: true });
        fs.writeFileSync(params.path, params.content, 'utf8');
        return {};
      }

      // ---- 终端代理 ----
      case 'terminal/create': {
        const env = { ...process.env };
        for (const kv of params.env || []) env[kv.name] = kv.value;
        const args = params.args || [];
        const t = spawn(params.command, args, {
          cwd: params.cwd || this.cwd,
          env,
          shell: process.platform === 'win32',
          windowsHide: true,
        });
        const term = { child: t, out: '', exit: null };
        const cap = params.outputByteLimit || 1 << 20;
        const push = (b) => {
          term.out += b.toString('utf8');
          if (term.out.length > cap) term.out = term.out.slice(-cap);
        };
        t.stdout.on('data', push);
        t.stderr.on('data', push);
        t.on('exit', (code, signal) => (term.exit = { exitCode: code, signal }));
        const terminalId = `term-${this.terminals.size + 1}`;
        this.terminals.set(terminalId, term);
        return { terminalId };
      }
      case 'terminal/output': {
        const term = this.terminals.get(params.terminalId);
        if (!term) throw new Error(`unknown terminalId ${params.terminalId}`);
        return { output: term.out, truncated: false, ...(term.exit ? { exitStatus: term.exit } : {}) };
      }
      case 'terminal/wait_for_exit': {
        const term = this.terminals.get(params.terminalId);
        if (!term) throw new Error(`unknown terminalId ${params.terminalId}`);
        if (term.exit) return term.exit;
        return new Promise((resolve) => term.child.on('exit', (code, signal) => resolve({ exitCode: code, signal })));
      }
      case 'terminal/kill': {
        const term = this.terminals.get(params.terminalId);
        term?.child?.kill();
        return {};
      }
      case 'terminal/release': {
        this.terminals.delete(params.terminalId);
        return {};
      }

      // ---- 权限询问 ----
      case 'session/request_permission': {
        const options = params.options || [];
        // 记录完整结构，供笔记里写「可回应的 optionId」。
        this.record('permission-request', { params });
        if (this.permissionPolicy === 'reject') {
          const reject = options.find((o) => String(o.kind).startsWith('reject'));
          return reject
            ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
            : { outcome: { outcome: 'cancelled' } };
        }
        const wantAlways = this.permissionPolicy === 'allow_always';
        const picked =
          options.find((o) => o.kind === (wantAlways ? 'allow_always' : 'allow_once')) ??
          options.find((o) => String(o.kind).startsWith('allow')) ??
          options[0];
        return picked
          ? { outcome: { outcome: 'selected', optionId: picked.optionId } }
          : { outcome: { outcome: 'cancelled' } };
      }

      default:
        this.record('unhandled-server-request', { method, params });
        throw new Error(`client does not implement ${method}`);
    }
  }

  /** 等待某个 session/update variant（或任意 update） */
  waitForUpdate(predicate, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitForUpdate timeout')), timeout);
      const orig = this.notifyHandler;
      this.notifyHandler = (method, params, raw) => {
        orig?.(method, params, raw);
        if (method === 'session/update' && predicate(params.update || {})) {
          clearTimeout(timer);
          this.notifyHandler = orig;
          resolve(params.update);
        }
      };
    });
  }

  /** 关闭 stdin，等进程自己退出（观察优雅退出码） */
  async waitExit(ms = 10000) {
    if (this.exit) return this.exit;
    try {
      this.child.stdin.end();
    } catch {}
    const started = Date.now();
    while (!this.exit && Date.now() - started < ms) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.exit || { code: null, signal: null, timedOut: true };
  }

  async stop() {
    try {
      this.child.stdin.end();
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
    if (this.child && this.child.pid && !this.child.killed) {
      if (process.platform === 'win32') {
        // cmd.exe 会再起 node 子进程，必须杀整棵树
        spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        this.child.kill('SIGTERM');
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    try {
      fs.closeSync(this.fd);
    } catch {}
  }

  summary() {
    return {
      name: this.name,
      exit: this.exit,
      stdoutPollutedLines: this.stdoutRawNonJson,
      stderrBytes: this.stderrText.length,
      messageCount: this.records.length,
      jsonl: this.jsonlPath,
      stderr: this.stderrPath,
    };
  }
}

export async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
  return p;
}
