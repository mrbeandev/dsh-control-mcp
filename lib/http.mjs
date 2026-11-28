/**
 * HTTP surface of dsh-control-mcp, mounted under one prefix on the DSH web
 * server (default `/dsh-control-mcp`):
 *
 *   POST {prefix}/mcp                     MCP Streamable HTTP (JSON responses)   [mcpEnabled]
 *   GET  {prefix}/api/v1/info             harness + plugin facts                 [apiEnabled]
 *   GET  {prefix}/api/v1/endpoints        endpoint catalog (?namespace=&q=&schemas=1)
 *   GET  {prefix}/api/v1/endpoints/:ns/:m one endpoint with schemas
 *   POST {prefix}/api/v1/call/:ns/:m      body = named args            -> {ok,value}
 *   POST {prefix}/api/v1/stream/:ns/:m    body = {args,maxItems,timeoutMs}; SSE with Accept: text/event-stream
 *   GET  {prefix}/api/v1/tools            curated tool list
 *   POST {prefix}/api/v1/tools/:name      body = tool arguments        -> {ok,value}
 *   GET  {prefix}/status                  public: which surfaces are enabled (no secrets)
 *   GET  {prefix}/token                   owner session only: the built-in owner token
 *   POST {prefix}/token/rotate            owner session only: mint a new owner token
 *   GET  {prefix}/keys                    owner session only: API keys (never their tokens)
 *   POST {prefix}/keys                    owner session only: create a key -> { key, token } (token shown once)
 *   PATCH/DELETE {prefix}/keys/:id        owner session only: edit or delete a key
 *   POST {prefix}/keys/:id/rotate         owner session only: new token for a key
 *   GET  {prefix}/scope-options           owner session only: workspaces and sessions to choose from
 *
 * MCP and API calls need `Authorization: Bearer <token>`: the owner token, or
 * an API key (see lib/access.mjs), each enabled for MCP and/or the API. The owner routes
 * accept only the DSH browser session cookie (checked by ctx.connection) from
 * a same-origin request, so the GUI page can show the token to its owner.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  ControlError, authorize, catalog, callEndpoint, collectStream, describeDescriptor, errorInfo,
  handleMcpMessage, isRecord, listTools, parseEndpoint, parseJsonBody, runTool, safeJson, toolDefinition,
  STREAM_LIMITS, STREAM_DEFAULTS,
} from './core.mjs';

export const ROUTE_PREFIX = '/dsh-control-mcp';
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export function tokensEqual(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string' || expected.length < 32) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerOf(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/**
 * True when the request carries no Origin or an Origin naming the same
 * authority as Host. Browsers always send Origin on cross-site POSTs.
 */
export function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (origin === undefined) return req.headers?.['sec-fetch-site'] !== 'cross-site';
  try {
    return new URL(origin).host === req.headers?.host && req.headers?.['sec-fetch-site'] !== 'cross-site';
  } catch {
    return false;
  }
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) { res.end(); return; }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function sendError(res, error, extraHeaders) {
  const info = errorInfo(error);
  const { status, ...rest } = info;
  send(res, status >= 400 && status < 600 ? status : 500, { ok: false, error: rest }, extraHeaders);
}

export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const length = Number(req.headers?.['content-length']);
    if (Number.isFinite(length) && length > limit) { reject(new ControlError('dsh-control/body-too-large', `Request body exceeds ${limit} bytes.`, 413)); return; }
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new ControlError('dsh-control/body-too-large', `Request body exceeds ${limit} bytes.`, 413)); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ControlError('dsh-control/body-invalid', 'Request body must be JSON.', 400);
  }
}

function requestSignal(req, res) {
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(new ControlError('dsh-control/client-closed', 'The client closed the request.', 499)); };
  res.on('close', abort);
  return controller.signal;
}

/**
 * @param {object} options
 * @param {object} options.bridge - see lib/core.mjs.
 * @param {() => string | undefined} options.getToken - current access token.
 * @param {() => Promise<string>} options.rotateToken - mint and persist a new token.
 * @param {(req) => boolean} options.isOwnerBrowser - DSH browser-session check.
 * @param {(message: string) => void} [options.warn]
 */
/**
 * @param {object} options
 * @param {object} options.bridge - owner bridge (lib/core.mjs).
 * @param {(caller) => object} [options.bridgeFor] - bridge speaking for an API key; defaults to the owner bridge.
 * @param {object} [options.keys] - key registry (lib/access.mjs); absent disables API keys.
 * @param {(signal) => Promise<object>} [options.scopeOptions] - workspaces and sessions for the key editor.
 * @param {() => boolean} [options.scopedSupported] - whether DSH can confine scoped keys.
 */
export function createHttpHandler({ bridge, bridgeFor = () => bridge, keys, scopeOptions, scopedSupported = () => true, getToken, rotateToken, isOwnerBrowser, warn = () => {}, prefix = ROUTE_PREFIX }) {
  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      send(res, 400, { ok: false, error: { code: 'dsh-control/url-invalid', message: 'Malformed URL.' } });
      return;
    }
    const path = url.pathname.slice(prefix.length) || '/';
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      // ── public status (no secrets; lets the page and probes see what is on) ──
      if (path === '/status' && method === 'GET') {
        const settings = bridge.settings();
        send(res, 200, { ok: true, value: { mcpEnabled: settings.mcpEnabled === true, apiEnabled: settings.apiEnabled === true, readOnly: settings.readOnly === true, mcpPath: `${prefix}/mcp`, apiPath: `${prefix}/api/v1` } });
        return;
      }

      // ── owner browser routes ──
      if (path === '/token' || path === '/token/rotate') {
        if (!sameOrigin(req) || !isOwnerBrowser(req)) {
          send(res, 401, { ok: false, error: { code: 'dsh-control/unauthorized', message: 'Open this from the DSH web GUI you are signed in to.' } });
          return;
        }
        if (path === '/token' && method === 'GET') { send(res, 200, { ok: true, value: { token: getToken() ?? null } }); return; }
        if (path === '/token/rotate' && method === 'POST') { send(res, 200, { ok: true, value: { token: await rotateToken() } }); return; }
        send(res, 405, { ok: false, error: { code: 'dsh-control/method-not-allowed', message: 'Method not allowed.' } }, { allow: path === '/token' ? 'GET' : 'POST' });
        return;
      }

      // ── owner browser: API key management ──
      if (path === '/keys' || path.startsWith('/keys/') || path === '/scope-options') {
        if (!sameOrigin(req) || !isOwnerBrowser(req)) {
          send(res, 401, { ok: false, error: { code: 'dsh-control/unauthorized', message: 'Open this from the DSH web GUI you are signed in to.' } });
          return;
        }
        if (keys === undefined) throw new ControlError('dsh-control/keys-unavailable', 'API keys are unavailable.', 503);
        await handleKeys(req, res, method, path, { keys, scopeOptions, scopedSupported });
        return;
      }

      const isMcp = path === '/mcp';
      const isApi = path === '/api/v1' || path.startsWith('/api/v1/');
      if (!isMcp && !isApi) { send(res, 404, { ok: false, error: { code: 'dsh-control/not-found', message: 'Not found.' } }); return; }

      const settings = bridge.settings();
      if (isMcp && settings.mcpEnabled !== true) {
        send(res, 404, { ok: false, error: { code: 'dsh-control/mcp-disabled', message: 'MCP mode is off. Turn it on in Plugins → dsh-control-mcp.' } });
        return;
      }
      if (isApi && settings.apiEnabled !== true) {
        send(res, 404, { ok: false, error: { code: 'dsh-control/api-disabled', message: 'The HTTP API is off. Turn it on in Plugins → dsh-control-mcp.' } });
        return;
      }
      // Browsers are never legitimate callers here; refuse cross-site pages outright.
      if (!sameOrigin(req)) { send(res, 403, { ok: false, error: { code: 'dsh-control/cross-origin', message: 'Cross-origin requests are refused.' } }); return; }
      const presented = bearerOf(req);
      let caller;
      if (tokensEqual(getToken(), presented)) caller = { keyName: 'owner', mode: 'full', access: 'prompt', owner: true };
      else {
        const key = keys?.authenticate(presented);
        if (key !== undefined) caller = { keyId: key.id, keyName: key.name, mode: key.mode, access: key.mode === 'full' ? 'prompt' : key.access, mcp: key.mcp, api: key.api, key };
      }
      if (caller === undefined) {
        send(res, 401, { ok: false, error: { code: 'dsh-control/unauthorized', message: 'Missing, wrong, disabled or expired bearer token. Copy one from Plugins → dsh-control-mcp.' } }, { 'www-authenticate': 'Bearer realm="dsh-control-mcp"' });
        return;
      }
      if (!caller.owner) {
        if ((isMcp && caller.mcp !== true) || (isApi && caller.api !== true)) {
          send(res, 403, { ok: false, error: { code: 'dsh-control/key-surface', message: `This key is not enabled for ${isMcp ? 'MCP' : 'the HTTP API'}. Change it in Plugins → dsh-control-mcp.` } });
          return;
        }
        if (caller.mode === 'scoped' && !scopedSupported()) {
          send(res, 403, { ok: false, error: { code: 'dsh-control/scoped-unsupported', message: 'Scoped keys need DSH 0.2.1 or later. Use a full-access key on this harness.' } });
          return;
        }
        keys.touch(caller.key);
      }
      const { key: _key, ...publicCaller } = caller;
      void _key;
      const callerBridge = caller.owner ? bridge : bridgeFor(publicCaller);

      if (isMcp) { await handleMcpHttp(callerBridge, req, res, method); return; }
      await handleApi(callerBridge, req, res, method, path.slice('/api/v1'.length) || '/', url);
    } catch (error) {
      const info = errorInfo(error);
      if (info.status >= 500) warn(`request ${method} ${url.pathname} failed: ${info.message}`);
      sendError(res, error);
    }
  };
}

async function handleMcpHttp(bridge, req, res, method) {
  if (method === 'GET') {
    // No server-initiated messages: the spec allows 405 for the SSE stream.
    send(res, 405, 'This MCP server sends no server-initiated messages.', { allow: 'POST, DELETE' });
    return;
  }
  if (method === 'DELETE') { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; }
  if (method !== 'POST') { send(res, 405, 'Method not allowed.', { allow: 'POST' }); return; }
  const parsed = parseJsonBody(await readBody(req));
  if (!parsed.ok) { send(res, 400, parsed.error); return; }
  const response = await handleMcpMessage(bridge, parsed.value, requestSignal(req, res));
  if (response === undefined) { res.writeHead(202, { 'cache-control': 'no-store' }); res.end(); return; }
  const protocol = Array.isArray(parsed.value) ? undefined : response?.result?.protocolVersion;
  send(res, 200, response, protocol ? { 'mcp-protocol-version': protocol } : {});
}

async function handleApi(bridge, req, res, method, path, url) {
  const ok = value => send(res, 200, { ok: true, value: safeJson(value) });
  if (path === '/' || path === '/info') {
    if (method !== 'GET') { send(res, 405, { ok: false, error: { code: 'dsh-control/method-not-allowed', message: 'Use GET.' } }, { allow: 'GET' }); return; }
    const settings = bridge.settings();
    ok({ ...bridge.info(), readOnly: settings.readOnly === true, endpoints: catalog(bridge).length });
    return;
  }
  if (path === '/endpoints' && method === 'GET') {
    const namespace = url.searchParams.get('namespace');
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const includeSchema = url.searchParams.get('schemas') === '1';
    const rows = catalog(bridge)
      .filter(descriptor => !namespace || descriptor.namespace === namespace)
      .map(descriptor => describeDescriptor(descriptor, { includeSchema }))
      .filter(row => !query || row.endpoint.toLowerCase().includes(query) || row.description.toLowerCase().includes(query));
    ok({ count: rows.length, endpoints: rows });
    return;
  }
  let match = /^\/endpoints\/([^/]+)\/([^/]+)$/.exec(path);
  if (match && method === 'GET') {
    const endpoint = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
    parseEndpoint(endpoint);
    const descriptor = catalog(bridge).find(candidate => `${candidate.namespace}/${candidate.method}` === endpoint);
    if (descriptor === undefined) throw new ControlError('dsh-control/endpoint-unknown', `No active endpoint ${endpoint}.`, 404);
    ok(describeDescriptor(descriptor, { includeSchema: true }));
    return;
  }
  match = /^\/(call|stream)\/([^/]+)\/([^/]+)$/.exec(path);
  if (match) {
    if (method !== 'POST') { send(res, 405, { ok: false, error: { code: 'dsh-control/method-not-allowed', message: 'Use POST.' } }, { allow: 'POST' }); return; }
    const endpoint = `${decodeURIComponent(match[2])}/${decodeURIComponent(match[3])}`;
    const body = await readJson(req);
    if (!isRecord(body)) throw new ControlError('dsh-control/body-invalid', 'Body must be a JSON object.', 400);
    const signal = requestSignal(req, res);
    if (match[1] === 'call') { ok(await callEndpoint(bridge, endpoint, body, signal)); return; }
    const args = isRecord(body.args) ? body.args : {};
    if (/text\/event-stream/.test(req.headers?.accept ?? '')) { await streamSse(bridge, res, endpoint, args, body, signal); return; }
    ok(await collectStream(bridge, endpoint, args, body, signal));
    return;
  }
  if (path === '/tools' && method === 'GET') { ok({ tools: listTools(bridge).map(toolDefinition) }); return; }
  match = /^\/tools\/([^/]+)$/.exec(path);
  if (match) {
    if (method !== 'POST') { send(res, 405, { ok: false, error: { code: 'dsh-control/method-not-allowed', message: 'Use POST.' } }, { allow: 'POST' }); return; }
    const body = await readJson(req);
    ok(await runTool(bridge, decodeURIComponent(match[1]), isRecord(body) ? body : {}, requestSignal(req, res)));
    return;
  }
  send(res, 404, { ok: false, error: { code: 'dsh-control/not-found', message: `No API route ${method} ${path}.` } });
}

async function handleKeys(req, res, method, path, { keys, scopeOptions, scopedSupported }) {
  const ok = value => send(res, 200, { ok: true, value });
  if (path === '/scope-options') {
    if (method !== 'GET') { send(res, 405, { ok: false, error: { code: 'dsh-control/method-not-allowed', message: 'Use GET.' } }, { allow: 'GET' }); return; }
    ok({ ...(scopeOptions ? await scopeOptions() : { workspaces: [], sessions: [] }), scopedSupported: scopedSupported() });
    return;
  }
  if (path === '/keys') {
    if (method === 'GET') { ok({ keys: keys.list(), scopedSupported: scopedSupported() }); return; }
    if (method === 'POST') { ok(await keys.create(await readJson(req))); return; }
    send(res, 405, { ok: false, error: { code: 'dsh-control/method-not-allowed', message: 'Use GET or POST.' } }, { allow: 'GET, POST' });
    return;
  }
  const match = /^\/keys\/([A-Za-z0-9-]{1,64})(\/rotate)?$/.exec(path);
  if (!match) { send(res, 404, { ok: false, error: { code: 'dsh-control/not-found', message: 'Not found.' } }); return; }
  const [, id, rotate] = match;
  if (rotate) {
    if (method !== 'POST') { send(res, 405, { ok: false, error: { code: 'dsh-control/method-not-allowed', message: 'Use POST.' } }, { allow: 'POST' }); return; }
    ok(await keys.rotate(id));
    return;
  }
  if (method === 'PATCH') { ok({ key: await keys.update(id, await readJson(req)) }); return; }
  if (method === 'DELETE') { await keys.remove(id); ok({ deleted: id }); return; }
  send(res, 405, { ok: false, error: { code: 'dsh-control/method-not-allowed', message: 'Use PATCH or DELETE.' } }, { allow: 'PATCH, DELETE' });
}

/** Live Server-Sent Events relay of one stream endpoint until the client disconnects or a limit is hit. */
async function streamSse(bridge, res, endpoint, args, options, signal) {
  const maxItems = Number.isFinite(Number(options.maxItems)) ? Math.min(Math.max(1, Math.trunc(options.maxItems)), 100000) : 100000;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.min(Math.max(50, Math.trunc(options.timeoutMs)), 24 * 3600 * 1000) : 24 * 3600 * 1000;
  // Reuse the core checks (blocklist, read-only, stream mode) without collecting.
  const { namespace, method } = parseEndpoint(endpoint);
  await collectStreamGuard(bridge, endpoint);
  const controller = new AbortController();
  signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  const timer = setTimeout(() => controller.abort(new ControlError('dsh-control/stream-timeout', 'timeout', 408)), timeoutMs);
  let count = 0;
  try {
    const iterable = await bridge.stream(namespace, method, args, controller.signal);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    for await (const item of iterable) {
      res.write(`event: item\ndata: ${JSON.stringify(safeJson(item))}\n\n`);
      count += 1;
      if (count >= maxItems || controller.signal.aborted) break;
    }
    if (!res.writableEnded) res.write(`event: end\ndata: ${JSON.stringify({ count })}\n\n`);
  } catch (error) {
    if (!res.headersSent) throw error;
    if (!controller.signal.aborted && !res.writableEnded) res.write(`event: error\ndata: ${JSON.stringify(errorInfo(error))}\n\n`);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (!res.writableEnded) res.end();
  }
}

async function collectStreamGuard(bridge, endpoint) {
  authorize(bridge, endpoint);
  const descriptor = bridge.list().find(candidate => `${candidate.namespace}/${candidate.method}` === endpoint);
  if (descriptor !== undefined && descriptor.mode !== 'stream') {
    throw new ControlError('dsh-control/unary-endpoint', `${endpoint} is not a stream; POST /api/v1/call/${endpoint} instead.`, 400);
  }
}

export { STREAM_LIMITS, STREAM_DEFAULTS };
