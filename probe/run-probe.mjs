// ACP 探针场景驱动（零第三方依赖）
// 用法：
//   node run-probe.mjs init
//   node run-probe.mjs session
//   node run-probe.mjs models
//   node run-probe.mjs prompt
//   node run-probe.mjs cancel
//   node run-probe.mjs permission
//   node run-probe.mjs mcp
//   node run-probe.mjs all
// 原始帧输出到 probe/out/<scenario>.jsonl，摘要输出到 probe/out/<scenario>.summary.json
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AcpClient } from './lib/acp-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const WORK = path.join(HERE, 'work');
fs.mkdirSync(WORK, { recursive: true });

export const CLIENT_CAPS = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  // 以下为 ACP 1.x 扩展能力，CodeBuddy 未必认识，但声明了不会有害
  auth: { terminal: false },
};
export const CLIENT_INFO = { name: 'dsh-acp-probe', title: 'DSH ACP Probe', version: '0.0.1' };

function brief(u) {
  const t = u.sessionUpdate;
  try {
    if (t === 'agent_message_chunk' || t === 'user_message_chunk' || t === 'agent_thought_chunk') {
      return ' ' + JSON.stringify(u.content?.text ?? u.content ?? '').slice(0, 120);
    }
    if (t === 'tool_call') return ` title=${JSON.stringify(u.title)} kind=${u.kind} status=${u.status} id=${u.toolCallId}`;
    if (t === 'tool_call_update') return ` id=${u.toolCallId} status=${u.status} kind=${u.kind}`;
    if (t === 'available_commands_update') return ` commands=${(u.availableCommands || []).length}`;
    if (t === 'current_mode_update') return ` modeId=${u.currentModeId}`;
    if (t === 'config_option_update') return ` options=${(u.configOptions || []).length}`;
    if (t === 'usage_update') return ` used=${u.used} size=${u.size}`;
    if (t === 'plan') return ` entries=${(u.entries || []).length}`;
    return ' ' + JSON.stringify(u).slice(0, 200);
  } catch {
    return '';
  }
}

function summarizeUpdate(u) {
  const t = u.sessionUpdate;
  const s = { sessionUpdate: t };
  if (u.content) s.contentType = u.content.type;
  if (t === 'tool_call' || t === 'tool_call_update') {
    s.toolCallId = u.toolCallId;
    s.title = u.title;
    s.kind = u.kind;
    s.status = u.status;
    s.locationCount = (u.locations || []).length;
    s.contentKinds = (u.content || []).map((c) => c.type);
    s.rawInputKeys = u.rawInput && typeof u.rawInput === 'object' ? Object.keys(u.rawInput) : undefined;
  }
  if (t === 'plan') s.entries = u.entries;
  if (t === 'available_commands_update') s.commands = (u.availableCommands || []).map((c) => c.name);
  if (t === 'current_mode_update') s.currentModeId = u.currentModeId;
  if (t === 'config_option_update') s.configOptions = u.configOptions;
  if (t === 'session_info_update') s.info = u;
  if (t === 'usage_update') s.usage = { used: u.used, size: u.size, cost: u.cost };
  if (u._meta) s._meta = u._meta;
  return s;
}

class Runner {
  constructor(scenario, opts = {}) {
    this.scenario = scenario;
    this.opts = opts;
    this.out = { scenario, startedAt: new Date().toISOString(), steps: [], envOverrides: opts.env || {} };
    this.client = new AcpClient({
      outDir: OUT,
      name: opts.name || scenario,
      cwd: WORK,
      timeout: 120000,
      permissionPolicy: opts.permissionPolicy || 'allow_once',
      args: opts.args || ['--acp'],
      env: opts.env || {},
    });
  }

  async body() {
    const fn = this.opts.body;
    if (typeof fn !== 'function') throw new Error(`场景 ${this.scenario} 没有实现`);
    await fn(this);
  }

  async run() {
    this.client.start();
    try {
      await this.body();
    } catch (e) {
      this.out.fatalError = { message: e.message, rpcError: e.rpcError };
      console.error(`\n!! 场景 ${this.scenario} 失败:`, e.message, e.rpcError ? JSON.stringify(e.rpcError) : '');
    } finally {
      await this.client.stop();
      this.out.client = this.client.summary();
      this.out.finishedAt = new Date().toISOString();
      const p = path.join(OUT, `${this.client.name}.summary.json`);
      fs.writeFileSync(p, JSON.stringify(this.out, null, 2));
      console.log(`\n[summary] -> ${p}`);
      console.log(JSON.stringify(this.out, null, 2));
    }
  }

  async initialize() {
    console.log('>>> initialize');
    const req = { protocolVersion: 1, clientCapabilities: CLIENT_CAPS, clientInfo: CLIENT_INFO };
    const res = await this.client.request('initialize', req, { timeout: 180000 });
    this.out.initialize = { request: req, response: res };
    console.log('<<< initialize:', JSON.stringify(res, null, 2));
    // 若指定了 --auth-method，则在后续会话操作前先完成一次 authenticate
    if (this.opts.authMethod && this.scenario !== 'auth' && this.scenario !== 'init') {
      await this.authenticateWith(this.opts.authMethod, this.opts.authTimeout || 20000);
    }
    return res;
  }

  async authenticateWith(methodId, timeout = 20000) {
    const t0 = Date.now();
    try {
      const res = await this.client.request('authenticate', { methodId }, { timeout });
      this.out.authenticate = { methodId, durationMs: Date.now() - t0, response: res };
      console.log('<<< authenticate OK:', JSON.stringify(res));
      return res;
    } catch (e) {
      this.out.authenticate = { methodId, durationMs: Date.now() - t0, error: { message: e.message, rpcError: e.rpcError } };
      console.log('<<< authenticate 失败:', e.message, JSON.stringify(e.rpcError || {}));
      throw e;
    }
  }

  async authenticate(initRes) {
    const methods = initRes?.authMethods || [];
    this.out.authMethods = methods;
    if (!methods.length) {
      console.log('<<< initialize 未返回 authMethods（说明无需/未提供 ACP 层鉴权方法）');
      return;
    }
    const pick = methods[0];
    console.log('>>> authenticate', JSON.stringify(pick));
    try {
      const res = await this.client.request('authenticate', { methodId: pick.id }, { timeout: 10000 });
      this.out.authenticate = { methodId: pick.id, response: res };
      console.log('<<< authenticate:', JSON.stringify(res, null, 2));
    } catch (e) {
      this.out.authenticate = { methodId: pick.id, error: { message: e.message, rpcError: e.rpcError } };
      console.log('<<< authenticate 失败:', e.message, JSON.stringify(e.rpcError || {}));
    }
  }

  async newSession(extra = {}) {
    const req = { cwd: WORK, mcpServers: [], ...extra };
    console.log('>>> session/new', JSON.stringify({ ...req, mcpServers: `[${(req.mcpServers || []).length} servers]` }));
    const res = await this.client.request('session/new', req, { timeout: 180000 });
    this.out.newSession = { request: req, response: res };
    this.sessionId = res.sessionId;
    console.log('<<< session/new:', JSON.stringify(res, null, 2));
    return res;
  }

  attachUpdateCollector(store) {
    this.client.notifyHandler = (method, params) => {
      if (method !== 'session/update') {
        store.otherNotifications.push({ t: this.client.elapsed(), method, params });
        console.log(`[notif] +${this.client.elapsed()}ms ${method} ${JSON.stringify(params).slice(0, 200)}`);
        return;
      }
      const u = params.update || {};
      store.updates.push({ i: store.updates.length, tMs: this.client.elapsed(), update: u });
      console.log(`[update ${String(store.updates.length).padStart(2, '0')}] +${this.client.elapsed()}ms ${u.sessionUpdate}${brief(u)}`);
    };
  }

  async prompt(text, timeout = 300000) {
    const store = { updates: [], otherNotifications: [] };
    this.attachUpdateCollector(store);
    console.log(`>>> session/prompt ${JSON.stringify(text)}`);
    const started = Date.now();
    let res = null;
    let err = null;
    try {
      res = await this.client.request(
        'session/prompt',
        { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
        { timeout },
      );
    } catch (e) {
      err = { message: e.message, rpcError: e.rpcError };
      console.log('<<< session/prompt 失败:', e.message, JSON.stringify(e.rpcError || {}));
    }
    const agentText = store.updates
      .filter((x) => x.update.sessionUpdate === 'agent_message_chunk')
      .map((x) => x.update.content?.text || '')
      .join('');
    const summary = {
      prompt: text,
      durationMs: Date.now() - started,
      response: res,
      error: err,
      agentText,
      updateCount: store.updates.length,
      updateOrder: store.updates.map((x) => x.update.sessionUpdate),
      updateVariants: [...new Set(store.updates.map((x) => x.update.sessionUpdate))],
      updateDigests: store.updates.map((x) => summarizeUpdate(x.update)),
      otherNotifications: store.otherNotifications,
    };
    return summary;
  }
}

// ---------------------------------------------------------------- 场景
const scenarios = {
  // 0) 关键验证：authenticate 后能否解锁 session/new 与 prompt
  async unlocked(r) {
    const init = await r.initialize();
    r.out.agentCapabilities = init.agentCapabilities;
    const sess = await r.newSession();
    r.out.configOptions = sess.configOptions;
    r.out.modes = sess.modes;
    r.out.sessionMeta = sess._meta;
    r.out.prompt = await r.prompt('用一句话回答：1+1=? 只输出结果。', 300000);
  },

  // 1) 握手 + 鉴权
  async init(r) {
    const init = await r.initialize();
    r.out.agentCapabilities = init.agentCapabilities;
    r.out.protocolVersion = init.protocolVersion;
    r.out.agentInfo = init.agentInfo;
    await r.authenticate(init);
  },

  // 2) 建会话 + 会话级能力发现
  async session(r) {
    const init = await r.initialize();
    const res = await r.newSession();
    r.out.configOptions = res.configOptions;
    r.out.modes = res.modes;
    r.out.modelsField = res.models;
    r.out.sessionMeta = res._meta;
    r.out.agentCapabilities = init.agentCapabilities;

    // 尝试会话列举/提供方枚举（若 agent 声明支持）
    const sc = init.agentCapabilities?.sessionCapabilities || {};
    if (sc.list) {
      try {
        r.out.sessionList = await r.client.request('session/list', { cwd: WORK });
      } catch (e) {
        r.out.sessionList = { error: e.message, rpcError: e.rpcError };
      }
    }
    if (init.agentCapabilities?.providers) {
      try {
        r.out.providers = await r.client.request('providers/list', {});
      } catch (e) {
        r.out.providers = { error: e.message, rpcError: e.rpcError };
      }
    }
  },

  // 3) 模型枚举 + 模型切换（需 --auth-method）
  async models(r) {
    const init = await r.initialize();
    const res = await r.newSession();
    r.out.models = res.models ?? null;
    r.out.configOptions = res.configOptions;
    r.out.currentModelId = res.models?.currentModelId ?? null;
    const av = res.models?.availableModels || [];
    r.out.enumeratedModels = av.map((m) => ({
      modelId: m.modelId,
      name: m.name,
      description: m.description,
      maxInputTokens: m._meta?.maxInputTokens,
      supportsImages: !!m._meta?.supportsImages,
      supportsReasoning: !!m._meta?.supportsReasoning,
      effortOptions: (m._meta?.effortOptions || []).map((e) => e.value),
    }));
    r.out.enumeratedModelIds = r.out.enumeratedModels.map((m) => m.modelId);
    console.log(`\n=== models.availableModels (${av.length}) ===`);
    for (const m of r.out.enumeratedModels) {
      console.log(`${m.modelId}\t${m.name}\tmaxIn=${m.maxInputTokens}\t${m.description}\teffort=${m.effortOptions.join('|')}`);
    }
    const modelOpt = (res.configOptions || []).find((o) => o.id === 'model');
    r.out.modelConfigOption = modelOpt
      ? { id: modelOpt.id, currentValue: modelOpt.currentValue, optionCount: (modelOpt.options || []).length }
      : null;

    const probe = async (label, method, params) => {
      try {
        const out = await r.client.request(method, params, { timeout: 30000 });
        r.out[label] = { ok: true, result: out };
        console.log(`[${label}] OK ${JSON.stringify(out).slice(0, 500)}`);
        return out;
      } catch (e) {
        r.out[label] = { ok: false, error: { message: e.message, rpcError: e.rpcError } };
        console.log(`[${label}] ERR ${JSON.stringify(e.rpcError || e.message)}`);
        return null;
      }
    };

    // 非法 modelId：看是否在错误里回带合法枚举
    await probe('setModel_bogus', 'session/set_model', { sessionId: r.sessionId, modelId: '__dsh_probe_no_such_model__' });

    // 合法 modelId：真正切模型
    const target = process.env.DSH_PROBE_MODEL || 'deepseek-v4.1-flash';
    const setRes = await probe('setModel_valid', 'session/set_model', { sessionId: r.sessionId, modelId: target });
    r.out.setModelValidTarget = target;
    if (setRes) r.out.currentModelIdAfterSetModel = setRes.currentModelId ?? setRes.models?.currentModelId ?? null;

    // 标准 config option 路径切模型
    const cfgRes = await probe('setConfigOption_model', 'session/set_config_option', {
      sessionId: r.sessionId,
      configId: 'model',
      value: 'hy3',
    });
    if (cfgRes) r.out.currentModelIdAfterSetConfig = cfgRes.configOptions?.find((o) => o.id === 'model')?.currentValue ?? null;

    // 模式切换
    await probe('setMode_acceptEdits', 'session/set_mode', { sessionId: r.sessionId, modeId: 'acceptEdits' });

    // 读回当前配置（若存在读取方法）
    await probe('getConfigOptions', 'session/get_config_options', { sessionId: r.sessionId });
  },

  // 4) 最小 prompt 全流
  async prompt(r) {
    await r.initialize();
    await r.newSession();
    r.out.prompt = await r.prompt('用一句话回答：1+1=? 只输出结果。', 300000);
  },

  // 5) 取消
  async cancel(r) {
    await r.initialize();
    await r.newSession();
    const store = { updates: [], otherNotifications: [] };
    r.attachUpdateCollector(store);
    console.log('>>> session/prompt（长任务，4s 后 cancel）');
    const p = r.client
      .request('session/prompt', {
        sessionId: r.sessionId,
        prompt: [{ type: 'text', text: '请从 1 数到 100，每个数字单独一行，不要省略。' }],
      }, { timeout: 300000 })
      .then((res) => ({ res }))
      .catch((e) => ({ error: { message: e.message, rpcError: e.rpcError } }));
    await new Promise((x) => setTimeout(x, 4000));
    console.log('>>> session/cancel (notification)');
    r.client.notify('session/cancel', { sessionId: r.sessionId });
    const out = await p;
    const elapsedAfterCancel = r.client.elapsed() - 4000;
    r.out.cancel = {
      ...out,
      updatesBeforeCancel: store.updates.filter((x) => x.tMs <= 4000).length,
      updatesAfterCancelMs: elapsedAfterCancel,
      updatesAfterCancel: store.updates.filter((x) => x.tMs > 4000).map((x) => x.update.sessionUpdate),
      updateOrder: store.updates.map((x) => x.update.sessionUpdate),
      lastUpdates: store.updates.slice(-5).map((x) => summarizeUpdate(x.update)),
    };
    console.log('<<< cancel 后响应:', JSON.stringify(out, null, 2));
  },

  // 6) 权限询问
  async permission(r) {
    await r.initialize();
    await r.newSession();
    const target = path.join(WORK, 'acp-perm-test.txt');
    try {
      fs.rmSync(target, { force: true });
    } catch {}
    r.out.prompt = await r.prompt(
      `请在当前工作目录下创建文件 acp-perm-test.txt，文件内容为 hello-acp，然后回答"已完成"。`,
      300000,
    );
    const permReqs = r.client.records.filter((x) => x.dir === 'permission-request');
    r.out.permissionRequests = permReqs.map((x) => x.params);
    r.out.permissionRequestCount = permReqs.length;
    r.out.fileCreated = fs.existsSync(target);
    r.out.fileContent = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    r.out.fsProxyCalls = r.client.records
      .filter((x) => x.dir === 'in' && /^fs\//.test(x.msg?.method || ''))
      .map((x) => ({ method: x.msg.method, params: x.msg.params }));
    r.out.terminalCalls = r.client.records
      .filter((x) => x.dir === 'in' && /^terminal\//.test(x.msg?.method || ''))
      .map((x) => ({ method: x.msg.method, params: x.msg.params }));
  },

  // 6.5) 错误与边界（不依赖登录态）
  async errors(r) {
    const probe = async (label, fn) => {
      try {
        const res = await fn();
        r.out[label] = { ok: true, result: res };
        console.log(`[${label}] -> OK ${JSON.stringify(res).slice(0, 400)}`);
      } catch (e) {
        r.out[label] = { ok: false, error: { message: e.message, rpcError: e.rpcError } };
        console.log(`[${label}] -> ERR ${JSON.stringify(e.rpcError || e.message)}`);
      }
    };

    // 未 initialize 先调别的方法：看错误码
    await probe('callBeforeInitialize_sessionNew', () =>
      r.client.request('session/new', { cwd: WORK, mcpServers: [] }, { timeout: 20000 }),
    );

    await r.initialize();

    await probe('unknownMethod', () => r.client.request('dsh/not_a_real_method', {}, { timeout: 15000 }));

    await probe('sessionNew_missingEverything', () => r.client.request('session/new', {}, { timeout: 20000 }));

    await probe('sessionNew_missingMcpServers', () =>
      r.client.request('session/new', { cwd: WORK }, { timeout: 20000 }),
    );

    await probe('sessionNew_badCwdType', () =>
      r.client.request('session/new', { cwd: 123, mcpServers: [] }, { timeout: 20000 }),
    );

    await probe('sessionNew_correct', () => r.client.request('session/new', { cwd: WORK, mcpServers: [] }, { timeout: 60000 }));

    await probe('prompt_unknownSession', () =>
      r.client.request(
        'session/prompt',
        { sessionId: 'no-such-session', prompt: [{ type: 'text', text: 'hi' }] },
        { timeout: 20000 },
      ),
    );

    await probe('setModel_unknownSession', () =>
      r.client.request('session/set_model', { sessionId: 'no-such-session', modelId: 'hy3' }, { timeout: 20000 }),
    );

    await probe('setConfigOption_unknownSession', () =>
      r.client.request(
        'session/set_config_option',
        { sessionId: 'no-such-session', configId: 'model', value: 'hy3' },
        { timeout: 20000 },
      ),
    );

    // 字符串 id 是否被接受
    await probe('stringIdRequest', () =>
      r.client.requestWithId('dsh-probe-string-id', 'dsh/not_a_real_method', {}, { timeout: 15000 }),
    );

    // 畸形 JSON 行：看进程是否存活、是否回 -32700
    const beforeBad = r.client.records.length;
    r.client.raw('{ this is not json\n');
    await new Promise((x) => setTimeout(x, 1500));
    r.out.malformedJsonFrames = r.client.records
      .slice(beforeBad)
      .filter((x) => x.dir === 'in' || x.dir === 'stdout-nonjson' || x.dir === 'exit')
      .map((x) => ({ dir: x.dir, msg: x.msg, line: x.line }));
    r.out.aliveAfterMalformedJson = r.client.exit === null;
    console.log('[malformedJson] 后续帧:', JSON.stringify(r.out.malformedJsonFrames));

    // 畸形之后还能不能正常往返
    await probe('afterMalformed_unknownMethod', () =>
      r.client.request('dsh/not_a_real_method2', {}, { timeout: 15000 }),
    );

    // 重复 initialize
    await probe('initializeAgain', () => r.client.request('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPS, clientInfo: CLIENT_INFO }, { timeout: 30000 }));
  },

  // 1.5) 逐个 authMethod 真发 authenticate，观察行为（重点：能否做「一键登录」）
  async auth(r) {
    const init = await r.initialize();
    const methods = init.authMethods || [];
    r.out.authMethods = methods;
    r.out.authResults = [];
    for (const m of methods) {
      const before = r.client.records.length;
      const t0 = Date.now();
      console.log(`\n>>> authenticate {methodId:"${m.id}"}  (${m.name})`);
      let outcome;
      try {
        const res = await r.client.request('authenticate', { methodId: m.id }, { timeout: 10000 });
        outcome = { status: 'resolved', response: res };
        console.log('<<< resolved:', JSON.stringify(res));
      } catch (e) {
        outcome = { status: /TIMEOUT/.test(e.message) ? 'timeout(10s 无响应)' : 'error', error: { message: e.message, rpcError: e.rpcError } };
        console.log('<<< ' + outcome.status + ':', JSON.stringify(e.rpcError || e.message));
      }
      const frames = r.client.records
        .slice(before)
        .filter((x) => x.dir === 'in' || x.dir === 'stdout-nonjson' || x.dir === 'stderr' || x.dir === 'exit')
        .map((x) => ({ dir: x.dir, msg: x.msg, line: x.line, text: x.text }));
      r.out.authResults.push({
        methodId: m.id,
        name: m.name,
        description: m.description ?? null,
        durationMs: Date.now() - t0,
        ...outcome,
        // 有没有在鉴权窗口内收到任何帧（URL/设备码/通知）
        framesDuringAuth: frames,
        userinfo: outcome.response?._meta?.['codebuddy.ai/userinfo'] ?? null,
      });
    }
    // 各 method 结束后，进程还活着吗？
    r.out.aliveAfterAuth = r.client.exit === null;
    // 观察优雅退出：关掉 stdin 看退出码
    const ex = await r.client.waitExit(8000);
    r.out.gracefulExit = ex;
    console.log('graceful exit:', JSON.stringify(ex));
  },

  // 1.6) 不依赖登录也能探到的 session/new 参数面
  async params(r) {
    const init = await r.initialize();
    r.out.agentCapabilities = init.agentCapabilities;

    const cases = [
      ['baseline', { cwd: WORK, mcpServers: [] }],
      ['withMeta_codeMode', { cwd: WORK, mcpServers: [], _meta: { 'codebuddy.ai/codeMode': 'off' } }],
      ['withTopLevelModel', { cwd: WORK, mcpServers: [], model: 'hy3' }],
      ['withMetaModel', { cwd: WORK, mcpServers: [], _meta: { model: 'hy3', 'codebuddy.ai/model': 'hy3' } }],
      ['withAdditionalDirectories', { cwd: WORK, mcpServers: [], additionalDirectories: [WORK] }],
      ['withMetaConversationRequestId', { cwd: WORK, mcpServers: [], _meta: { 'codebuddy.ai/conversationRequestId': '0198a1b2c3d47e5f8a9b0c1d2e3f4a5b' } }],
      ['mcpStdioShape', {
        cwd: WORK,
        mcpServers: [{ name: 'probe', command: process.execPath, args: ['-e', ''], env: [] }],
      }],
      ['mcpHttpShape', {
        cwd: WORK,
        mcpServers: [{ type: 'http', name: 'probe-http', url: 'http://127.0.0.1:9/mcp', headers: [] }],
      }],
    ];
    r.out.paramCases = [];
    for (const [label, params] of cases) {
      let rec;
      try {
        const res = await r.client.request('session/new', params, { timeout: 20000 });
        rec = { label, ok: true, response: res };
        console.log(`[${label}] OK ${JSON.stringify(res).slice(0, 300)}`);
      } catch (e) {
        rec = { label, ok: false, error: { message: e.message, rpcError: e.rpcError } };
        const c = e.rpcError ? `${e.rpcError.code} ${e.rpcError.message} ${JSON.stringify(e.rpcError.data)}` : e.message;
        console.log(`[${label}] ERR ${c}`);
      }
      r.out.paramCases.push(rec);
    }

    // 会话级方法在无会话/无登录下的错误形状
    for (const [label, method, params] of [
      ['sessionLoad_fake', 'session/load', { sessionId: 'dsh-fake', cwd: WORK, mcpServers: [] }],
      ['sessionResume_fake', 'session/resume', { sessionId: 'dsh-fake', cwd: WORK, mcpServers: [] }],
      ['sessionList', 'session/list', { cwd: WORK }],
      ['sessionSetMode_fake', 'session/set_mode', { sessionId: 'dsh-fake', modeId: 'default' }],
      ['sessionSetModel_fake', 'session/set_model', { sessionId: 'dsh-fake', modelId: 'hy3' }],
      ['sessionClose_fake', 'session/close', { sessionId: 'dsh-fake' }],
      ['providersList', 'providers/list', {}],
    ]) {
      try {
        const res = await r.client.request(method, params, { timeout: 20000 });
        r.out[label] = { ok: true, result: res };
        console.log(`[${label}] OK ${JSON.stringify(res).slice(0, 300)}`);
      } catch (e) {
        r.out[label] = { ok: false, error: { message: e.message, rpcError: e.rpcError } };
        console.log(`[${label}] ERR ${JSON.stringify(e.rpcError || e.message)}`);
      }
    }
  },

  // 7) 外部 MCP 注入
  async mcp(r) {    const mcpLog = path.join(OUT, 'mcp-server.jsonl');
    const mini = path.join(HERE, 'lib', 'mini-mcp-server.mjs');
    r.out.mcpLog = mcpLog;
    await r.initialize();
    await r.newSession({
      mcpServers: [
        {
          name: 'dsh-probe-mcp',
          command: process.execPath,
          args: [mini],
          env: [{ name: 'MCP_LOG', value: mcpLog }],
        },
      ],
    });
    r.out.mcpServerKind = 'stdio (无 type 字段，字段形态 {name,command,args,env})';
    // 给 MCP 连接一点时间
    await new Promise((x) => setTimeout(x, 3000));
    r.out.mcpServerLogExists = fs.existsSync(mcpLog);
    if (fs.existsSync(mcpLog)) {
      const lines = fs.readFileSync(mcpLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      r.out.mcpFrames = lines;
      r.out.mcpMethodsSeen = [...new Set(lines.filter((l) => l.dir === 'in').map((l) => l.msg?.method).filter(Boolean))];
      console.log('=== MCP server 收到的帧 ===');
      for (const l of lines) console.log(JSON.stringify(l));
    }
    r.out.prompt = await r.prompt(
      `请调用名为 echo_probe 的 MCP 工具，参数 text 为 "ping"，然后告诉我它返回的原文。`,
      300000,
    );
    if (fs.existsSync(mcpLog)) {
      const lines = fs.readFileSync(mcpLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      r.out.mcpMethodsSeenAfterPrompt = [...new Set(lines.filter((l) => l.dir === 'in').map((l) => l.msg?.method).filter(Boolean))];
      r.out.mcpToolCallSeen = lines.some((l) => l.msg?.method === 'tools/call');
      r.out.mcpFrames = lines;
    }
  },
};

// ---------------------------------------------------------------- main
const argv = process.argv.slice(2);
const name = argv[0] || 'init';
const RUN = argv.includes('--run'); // 默认 dry-run：绝不 spawn 进程
const promptIdx = argv.indexOf('--prompt');
const extra = promptIdx >= 0 ? { customPrompt: argv[promptIdx + 1] } : {};
// --env KEY=VALUE（可重复），用于测试 CODEBUDDY_API_KEY 等环境变量通道
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--env' && argv[i + 1]) {
    const eq = argv[i + 1].indexOf('=');
    if (eq > 0) {
      extra.env = extra.env || {};
      extra.env[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
    }
    i++;
  }
  if (argv[i] === '--name-suffix' && argv[i + 1]) {
    extra.nameSuffix = argv[i + 1];
    i++;
  }
  if (argv[i] === '--auth-method' && argv[i + 1]) {
    extra.authMethod = argv[i + 1];
    i++;
  }
  if (argv[i] === '--auth-timeout' && argv[i + 1]) {
    extra.authTimeout = Number(argv[i + 1]);
    i++;
  }
}
if (extra.nameSuffix) extra.name = `${name}-${extra.nameSuffix}`;

// 每个场景的说明：spawn=是否需要真起 codebuddy，auth=是否需要先登录
const SCENARIO_DOCS = {
  init: { desc: '握手 initialize，并逐条尝试 4 种 authenticate', needsAuth: false, mayPopupBrowser: true, est: '~60s（iOA/external/selfhosted 各 10s 超时）' },
  auth: { desc: '逐个 authMethod 真发 authenticate，记录 userinfo/耗时/是否弹浏览器', needsAuth: false, mayPopupBrowser: true, est: '~70s' },
  params: { desc: '不依赖登录也能探到的 session/new 参数面 + 会话方法错误形状', needsAuth: true, mayPopupBrowser: false, est: '~30s' },
  session: { desc: 'session/new 全量响应（models/modes/configOptions）', needsAuth: true, mayPopupBrowser: false, est: '~20s' },
  models: { desc: '模型枚举 + set_model/set_config_option/set_mode 切换', needsAuth: true, mayPopupBrowser: false, est: '~30s' },
  prompt: { desc: '最小 prompt，抓全部 session/update 直到 result', needsAuth: true, mayPopupBrowser: false, est: '~40s' },
  cancel: { desc: '长任务 prompt，4s 后发 session/cancel，看 stopReason', needsAuth: true, mayPopupBrowser: false, est: '~60s' },
  permission: { desc: '让 agent 写文件，触发 session/request_permission + fs 代理', needsAuth: true, mayPopupBrowser: false, est: '~90s' },
  errors: { desc: '错误边界（-32700/-32601/-32602/-32603/-32000、字符串 id、畸形帧）', needsAuth: false, mayPopupBrowser: false, est: '~20s' },
  mcp: { desc: '通过 session/new.mcpServers 注入 stdio MCP server 并调用其工具', needsAuth: true, mayPopupBrowser: false, est: '~90s' },
  unlocked: { desc: '(历史用) authenticate 后直接 session/new + prompt', needsAuth: true, mayPopupBrowser: false, est: '~40s' },
};

function printDryRun(target) {
  const list = target === 'all' ? ['init', 'auth', 'params', 'session', 'models', 'prompt', 'cancel', 'permission', 'errors', 'mcp'] : [target];
  console.log('================ DRY RUN（未启动任何进程）================');
  console.log('要真正执行，请追加 --run；并建议同时给 --auth-method internal --auth-timeout 90000');
  console.log('警告：init / auth 场景会触发真实登录流程，可能拉起浏览器授权页。\n');
  for (const s of list) {
    const d = SCENARIO_DOCS[s];
    if (!d) {
      console.log(`? 未知场景 ${s}`);
      continue;
    }
    console.log(`[${s}] ${d.desc}`);
    console.log(`    spawn: codebuddy --acp    cwd: ${WORK}`);
    console.log(`    需要登录态: ${d.needsAuth ? '是（先 authenticate）' : '否'}    可能弹浏览器: ${d.mayPopupBrowser ? '是' : '否'}    预计: ${d.est}`);
    console.log(`    产出: out/${s}.jsonl, out/${s}.summary.json, out/${s}.console.txt`);
  }
  console.log('\n可选参数:');
  console.log('  --run                     真正执行（默认 dry-run）');
  console.log('  --auth-method internal    会话操作前先 authenticate 该 method（本机 internal 走缓存凭据）');
  console.log('  --auth-timeout 90000      authenticate 超时 ms');
  console.log('  --env KEY=VALUE           为子进程注入环境变量（可重复），如 CODEBUDDY_API_KEY');
  console.log('  --name-suffix apikey      输出文件名后缀，便于区分多次实验');
  console.log(`\n当前 dry-run 目标: ${target}`);
}

if (!RUN) {
  printDryRun(name);
  process.exit(0);
}

if (name === 'all') {
  const order = ['init', 'auth', 'params', 'session', 'models', 'prompt', 'cancel', 'permission', 'errors', 'mcp'];
  for (const s of order) {
    console.log(`\n\n================ SCENARIO ${s} ================`);
    await new Runner(s, { ...extra, name: s + (extra.nameSuffix ? '-' + extra.nameSuffix : ''), body: scenarios[s] }).run();
  }
} else if (scenarios[name]) {
  await new Runner(extra.name || name, { ...extra, body: scenarios[name] }).run();
} else {
  console.error(`未知场景 ${name}；可选：${Object.keys(scenarios).join(', ')}, all`);
  process.exit(2);
}
