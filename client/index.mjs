/**
 * Self-contained factory: scripts/build-client.mjs embeds it in lib/client.js
 * without bundling another React.
 *
 * Registers this plugin's page in the Plugins view (`plugins.bundle.config`,
 * keyed by the package name): MCP and HTTP API switches, read-only mode,
 * per-endpoint tools, blocked endpoints, the access token (show, copy,
 * rotate) and ready-to-paste client configuration. Settings live in the Host
 * entry's volatile Config, edited through the `configForms` service. The
 * token is read from the Host's owner-only `/dsh-control-mcp/token` route.
 */
export function createClientPlugin(require) {
  const React = require('react');
  const { createElement: h, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;
  const PACKAGE = 'dsh-control-mcp';
  const ENTRY_ID = 'dsh-control-mcp';
  const ROUTE = '/dsh-control-mcp';
  const inject = ['slots'];
  const SAVE_ERROR = 'Could not save this setting. It may have changed elsewhere; review the current value and try again.';
  const SWITCHES = [
    { field: 'mcpEnabled', label: 'MCP server', hint: 'Serve the MCP endpoint so MCP clients (Claude, Codex, Cursor, another DSH…) can control this harness.' },
    { field: 'apiEnabled', label: 'HTTP API', hint: 'Serve a JSON and Server-Sent Events API for scripts and other programs.' },
    { field: 'readOnly', label: 'Read-only mode', hint: 'Allow only calls that read. Prompts, creating sessions, plugin changes and every other change are refused.' },
    { field: 'exposeAllEndpoints', label: 'One MCP tool per endpoint', hint: 'Also list every harness endpoint as its own MCP tool (about 200). The curated tools and dsh_call already reach all of them.' },
  ];

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /** Settings namespace of this plugin's Host entry among the served ones. */
  function findEntryNamespace(namespaces) {
    const ids = (Array.isArray(namespaces) ? namespaces : []).map(view => view?.ns).filter(id => typeof id === 'string');
    return ids.find(id => id === `include:${ENTRY_ID}`)
      ?? ids.find(id => id === ENTRY_ID)
      ?? ids.find(id => id.endsWith(`:${ENTRY_ID}`));
  }

  /** Parse the blocked-endpoints textarea: one pattern per line or comma. */
  function parseBlocked(text) {
    const items = String(text ?? '').split(/[\n,]/).map(item => item.trim()).filter(Boolean);
    const invalid = items.filter(item => !/^[A-Za-z0-9_*-]+\/[A-Za-z0-9_*-]+$/.test(item));
    return { items: [...new Set(items)], invalid };
  }

  function originUrl(path) {
    try {
      return new URL(path, window.location.href).toString();
    } catch {
      return path;
    }
  }

  function mcpJsonConfig(url, token) {
    return JSON.stringify({ mcpServers: { 'dsh-control': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  }

  function stdioConfig(url, token) {
    return JSON.stringify({ mcpServers: { 'dsh-control': { command: 'npx', args: ['-y', 'dsh-control-mcp'], env: { DSH_CONTROL_URL: url, DSH_CONTROL_TOKEN: token } } } }, null, 2);
  }

  async function tokenRequest(path, method) {
    const response = await fetch(`${ROUTE}${path}`, { method, credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || body?.ok !== true || typeof body?.value?.token !== 'string') throw new Error('token request failed');
    return body.value.token;
  }

  const styles = {
    page: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
    head: { display: 'flex', flexDirection: 'column', gap: '4px' },
    title: { margin: 0, fontSize: '14px', fontWeight: 500, lineHeight: '20px' },
    lead: { margin: 0, color: 'var(--dsw-alias-label-secondary)' },
    card: { display: 'flex', flexDirection: 'column', borderRadius: 'var(--dsw-radius-md, 8px)', border: '.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-1)' },
    row: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', padding: '12px 14px', borderBottom: '.5px solid var(--dsw-alias-border-l2)' },
    rowLast: { borderBottom: 0 },
    rowText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
    label: { fontSize: '13.5px', fontWeight: 500 },
    hint: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
    section: { display: 'flex', flexDirection: 'column', gap: '8px' },
    sectionTitle: { margin: 0, fontSize: '13px', fontWeight: 500 },
    status: { margin: 0, color: 'var(--dsw-alias-label-tertiary)' },
    error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' },
    ok: { margin: 0, color: 'var(--dsw-alias-state-success-primary, #39a869)' },
    warn: { margin: 0, padding: '8px 12px', borderRadius: 'var(--dsw-radius-md, 8px)', background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d08a00) 12%, transparent)', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' },
    code: { margin: 0, padding: '8px 10px', borderRadius: 'var(--dsw-radius-md, 8px)', background: 'var(--dsw-alias-bg-layer-3)', border: '.5px solid var(--dsw-alias-border-l3)', fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: '12px', lineHeight: '18px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
    inline: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
    input: { flex: 1, minWidth: '220px', height: '30px', padding: '0 10px', boxSizing: 'border-box', borderRadius: 'var(--dsw-radius-md, 8px)', border: '.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', color: 'inherit', font: 'inherit', fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: '12px' },
    textarea: { width: '100%', minHeight: '64px', padding: '8px 10px', boxSizing: 'border-box', borderRadius: 'var(--dsw-radius-md, 8px)', border: '.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', color: 'inherit', font: 'inherit', fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: '12px', resize: 'vertical' },
    button: { height: '28px', padding: '0 12px', borderRadius: 'var(--dsw-radius-md, 8px)', border: '.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', color: 'inherit', font: 'inherit', fontSize: '12.5px', cursor: 'pointer' },
    primary: { background: 'var(--dsw-alias-brand-primary)', borderColor: 'transparent', color: 'var(--dsw-alias-label-on-brand, #fff)' },
    disabled: { opacity: 0.5, cursor: 'not-allowed' },
    tabs: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
  };

  function buttonStyle(primary, disabled) {
    return { ...styles.button, ...primary ? styles.primary : {}, ...disabled ? styles.disabled : {} };
  }

  const emptyMirror = { view: undefined };
  const unavailableSnapshot = { status: 'unavailable', value: undefined, revision: undefined, writable: false };
  const noForm = { getSnapshot: () => unavailableSnapshot, subscribe: () => () => {}, mutate: async () => false };

  function useStore(store, fallback) {
    const subscribe = useCallback(listener => (store ? store.subscribe(listener) : () => {}), [store]);
    const getSnapshot = useCallback(() => (store ? store.getSnapshot() : fallback), [store, fallback]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  function Switch({ id, checked, disabled, label, onChange }) {
    return h('input', {
      id, type: 'checkbox', role: 'switch', checked, disabled, 'aria-label': label,
      style: { width: '18px', height: '18px', flex: 'none', marginTop: '2px', cursor: disabled ? 'not-allowed' : 'pointer' },
      onChange: event => onChange(event.target.checked),
    });
  }

  function CopyButton({ text, label = 'Copy', disabled }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => { if (!copied) return undefined; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
    return h('button', {
      type: 'button', style: buttonStyle(false, disabled), disabled,
      onClick: async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* clipboard blocked; text stays selectable */ } },
    }, copied ? 'Copied' : label);
  }

  function TokenSection({ enabled }) {
    const [token, setToken] = useState('');
    const [state, setState] = useState('idle');
    const [visible, setVisible] = useState(false);
    const [tab, setTab] = useState('http');
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);

    const load = useCallback(async () => {
      setState('loading');
      try {
        const value = await tokenRequest('/token', 'GET');
        if (mounted.current) { setToken(value); setState('ready'); }
      } catch {
        if (mounted.current) setState('error');
      }
    }, []);
    useEffect(() => { if (enabled) void load(); }, [enabled, load]);

    const rotate = async () => {
      if (!window.confirm('Rotate the access token? Every MCP and API client using the current token stops working until you update it.')) return;
      setState('loading');
      try {
        const value = await tokenRequest('/token/rotate', 'POST');
        if (mounted.current) { setToken(value); setVisible(true); setState('rotated'); }
      } catch {
        if (mounted.current) setState('error');
      }
    };

    if (!enabled) return h('p', { style: styles.status }, 'Turn on the MCP server or the HTTP API to see the access token and client setup.');
    const mcpUrl = originUrl(`${ROUTE}/mcp`);
    const apiUrl = originUrl(`${ROUTE}/api/v1`);
    const shown = visible ? token : token.replace(/^(dshc_.{4}).*$/, '$1••••••••••••••••••••••');
    const snippetsFor = value => ({
      http: { label: 'MCP over HTTP', text: mcpJsonConfig(mcpUrl, value) },
      stdio: { label: 'MCP over stdio', text: stdioConfig(mcpUrl, value) },
      curl: { label: 'HTTP API', text: `curl -s -H 'Authorization: Bearer ${value}' ${apiUrl}/info\ncurl -s -X POST -H 'Authorization: Bearer ${value}' -H 'content-type: application/json' \\\n  -d '{"_request":{}}' ${apiUrl}/call/session/list` },
    });
    // Displayed text follows the Show/Hide state; copying always uses the real token.
    const snippets = snippetsFor(token);
    const displayed = snippetsFor(shown);
    return h('div', { style: styles.section },
      h('h5', { style: styles.sectionTitle }, 'Access token'),
      h('p', { style: styles.hint }, 'MCP and API clients send this as "Authorization: Bearer <token>". It grants full control of this harness (or read access in read-only mode). Keep it secret.'),
      state === 'error' ? h('p', { role: 'alert', style: styles.error }, 'Could not read the token. Reload this page from the DSH web GUI you are signed in to.') : null,
      h('div', { style: styles.inline },
        h('input', { readOnly: true, value: state === 'loading' && !token ? 'Loading…' : shown, style: styles.input, 'aria-label': 'Access token', onFocus: event => event.target.select() }),
        h('button', { type: 'button', style: buttonStyle(false, !token), disabled: !token, onClick: () => setVisible(!visible) }, visible ? 'Hide' : 'Show'),
        h(CopyButton, { text: token, disabled: !token }),
        h('button', { type: 'button', style: buttonStyle(false, state === 'loading'), disabled: state === 'loading', onClick: () => { void rotate(); } }, 'Rotate')),
      state === 'rotated' ? h('p', { role: 'status', style: styles.ok }, 'New token issued. The old one no longer works.') : null,
      h('h5', { style: { ...styles.sectionTitle, marginTop: '8px' } }, 'Client setup'),
      h('div', { style: styles.tabs, role: 'tablist' }, Object.entries(snippets).map(([key, snippet]) => h('button', {
        key, type: 'button', role: 'tab', 'aria-selected': tab === key, style: buttonStyle(tab === key, false), onClick: () => setTab(key),
      }, snippet.label))),
      h('pre', { style: styles.code, 'data-dsh-control-mcp-snippet': tab }, token ? displayed[tab].text : '…'),
      h('div', { style: styles.inline }, h(CopyButton, { text: snippets[tab].text, label: 'Copy configuration', disabled: !token })),
      h('p', { style: styles.hint }, `MCP endpoint: ${mcpUrl} · API base: ${apiUrl}. DSH listens on this machine only unless you started it with a trusted host; remote clients need a tunnel or a trusted host.`));
  }

  function ControlPage({ source }) {
    const mirrorSnapshot = useStore(source.describe, emptyMirror);
    const namespaces = mirrorSnapshot?.view?.namespaces ?? [];
    const form = source.formFor(namespaces);
    const snapshot = useStore(form ?? noForm, unavailableSnapshot);
    const [pending, setPending] = useState('');
    const [failure, setFailure] = useState('');
    const [blockedDraft, setBlockedDraft] = useState(undefined);
    const busy = useRef(false);

    useEffect(() => { try { void source.describe?.ensure?.(); } catch { /* the mirror reports its own failure */ } }, [source]);

    const value = isRecord(snapshot.value) ? snapshot.value : {};
    const writable = snapshot.status === 'ready' && snapshot.writable === true && (snapshot.mode === undefined || snapshot.mode === 'host');
    const storedBlocked = useMemo(() => (Array.isArray(value.blockedEndpoints) ? value.blockedEndpoints : []).join('\n'), [snapshot.value]);
    const blockedText = blockedDraft ?? storedBlocked;
    const blocked = parseBlocked(blockedText);

    async function write(field, next) {
      if (!writable || busy.current || form === undefined) return;
      busy.current = true;
      setPending(field);
      setFailure('');
      try {
        await form.mutate([{ op: 'set', path: [field], value: next }], snapshot.revision);
        const settled = form.getSnapshot();
        if (settled.status !== 'ready' || JSON.stringify(settled.value?.[field]) !== JSON.stringify(next)) throw new Error('not confirmed');
        if (field === 'blockedEndpoints') setBlockedDraft(undefined);
      } catch {
        setFailure(SAVE_ERROR);
      } finally {
        busy.current = false;
        setPending('');
      }
    }

    let status = null;
    if (mirrorSnapshot?.view === undefined && form === undefined) status = 'Loading settings…';
    else if (form === undefined || snapshot.status === 'unavailable') status = 'The dsh-control-mcp host plugin is not running, so these settings cannot be changed. Check the dsh startup output.';
    else if (snapshot.status === 'loading') status = 'Loading settings…';
    else if (!writable) status = 'These settings are read-only in this browser.';

    const anyEnabled = value.mcpEnabled === true || value.apiEnabled === true;
    return h('section', { style: styles.page, 'data-dsh-control-mcp': '' },
      h('div', { style: styles.head },
        h('h4', { style: styles.title }, 'Harness control'),
        h('p', { style: styles.lead }, 'Let MCP clients and programs drive this harness through the same API the web GUI uses: sessions and prompts, workspaces, models, plugins, schedules, goals, terminals and settings. Both surfaces are off until you turn them on.')),
      status === null ? null : h('p', { role: 'status', style: styles.status }, status),
      h('div', { style: styles.card }, SWITCHES.map((item, index) => h('div', { key: item.field, style: { ...styles.row, ...index === SWITCHES.length - 1 ? styles.rowLast : {} } },
        h('label', { htmlFor: `dsh-control-mcp-${item.field}`, style: styles.rowText },
          h('span', { style: styles.label }, item.label),
          h('span', { style: styles.hint }, item.hint)),
        h(Switch, {
          id: `dsh-control-mcp-${item.field}`, label: item.label, checked: value[item.field] === true,
          disabled: !writable || pending !== '',
          onChange: checked => { void write(item.field, checked); },
        })))),
      anyEnabled && value.readOnly !== true ? h('p', { style: styles.warn, role: 'note' }, 'Full control is on: a client with the token can run prompts (which run tools and shell commands), change plugins and settings, and read every session. Use read-only mode or blocked endpoints to narrow it.') : null,
      failure ? h('p', { role: 'alert', style: styles.error }, failure) : null,
      h('div', { style: styles.section },
        h('label', { htmlFor: 'dsh-control-mcp-blocked', style: styles.sectionTitle }, 'Blocked endpoints'),
        h('p', { style: styles.hint }, 'One pattern per line, "*" matches anything: account/*, pluginManager/removeBundle, */delete. Blocked endpoints are hidden and refused.'),
        h('textarea', { id: 'dsh-control-mcp-blocked', style: styles.textarea, value: blockedText, disabled: !writable, spellCheck: false, onChange: event => setBlockedDraft(event.target.value) }),
        blocked.invalid.length > 0 ? h('p', { role: 'alert', style: styles.error }, `Not a "namespace/method" pattern: ${blocked.invalid.join(', ')}`) : null,
        h('div', { style: styles.inline },
          h('button', {
            type: 'button', style: buttonStyle(true, !writable || blockedDraft === undefined || blocked.invalid.length > 0 || pending !== ''),
            disabled: !writable || blockedDraft === undefined || blocked.invalid.length > 0 || pending !== '',
            onClick: () => { void write('blockedEndpoints', blocked.items); },
          }, pending === 'blockedEndpoints' ? 'Saving…' : 'Save'),
          blockedDraft !== undefined ? h('button', { type: 'button', style: buttonStyle(false, false), onClick: () => setBlockedDraft(undefined) }, 'Discard') : null)),
      h(TokenSection, { enabled: anyEnabled }));
  }

  function apply(ctx) {
    ctx.inject(['configForms'], child => {
      const forms = child.configForms;
      let cached;
      const source = {
        describe: forms.describe(),
        formFor(namespaces) {
          const ns = findEntryNamespace(namespaces);
          if (ns === undefined) return undefined;
          if (cached?.ns !== ns) cached = { ns, form: forms.get(ns) };
          return cached.form;
        },
      };
      child.slots.inject('plugins.bundle.config', () => child.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE,
        inject: () => ({ source }),
      }, ControlPage));
    });
  }

  return { inject, apply, findEntryNamespace, parseBlocked, mcpJsonConfig, stdioConfig };
}
