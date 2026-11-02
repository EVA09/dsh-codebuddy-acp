// 极简 MCP server（stdio / NDJSON），零第三方依赖。
// 只有一个目的：证明 CodeBuddy 通过 ACP session/new 的 mcpServers 真的连上来了、
// 拉取了工具列表、并且能调用工具。所有进出帧写到 MCP_LOG 指定的 JSONL。
import fs from 'node:fs';

const LOG = process.env.MCP_LOG || '';
const fd = LOG ? fs.openSync(LOG, 'w') : null;
function log(dir, msg) {
  if (fd) fs.writeSync(fd, JSON.stringify({ ts: new Date().toISOString(), dir, msg }) + '\n');
}

const SERVER_INFO = { name: 'dsh-probe-mcp', version: '0.0.1' };
const TOOLS = [
  {
    name: 'echo_probe',
    description: '把输入文本原样回显，前缀 ECHO:。用于验证外部 MCP 工具是否可用。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
];

function send(msg) {
  log('out', msg);
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}
function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('stdout-nonjson', { line });
      continue;
    }
    log('in', msg);
    handle(msg);
  }
});

function handle(msg) {
  const { id, method, params } = msg;
  if (method === undefined) return; // 客户端对我们请求的响应，忽略
  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
      return; // 通知无需响应
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name !== 'echo_probe') return error(id, -32602, `unknown tool ${name}`);
      return result(id, {
        content: [{ type: 'text', text: `ECHO:${args.text ?? ''}` }],
        isError: false,
      });
    }
    case 'ping':
      return result(id, {});
    default:
      if (id !== undefined) return error(id, -32601, `method not found: ${method}`);
  }
}

log('boot', { server: SERVER_INFO, pid: process.pid, cwd: process.cwd() });
