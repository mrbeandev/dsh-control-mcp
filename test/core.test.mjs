import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURATED_TOOLS, ControlError, boundedJson, callEndpoint, collectStream, endpointMatches, endpointToolName, errorInfo,
  handleMcpMessage, inputSchemaFor, isReadOnlyEndpoint, listTools, messagesFrom, runTool, safeJson,
} from '../lib/core.mjs';
import { fakeBridge } from './fake.mjs';

describe('endpoint classification', () => {
  it('treats reading verbs as read-only and everything else as a change', () => {
    for (const ep of ['session/list', 'session/page', 'session/state', 'session/wait', 'workspace/follow', 'pluginManager/listPlugins', 'goals/get', 'job/list', 'settings/describe', 'schedule/catalog']) {
      const [ns, m] = ep.split('/');
      assert.equal(isReadOnlyEndpoint(ns, m), true, ep);
    }
    for (const ep of ['session/prompt', 'session/create', 'session/cancel', 'pluginManager/setPluginEnabled', 'pluginManager/removeBundle', 'settings/mutate', 'credentials/set', 'terminal/create', 'forgePanel/changeRequestReviewWrite', 'account/signOut', 'workspace/delete']) {
      const [ns, m] = ep.split('/');
      assert.equal(isReadOnlyEndpoint(ns, m), false, ep);
    }
  });

  it('matches blocked patterns as whole-endpoint globs', () => {
    assert.equal(endpointMatches('account/*', 'account/signOut'), true);
    assert.equal(endpointMatches('*/delete', 'workspace/delete'), true);
    assert.equal(endpointMatches('session/prompt', 'session/promptX'), false);
    assert.equal(endpointMatches('session.prompt', 'sessionXprompt'), false);
    assert.equal(endpointMatches('', 'a/b'), false);
  });

  it('builds argument schemas from descriptors and marks lookups', () => {
    const schema = inputSchemaFor({ parameters: [
      { wire: 'agentId', source: 'lookup', lookup: 'agent', codec: { jsonSchema: { type: 'string' } } },
      { wire: 'line', source: 'json', codec: { jsonSchema: { type: 'string' } } },
      { wire: 'cursor', source: 'json', acceptsUndefined: true, codec: { mode: 'src-json' } },
    ] });
    assert.deepEqual(schema.required, ['agentId', 'line']);
    assert.match(schema.properties.agentId.description, /session id/);
    assert.equal(schema.additionalProperties, false);
  });
});

describe('calls and policy', () => {
  it('forwards unary calls with exact named args', async () => {
    const bridge = fakeBridge();
    const value = await callEndpoint(bridge, 'session/state', { request: { sessionId: 's1' } });
    assert.deepEqual(value, { cursor: 7, running: false });
    assert.deepEqual(bridge.calls.at(-1), { ns: 'session', method: 'state', args: { request: { sessionId: 's1' } } });
  });

  it('refuses changes in read-only mode and blocked endpoints, before the harness sees them', async () => {
    const bridge = fakeBridge({ readOnly: true, blockedEndpoints: ['account/*'] });
    await assert.rejects(callEndpoint(bridge, 'session/prompt', { request: {} }), err => err.code === 'dsh-control/read-only' && err.status === 403);
    await assert.rejects(callEndpoint(bridge, 'account/getState', {}), err => err.code === 'dsh-control/blocked');
    assert.equal(bridge.calls.length, 0);
    assert.deepEqual(await callEndpoint(bridge, 'session/list', { _request: {} }), [{ sessionId: 's1', running: false, updatedAt: 2, projections: { values: { title: 'First' } } }, { sessionId: 's2', origin: 'subagent', updatedAt: 3 }, { sessionId: 's3', blank: true, updatedAt: 4 }]);
  });

  it('rejects malformed endpoints and non-object args', async () => {
    const bridge = fakeBridge();
    await assert.rejects(callEndpoint(bridge, '../etc', {}), err => err.code === 'dsh-control/endpoint-invalid');
    await assert.rejects(callEndpoint(bridge, 'session/list', []), err => err.code === 'dsh-control/arguments-invalid');
    await assert.rejects(callEndpoint(bridge, 'workspace/follow', {}), err => err.code === 'dsh-control/stream-endpoint');
  });

  it('collects stream items up to maxItems and closes the stream', async () => {
    const bridge = fakeBridge();
    const result = await collectStream(bridge, 'job/list', { request: {} }, { maxItems: 2 });
    assert.equal(result.count, 2);
    assert.equal(result.ended, 'maxItems');
    assert.equal(bridge.streamsClosed, 1);
  });

  it('stops a quiet stream at timeoutMs', async () => {
    const bridge = fakeBridge();
    const started = Date.now();
    const result = await collectStream(bridge, 'workspace/follow', {}, { maxItems: 5, timeoutMs: 120 });
    assert.equal(result.count, 1);
    assert.equal(result.ended, 'timeout');
    assert.ok(Date.now() - started < 2000);
  });

  it('maps harness errors to stable codes and statuses', () => {
    assert.deepEqual(errorInfo(Object.assign(new Error('nope'), { code: 'remote-access/denied' })).status, 403);
    assert.equal(errorInfo(Object.assign(new Error('x'), { code: 'gateway/input-invalid' })).status, 400);
    assert.equal(errorInfo(new Error('boom')).code, 'internal');
    assert.equal(errorInfo(new ControlError('a/b', 'c', 409)).status, 409);
  });
});

describe('values', () => {
  it('turns bytes, maps, bigints and cycles into JSON', () => {
    const cyclic = { a: 1 }; cyclic.self = cyclic;
    const out = safeJson({ b: new Uint8Array([1, 2, 3]), m: new Map([['k', 1n]]), cyclic, f: () => 1 });
    assert.deepEqual(out.b, { $bytes: 'AQID', byteLength: 3 });
    assert.deepEqual(out.m, [['k', '1']]);
    assert.equal(out.cyclic.self, '[circular]');
    assert.equal('f' in out, false);
  });

  it('bounds result text and says how to narrow it', () => {
    const { text, truncated } = boundedJson({ big: 'x'.repeat(10000) }, 4096);
    assert.equal(truncated, true);
    assert.ok(Buffer.byteLength(text) < 4400);
    assert.match(text, /truncated/);
  });

  it('extracts role/text messages from page records', () => {
    const page = { records: [
      { type: 'event', event: { type: 'message/user', seq: 1, data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'event', event: { type: 'message/assistant', seq: 2, data: { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'image' }] } } },
      { type: 'event', event: { type: 'tool/call', seq: 3, data: { name: 'bash' } } },
    ] };
    assert.deepEqual(messagesFrom(page), [{ seq: 1, role: 'user', text: 'hi' }, { seq: 2, role: 'assistant', text: 'hello\n[image]' }]);
  });
});

describe('curated tools', () => {
  it('hide write tools in read-only mode and add endpoint tools on request', () => {
    const names = listTools(fakeBridge()).map(tool => tool.name);
    assert.deepEqual(names, CURATED_TOOLS.map(tool => tool.name));
    const readOnly = listTools(fakeBridge({ readOnly: true })).map(tool => tool.name);
    assert.ok(!readOnly.includes('dsh_send_prompt') && !readOnly.includes('dsh_call'));
    assert.ok(readOnly.includes('dsh_list_sessions'));
    const all = listTools(fakeBridge({ exposeAllEndpoints: true })).map(tool => tool.name);
    assert.ok(all.includes(endpointToolName('session', 'prompt')));
    assert.ok(all.every(name => /^[A-Za-z0-9_-]{1,64}$/.test(name)));
  });

  it('lists visible sessions newest first with titles', async () => {
    const value = await runTool(fakeBridge(), 'dsh_list_sessions', {});
    assert.deepEqual(value.sessions, [{ sessionId: 's1', title: 'First', running: false, updatedAt: 2 }]);
    assert.equal(value.total, 3);
  });

  it('sends a prompt with a fresh request id and waits for the reply', async () => {
    const bridge = fakeBridge();
    const value = await runTool(bridge, 'dsh_send_prompt', { sessionId: 's1', text: 'do it', wait: true, timeoutMs: 5000 });
    const prompt = bridge.calls.find(call => call.method === 'prompt');
    assert.equal(prompt.args.request.sessionId, 's1');
    assert.equal(prompt.args.request.mode, 'queue');
    assert.match(prompt.args.request.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(prompt.args.request.content, [{ type: 'text', text: 'do it' }]);
    const wait = bridge.calls.find(call => call.method === 'wait');
    assert.equal(wait.args.request.afterSeq, 7);
    assert.equal(value.reason, 'idle');
    assert.equal(value.reply, 'done');
  });

  it('refuses an empty prompt and unknown tools', async () => {
    await assert.rejects(runTool(fakeBridge(), 'dsh_send_prompt', { sessionId: 's1', text: '  ' }), /non-empty/);
    await assert.rejects(runTool(fakeBridge(), 'nope', {}), err => err.status === 404);
    await assert.rejects(runTool(fakeBridge({ readOnly: true }), 'dsh_call', { endpoint: 'session/list' }), err => err.code === 'dsh-control/read-only');
  });
});

describe('MCP JSON-RPC', () => {
  it('negotiates the protocol version and advertises tools', async () => {
    const bridge = fakeBridge();
    const init = await handleMcpMessage(bridge, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.result.serverInfo.name, 'dsh-control-mcp');
    const odd = await handleMcpMessage(bridge, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal(odd.result.protocolVersion, '2025-06-18');
    assert.equal(await handleMcpMessage(bridge, { jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    const list = await handleMcpMessage(bridge, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const send = list.result.tools.find(tool => tool.name === 'dsh_send_prompt');
    assert.equal(send.annotations.readOnlyHint, false);
    assert.deepEqual(send.inputSchema.required, ['sessionId', 'text']);
  });

  it('returns tool results as text plus structured content, and tool failures as isError', async () => {
    const bridge = fakeBridge();
    const ok = await handleMcpMessage(bridge, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dsh_call', arguments: { endpoint: 'session/state', args: { request: { sessionId: 's1' } } } } });
    assert.equal(ok.result.isError, false);
    assert.deepEqual(JSON.parse(ok.result.content[0].text), { cursor: 7, running: false });
    assert.deepEqual(ok.result.structuredContent, { cursor: 7, running: false });
    const failed = await handleMcpMessage(bridge, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'dsh_call', arguments: { endpoint: 'session/missing', args: {} } } });
    assert.equal(failed.result.isError, true);
    assert.match(failed.result.content[0].text, /gateway\/invocation-unavailable/);
    const unknown = await handleMcpMessage(bridge, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'zzz' } });
    assert.equal(unknown.error.code, -32602);
  });

  it('handles batches, unknown methods and invalid messages', async () => {
    const bridge = fakeBridge();
    const batch = await handleMcpMessage(bridge, [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'bogus' }]);
    assert.equal(batch.length, 2);
    assert.deepEqual(batch[0].result, {});
    assert.equal(batch[1].error.code, -32601);
    assert.equal((await handleMcpMessage(bridge, { id: 1, method: 'ping' })).error.code, -32600);
    assert.equal((await handleMcpMessage(bridge, [])).error.code, -32600);
  });
});

describe('plugin list summary', () => {
  it('compacts rows and filters by query', async () => {
    const bridge = fakeBridge();
    bridge.invoke = async () => [
      { entryId: 'dsh-control-mcp', moduleName: 'dsh-control-mcp', enabled: true, fiberPhase: 'active', meta: { title: { en: 'Harness control', zh: 'x' } } },
      { entryId: 'include', moduleName: 'cordis:include', enabled: true, fiberPhase: 'active', readOnlyReason: 'unaddressable' },
    ];
    const value = await runTool(bridge, 'dsh_list_plugins', { query: 'control' });
    assert.deepEqual(value, { count: 1, plugins: [{ entryId: 'dsh-control-mcp', moduleName: 'dsh-control-mcp', enabled: true, phase: 'active', title: 'Harness control' }] });
  });
});

describe('message extraction from real page records', () => {
  it('skips injected context, keeps prompts and replies, surfaces turn errors', () => {
    const records = [
      { type: 'event', event: { seq: 8, type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'You are' }] } } } },
      { type: 'event', event: { seq: 9, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ping' }] } } },
      { type: 'event', event: { seq: 10, type: 'user/message', data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '<system-reminder>' }] } } },
      { type: 'event', event: { seq: 11, type: 'user/message', data: { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'skills' }] } } },
      { type: 'event', event: { seq: 12, type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] } } },
      { type: 'event', event: { seq: 13, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'no API key' } } } } },
    ];
    assert.deepEqual(messagesFrom({ records }), [
      { seq: 9, role: 'user', text: 'ping' },
      { seq: 12, role: 'assistant', text: 'pong' },
      { seq: 13, role: 'error', text: 'no API key' },
    ]);
  });
});

describe('wait fallback', () => {
  it('reports a turn error from the page when the wait has no assistant output', async () => {
    const bridge = fakeBridge();
    const invoke = bridge.invoke;
    bridge.invoke = async (ns, method, args) => {
      if (method === 'wait') { bridge.calls.push({ ns, method, args }); return { reason: 'idle', state: { cursor: 9 }, output: { records: [] } }; }
      if (method === 'page') return { records: [
        { type: 'event', event: { seq: 5, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'old' } } } } },
        { type: 'event', event: { seq: 9, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'no API key' } } } } },
      ] };
      return invoke(ns, method, args);
    };
    const value = await runTool(bridge, 'dsh_send_prompt', { sessionId: 's1', text: 'x', wait: true });
    assert.equal(value.reply, '');
    assert.equal(value.error, 'no API key');
  });
});

describe('DSH 0.2.1 fallbacks (no session/state or session/wait; page needs throughSeq)', () => {
  function oldBridge() {
    const bridge = fakeBridge();
    const descriptors = bridge.list()
      .filter(d => !(d.namespace === 'session' && ['state', 'wait'].includes(d.method)))
      .map(d => d.namespace === 'session' && d.method === 'page'
        ? { ...d, parameters: [{ ...d.parameters[0], codec: { mode: 'strict', jsonSchema: { type: 'object', required: ['address', 'throughSeq'] } } }] }
        : d);
    let running = true;
    bridge.list = () => descriptors;
    bridge.invoke = async (ns, method, args) => {
      bridge.calls.push({ ns, method, args });
      const ep = `${ns}/${method}`;
      if (ep === 'session/list') { const row = { sessionId: 's1', running, projections: { asOfSeq: running ? 4 : 18 } }; running = false; return { items: [row] }; }
      if (ep === 'session/prompt') return { accepted: true };
      if (ep === 'session/page') {
        if (!Number.isFinite(args.request.throughSeq)) throw Object.assign(new Error('boundary'), { code: 'gateway/input-invalid' });
        return { records: [
          { type: 'event', event: { seq: 8, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } } },
          { type: 'event', event: { seq: 17, type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } } },
        ] };
      }
      throw Object.assign(new Error(`no ${ep}`), { code: 'gateway/invocation-unavailable' });
    };
    return bridge;
  }

  it('reads history with throughSeq from the session projection', async () => {
    const bridge = oldBridge();
    const value = await runTool(bridge, 'dsh_read_session', { sessionId: 's1' });
    assert.deepEqual(value.messages.map(m => m.text), ['hi', 'hello']);
    assert.equal(bridge.calls.find(c => c.method === 'page').args.request.throughSeq, 4);
  });

  it('waits by polling session/list and reads the reply from the page', async () => {
    const bridge = oldBridge();
    const value = await runTool(bridge, 'dsh_send_prompt', { sessionId: 's1', text: 'hi', wait: true, timeoutMs: 5000 });
    assert.equal(value.reason, 'idle');
    assert.equal(value.reply, 'hello');
    assert.ok(!bridge.calls.some(c => c.method === 'wait' || c.method === 'state'));
  });
});

describe('schemas on DSH 0.2.0 (no precomputed jsonSchema)', () => {
  it('derives argument schemas from the codec parser', () => {
    const parser = { toJSONSchema: () => ({ $schema: 'x', type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] }) };
    const schema = inputSchemaFor({ parameters: [{ wire: 'request', source: 'json', codec: { mode: 'strict', create: () => parser } }] });
    assert.deepEqual(schema.properties.request, { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] });
    const broken = inputSchemaFor({ parameters: [{ wire: 'x', source: 'json', codec: { create: () => { throw new Error('no'); } } }] });
    assert.deepEqual(broken.properties.x, {});
  });
});
