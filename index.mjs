/**
 * dsh-control-mcp Host entry.
 *
 * Exposes the running DeepSeek Harness's own Remote API (the API the Web UI
 * uses: sessions, prompts, workspaces, models, plugins, schedules, goals,
 * terminals, settings, …) as
 *   - an MCP server (Streamable HTTP, plus the bundled stdio bridge), and
 *   - an opt-in JSON/SSE HTTP API,
 * both under `/dsh-control-mcp` on the DSH web server, both off by default,
 * and both behind one bearer token kept in the harness credential store.
 *
 * Calls go through `ctx.typertGateway.invoke()/stream()` with an in-process
 * owner Peer, so they get exactly the argument validation, lookups and
 * business rules a Web UI call gets.
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_MAX_RESULT_BYTES } from './lib/core.mjs';
import { createHttpHandler, ROUTE_PREFIX } from './lib/http.mjs';
import { KEY_PRINCIPAL, createKeyRegistry, createScopedPolicy, keyPrincipal, scopedPreCheck } from './lib/access.mjs';

export const name = 'dsh-control-mcp';
export const inject = ['typert', 'typertGateway', 'connection', 'webServer'];
const LOG_PREFIX = 'dsh-control-mcp:';
export const TOKEN_SCOPE = 'dsh-control-mcp';
export const TOKEN_ID = 'access-token';
export const KEYS_ID = 'api-keys';
export const SUPPORTED_DSH_RANGE = Object.freeze({ min: '0.2.0-0', below: '0.3.0-0' });

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  } catch {
    return undefined;
  }
})();

/** Volatile so the plugin page applies changes without a restart. */
export function createConfig(z) {
  return z.object({
    mcpEnabled: z.boolean().default(false).volatile()
      .description('Serve the MCP endpoint at /dsh-control-mcp/mcp.'),
    apiEnabled: z.boolean().default(false).volatile()
      .description('Serve the JSON/SSE HTTP API at /dsh-control-mcp/api/v1.'),
    readOnly: z.boolean().default(false).volatile()
      .description('Refuse every endpoint that changes harness state.'),
    exposeAllEndpoints: z.boolean().default(false).volatile()
      .description('List one MCP tool per harness endpoint in addition to the curated tools.'),
    blockedEndpoints: z.array(z.string()).default([]).volatile()
      .description('Endpoint patterns never callable through this plugin, e.g. "account/*".'),
    maxResultBytes: z.natural().min(4096).max(16777216).default(DEFAULT_MAX_RESULT_BYTES).volatile()
      .description('Largest MCP tool result text, in bytes.'),
  });
}

function harnessPackageRoot(entry = process.argv[1]) {
  try {
    let dir = dirname(realpathSync(entry));
    for (let i = 0; i < 8; i += 1) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (pkg.name === '@deepseek-ai/dsh') return { dir, version: pkg.version };
      } catch { /* keep walking */ }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* not running under dsh */ }
  return undefined;
}

// Build Config with the running harness's own schemastery, never a second copy.
const harness = harnessPackageRoot();
const harnessSchemastery = (() => {
  try {
    return harness && pathToFileURL(createRequire(join(harness.dir, 'package.json')).resolve('@deepseek-ai/schemastery')).href;
  } catch {
    return undefined;
  }
})();
export const Config = harnessSchemastery === undefined ? undefined : createConfig((await import(harnessSchemastery)).default);

function read(config, field, fallback) {
  const value = config?.[field];
  const current = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
  return current === undefined ? fallback : current;
}

/** Live settings snapshot, read on every request so volatile edits apply at once. */
export function settingsFrom(config) {
  const blocked = read(config, 'blockedEndpoints', []);
  const maxResultBytes = Number(read(config, 'maxResultBytes', DEFAULT_MAX_RESULT_BYTES));
  return {
    mcpEnabled: read(config, 'mcpEnabled', false) === true,
    apiEnabled: read(config, 'apiEnabled', false) === true,
    readOnly: read(config, 'readOnly', false) === true,
    exposeAllEndpoints: read(config, 'exposeAllEndpoints', false) === true,
    blockedEndpoints: Array.isArray(blocked) ? blocked.filter(item => typeof item === 'string' && item.trim() !== '') : [],
    maxResultBytes: Number.isFinite(maxResultBytes) && maxResultBytes >= 4096 ? maxResultBytes : DEFAULT_MAX_RESULT_BYTES,
  };
}

export function newToken() {
  return `dshc_${randomBytes(32).toString('base64url')}`;
}

/** Read and write one grant record of this plugin in the harness credential store. */
export function createGrantRecord(ctx, id) {
  let key;
  const store = () => ctx.get?.('credentials');
  const keyOf = async () => {
    if (key !== undefined) return key;
    const { credentialKey } = await import(pathToFileURL(createRequire(join(harness.dir, 'package.json')).resolve('@deepseek-ai/dsh-credentials')).href);
    key = credentialKey(TOKEN_SCOPE, id);
    return key;
  };
  return {
    available: () => store() !== undefined && harness !== undefined,
    async read() {
      if (store() === undefined || harness === undefined) return undefined;
      const record = await store().readRecord(await keyOf());
      return record?.kind === 'grant' ? record.payload : undefined;
    },
    async write(payload) {
      if (store() === undefined || harness === undefined) return false;
      await store().modifyRecord(await keyOf(), async () => ({ kind: 'grant', payload }));
      return true;
    },
  };
}

/** Token persistence in the harness credential store, with an in-memory fallback. */
export function createTokenStore(ctx, logger) {
  let token;
  let key;
  const credentials = () => ctx.get?.('credentials');
  const keyOf = async () => {
    if (key !== undefined) return key;
    const { credentialKey } = await import(pathToFileURL(createRequire(join(harness.dir, 'package.json')).resolve('@deepseek-ai/dsh-credentials')).href);
    key = credentialKey(TOKEN_SCOPE, TOKEN_ID);
    return key;
  };
  const persist = async value => {
    const store = credentials();
    if (store === undefined || harness === undefined) { logger.warn(`${LOG_PREFIX} no credential store; the access token lasts until restart`); return; }
    await store.modifyRecord(await keyOf(), async () => ({ kind: 'grant', payload: { token: value, createdAt: new Date().toISOString() } }));
  };
  return {
    get: () => token,
    async load() {
      const store = credentials();
      if (store !== undefined && harness !== undefined) {
        try {
          const record = await store.readRecord(await keyOf());
          const stored = record?.kind === 'grant' ? record.payload?.token : undefined;
          if (typeof stored === 'string' && stored.length >= 32) { token = stored; return token; }
        } catch (error) {
          logger.warn(`${LOG_PREFIX} could not read the stored access token: ${error?.message ?? error}`);
        }
      }
      token = newToken();
      try { await persist(token); } catch (error) { logger.warn(`${LOG_PREFIX} could not store the access token: ${error?.message ?? error}`); }
      return token;
    },
    async rotate() {
      const next = newToken();
      await persist(next);
      token = next;
      logger.info(`${LOG_PREFIX} access token rotated; update your MCP and API clients`);
      return next;
    },
  };
}

/** The bridge lib/core.mjs works on, over the live gateway. */
export function createBridge(ctx, config, peer, { caller, precheck } = {}) {
  // DSH 0.2.0 has no Peer API; its gateway runs calls without a peer as the operator (owner).
  const withPeer = peer === undefined ? {} : { peer };
  return {
    ...(caller ? { caller } : {}),
    ...(precheck ? { precheck } : {}),
    list: () => ctx.typert.local.list(),
    invoke: (namespace, method, args, signal) => ctx.typertGateway.invoke({ namespace, method, args, ...withPeer, ...(signal ? { signal } : {}) }),
    stream: (namespace, method, args, signal) => ctx.typertGateway.stream({ namespace, method, args, ...withPeer, ...(signal ? { signal } : {}) }),
    settings: () => settingsFrom(config),
    info: () => ({ plugin: name, pluginVersion: PLUGIN_VERSION, dshVersion: harness?.version }),
  };
}

export async function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;
  if (typeof ctx.typertGateway?.invoke !== 'function' || typeof ctx.typert?.local?.list !== 'function') {
    throw new Error(`${LOG_PREFIX} this dsh has no Typert gateway; DSH ${SUPPORTED_DSH_RANGE.min} or later is required`);
  }
  // One owner Peer for every call this plugin makes; disposed with the plugin.
  // `interactions: 'none'`: it never answers forwarded approvals or questions.
  // DSH 0.2.1+: a dedicated owner Peer. DSH 0.2.0: no Peer API, calls run as the operator.
  const peer = typeof ctx.connection.createPeer === 'function'
    ? ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    : undefined;
  const bridge = createBridge(ctx, config, peer);
  const tokens = createTokenStore(ctx, logger);
  await tokens.load();

  // ── API keys ──
  const keyRecord = createGrantRecord(ctx, KEYS_ID);
  const keyPeers = new Map();
  /** DSH 0.2.1+ ships the remote-access engine that confines scoped keys. */
  const remoteAccess = () => ctx.get?.('remoteAccess');
  const scopedSupported = () => typeof ctx.connection.createPeer === 'function' && typeof remoteAccess()?.registerPolicy === 'function';
  const keys = createKeyRegistry({
    persist: async list => {
      if (!(await keyRecord.write({ version: 1, keys: list }))) logger.warn(`${LOG_PREFIX} no credential store; API keys last until restart`);
    },
    onChange: () => {
      // Drop Peers of keys that changed mode or vanished, and recompute access.
      for (const [id, entry] of keyPeers) {
        const current = keys?.get(id);
        if (current === undefined || current.mode !== entry.mode) { keyPeers.delete(id); entry.peer?.dispose?.(); }
      }
      try { remoteAccess()?.invalidate?.(); } catch { /* recomputed on the next decision anyway */ }
    },
  });
  try {
    keys.load(await keyRecord.read());
  } catch (error) {
    logger.warn(`${LOG_PREFIX} could not read stored API keys: ${error?.message ?? error}`);
  }
  if (typeof ctx.inject === 'function') {
    // Scoped keys ride DSH's remote-access engine (0.2.1+), like Liveshare viewers.
    ctx.inject(['remoteAccess', 'workspaceRegistry'], inner => {
      const policy = createScopedPolicy(keys, () => inner.workspaceRegistry.list().map(workspace => ({ id: workspace.id, sessionIds: [...(workspace.sessionIds ?? [])] })));
      // DSH reads bindings() afresh on every decision, so sessions that join a
      // scoped workspace later are covered from their first call on.
      inner.remoteAccess.registerPolicy(KEY_PRINCIPAL, policy);
    });
  }
  /** A Peer per key: owner principal for full keys, the key principal for scoped ones. */
  const peerFor = key => {
    if (typeof ctx.connection.createPeer !== 'function') return undefined;
    let entry = keyPeers.get(key.id);
    if (entry === undefined || entry.peer?.signal?.aborted) {
      const principal = key.mode === 'scoped' ? keyPrincipal(key) : { kind: 'owner' };
      entry = { mode: key.mode, peer: ctx.connection.createPeer({ principal, interactions: 'none' }) };
      keyPeers.set(key.id, entry);
    }
    return entry.peer;
  };
  ctx.effect(() => () => { for (const entry of keyPeers.values()) entry.peer?.dispose?.(); keyPeers.clear(); }, 'dsh-control-mcp: key peers');
  const bridgeFor = caller => {
    const key = keys.get(caller.keyId);
    if (key === undefined) throw new Error('key vanished');
    return createBridge(ctx, config, peerFor(key), {
      caller: { keyName: caller.keyName, mode: caller.mode, access: caller.access },
      precheck: endpoint => scopedPreCheck(keys.get(caller.keyId), endpoint),
    });
  };
  /** Workspaces and sessions the key editor offers, read as the owner. */
  const scopeOptions = async () => {
    const out = { workspaces: [], sessions: [] };
    try {
      for (const workspace of ctx.get?.('workspaceRegistry')?.list?.() ?? []) {
        out.workspaces.push({ id: workspace.id, title: workspace.title, path: workspace.path, sessionIds: [...(workspace.sessionIds ?? [])] });
      }
    } catch { /* registry unavailable */ }
    try {
      const value = await bridge.invoke('session', 'list', { _request: {} });
      const rows = Array.isArray(value) ? value : value?.items ?? [];
      for (const row of rows) {
        // Subagent children belong to their parent chat; blank sessions stay
        // selectable (a key may be prepared for a chat before its first prompt).
        if (row.origin === 'subagent') continue;
        const title = row.projections?.values?.title;
        out.sessions.push({ id: row.sessionId, title: typeof title === 'string' && title.trim() ? title.trim() : 'Untitled session', cwd: row.cwd, updatedAt: row.updatedAt, running: row.running === true, blank: row.blank === true });
      }
    } catch { /* listed empty */ }
    return out;
  };

  /**
   * True for a request DSH itself admits as the owner: the signed-in browser
   * session, or an owner API cookie from /connect. Either already has full
   * control of this harness, so it may read this plugin's token.
   * (0.2.0 admits the operator; 0.2.1/0.2.2 the shared browserPeer; 0.2.3+
   * the authentication provider's owner Peer.)
   */
  // DSH 0.2.3+ splits authentication into `connection.authentication`, and
  // `connection.admit` only works from a context that injects it. Older
  // releases have no such service, so `admitCtx` stays the plugin context.
  let admitCtx = ctx;
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection', 'connection.authentication'], inner => {
      admitCtx = inner;
      inner.effect(() => () => { admitCtx = ctx; }, 'dsh-control-mcp: owner admission');
    });
  }
  const isOwnerBrowser = req => {
    try {
      const admission = admitCtx.connection.admit(req);
      if (!('peer' in admission) || admission.peer === undefined) return false;
      const admitted = admission.peer;
      if (admitted === ctx.connection.browserPeer || admitted === ctx.connection.operator) return true;
      return admitted.principal?.kind === 'owner' && admitted.signal?.aborted !== true;
    } catch {
      return false;
    }
  };
  const handler = createHttpHandler({
    bridge,
    bridgeFor,
    keys,
    scopeOptions,
    scopedSupported,
    getToken: tokens.get,
    rotateToken: tokens.rotate,
    isOwnerBrowser,
    warn: message => logger.warn(`${LOG_PREFIX} ${message}`),
  });
  // `auth: 'anonymous'`: DSH 0.2.3+ otherwise requires a browser session for every
  // route. This plugin authenticates each request itself (bearer token, or the
  // owner browser session for the token routes). Earlier releases ignore the field.
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler, auth: 'anonymous' }), 'dsh-control-mcp: HTTP routes');
  if (peer !== undefined) ctx.effect(() => () => peer.dispose?.(), 'dsh-control-mcp: owner peer');

  const s = settingsFrom(config);
  let origin = '';
  try { origin = ctx.webServer.getOrigin?.() ?? ''; } catch { /* port not bound yet */ }
  logger.info(`${LOG_PREFIX} ready at ${origin}${ROUTE_PREFIX} (mcp ${s.mcpEnabled ? 'on' : 'off'}, api ${s.apiEnabled ? 'on' : 'off'}${s.readOnly ? ', read-only' : ''}); Plugins → dsh-control-mcp`);
}
