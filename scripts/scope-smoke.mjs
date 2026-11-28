#!/usr/bin/env node
/**
 * Live isolation test for scoped API keys against a running DSH (0.2.1+) with
 * this plugin installed and MCP + API on. Use a disposable DSH_HOME.
 *
 *   DSH_E2E_URL='http://127.0.0.1:18767/?token=…' npm run test:scope
 *
 * Signs in as the owner with the launch URL, creates two workspaces with two
 * sessions each in temporary directories, then creates keys through the
 * owner-only key routes and checks, through both MCP and the HTTP API, that:
 *   - a session-scoped read key sees exactly its session (session/list,
 *     search, workspace/follow, session/control) and can read it;
 *   - it is refused on every other session, on prompts, and on harness-wide
 *     endpoints (plugins, settings, credentials, terminals, schedules, …);
 *   - a workspace-scoped prompt key sees all sessions of its workspace,
 *     including ones created later, can create sessions there, and cannot
 *     create or touch anything elsewhere;
 *   - disabling, narrowing, expiring, rotating and deleting a key take effect
 *     on the next request;
 *   - per-key MCP/API switches are enforced.
 * Cleans up the keys, sessions and workspaces it made. Node built-ins only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const launch = process.env.DSH_E2E_URL;
if (!launch) { console.error('Set DSH_E2E_URL to the dsh web URL printed at startup (including ?token=…).'); process.exit(2); }
const origin = new URL(launch).origin;
const P = `${origin}/dsh-control-mcp`;
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`); };

// ── owner session cookie ──
const exchange = await fetch(launch, { redirect: 'manual' });
const cookie = (exchange.headers.getSetCookie?.() ?? [exchange.headers.get('set-cookie')]).filter(Boolean).map(c => c.split(';')[0]).join('; ');
if (!cookie) { console.error('Launch token exchange gave no cookie.'); process.exit(2); }
const owner = async (method, path, body) => {
  const res = await fetch(`${P}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => undefined);
  if (!res.ok || json?.ok !== true) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json?.error ?? json)}`);
  return json.value;
};
const ownerToken = (await owner('GET', '/token')).token;

// ── callers ──
const api = token => async (endpoint, args = {}) => {
  const res = await fetch(`${P}/api/v1/call/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};
const apiStream = token => async (endpoint, args = {}) => {
  const res = await fetch(`${P}/api/v1/stream/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ args, maxItems: 1, timeoutMs: 4000 }) });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};
let rpcId = 0;
const mcpTool = token => async (name, args = {}) => {
  const res = await fetch(`${P}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await res.json().catch(() => undefined);
  const text = body?.result?.content?.[0]?.text ?? JSON.stringify(body);
  let value; try { value = JSON.parse(text); } catch { value = text; }
  return { status: res.status, isError: body?.result?.isError === true || body?.error !== undefined, value, text };
};
const mcpList = async token => {
  const res = await fetch(`${P}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }) });
  return (await res.json()).result?.tools?.map(t => t.name) ?? [];
};

const asOwner = api(ownerToken);
const scratch = [mkdtempSync(join(tmpdir(), 'dshc-scope-a-')), mkdtempSync(join(tmpdir(), 'dshc-scope-b-'))];
const made = { workspaces: [], sessions: [], keys: [] };
const ids = r => (r.body?.value?.items ?? []).map(row => row.sessionId);

try {
  // ── fixtures: workspaces A and B, two sessions each ──
  for (const dir of scratch) {
    const ws = await asOwner('workspace/create', { request: { path: dir } });
    made.workspaces.push(ws.body.value.workspace.workspaceId);
  }
  const [wsA, wsB] = made.workspaces;
  const newSession = async workspaceId => {
    const r = await asOwner('session/create', { request: { workspaceId } });
    const id = r.body?.value?.sessionId; made.sessions.push(id);
    // A session needs one event to be listed: rename it.
    await asOwner('session/rename', { request: { sessionId: id, title: `scope-${made.sessions.length}` } });
    return id;
  };
  const a1 = await newSession(wsA); const a2 = await newSession(wsA);
  const b1 = await newSession(wsB); const b2 = await newSession(wsB);
  check('fixtures: 2 workspaces, 4 sessions', [a1, a2, b1, b2].every(Boolean));
  const allOwner = ids(await asOwner('session/list', { _request: {} }));
  check('owner sees all four sessions', [a1, a2, b1, b2].every(id => allOwner.includes(id)));

  const options = await owner('GET', '/scope-options');
  check('scope options list the workspaces and sessions', options.scopedSupported === true && [wsA, wsB].every(id => options.workspaces.some(w => w.id === id)) && options.sessions.some(s => s.id === a1));

  // ── key 1: read-only, one session ──
  const k1 = await owner('POST', '/keys', { name: 'Read A1', mode: 'scoped', access: 'read', sessions: [a1] });
  made.keys.push(k1.key.id);
  check('create returns the token once and lists the key without it', /^dshc_/.test(k1.token) && !(await owner('GET', '/keys')).keys.some(k => 'hash' in k || 'token' in k));
  const r1 = api(k1.token); const m1 = mcpTool(k1.token);
  let seen = ids(await r1('session/list', { _request: {} }));
  check('session key: session/list shows only its session', seen.length === 1 && seen[0] === a1, seen.join(','));
  const search = await r1('session/search', { request: { query: 'scope' } });
  if (search.status === 200) check('session key: session/search never returns other sessions', (search.body.value.items ?? []).every(item => item.sessionId === a1));
  else console.log(`ℹ session/search unavailable on this deployment (${search.body?.error?.message?.slice(0, 80)}); skipped`);
  const wsf = await apiStream(k1.token)('workspace/follow', {});
  const wsText = JSON.stringify(wsf.body?.value?.items ?? []);
  check('session key: workspace/follow shows workspace A with only A1', wsText.includes(a1) && !wsText.includes(a2) && !wsText.includes(b1) && !wsText.includes(wsB), `status ${wsf.status}`);
  const ctl = await apiStream(k1.token)('session/control', {});
  const ctlText = JSON.stringify(ctl.body?.value?.items ?? []);
  check('session key: session/control baseline only carries A1', ctl.status === 200 && ctlText.includes(a1) && ![a2, b1, b2].some(id => ctlText.includes(id)));
  check('session key: can read its session', (await r1('session/page', { request: { address: { kind: 'session', sessionId: a1 }, throughSeq: 0, maxMessages: 5 } })).status === 200);
  for (const [label, sid] of [['same workspace', a2], ['other workspace', b1]]) {
    const r = await r1('session/page', { request: { address: { kind: 'session', sessionId: sid }, throughSeq: 0, maxMessages: 5 } });
    check(`session key: refused reading a session in the ${label}`, r.status === 403, `${r.status} ${r.body?.error?.code}`);
  }
  const p1 = await r1('session/prompt', { request: { requestId: '00000000-0000-4000-8000-000000000001', sessionId: a1, mode: 'queue', content: [{ type: 'text', text: 'x' }] } });
  check('read key: refused prompting even its own session', p1.status === 403, p1.body?.error?.code);
  for (const ep of ['pluginManager/listPlugins', 'settings/describe', 'credentials/describe', 'schedule/catalog', 'workspace/create', 'workspace/delete', 'pluginManager/setPluginEnabled', 'account/getState', 'job/kill']) {
    const r = await r1(ep, {});
    check(`session key: harness-wide ${ep} refused`, r.status === 403, `${r.status} ${r.body?.error?.code}`);
  }
  const t1 = await r1('terminal/list', { sessionId: b1 });
  check('session key: terminal/list of another session refused', t1.status === 403, `${t1.status}`);
  const mcpSessions = await m1('dsh_list_sessions', { includeAll: true });
  check('MCP: dsh_list_sessions shows only A1', !mcpSessions.isError && mcpSessions.value.sessions.map(s => s.sessionId).join() === a1);
  const mcpRead = await m1('dsh_read_session', { sessionId: b2 });
  check('MCP: dsh_read_session on another session is a tool error', mcpRead.isError, mcpRead.text.slice(0, 80));
  const tools1 = await mcpList(k1.token);
  check('MCP: read key does not list prompt or plugin tools', !tools1.includes('dsh_send_prompt') && !tools1.includes('dsh_list_plugins') && tools1.includes('dsh_read_session'));
  const eps = await m1('dsh_list_endpoints', {});
  check('MCP: dsh_list_endpoints only lists endpoints the key can reach', !eps.isError && eps.value.endpoints.every(e => !/^(pluginManager|settings|credentials|account)\//.test(e.endpoint)), `${eps.value?.count} endpoints`);

  // ── key 2: workspace A, prompt ──
  const k2 = await owner('POST', '/keys', { name: 'Drive A', mode: 'scoped', access: 'prompt', workspaces: [wsA] });
  made.keys.push(k2.key.id);
  const r2 = api(k2.token);
  seen = ids(await r2('session/list', { _request: {} }));
  check('workspace key: sees both A sessions and nothing from B', seen.includes(a1) && seen.includes(a2) && !seen.includes(b1) && !seen.includes(b2), seen.join(','));
  const created = await r2('session/create', { request: { workspaceId: wsA } });
  const a3 = created.body?.value?.sessionId; if (a3) made.sessions.push(a3);
  check('workspace key: can create a session in its workspace', created.status === 200 && Boolean(a3), `${created.status} ${created.body?.error?.code ?? ''}`);
  if (a3) {
    const renamed = await r2('session/rename', { request: { sessionId: a3, title: 'made by key' } });
    check('workspace key: drives the session it created (follows the workspace)', renamed.status === 200, `${renamed.status} ${renamed.body?.error?.code ?? ''}`);
  }
  const a4 = await newSession(wsA);
  check('workspace key: a session the owner adds later is in scope at once', ids(await r2('session/list', { _request: {} })).includes(a4));
  const elsewhere = await r2('session/create', { request: { workspaceId: wsB } });
  check('workspace key: refused creating a session in another workspace', elsewhere.status === 403, `${elsewhere.status}`);
  const anywhere = await r2('session/create', { request: { cwd: scratch[1] } });
  check('workspace key: refused creating a session outside any workspace', anywhere.status === 403, `${anywhere.status}`);
  const promptB = await r2('session/rename', { request: { sessionId: b1, title: 'hijack' } });
  check('workspace key: refused changing a session in another workspace', promptB.status === 403);
  const cancelOwn = await r2('session/cancel', { request: { sessionId: a1 } });
  check('prompt key: may cancel in its scope', cancelOwn.status === 200, `${cancelOwn.status} ${cancelOwn.body?.error?.code ?? ''}`);

  // ── lifecycle ──
  await owner('PATCH', `/keys/${k2.key.id}`, { workspaces: [], sessions: [a2] });
  seen = ids(await r2('session/list', { _request: {} }));
  check('narrowing a key applies on the next request', seen.length === 1 && seen[0] === a2, seen.join(','));
  await owner('PATCH', `/keys/${k2.key.id}`, { api: false });
  const off = await r2('session/list', { _request: {} });
  check('per-key API switch: refused when the key has API off', off.status === 403 && off.body?.error?.code === 'dsh-control/key-surface');
  check('per-key API switch: the same key still works over MCP', !(await mcpTool(k2.token)('dsh_list_sessions', {})).isError);
  await owner('PATCH', `/keys/${k2.key.id}`, { api: true, disabled: true });
  check('disabled key is refused', (await r2('session/list', { _request: {} })).status === 401);
  await owner('PATCH', `/keys/${k2.key.id}`, { disabled: false, expiresAt: new Date(Date.now() - 1000).toISOString() });
  check('expired key is refused', (await r2('session/list', { _request: {} })).status === 401);
  await owner('PATCH', `/keys/${k2.key.id}`, { expiresAt: null });
  const rotated = await owner('POST', `/keys/${k2.key.id}/rotate`);
  check('rotation: old token refused, new token works', (await r2('session/list', { _request: {} })).status === 401 && (await api(rotated.token)('session/list', { _request: {} })).status === 200);

  // ── full-access key ──
  const k3 = await owner('POST', '/keys', { name: 'Full', mode: 'full', mcp: false, api: true });
  made.keys.push(k3.key.id);
  const all3 = ids(await api(k3.token)('session/list', { _request: {} }));
  check('full key sees everything', [a1, a2, b1, b2].every(id => all3.includes(id)));
  check('full key with MCP off is refused on MCP', (await mcpTool(k3.token)('dsh_overview')).status === 403);

  await owner('DELETE', `/keys/${k1.key.id}`);
  made.keys = made.keys.filter(id => id !== k1.key.id);
  check('deleted key is refused', (await r1('session/list', { _request: {} })).status === 401);
  check('key management refuses bearer tokens (owner browser only)', (await fetch(`${P}/keys`, { headers: { authorization: `Bearer ${ownerToken}` } })).status === 401);
} catch (error) {
  check('scope run', false, error.stack ?? String(error));
} finally {
  for (const id of made.keys) await owner('DELETE', `/keys/${id}`).catch(() => {});
  for (const id of made.sessions) {
    await asOwner('session/cancel', { request: { sessionId: id } }).catch(() => {});
    await asOwner('workspace/archiveSession', { request: { sessionId: id } }).catch(() => {});
  }
  for (const id of made.workspaces) await asOwner('workspace/delete', { request: { workspaceId: id } }).catch(() => {});
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
