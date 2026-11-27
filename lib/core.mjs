/**
 * Transport-independent core of dsh-control-mcp.
 *
 * Everything here works on a small "bridge" object instead of the live
 * harness, so it can be unit tested with a fake:
 *
 *   bridge.list()                       -> InvocationDescriptor[] (ctx.typert.local.list())
 *   bridge.invoke(ns, method, args, signal)  -> Promise<unknown>   (unary Remote call)
 *   bridge.stream(ns, method, args, signal)  -> Promise<AsyncIterable<unknown>>
 *   bridge.settings()                   -> { readOnly, exposeAllEndpoints, blockedEndpoints, maxResultBytes }
 *   bridge.info()                       -> { dshVersion, pluginVersion }
 *
 * The Host entry (index.mjs) supplies the real bridge over ctx.typertGateway.
 */
import { randomUUID } from 'node:crypto';

export const PLUGIN_NAME = 'dsh-control-mcp';
export const SERVER_TITLE = 'DeepSeek Harness control';
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
export const DEFAULT_MAX_RESULT_BYTES = 262144;
export const STREAM_DEFAULTS = Object.freeze({ maxItems: 20, timeoutMs: 5000 });
export const STREAM_LIMITS = Object.freeze({ maxItems: 1000, timeoutMs: 300000 });

// ── errors ──────────────────────────────────────────────────────────────────

/** A failure the caller caused or may see; `status` maps it onto HTTP. */
export class ControlError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

const STATUS_BY_CODE = new Map([
  ['gateway/arguments-invalid', 400], ['gateway/input-invalid', 400], ['gateway/signature-invalid', 400],
  ['gateway/invocation-unavailable', 404], ['gateway/method-unavailable', 404], ['gateway/lookup-not-found', 404],
  ['gateway/context-not-found', 404], ['gateway/definition-unavailable', 404], ['gateway/service-unavailable', 503],
  ['gateway/lookup-unavailable', 503], ['gateway/context-unavailable', 503], ['gateway/cancelled', 408],
  ['remote-access/denied', 403],
]);

/** Project any thrown value onto a stable, transport-safe error shape. */
export function errorInfo(error) {
  if (error instanceof ControlError) {
    return { code: error.code, message: error.message, status: error.status, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'internal';
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : 'The harness call failed.';
  const status = STATUS_BY_CODE.get(code) ?? (code === 'internal' ? 500 : 422);
  const details = isRecord(error?.details) ? safeJson(error.details) : undefined;
  return { code, message, status, ...(details === undefined ? {} : { details }) };
}

// ── small value helpers ─────────────────────────────────────────────────────

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Convert a harness result into plain JSON: byte views become base64 objects,
 * Maps/Sets become arrays, bigint becomes string, cycles are cut.
 */
export function safeJson(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return { $bytes: bytes.toString('base64'), byteLength: bytes.byteLength };
  }
  if (value instanceof ArrayBuffer) return { $bytes: Buffer.from(value).toString('base64'), byteLength: value.byteLength };
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  let out;
  if (value instanceof Map) out = [...value.entries()].map(([k, v]) => [safeJson(k, seen), safeJson(v, seen)]);
  else if (value instanceof Set || Array.isArray(value)) out = [...value].map(item => { const v = safeJson(item, seen); return v === undefined ? null : v; });
  else {
    out = {};
    for (const [key, item] of Object.entries(value)) {
      const v = safeJson(item, seen);
      if (v !== undefined) out[key] = v;
    }
  }
  seen.delete(value);
  return out;
}

/** JSON text bounded to `maxBytes`; reports truncation instead of failing. */
export function boundedJson(value, maxBytes = DEFAULT_MAX_RESULT_BYTES) {
  const text = JSON.stringify(safeJson(value), null, 2) ?? 'null';
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const cut = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  return { text: `${cut}\n… [truncated: result is ${Buffer.byteLength(text)} bytes, limit ${maxBytes}. Narrow the request (smaller pages, fewer items) or raise maxResultBytes.]`, truncated: true };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// ── endpoint catalog ────────────────────────────────────────────────────────

const ENDPOINT_RE = /^[A-Za-z][A-Za-z0-9_-]*\/[A-Za-z][A-Za-z0-9_-]*$/;

export function parseEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !ENDPOINT_RE.test(endpoint)) {
    throw new ControlError('dsh-control/endpoint-invalid', 'An endpoint is "<namespace>/<method>", for example "session/list".', 400);
  }
  const [namespace, method] = endpoint.split('/');
  return { namespace, method, endpoint };
}

/** Methods whose names say they only read. Everything else counts as a change. */
const READ_PREFIX = /^(list|get|wait|read|describe|search|view|stat|watch|follow|observe|catalog|inventory|limits|history|probe|inspect|registries|capabilities|identity|relay|generation|enabled|environment|shells|state|page|events|projections|modelCatalog|applications|applicationIcons|systemStatus|ptcConfiguration|canOpen|workspacePathApplications|deliveryLimits|branches|diffBases|localDiff|localText|localCommits|changeRequest(Checks|Commits|Diff|Review|Text|Viewed|States)$|reviewerCandidates|candidates|fastest|changes|audit|worktreeCleanup)/;
const READ_EXCEPTIONS = new Set(['account/getNotificationContent']);
const WRITE_OVERRIDES = new Set(['changeRequestReviewWrite']);

export function isReadOnlyEndpoint(namespace, method) {
  if (WRITE_OVERRIDES.has(method)) return false;
  if (READ_EXCEPTIONS.has(`${namespace}/${method}`)) return true;
  return READ_PREFIX.test(method);
}

/** Glob match for blocked endpoint patterns: `session/*`, `*\/delete`, `account/signOut`. */
export function endpointMatches(pattern, endpoint) {
  if (typeof pattern !== 'string' || pattern.trim() === '') return false;
  const source = pattern.trim().split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`).test(endpoint);
}

/** One public catalog row for a descriptor. */
export function describeDescriptor(descriptor, { includeSchema = false } = {}) {
  const endpoint = `${descriptor.namespace}/${descriptor.method}`;
  const row = {
    endpoint,
    mode: descriptor.mode === 'stream' ? 'stream' : 'unary',
    readOnly: isReadOnlyEndpoint(descriptor.namespace, descriptor.method),
    description: typeof descriptor.description === 'string' ? descriptor.description : '',
    parameters: (descriptor.parameters ?? []).map(parameter => parameter.wire),
  };
  if (includeSchema) {
    row.inputSchema = inputSchemaFor(descriptor);
    const result = codecJsonSchema(descriptor.result);
    if (Object.keys(result).length > 0) row.resultSchema = result;
  }
  return row;
}

const derivedSchemas = new WeakMap();

/**
 * A codec's JSON Schema. DSH 0.2.1+ precomputes `jsonSchema`; DSH 0.2.0 only
 * ships the generated zod parser (`create()`), whose own `toJSONSchema()`
 * derives an equivalent input schema. Cached per codec; `{}` when unavailable.
 */
export function codecJsonSchema(codec) {
  if (!isRecord(codec)) return {};
  if (isRecord(codec.jsonSchema)) return codec.jsonSchema;
  if (derivedSchemas.has(codec)) return derivedSchemas.get(codec);
  let schema = {};
  try {
    const parser = typeof codec.create === 'function' ? codec.create() : undefined;
    if (typeof parser?.toJSONSchema === 'function') {
      const { $schema, ...rest } = parser.toJSONSchema({ unrepresentable: 'any', io: 'input' });
      void $schema;
      if (isRecord(rest)) schema = rest;
    }
  } catch { /* leave it open */ }
  derivedSchemas.set(codec, schema);
  return schema;
}

/** JSON Schema of the named `args` object a descriptor accepts. */
export function inputSchemaFor(descriptor) {
  const properties = {};
  const required = [];
  for (const parameter of descriptor.parameters ?? []) {
    const schema = { ...codecJsonSchema(parameter.codec) };
    const notes = [];
    if (typeof parameter.description === 'string' && parameter.description) notes.push(parameter.description);
    if (parameter.source === 'lookup') notes.push(`Identity resolved by the harness "${parameter.lookup}" lookup (for "agent" pass the session id).`);
    if (notes.length > 0 && schema.description === undefined) schema.description = notes.join(' ');
    properties[parameter.wire] = schema;
    if (parameter.acceptsUndefined !== true) required.push(parameter.wire);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

export function catalog(bridge) {
  const settings = bridge.settings();
  const rows = [];
  for (const descriptor of bridge.list()) {
    if (typeof descriptor?.namespace !== 'string' || typeof descriptor?.method !== 'string') continue;
    rows.push(descriptor);
  }
  rows.sort((a, b) => `${a.namespace}/${a.method}`.localeCompare(`${b.namespace}/${b.method}`));
  return rows.filter(descriptor => !isBlocked(settings, `${descriptor.namespace}/${descriptor.method}`));
}

function isBlocked(settings, endpoint) {
  return (settings.blockedEndpoints ?? []).some(pattern => endpointMatches(pattern, endpoint));
}

function findDescriptor(bridge, endpoint) {
  const { namespace, method } = parseEndpoint(endpoint);
  return bridge.list().find(descriptor => descriptor.namespace === namespace && descriptor.method === method);
}

/** Gate one call by blocklist and read-only mode before it reaches the harness. */
export function authorize(bridge, endpoint) {
  const { namespace, method } = parseEndpoint(endpoint);
  const settings = bridge.settings();
  if (isBlocked(settings, endpoint)) {
    throw new ControlError('dsh-control/blocked', `${endpoint} is blocked by this plugin's blockedEndpoints setting.`, 403);
  }
  if (settings.readOnly === true && !isReadOnlyEndpoint(namespace, method)) {
    throw new ControlError('dsh-control/read-only', `${endpoint} changes harness state, and read-only mode is on. Turn off read-only mode on the plugin page to allow it.`, 403);
  }
  return { namespace, method };
}

// ── calls ───────────────────────────────────────────────────────────────────

export async function callEndpoint(bridge, endpoint, args = {}, signal) {
  if (!isRecord(args)) throw new ControlError('dsh-control/arguments-invalid', 'args must be a JSON object of named parameters.', 400);
  const { namespace, method } = authorize(bridge, endpoint);
  const descriptor = findDescriptor(bridge, endpoint);
  if (descriptor?.mode === 'stream') {
    throw new ControlError('dsh-control/stream-endpoint', `${endpoint} is a stream; use dsh_stream (MCP) or POST /api/v1/stream/${endpoint} instead.`, 400);
  }
  return bridge.invoke(namespace, method, args, signal);
}

/**
 * Open a stream endpoint and collect items until `maxItems`, `timeoutMs`, or
 * its natural end. Always cancels the stream afterwards.
 */
export async function collectStream(bridge, endpoint, args = {}, options = {}, outerSignal) {
  if (!isRecord(args)) throw new ControlError('dsh-control/arguments-invalid', 'args must be a JSON object of named parameters.', 400);
  const { namespace, method } = authorize(bridge, endpoint);
  const descriptor = findDescriptor(bridge, endpoint);
  if (descriptor !== undefined && descriptor.mode !== 'stream') {
    throw new ControlError('dsh-control/unary-endpoint', `${endpoint} is not a stream; use dsh_call (MCP) or POST /api/v1/call/${endpoint}.`, 400);
  }
  const maxItems = clampInt(options.maxItems, STREAM_DEFAULTS.maxItems, 1, STREAM_LIMITS.maxItems);
  const timeoutMs = clampInt(options.timeoutMs, STREAM_DEFAULTS.timeoutMs, 50, STREAM_LIMITS.timeoutMs);
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outerSignal.reason);
  if (outerSignal?.aborted) controller.abort(outerSignal.reason);
  outerSignal?.addEventListener?.('abort', onOuterAbort, { once: true });
  const items = [];
  let ended = 'complete';
  let timer;
  try {
    const iterable = await bridge.stream(namespace, method, args, controller.signal);
    const iterator = iterable[Symbol.asyncIterator]();
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs); });
    try {
      while (items.length < maxItems) {
        const next = await Promise.race([iterator.next(), timeout]);
        if (next === TIMEOUT) { ended = 'timeout'; break; }
        if (next.done) { ended = 'complete'; break; }
        items.push(next.value);
        if (items.length >= maxItems) ended = 'maxItems';
      }
    } finally {
      controller.abort(new ControlError('dsh-control/stream-closed', 'collection finished', 499));
      // Bounded: some iterators settle return() only after their pending next().
      await Promise.race([Promise.resolve().then(() => iterator.return?.()).catch(() => {}), new Promise(resolve => setTimeout(resolve, 250))]);
    }
  } catch (error) {
    if (items.length === 0 || !controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener?.('abort', onOuterAbort);
  }
  return { endpoint, items, count: items.length, ended };
}
const TIMEOUT = Symbol('timeout');

// ── curated tools ───────────────────────────────────────────────────────────

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join('\n');
  if (isRecord(content)) {
    if (content.type === 'text' && typeof content.text === 'string') return content.text;
    if (content.type === 'image') return '[image]';
    if (content.type === 'file') return `[file ${content.attachment?.name ?? content.name ?? ''}]`.replace(' ]', ']');
    if (typeof content.text === 'string') return content.text;
    if ('content' in content) return textOf(content.content);
  }
  return '';
}

function sessionTitle(row) {
  const raw = row?.projections?.values?.title ?? row?.title;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

function summarizeSession(row) {
  const out = { sessionId: row.sessionId ?? row.id };
  const title = sessionTitle(row);
  if (title) out.title = title;
  for (const key of ['cwd', 'running', 'blank', 'updatedAt', 'origin', 'parentSessionId', 'agentAvailable']) if (row[key] !== undefined) out[key] = row[key];
  return out;
}

/** Harness-injected context that is stored as role "user" but was not typed by anyone. */
const CONTEXT_SOURCES = /context|catalog|reminder|instructions|snapshot/i;

/**
 * Pull readable messages out of a page or wait result: user prompts,
 * assistant text, and turn errors. Harness-injected context records are
 * skipped. Unknown shapes fall back to a generic walk.
 */
export function messagesFrom(value, limit = 50) {
  const records = [];
  const visit = node => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!isRecord(node)) return;
    const event = isRecord(node.event) ? node.event : node;
    if (typeof event.type === 'string' && typeof event.seq === 'number') {
      const data = isRecord(event.data) ? event.data : {};
      if (event.type === 'turn/end' && data.reason?.kind === 'error') {
        records.push({ seq: event.seq, role: 'error', text: String(data.reason.error?.message ?? 'The turn ended with an error.') });
        return;
      }
      if (/^(system\/|request\/|permission\/|sandbox\/|approval\/)/.test(event.type)) return;
      if (/message|assistant|prompt/i.test(event.type)) {
        const role = data.role ?? data.message?.role ?? (event.type.startsWith('assistant') ? 'assistant' : event.type.startsWith('user') ? 'user' : undefined);
        const sourceKind = typeof data.source?.kind === 'string' ? data.source.kind : undefined;
        if (role === 'user' && sourceKind !== undefined && CONTEXT_SOURCES.test(sourceKind)) return;
        if (role === 'system') return;
        const text = textOf(data.content ?? data.message?.content ?? data.text ?? data.parts);
        if (role && text) records.push({ seq: event.seq, role, text });
        return;
      }
      return;
    }
    for (const key of ['records', 'items', 'messages', 'events', 'page', 'output', 'entries']) if (key in node) visit(node[key]);
  };
  visit(value);
  return records.slice(-limit);
}

const sessionIdSchema = { type: 'string', description: 'Session id, from dsh_list_sessions or dsh_create_session.' };

/**
 * High-level tools. Each `run(bridge, args, signal)` composes Remote calls the
 * Web UI also makes, so behavior matches clicking through the GUI.
 */
export const CURATED_TOOLS = Object.freeze([
  {
    name: 'dsh_overview',
    title: 'Harness overview',
    description: 'Summarize this DeepSeek Harness: version, control mode (read-only or full), available Remote namespaces with endpoint counts, and how to call anything not covered by a dedicated tool. Call this first.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(bridge) {
      const settings = bridge.settings();
      const namespaces = {};
      for (const descriptor of catalog(bridge)) {
        const entry = namespaces[descriptor.namespace] ??= { endpoints: 0, streams: 0 };
        entry.endpoints += 1;
        if (descriptor.mode === 'stream') entry.streams += 1;
      }
      return {
        ...bridge.info(),
        readOnly: settings.readOnly === true,
        blockedEndpoints: settings.blockedEndpoints ?? [],
        namespaces,
        hint: 'Use dsh_list_endpoints to discover an endpoint, dsh_describe_endpoint for its argument schema, then dsh_call (unary) or dsh_stream (stream). Endpoints are the same Remote API the DSH Web UI uses.',
      };
    },
  },
  {
    name: 'dsh_list_endpoints',
    title: 'List harness endpoints',
    description: 'List every Remote endpoint this harness exposes (the same API the Web UI uses). Filter by namespace or a text query matched against endpoint names and descriptions.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Only this namespace, for example "session" or "pluginManager".' },
        query: { type: 'string', description: 'Case-insensitive text to match in the endpoint or its description.' },
        includeSchemas: { type: 'boolean', description: 'Include each endpoint\'s argument and result JSON Schema (large).' },
      },
      additionalProperties: false,
    },
    async run(bridge, args) {
      const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
      const rows = catalog(bridge)
        .filter(descriptor => !args.namespace || descriptor.namespace === args.namespace)
        .map(descriptor => describeDescriptor(descriptor, { includeSchema: args.includeSchemas === true }))
        .filter(row => !query || row.endpoint.toLowerCase().includes(query) || row.description.toLowerCase().includes(query));
      return { count: rows.length, endpoints: rows };
    },
  },
  {
    name: 'dsh_describe_endpoint',
    title: 'Describe one endpoint',
    description: 'Show one endpoint\'s description, whether it is a stream, whether it only reads, and the JSON Schema of the args object dsh_call / dsh_stream expect.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { endpoint: { type: 'string', description: '"<namespace>/<method>", for example "session/prompt".' } }, required: ['endpoint'], additionalProperties: false },
    async run(bridge, args) {
      const descriptor = findDescriptor(bridge, args.endpoint);
      if (descriptor === undefined || isBlocked(bridge.settings(), args.endpoint)) throw new ControlError('dsh-control/endpoint-unknown', `No active endpoint ${args.endpoint}. Use dsh_list_endpoints.`, 404);
      return describeDescriptor(descriptor, { includeSchema: true });
    },
  },
  {
    name: 'dsh_call',
    title: 'Call an endpoint',
    description: 'Call any unary harness endpoint with named args, exactly as the Web UI does. Example: {"endpoint":"session/state","args":{"request":{"sessionId":"…"}}}. Use dsh_describe_endpoint for the args shape.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: '"<namespace>/<method>".' },
        args: { type: 'object', description: 'Named parameters; keys are the endpoint\'s parameter names. Use {} for none.', additionalProperties: true },
      },
      required: ['endpoint'],
      additionalProperties: false,
    },
    async run(bridge, args, signal) {
      return callEndpoint(bridge, args.endpoint, args.args ?? {}, signal);
    },
  },
  {
    name: 'dsh_stream',
    title: 'Read from a stream endpoint',
    description: 'Open a stream endpoint (for example workspace/follow, job/list, session/control), collect items until maxItems or timeoutMs, then close it. Most streams send a complete baseline as their first item.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string' },
        args: { type: 'object', additionalProperties: true },
        maxItems: { type: 'integer', minimum: 1, maximum: STREAM_LIMITS.maxItems, description: `Default ${STREAM_DEFAULTS.maxItems}.` },
        timeoutMs: { type: 'integer', minimum: 50, maximum: STREAM_LIMITS.timeoutMs, description: `Default ${STREAM_DEFAULTS.timeoutMs}.` },
      },
      required: ['endpoint'],
      additionalProperties: false,
    },
    async run(bridge, args, signal) {
      return collectStream(bridge, args.endpoint, args.args ?? {}, args, signal);
    },
  },
  {
    name: 'dsh_list_sessions',
    title: 'List sessions',
    description: 'List harness sessions (conversations) with id, title, working directory and whether they are running. Subagent children and blank sessions are hidden unless includeAll is true.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { includeAll: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, additionalProperties: false },
    async run(bridge, args, signal) {
      const value = await callEndpoint(bridge, 'session/list', { _request: {} }, signal);
      const rows = Array.isArray(value) ? value : Array.isArray(value?.sessions) ? value.sessions : Array.isArray(value?.items) ? value.items : [];
      const visible = rows
        .filter(row => args.includeAll === true || (row.origin !== 'subagent' && row.blank !== true))
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .slice(0, clampInt(args.limit, 100, 1, 1000))
        .map(summarizeSession);
      return { count: visible.length, total: rows.length, sessions: visible };
    },
  },
  {
    name: 'dsh_create_session',
    title: 'Create a session',
    description: 'Create a new session in a workspace (workspaceId) or a directory (cwd), optionally with an agent preset. Returns the new session id; send work to it with dsh_send_prompt.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute directory the session works in (exclusive with workspaceId).' },
        workspaceId: { type: 'string' },
        agentPreset: { type: 'string', description: 'Preset id from agentPresets/list; the configured default when omitted.' },
      },
      additionalProperties: false,
    },
    async run(bridge, args, signal) {
      const request = {};
      for (const key of ['cwd', 'workspaceId', 'agentPreset']) if (typeof args[key] === 'string' && args[key] !== '') request[key] = args[key];
      return callEndpoint(bridge, 'session/create', { request }, signal);
    },
  },
  {
    name: 'dsh_send_prompt',
    title: 'Send a prompt',
    description: 'Send a user message to a session, like typing in the composer. mode "queue" (default) runs it as the next turn; "steer" injects it into the running turn. With wait=true, waits for the agent to finish (or to need input) and returns its reply text.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: sessionIdSchema,
        text: { type: 'string', description: 'Message text.' },
        mode: { type: 'string', enum: ['queue', 'steer'] },
        wait: { type: 'boolean', description: 'Wait for the turn to settle and return the reply.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 1800000, description: 'Wait limit when wait=true (default 120000).' },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
    async run(bridge, args, signal) {
      if (typeof args.text !== 'string' || args.text.trim() === '') throw new ControlError('dsh-control/arguments-invalid', 'text must be a non-empty string.', 400);
      const before = args.wait === true ? await sessionCursor(bridge, args.sessionId, signal).catch(() => undefined) : undefined;
      const request = {
        requestId: randomUUID(),
        sessionId: args.sessionId,
        mode: args.mode === 'steer' ? 'steer' : 'queue',
        content: [{ type: 'text', text: args.text }],
      };
      const accepted = await callEndpoint(bridge, 'session/prompt', { request }, signal);
      if (args.wait !== true) return { accepted: safeJson(accepted), requestId: request.requestId };
      const waited = await waitSession(bridge, args.sessionId, args.timeoutMs ?? 120000, before, signal);
      return { requestId: request.requestId, ...waited };
    },
  },
  {
    name: 'dsh_wait_session',
    title: 'Wait for a session',
    description: 'Wait until a session is idle or needs user input (approval or question), then return its state and the assistant output since afterSeq.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { sessionId: sessionIdSchema, timeoutMs: { type: 'integer', minimum: 100, maximum: 1800000 }, afterSeq: { type: 'number' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    async run(bridge, args, signal) {
      return waitSession(bridge, args.sessionId, args.timeoutMs ?? 60000, args.afterSeq, signal);
    },
  },
  {
    name: 'dsh_read_session',
    title: 'Read session history',
    description: 'Read the latest messages of a session as role/text pairs. Set raw=true for the full history page records.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { sessionId: sessionIdSchema, maxMessages: { type: 'integer', minimum: 1, maximum: 500 }, raw: { type: 'boolean' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    async run(bridge, args, signal) {
      const maxMessages = clampInt(args.maxMessages, 20, 1, 500);
      const page = await readPage(bridge, args.sessionId, maxMessages, signal);
      if (args.raw === true) return page;
      const messages = messagesFrom(page, maxMessages);
      return messages.length > 0 ? { sessionId: args.sessionId, messages } : { sessionId: args.sessionId, messages, note: 'No text messages were recognized; retry with raw=true.' };
    },
  },
  {
    name: 'dsh_cancel_session',
    title: 'Cancel the running turn',
    description: 'Stop the agent turn that is running in a session (queued prompts stay queued).',
    readOnly: false,
    inputSchema: { type: 'object', properties: { sessionId: sessionIdSchema }, required: ['sessionId'], additionalProperties: false },
    async run(bridge, args, signal) {
      return callEndpoint(bridge, 'session/cancel', { request: { sessionId: args.sessionId } }, signal);
    },
  },
  {
    name: 'dsh_list_workspaces',
    title: 'List workspaces',
    description: 'List harness workspaces (project folders) with their ids, titles, paths and session ids.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(bridge, _args, signal) {
      const result = await collectStream(bridge, 'workspace/follow', {}, { maxItems: 1, timeoutMs: 10000 }, signal);
      return result.items[0] ?? { note: 'The workspace stream sent no baseline in time.' };
    },
  },
  {
    name: 'dsh_list_models',
    title: 'List models',
    description: 'List every model the harness can currently route to, grouped by provider. Use with session/selectModel through dsh_call.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(bridge, _args, signal) {
      return callEndpoint(bridge, 'session/modelCatalog', {}, signal);
    },
  },
  {
    name: 'dsh_list_plugins',
    title: 'List plugins',
    description: 'List harness plugins: entry id, module, enabled, load phase and English title. Filter with query. Enable or disable one with dsh_call pluginManager/setPluginEnabled {"id": <entryId>, "enabled": true|false}. raw=true returns the full rows.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Case-insensitive text matched in entry id, module or title.' }, raw: { type: 'boolean' } }, additionalProperties: false },
    async run(bridge, args, signal) {
      const value = await callEndpoint(bridge, 'pluginManager/listPlugins', {}, signal);
      const rows = Array.isArray(value) ? value : Array.isArray(value?.plugins) ? value.plugins : [];
      const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
      const titleOf = row => (typeof row.meta?.title === 'string' ? row.meta.title : row.meta?.title?.en);
      const matched = rows.filter(row => !query || [row.entryId, row.moduleName, titleOf(row)].some(text => typeof text === 'string' && text.toLowerCase().includes(query)));
      if (args.raw === true) return { count: matched.length, plugins: matched };
      return {
        count: matched.length,
        plugins: matched.map(row => {
          const out = { entryId: row.entryId, moduleName: row.moduleName, enabled: row.enabled, phase: row.fiberPhase ?? null };
          const title = titleOf(row);
          if (title) out.title = title;
          if (row.readOnlyReason) out.readOnlyReason = row.readOnlyReason;
          return out;
        }),
      };
    },
  },
]);

function hasEndpoint(bridge, endpoint) {
  return bridge.list().some(descriptor => `${descriptor.namespace}/${descriptor.method}` === endpoint);
}

/** One session row from session/list (works on every DSH 0.2 release). */
async function sessionRow(bridge, sessionId, signal) {
  const value = await callEndpoint(bridge, 'session/list', { _request: {} }, signal);
  const rows = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : Array.isArray(value?.sessions) ? value.sessions : [];
  return rows.find(row => (row.sessionId ?? row.id) === sessionId);
}

/** Log cursor of a session: session/state on DSH 0.2.2+, the projection's asOfSeq before. */
async function sessionCursor(bridge, sessionId, signal) {
  if (hasEndpoint(bridge, 'session/state')) {
    const state = await callEndpoint(bridge, 'session/state', { request: { sessionId } }, signal);
    if (Number.isFinite(state?.cursor)) return state.cursor;
  }
  const row = await sessionRow(bridge, sessionId, signal);
  const seq = row?.projections?.asOfSeq;
  return Number.isFinite(seq) ? seq : undefined;
}

/**
 * Read one history page. DSH 0.2.1 requires `throughSeq`; 0.2.2+ makes it
 * optional. Supply it from the session cursor when the schema demands it.
 */
export async function readPage(bridge, sessionId, maxMessages, signal) {
  const request = { address: { kind: 'session', sessionId }, maxMessages };
  const descriptor = bridge.list().find(candidate => candidate.namespace === 'session' && candidate.method === 'page');
  const required = codecJsonSchema(descriptor?.parameters?.[0]?.codec).required;
  if (Array.isArray(required) && required.includes('throughSeq')) {
    const cursor = await sessionCursor(bridge, sessionId, signal);
    if (cursor === undefined) throw new ControlError('dsh-control/session-unknown', `No session ${sessionId}.`, 404);
    request.throughSeq = cursor;
  }
  return callEndpoint(bridge, 'session/page', { request }, signal);
}

/** Poll session/list until the session stops running (DSH releases without session/wait). */
async function pollUntilIdle(bridge, sessionId, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  // Give a just-queued prompt a moment to start.
  await delay(400, signal);
  for (;;) {
    const row = await sessionRow(bridge, sessionId, signal);
    if (row === undefined) throw new ControlError('dsh-control/session-unknown', `No session ${sessionId}.`, 404);
    if (row.running !== true) return { reason: 'idle', state: { running: false, cursor: row.projections?.asOfSeq } };
    if (Date.now() >= deadline) return { reason: 'timeout', state: { running: true, cursor: row.projections?.asOfSeq } };
    await delay(Math.min(1000, Math.max(50, deadline - Date.now())), signal);
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

async function waitSession(bridge, sessionId, timeoutMs, afterSeq, signal) {
  const limit = clampInt(timeoutMs, 60000, 100, 1800000);
  let value;
  if (hasEndpoint(bridge, 'session/wait')) {
    const request = { sessionId, timeoutMs: limit };
    if (Number.isFinite(afterSeq)) request.afterSeq = afterSeq;
    value = await callEndpoint(bridge, 'session/wait', { request }, signal);
  } else {
    value = await pollUntilIdle(bridge, sessionId, limit, signal);
  }
  let messages = messagesFrom(value?.output ?? value, 50);
  // session/wait returns assistant records only; when there are none, read the
  // latest page so a turn that ended in an error reports why.
  if (!messages.some(message => message.role === 'assistant') && value?.reason === 'idle' && hasEndpoint(bridge, 'session/page')) {
    try {
      const page = await readPage(bridge, sessionId, 5, signal);
      messages = messagesFrom(page, 20).filter(message => message.role !== 'user' && (!Number.isFinite(afterSeq) || message.seq > afterSeq));
    } catch { /* keep the wait result */ }
  }
  const reply = messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n\n');
  const errors = messages.filter(message => message.role === 'error').map(message => message.text);
  const out = { reason: value?.reason, state: value?.state, reply };
  if (errors.length > 0) out.error = errors.at(-1);
  if (value?.reason === 'input-required') out.note = 'The agent is waiting for an approval or an answer; respond in the DSH GUI (or with dsh_call userQuestions/answer), then call dsh_wait_session.';
  if (reply === '' && errors.length === 0) out.output = value?.output;
  return out;
}

// ── per-endpoint tools (optional) ───────────────────────────────────────────

const ENDPOINT_TOOL_PREFIX = 'dsh__';

export function endpointToolName(namespace, method) {
  return `${ENDPOINT_TOOL_PREFIX}${namespace}__${method}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function endpointTools(bridge) {
  const settings = bridge.settings();
  const tools = [];
  for (const descriptor of catalog(bridge)) {
    const readOnly = isReadOnlyEndpoint(descriptor.namespace, descriptor.method);
    if (settings.readOnly === true && !readOnly) continue;
    const endpoint = `${descriptor.namespace}/${descriptor.method}`;
    const stream = descriptor.mode === 'stream';
    const inputSchema = inputSchemaFor(descriptor);
    if (stream) {
      inputSchema.properties = { ...inputSchema.properties, $maxItems: { type: 'integer', minimum: 1, maximum: STREAM_LIMITS.maxItems }, $timeoutMs: { type: 'integer', minimum: 50, maximum: STREAM_LIMITS.timeoutMs } };
    }
    tools.push({
      name: endpointToolName(descriptor.namespace, descriptor.method),
      title: endpoint,
      description: `${stream ? '[stream] ' : ''}${descriptor.description || endpoint}`.slice(0, 1024),
      readOnly,
      inputSchema,
      async run(innerBridge, args, signal) {
        if (!stream) return callEndpoint(innerBridge, endpoint, args, signal);
        const { $maxItems, $timeoutMs, ...rest } = args;
        return collectStream(innerBridge, endpoint, rest, { maxItems: $maxItems, timeoutMs: $timeoutMs }, signal);
      },
    });
  }
  return tools;
}

export function listTools(bridge) {
  const settings = bridge.settings();
  const curated = CURATED_TOOLS.filter(tool => !(settings.readOnly === true && tool.readOnly === false));
  return settings.exposeAllEndpoints === true ? [...curated, ...endpointTools(bridge)] : [...curated];
}

export function toolDefinition(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.title, readOnlyHint: tool.readOnly === true, destructiveHint: tool.readOnly !== true, openWorldHint: false },
  };
}

export async function runTool(bridge, name, args = {}, signal) {
  if (typeof name !== 'string') throw new ControlError('dsh-control/tool-unknown', 'Tool name is required.', 400);
  const tool = listTools(bridge).find(candidate => candidate.name === name)
    ?? (bridge.settings().readOnly === true && CURATED_TOOLS.some(candidate => candidate.name === name)
      ? (() => { throw new ControlError('dsh-control/read-only', `${name} changes harness state, and read-only mode is on.`, 403); })()
      : undefined);
  if (tool === undefined) throw new ControlError('dsh-control/tool-unknown', `Unknown tool ${name}.`, 404);
  if (!isRecord(args)) throw new ControlError('dsh-control/arguments-invalid', 'Tool arguments must be a JSON object.', 400);
  return tool.run(bridge, args, signal);
}

// ── MCP JSON-RPC ────────────────────────────────────────────────────────────

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/**
 * Handle one MCP JSON-RPC message (or batch). Returns the response object(s),
 * or `undefined` when the input contained only notifications/responses.
 */
export async function handleMcpMessage(bridge, message, signal) {
  if (Array.isArray(message)) {
    if (message.length === 0) return rpcError(null, JSONRPC_INVALID_REQUEST, 'Empty batch.');
    const responses = (await Promise.all(message.map(item => handleOne(bridge, item, signal)))).filter(Boolean);
    return responses.length > 0 ? responses : undefined;
  }
  return handleOne(bridge, message, signal);
}

async function handleOne(bridge, message, signal) {
  if (!isRecord(message) || message.jsonrpc !== '2.0') return rpcError(message?.id, JSONRPC_INVALID_REQUEST, 'Expected a JSON-RPC 2.0 message.');
  const isRequest = typeof message.method === 'string' && 'id' in message && message.id !== null;
  if (typeof message.method !== 'string') return undefined; // a response to us; we never send requests
  if (!isRequest) return undefined; // notification (initialized, cancelled, ...)
  const { id, method } = message;
  const params = isRecord(message.params) ? message.params : {};
  try {
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSIONS[0];
        const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
        const info = bridge.info();
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: PLUGIN_NAME, title: SERVER_TITLE, version: info.pluginVersion ?? '0.0.0' },
            instructions: `Controls the DeepSeek Harness this server runs in${bridge.settings().readOnly ? ' (read-only mode)' : ''}. Start with dsh_overview. dsh_list_sessions / dsh_create_session / dsh_send_prompt drive conversations; dsh_list_endpoints + dsh_call reach every other Web UI action (workspaces, models, plugins, schedules, goals, terminals, settings).`,
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: listTools(bridge).map(toolDefinition) } };
      case 'tools/call': {
        if (typeof params.name !== 'string') return rpcError(id, JSONRPC_INVALID_PARAMS, 'params.name is required.');
        const known = listTools(bridge).some(tool => tool.name === params.name) || CURATED_TOOLS.some(tool => tool.name === params.name);
        if (!known) return rpcError(id, JSONRPC_INVALID_PARAMS, `Unknown tool ${params.name}.`);
        try {
          const value = await runTool(bridge, params.name, params.arguments ?? {}, signal);
          const { text, truncated } = boundedJson(value, bridge.settings().maxResultBytes);
          const result = { content: [{ type: 'text', text }], isError: false };
          if (!truncated) {
            const structured = safeJson(value);
            if (isRecord(structured)) result.structuredContent = structured;
          }
          return { jsonrpc: '2.0', id, result };
        } catch (error) {
          const info = errorInfo(error);
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error ${info.code}: ${info.message}` }], isError: true } };
        }
      }
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } };
      case 'resources/templates/list':
        return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };
      default:
        return rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method ${method} is not supported.`);
    }
  } catch (error) {
    const info = errorInfo(error);
    return rpcError(id, -32603, info.message, { code: info.code });
  }
}

export function parseJsonBody(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: rpcError(null, JSONRPC_PARSE_ERROR, 'Body is not valid JSON.') };
  }
}
