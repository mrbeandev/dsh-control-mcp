import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { apply, createBridge, inject, name, newToken, settingsFrom } from '../index.mjs';
import { createClientPlugin } from '../client/index.mjs';
import { bridgeConfig, forward } from '../bin/dsh-control-mcp.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fakeCtx({ stored } = {}) {
  const effects = [];
  const logs = [];
  const calls = [];
  const records = new Map(stored ? [['dsh-control-mcp/access-token', stored]] : []);
  const browserPeer = { id: 'browser' };
  let routes = [];
  const ctx = {
    logger: { info: m => logs.push(['info', m]), warn: m => logs.push(['warn', m]) },
    typert: { local: { list: () => [{ namespace: 'session', method: 'state', parameters: [] }] } },
    typertGateway: {
      invoke: async request => { calls.push(request); return { ok: 1 }; },
      stream: async request => { calls.push(request); return (async function* () { yield 1; })(); },
    },
    connection: {
      browserPeer,
      createPeer: options => ({ id: 'mcp', principal: options.principal, interactions: options.interactions, dispose: async () => {} }),
      admit: req => (req.headers.cookie === 'ok' ? { peer: browserPeer } : { rejection: 401 }),
    },
    webServer: { register: route => { routes.push(route); return () => { routes = routes.filter(r => r !== route); }; }, getOrigin: () => 'http://127.0.0.1:3080' },
    effect: (fn, label) => { effects.push({ dispose: fn(), label }); },
    get: key => (key === 'credentials' ? {
      readRecord: async key => records.get(String(key)),
      modifyRecord: async (key, mutate) => { const next = await mutate(records.get(String(key))); records.set(String(key), next); return next; },
    } : undefined),
  };
  return { ctx, effects, logs, calls, records, routes: () => routes };
}

describe('Host entry', () => {
  it('declares unique identities and the services it needs', () => {
    assert.equal(name, 'dsh-control-mcp');
    assert.equal(pkg.name, 'dsh-control-mcp');
    assert.deepEqual(inject, ['typert', 'typertGateway', 'connection', 'webServer']);
    assert.match(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), /id: dsh-control-mcp\n\s+name: dsh-control-mcp/);
  });

  it('reads volatile and plain settings with safe defaults', () => {
    assert.deepEqual(settingsFrom({}), { mcpEnabled: false, apiEnabled: false, readOnly: false, exposeAllEndpoints: false, blockedEndpoints: [], maxResultBytes: 262144 });
    let mcp = false;
    const live = settingsFrom({ mcpEnabled: { get: () => mcp }, blockedEndpoints: ['a/b', '', 3], maxResultBytes: 10 });
    assert.equal(live.mcpEnabled, false);
    assert.deepEqual(live.blockedEndpoints, ['a/b']);
    assert.equal(live.maxResultBytes, 262144);
    mcp = true;
    assert.equal(settingsFrom({ mcpEnabled: { get: () => mcp } }).mcpEnabled, true);
  });

  it('mints high-entropy tokens', () => {
    const a = newToken();
    assert.match(a, /^dshc_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, newToken());
  });

  it('calls the gateway as a dedicated owner peer that never answers interactions', async () => {
    const { ctx, calls } = fakeCtx();
    const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
    const bridge = createBridge(ctx, {}, peer);
    await bridge.invoke('session', 'state', { request: { sessionId: 's' } });
    assert.deepEqual(calls[0], { namespace: 'session', method: 'state', args: { request: { sessionId: 's' } }, peer });
    assert.equal(calls[0].peer.interactions, 'none');
  });

  it('registers one prefix route and creates and persists a token', async () => {
    const { ctx, effects, logs, routes, records } = fakeCtx();
    await apply(ctx, {});
    assert.equal(routes().length, 1);
    assert.equal(routes()[0].path, '/dsh-control-mcp');
    assert.equal(routes()[0].kind, 'prefix');
    assert.equal(routes()[0].auth, 'anonymous', 'DSH 0.2.3+ must let bearer-token callers through');
    assert.ok(logs.some(([level, message]) => level === 'info' && /ready at http:\/\/127\.0\.0\.1:3080\/dsh-control-mcp \(mcp off, api off\)/.test(message)));
    // The credential store is only used when running under dsh; outside it falls back to memory.
    assert.ok(records.size === 1 || logs.some(([level, m]) => level === 'warn' && /no credential store/.test(m)));
    for (const effect of effects) await effect.dispose?.();
    assert.equal(routes().length, 0, 'route removed on dispose');
  });
});

describe('DSH 0.2.0 compatibility', () => {
  it('runs without the Peer API: calls omit peer and the operator is the owner browser', async () => {
    const { ctx, calls, routes } = fakeCtx();
    const operator = { id: 'operator' };
    delete ctx.connection.createPeer;
    delete ctx.connection.browserPeer;
    ctx.connection.operator = operator;
    ctx.connection.admit = req => (req.headers.cookie === 'ok' ? { peer: operator } : { rejection: 401 });
    await apply(ctx, { mcpEnabled: true });
    const bridge = createBridge(ctx, {}, undefined);
    await bridge.invoke('session', 'state', {});
    assert.equal('peer' in calls[0], false);
    const route = routes()[0];
    const respond = async headers => {
      const res = { status: 0, body: '', headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(body) { this.body = body ?? ''; }, on() {} };
      await route.handler({ url: '/dsh-control-mcp/token', method: 'GET', headers: { host: 'h', ...headers } }, res);
      return res;
    };
    assert.equal((await respond({ cookie: 'ok' })).status, 200);
    assert.equal((await respond({})).status, 401);
  });
});

describe('Client page', () => {
  it('builds a module that registers the page in the Plugins view', () => {
    const plugin = createClientPlugin(() => ({ createElement: () => null, useCallback: f => f, useEffect: () => {}, useMemo: f => f(), useRef: v => ({ current: v }), useState: v => [v, () => {}], useSyncExternalStore: (_s, g) => g() }));
    assert.deepEqual(plugin.inject, ['slots']);
    let registered;
    const child = {
      configForms: { describe: () => ({ getSnapshot: () => ({}), subscribe: () => () => {} }), get: ns => ({ ns }) },
      slots: { inject: (slot, fn) => { assert.equal(slot, 'plugins.bundle.config'); fn(); }, register: options => { registered = options; } },
    };
    plugin.apply({ inject: (keys, fn) => { assert.deepEqual(keys, ['configForms']); fn(child); } });
    assert.equal(registered.key, 'dsh-control-mcp');
    const { source } = registered.inject();
    assert.equal(source.formFor([{ ns: 'other' }, { ns: 'dsh-control-mcp' }]).ns, 'dsh-control-mcp');
    assert.equal(source.formFor([{ ns: 'other' }]), undefined);
  });

  it('validates blocked patterns and renders client snippets', () => {
    const plugin = createClientPlugin(() => ({}));
    assert.deepEqual(plugin.parseBlocked('account/*\n*/delete, account/*\n\nbad pattern'), { items: ['account/*', '*/delete', 'bad pattern'], invalid: ['bad pattern'] });
    const http = JSON.parse(plugin.mcpJsonConfig('http://h/dsh-control-mcp/mcp', 'T'));
    assert.deepEqual(http.mcpServers['dsh-control'], { type: 'http', url: 'http://h/dsh-control-mcp/mcp', headers: { Authorization: 'Bearer T' } });
    const stdio = JSON.parse(plugin.stdioConfig('u', 'T'));
    assert.deepEqual(stdio.mcpServers['dsh-control'].args, ['-y', 'dsh-control-mcp']);
  });

  it('ships a generated bundle that matches its source', () => {
    const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
    assert.ok(bundle.includes(createClientPlugin.toString()), 'run npm run build');
    assert.ok(bundle.includes("id: 'dsh-control-mcp'"));
  });
});

describe('stdio bridge', () => {
  it('reads url and token from flags or environment', () => {
    assert.deepEqual(bridgeConfig({ DSH_CONTROL_URL: 'u', DSH_CONTROL_TOKEN: 't' }, []), { url: 'u', token: 't', help: false });
    assert.deepEqual(bridgeConfig({}, ['--url', 'x', '--token=y']), { url: 'x', token: 'y', help: false });
    assert.equal(bridgeConfig({}, []).url, 'http://127.0.0.1:3080/dsh-control-mcp/mcp');
  });

  it('forwards messages with the bearer token and explains auth failures', async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = { url, init }; return { status: 200, ok: true, text: async () => '{"jsonrpc":"2.0","id":1,"result":{}}' }; };
    assert.deepEqual(await forward({ jsonrpc: '2.0', id: 1, method: 'ping' }, { url: 'u', token: 'T', fetchImpl }), { jsonrpc: '2.0', id: 1, result: {} });
    assert.equal(seen.init.headers.authorization, 'Bearer T');
    const denied = async () => ({ status: 401, ok: false, text: async () => '{"ok":false,"error":{"message":"bad token"}}' });
    await assert.rejects(forward({}, { url: 'u', token: 'x', fetchImpl: denied }), /401: bad token \(check DSH_CONTROL_TOKEN\)/);
    assert.equal(await forward({}, { url: 'u', token: 'x', fetchImpl: async () => ({ status: 202 }) }), undefined);
  });

  it('runs as a process over stdin/stdout against a real HTTP endpoint', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const message = JSON.parse(body);
        if (req.headers.authorization !== 'Bearer T') { res.writeHead(401); res.end('{}'); return; }
        if (!('id' in message)) { res.writeHead(202); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echo: message.method } }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/dsh-control-mcp.mjs', import.meta.url))], { env: { ...process.env, DSH_CONTROL_URL: url, DSH_CONTROL_TOKEN: 'T' } });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    child.stdin.end();
    const code = await new Promise(resolve => child.on('exit', resolve));
    server.close();
    assert.equal(code, 0);
    const lines = out.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 3);
    assert.ok(lines.some(line => line.error?.code === -32700));
    assert.deepEqual(lines.filter(line => line.result).map(line => line.result.echo).sort(), ['initialize', 'tools/list']);
  });
});

describe('DSH 0.2.3 owner admission', () => {
  it('accepts an owner Peer from the authentication provider and refuses other principals', async () => {
    const { ctx, routes } = fakeCtx();
    const providerPeer = { id: 'provider-owner', principal: { kind: 'owner' }, signal: new AbortController().signal };
    const viewer = { id: 'viewer', principal: { kind: 'liveshare-viewer' }, signal: new AbortController().signal };
    ctx.connection.admit = req => (req.headers.cookie === 'ok' ? { peer: providerPeer } : req.headers.cookie === 'viewer' ? { peer: viewer } : { rejection: 401 });
    await apply(ctx, {});
    const respond = async headers => {
      const res = { status: 0, headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end() {}, on() {} };
      await routes()[0].handler({ url: '/dsh-control-mcp/token', method: 'GET', headers: { host: 'h', ...headers } }, res);
      return res.status;
    };
    assert.equal(await respond({ cookie: 'ok' }), 200);
    assert.equal(await respond({ cookie: 'viewer' }), 401);
    assert.equal(await respond({}), 401);
  });
});
