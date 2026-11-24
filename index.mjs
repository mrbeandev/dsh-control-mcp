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

export const name = 'dsh-control-mcp';
export const inject = ['typert', 'typertGateway', 'connection', 'webServer'];
const LOG_PREFIX = 'dsh-control-mcp:';
export const TOKEN_SCOPE = 'dsh-control-mcp';
export const TOKEN_ID = 'access-token';
export const SUPPORTED_DSH_RANGE = Object.freeze({ min: '0.2.0', below: '0.3.0' });

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
export function createBridge(ctx, config, peer) {
  return {
    list: () => ctx.typert.local.list(),
    invoke: (namespace, method, args, signal) => ctx.typertGateway.invoke({ namespace, method, args, peer, ...(signal ? { signal } : {}) }),
    stream: (namespace, method, args, signal) => ctx.typertGateway.stream({ namespace, method, args, peer, ...(signal ? { signal } : {}) }),
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
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
  const bridge = createBridge(ctx, config, peer);
  const tokens = createTokenStore(ctx, logger);
  await tokens.load();

  const isOwnerBrowser = req => {
    try {
      const admission = ctx.connection.admit(req);
      return 'peer' in admission && admission.peer === ctx.connection.browserPeer;
    } catch {
      return false;
    }
  };
  const handler = createHttpHandler({
    bridge,
    getToken: tokens.get,
    rotateToken: tokens.rotate,
    isOwnerBrowser,
    warn: message => logger.warn(`${LOG_PREFIX} ${message}`),
  });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'dsh-control-mcp: HTTP routes');
  ctx.effect(() => () => peer.dispose?.(), 'dsh-control-mcp: owner peer');

  const s = settingsFrom(config);
  let origin = '';
  try { origin = ctx.webServer.getOrigin?.() ?? ''; } catch { /* port not bound yet */ }
  logger.info(`${LOG_PREFIX} ready at ${origin}${ROUTE_PREFIX} (mcp ${s.mcpEnabled ? 'on' : 'off'}, api ${s.apiEnabled ? 'on' : 'off'}${s.readOnly ? ', read-only' : ''}); Plugins → dsh-control-mcp`);
}
