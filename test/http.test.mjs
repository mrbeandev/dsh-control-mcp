import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHttpHandler, sameOrigin, tokensEqual, ROUTE_PREFIX } from '../lib/http.mjs';
import { fakeBridge } from './fake.mjs';

const TOKEN = 'dshc_' + 'a'.repeat(43);
let server;
let base;
let settings;
let ownerCookie = 'owner=1';

before(async () => {
  settings = {};
  const bridge = fakeBridge();
  const real = bridge.settings;
  bridge.settings = () => ({ ...real(), ...settings });
  let token = TOKEN;
  const handler = createHttpHandler({
    bridge,
    getToken: () => token,
    rotateToken: async () => { token = 'dshc_' + 'b'.repeat(43); return token; },
    isOwnerBrowser: req => req.headers.cookie === ownerCookie,
  });
  server = createServer((req, res) => {
    if (req.url.startsWith(ROUTE_PREFIX)) handler(req, res); else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`;
});
after(() => new Promise(resolve => server.close(resolve)));

const auth = { authorization: `Bearer ${TOKEN}` };
const post = (path, body, headers = auth) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('access control', () => {
  it('compares tokens in constant time and refuses short ones', () => {
    assert.equal(tokensEqual(TOKEN, TOKEN), true);
    assert.equal(tokensEqual(TOKEN, TOKEN + 'x'), false);
    assert.equal(tokensEqual('short', 'short'), false);
    assert.equal(tokensEqual(undefined, undefined), false);
  });

  it('accepts same-origin and Origin-less requests only', () => {
    assert.equal(sameOrigin({ headers: { host: 'a:1' } }), true);
    assert.equal(sameOrigin({ headers: { host: 'a:1', origin: 'http://a:1' } }), true);
    assert.equal(sameOrigin({ headers: { host: 'a:1', origin: 'http://evil' } }), false);
    assert.equal(sameOrigin({ headers: { host: 'a:1', 'sec-fetch-site': 'cross-site' } }), false);
  });

  it('keeps both surfaces off until enabled', async () => {
    settings = { mcpEnabled: false, apiEnabled: false };
    assert.equal((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404);
    assert.equal((await fetch(`${base}/api/v1/info`, { headers: auth })).status, 404);
    const status = await (await fetch(`${base}/status`)).json();
    assert.deepEqual(status.value, { mcpEnabled: false, apiEnabled: false, readOnly: false, mcpPath: '/dsh-control-mcp/mcp', apiPath: '/dsh-control-mcp/api/v1' });
    settings = {};
  });

  it('requires the bearer token and refuses cross-origin callers', async () => {
    const missing = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, {});
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get('www-authenticate'), /Bearer/);
    assert.equal((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { ...auth, origin: 'http://evil.example' })).status, 403);
  });

  it('serves the token only to the owner browser session, never cross-origin', async () => {
    assert.equal((await fetch(`${base}/token`)).status, 401);
    assert.equal((await fetch(`${base}/token`, { headers: auth })).status, 401);
    assert.equal((await fetch(`${base}/token`, { headers: { cookie: ownerCookie, origin: 'http://evil.example' } })).status, 401);
    const read = await (await fetch(`${base}/token`, { headers: { cookie: ownerCookie } })).json();
    assert.equal(read.value.token, TOKEN);
    assert.equal((await fetch(`${base}/token/rotate`, { headers: { cookie: ownerCookie } })).status, 405);
    const rotated = await (await fetch(`${base}/token/rotate`, { method: 'POST', headers: { cookie: ownerCookie } })).json();
    assert.notEqual(rotated.value.token, TOKEN);
    assert.equal((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401, 'old token stops working');
    assert.equal((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Bearer ${rotated.value.token}` })).status, 200);
    auth.authorization = `Bearer ${rotated.value.token}`;
  });
});

describe('MCP over HTTP', () => {
  it('initializes, lists tools and calls one', async () => {
    const init = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.status, 200);
    assert.equal(init.headers.get('mcp-protocol-version'), '2025-06-18');
    assert.equal((await init.json()).result.serverInfo.name, 'dsh-control-mcp');
    assert.equal((await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const tools = await (await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    assert.ok(tools.result.tools.some(tool => tool.name === 'dsh_list_sessions'));
    const call = await (await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dsh_list_sessions', arguments: {} } })).json();
    assert.equal(call.result.structuredContent.sessions[0].sessionId, 's1');
  });

  it('answers parse errors, GET and DELETE per the transport spec', async () => {
    const bad = await post('/mcp', '{nope');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, -32700);
    assert.equal((await fetch(`${base}/mcp`, { headers: auth })).status, 405);
    assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE', headers: auth })).status, 204);
  });
});

describe('HTTP API', () => {
  it('reports info and the endpoint catalog', async () => {
    const info = await (await fetch(`${base}/api/v1/info`, { headers: auth })).json();
    assert.equal(info.ok, true);
    assert.equal(info.value.dshVersion, '0.2.2-test');
    const list = await (await fetch(`${base}/api/v1/endpoints?namespace=session`, { headers: auth })).json();
    assert.ok(list.value.endpoints.every(row => row.endpoint.startsWith('session/')));
    const one = await (await fetch(`${base}/api/v1/endpoints/commands/execute`, { headers: auth })).json();
    assert.deepEqual(one.value.inputSchema.required, ['agentId', 'line']);
    assert.equal((await fetch(`${base}/api/v1/endpoints/no/where`, { headers: auth })).status, 404);
  });

  it('calls unary endpoints and maps errors to HTTP statuses', async () => {
    const ok = await (await post('/api/v1/call/session/state', { request: { sessionId: 's1' } })).json();
    assert.deepEqual(ok, { ok: true, value: { cursor: 7, running: false } });
    const missing = await post('/api/v1/call/session/missing', {});
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'gateway/invocation-unavailable');
    assert.equal((await post('/api/v1/call/session/state', '[1]')).status, 400);
    assert.equal((await fetch(`${base}/api/v1/call/session/state`, { headers: auth })).status, 405);
  });

  it('enforces read-only mode over HTTP too', async () => {
    settings = { readOnly: true };
    const refused = await post('/api/v1/call/session/prompt', { request: {} });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, 'dsh-control/read-only');
    settings = {};
  });

  it('collects streams as JSON and relays them as Server-Sent Events', async () => {
    const collected = await (await post('/api/v1/stream/job/list', { args: { request: {} }, maxItems: 3 })).json();
    assert.equal(collected.value.count, 3);
    const sse = await post('/api/v1/stream/job/list', { args: { request: {} }, maxItems: 2 }, { ...auth, accept: 'text/event-stream' });
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    const text = await sse.text();
    assert.equal((text.match(/event: item/g) ?? []).length, 2);
    assert.match(text, /event: end/);
    assert.equal((await post('/api/v1/stream/session/state', { args: {} }, { ...auth, accept: 'text/event-stream' })).status, 400);
  });

  it('runs curated tools', async () => {
    const tools = await (await fetch(`${base}/api/v1/tools`, { headers: auth })).json();
    assert.ok(tools.value.tools.length >= 10);
    const ws = await (await post('/api/v1/tools/dsh_list_workspaces', {})).json();
    assert.equal(ws.value.workspaces[0].id, 'w1');
  });
});
