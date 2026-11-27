#!/usr/bin/env node
/**
 * Live smoke test of the MCP endpoint, the HTTP API and the stdio bridge
 * against a running DSH with this plugin installed and both surfaces on.
 * Use a disposable DSH_HOME (see LOCAL-SETUP.md): it creates a workspace and
 * a session under a temporary directory and sends one prompt.
 *
 *   DSH_CONTROL_BASE=http://127.0.0.1:18765 DSH_CONTROL_TOKEN=dshc_… npm run test:live
 *
 * Optional: DSH_SMOKE_NO_PROMPT=1 skips session/prompt (no model call at all).
 * Node built-ins only. Prints one line per check; exits 1 on any failure.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (process.env.DSH_CONTROL_BASE ?? '').replace(/\/$/, '');
const token = process.env.DSH_CONTROL_TOKEN ?? '';
if (!base || !token) {
  console.error('Set DSH_CONTROL_BASE (DSH web origin) and DSH_CONTROL_TOKEN.');
  process.exit(2);
}
const MCP = `${base}/dsh-control-mcp/mcp`;
const API = `${base}/dsh-control-mcp/api/v1`;
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`); };
const auth = { authorization: `Bearer ${token}` };
let rpcId = 0;
async function rpc(method, params, headers = auth) {
  const response = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}
async function tool(name, args = {}) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  const result = body?.result;
  let value;
  try { value = JSON.parse(result?.content?.[0]?.text ?? 'null'); } catch { value = result?.content?.[0]?.text; }
  return { isError: result?.isError === true, value, text: result?.content?.[0]?.text ?? JSON.stringify(body) };
}
const api = async (path, body) => {
  const response = await fetch(`${API}${path}`, body === undefined ? { headers: auth } : { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => undefined) };
};

const scratch = mkdtempSync(join(tmpdir(), 'dsh-control-smoke-'));
let workspaceId;
try {
  // ── auth ──
  check('MCP refuses a missing token', (await rpc('ping', {}, {})).status === 401);
  check('MCP refuses a cross-site Origin', (await rpc('ping', {}, { ...auth, origin: 'http://evil.example' })).status === 403);

  // ── MCP handshake ──
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-smoke', version: '1' } });
  check('initialize', init.status === 200 && init.body?.result?.serverInfo?.name === 'dsh-control-mcp', `protocol ${init.body?.result?.protocolVersion}`);
  const list = await rpc('tools/list', {});
  const names = (list.body?.result?.tools ?? []).map(t => t.name);
  check('tools/list has curated tools', ['dsh_overview', 'dsh_send_prompt', 'dsh_call'].every(n => names.includes(n)), `${names.length} tools`);

  // ── reading ──
  const overview = await tool('dsh_overview');
  check('dsh_overview reports the live harness', !overview.isError && typeof overview.value?.dshVersion === 'string' && overview.value?.namespaces?.session?.endpoints > 5, `dsh ${overview.value?.dshVersion}, ${Object.keys(overview.value?.namespaces ?? {}).length} namespaces`);
  const endpoints = await tool('dsh_list_endpoints', { namespace: 'session' });
  check('dsh_list_endpoints session/*', endpoints.value?.count > 10, `${endpoints.value?.count} endpoints`);
  const described = await tool('dsh_describe_endpoint', { endpoint: 'session/prompt' });
  check('dsh_describe_endpoint carries the real schema', described.value?.inputSchema?.properties?.request?.required?.includes('content'));
  const presets = await tool('dsh_call', { endpoint: 'agentPresets/list', args: {} });
  check('dsh_call agentPresets/list', !presets.isError, presets.isError ? presets.text : '');
  const models = await tool('dsh_list_models');
  check('dsh_list_models', !models.isError, models.isError ? models.text : '');
  const plugins = await tool('dsh_list_plugins');
  check('dsh_list_plugins lists this plugin', !plugins.isError && plugins.text.includes('dsh-control-mcp'));
  const bad = await tool('dsh_call', { endpoint: 'session/doesNotExist', args: {} });
  check('unknown endpoint is a tool error, not a crash', bad.isError && /invocation-unavailable|not/i.test(bad.text));

  // ── changing state ──
  const workspace = await tool('dsh_call', { endpoint: 'workspace/create', args: { request: { path: scratch } } });
  workspaceId = workspace.value?.workspace?.workspaceId ?? workspace.value?.workspaceId;
  check('workspace/create', !workspace.isError, workspace.isError ? workspace.text : '');
  const workspaces = await tool('dsh_list_workspaces');
  check('dsh_list_workspaces sees it', !workspaces.isError && workspaces.text.includes(scratch.split('/').pop()));
  const created = await tool('dsh_create_session', { cwd: scratch });
  const sessionId = created.value?.sessionId ?? created.value?.session?.sessionId ?? created.value?.id;
  check('dsh_create_session', !created.isError && typeof sessionId === 'string', created.isError ? created.text : sessionId);
  if (sessionId) {
    const hasState = (await tool('dsh_list_endpoints', { query: 'session/state' })).value?.endpoints?.some(row => row.endpoint === 'session/state');
    if (hasState) {
      const state = await tool('dsh_call', { endpoint: 'session/state', args: { request: { sessionId } } });
      check('session/state on the new session', !state.isError, state.isError ? state.text : `cursor ${state.value?.cursor}`);
    } else console.log('ℹ session/state not offered by this DSH version; skipped');
    const renamed = await tool('dsh_call', { endpoint: 'session/rename', args: { request: { sessionId, title: 'dsh-control-mcp smoke' } } });
    check('session/rename', !renamed.isError, renamed.isError ? renamed.text : '');
    if (process.env.DSH_SMOKE_NO_PROMPT !== '1') {
      const sent = await tool('dsh_send_prompt', { sessionId, text: 'Reply with the single word: pong', wait: true, timeoutMs: 90000 });
      check('dsh_send_prompt + wait settles', !sent.isError && ['idle', 'input-required', 'timeout'].includes(sent.value?.reason), sent.isError ? sent.text : `reason ${sent.value?.reason}, reply ${JSON.stringify(String(sent.value?.reply ?? '').slice(0, 60))}${sent.value?.error ? `, error ${JSON.stringify(sent.value.error.slice(0, 80))}` : ''}`);
      check('the turn produced a reply or a reported error', Boolean(sent.value?.reply) || Boolean(sent.value?.error));
      const history = await tool('dsh_read_session', { sessionId, maxMessages: 10 });
      const roles = (history.value?.messages ?? []).map(m => m.role);
      check('dsh_read_session shows the prompt and no injected context', !history.isError && history.value?.messages?.[0]?.text?.includes('pong') && !history.text.includes('system-reminder'), roles.join(','));
    }
    const sessions = await tool('dsh_list_sessions', { includeAll: true });
    check('dsh_list_sessions includes it', sessions.text.includes(sessionId));
    await tool('dsh_cancel_session', { sessionId });
    await new Promise(resolve => setTimeout(resolve, 500));
    const archived = await tool('dsh_call', { endpoint: 'workspace/archiveSession', args: { request: { sessionId } } });
    check('workspace/archiveSession (cleanup)', !archived.isError, archived.isError ? archived.text : '');
  }
  if (workspaceId) {
    const removed = await tool('dsh_call', { endpoint: 'workspace/delete', args: { request: { workspaceId } } });
    check('workspace/delete (cleanup)', !removed.isError, removed.isError ? removed.text : '');
  } else check('workspace id returned by workspace/create', false, workspace.text.slice(0, 200));
  const streamed = await tool('dsh_stream', { endpoint: 'workspace/follow', args: {}, maxItems: 1, timeoutMs: 5000 });
  check('dsh_stream workspace/follow baseline', !streamed.isError && streamed.value?.count === 1);

  // ── HTTP API ──
  const info = await api('/info');
  check('API /info', info.status === 200 && info.body?.ok === true, `${info.body?.value?.endpoints} endpoints`);
  const call = await api('/call/session/list', { _request: {} });
  check('API call session/list', call.status === 200 && call.body?.ok === true);
  const invalid = await api('/call/session/state', { request: { nope: 1 } });
  check('API maps harness validation errors to 4xx', invalid.status >= 400 && invalid.status < 500 && invalid.body?.ok === false, `${invalid.status} ${invalid.body?.error?.code}`);
  const sse = await fetch(`${API}/stream/workspace/follow`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ args: {}, maxItems: 1 }) });
  const sseText = await sse.text();
  check('API SSE relay', /text\/event-stream/.test(sse.headers.get('content-type') ?? '') && sseText.includes('event: item') && sseText.includes('event: end'));

  // ── stdio bridge ──
  const bin = fileURLToPath(new URL('../bin/dsh-control-mcp.mjs', import.meta.url));
  const child = spawn(process.execPath, [bin], { env: { ...process.env, DSH_CONTROL_URL: MCP, DSH_CONTROL_TOKEN: token } });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"s","version":"1"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dsh_overview","arguments":{}}}\n');
  await new Promise(resolve => child.on('exit', resolve));
  const lines = out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  check('stdio bridge round trip', lines.length === 2 && lines[1]?.result?.isError === false);
} catch (error) {
  check('smoke run', false, error.stack ?? String(error));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
