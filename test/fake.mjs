/** A fake harness bridge with a handful of real-shaped descriptors. */
const str = { codec: { mode: 'strict', jsonSchema: { type: 'string' } } };
const obj = props => ({ codec: { mode: 'strict', jsonSchema: { type: 'object', properties: props, additionalProperties: true } } });

export const DESCRIPTORS = [
  { namespace: 'session', method: 'list', description: 'Read all visible Session rows.', parameters: [{ name: '_request', wire: '_request', source: 'json', ...obj({ cursor: { type: 'string' } }) }] },
  { namespace: 'session', method: 'state', description: 'Read passive Session state.', parameters: [{ name: 'request', wire: 'request', source: 'json', ...obj({ sessionId: { type: 'string' } }) }] },
  { namespace: 'session', method: 'prompt', description: 'Admit one prompt.', parameters: [{ name: 'request', wire: 'request', source: 'json', ...obj({}) }] },
  { namespace: 'session', method: 'wait', description: 'Wait for quiescence.', parameters: [{ name: 'request', wire: 'request', source: 'json', ...obj({}) }] },
  { namespace: 'session', method: 'page', description: 'Read a history page.', parameters: [{ name: 'request', wire: 'request', source: 'json', ...obj({}) }] },
  { namespace: 'session', method: 'cancel', description: 'Cancel a turn.', parameters: [{ name: 'request', wire: 'request', source: 'json', ...obj({}) }] },
  { namespace: 'workspace', method: 'follow', mode: 'stream', description: 'Stream workspaces.', parameters: [] },
  { namespace: 'job', method: 'list', mode: 'stream', description: 'Stream jobs.', parameters: [{ name: 'request', wire: 'request', source: 'json', ...obj({}) }] },
  { namespace: 'account', method: 'getState', description: 'Account state.', parameters: [] },
  { namespace: 'commands', method: 'execute', description: 'Execute a command.', parameters: [{ name: 'agentId', wire: 'agentId', source: 'lookup', lookup: 'agent', ...str }, { name: 'line', wire: 'line', source: 'json', ...str }] },
  { namespace: 'pluginManager', method: 'listPlugins', description: 'List plugins.', parameters: [] },
];

export function fakeBridge(settings = {}) {
  const bridge = {
    calls: [],
    streamsClosed: 0,
    list: () => DESCRIPTORS,
    settings: () => ({ mcpEnabled: true, apiEnabled: true, readOnly: false, exposeAllEndpoints: false, blockedEndpoints: [], maxResultBytes: 262144, ...settings }),
    info: () => ({ plugin: 'dsh-control-mcp', pluginVersion: '0.0.0-test', dshVersion: '0.2.2-test' }),
    async invoke(ns, method, args) {
      bridge.calls.push({ ns, method, args });
      const endpoint = `${ns}/${method}`;
      switch (endpoint) {
        case 'session/list': return [{ sessionId: 's1', running: false, updatedAt: 2, projections: { values: { title: 'First' } } }, { sessionId: 's2', origin: 'subagent', updatedAt: 3 }, { sessionId: 's3', blank: true, updatedAt: 4 }];
        case 'session/state': return { cursor: 7, running: false };
        case 'session/prompt': return { accepted: true };
        case 'session/wait': return { reason: 'idle', state: { cursor: 9 }, output: { records: [{ type: 'event', event: { type: 'message/assistant', seq: 8, data: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } }] } };
        case 'pluginManager/listPlugins': return { plugins: [] };
        case 'account/getState': return { signedIn: false };
        default: throw Object.assign(new Error(`typert gateway: ${endpoint}: no active Remote method exports this endpoint`), { code: 'gateway/invocation-unavailable' });
      }
    },
    async stream(ns, method, _args, signal) {
      const endpoint = `${ns}/${method}`;
      if (endpoint === 'workspace/follow') {
        return (async function* () {
          try {
            yield { type: 'baseline', workspaces: [{ id: 'w1', title: 'Home' }] };
            await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          } finally { bridge.streamsClosed += 1; }
        })();
      }
      return (async function* () {
        try { for (let i = 0; ; i += 1) { if (signal.aborted) return; yield { type: 'jobs', n: i }; await new Promise(r => setTimeout(r, 5)); } } finally { bridge.streamsClosed += 1; }
      })();
    },
  };
  return bridge;
}
