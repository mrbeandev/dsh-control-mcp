/**
 * API keys and their scopes.
 *
 * A key is either
 *   - full:   speaks as the harness owner, like the original single token;
 *   - scoped: speaks as a `dsh-control-key` principal whose permissions DSH's
 *             own remote-access engine decides through the policy below.
 *
 * Scoping rides the same engine that confines Liveshare viewers: every Remote
 * call names the session/workspace resources it touches, the gateway asks the
 * policy before running it, and list methods (session/list, session/search,
 * workspace/follow, session/control, …) filter their items per resource. So a
 * scoped key never sees a chat outside its scope, in any endpoint.
 *
 * Stored records (credential store, one grant record):
 *   { version: 1, keys: [{ id, name, hash, prefix, createdAt, expiresAt?,
 *     lastUsedAt?, disabled?, mcp, api, mode: 'full' | 'scoped',
 *     access: 'read' | 'prompt', workspaces: [...], sessions: [...] }] }
 * Tokens are never stored, only their SHA-256.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ControlError, isRecord } from './core.mjs';

export const KEY_PRINCIPAL = 'dsh-control-key';
export const KEY_STORE_VERSION = 1;
export const MAX_KEYS = 100;
export const MAX_SCOPE_ITEMS = 1000;
const TOKEN_PREFIX = 'dshc_';

// ── roles: the actions DSH lets a scoped key take ────────────────────────────

/**
 * Global reads a scoped key needs to find its way around. Every one either
 * names no private resource (model and provider catalogs, presets, command
 * descriptors) or filters its items through `remoteAccess.allows()` per
 * session/workspace (session/list, session/search, session/control,
 * workspace/follow). Nothing here mutates.
 */
export const SCOPED_GLOBAL_ACTIONS = Object.freeze([
  'agentPresets/list',
  'llm/listProviders',
  'permissionPresets/catalog',
  'session/canOpenWorkspacePath',
  'session/control',
  'session/list',
  'session/modelCatalog',
  'session/search',
  'workspace/follow',
  // Owner-side Remote events that carry a session the key may see.
  'event:api-session/activity',
  'event:api-session/added',
  'event:api-session/error',
  'event:api-session/removed',
  'event:api-session/status',
]);

/** Reading one allowed session. */
export const SESSION_READ_ACTIONS = Object.freeze([
  'commands/list',
  'goals/get',
  'session/attachment',
  'session/control',
  'session/events',
  'session/follow',
  'session/list',
  'session/observeEvent',
  'session/observeProjections',
  'session/observeState',
  'session/page',
  'session/projections',
  'session/search',
  'session/state',
  'session/wait',
  'skills/list',
  'terminal/list',
  'terminal/watch',
  'toolResults/watch',
  'workspace/follow',
  'event:api-session/activity',
  'event:api-session/added',
  'event:api-session/error',
  'event:api-session/removed',
  'event:api-session/status',
]);

/** Driving one allowed session, on top of reading it. */
export const SESSION_PROMPT_ACTIONS = Object.freeze([
  'session/prompt',
  'session/cancel',
  'session/rename',
  'session/selectModel',
  'session/updateQueue',
  'fileUploads/upload',
]);

/** Seeing one allowed workspace. */
export const WORKSPACE_READ_ACTIONS = Object.freeze(['workspace/follow']);

/** Starting new chats inside one allowed workspace (prompt access only). */
export const WORKSPACE_PROMPT_ACTIONS = Object.freeze(['session/create']);

/** Every action some scoped role grants: anything else is refused before it runs. */
export const SCOPED_ACTIONS = Object.freeze([...new Set([
  ...SCOPED_GLOBAL_ACTIONS, ...SESSION_READ_ACTIONS, ...SESSION_PROMPT_ACTIONS, ...WORKSPACE_READ_ACTIONS, ...WORKSPACE_PROMPT_ACTIONS,
])].sort());

const role = (name, resource, actions) => Object.freeze({ name, resource, actions: Object.freeze([...actions]) });
export const ROLES = Object.freeze({
  global: role('dsh-control-mcp:scoped-global', 'global', SCOPED_GLOBAL_ACTIONS),
  sessionRead: role('dsh-control-mcp:session-read', 'session', SESSION_READ_ACTIONS),
  sessionPrompt: role('dsh-control-mcp:session-prompt', 'session', SESSION_PROMPT_ACTIONS),
  workspaceRead: role('dsh-control-mcp:workspace-read', 'workspace', WORKSPACE_READ_ACTIONS),
  workspacePrompt: role('dsh-control-mcp:workspace-prompt', 'workspace', WORKSPACE_PROMPT_ACTIONS),
});

// ── key records ─────────────────────────────────────────────────────────────

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function newKeyToken() {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

const NAME_MAX = 80;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function cleanIds(values, label) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new ControlError('dsh-control/key-invalid', `${label} must be a list of ids.`, 400);
  const out = [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
  if (out.length > MAX_SCOPE_ITEMS) throw new ControlError('dsh-control/key-invalid', `${label} may list at most ${MAX_SCOPE_ITEMS} ids.`, 400);
  const bad = out.find(value => !ID_RE.test(value));
  if (bad !== undefined) throw new ControlError('dsh-control/key-invalid', `${label} contains an invalid id: ${bad.slice(0, 60)}`, 400);
  return out;
}

/**
 * Validate the editable fields of a key. `previous` supplies values the patch
 * omits, so the same function serves create and update.
 */
export function normalizeKeyFields(input, previous = {}) {
  if (!isRecord(input)) throw new ControlError('dsh-control/key-invalid', 'Key fields must be an object.', 400);
  const pick = (field, fallback) => (input[field] === undefined ? (previous[field] ?? fallback) : input[field]);
  const name = String(pick('name', '')).trim();
  if (name === '' || name.length > NAME_MAX) throw new ControlError('dsh-control/key-invalid', `A key needs a name of 1 to ${NAME_MAX} characters.`, 400);
  const mode = pick('mode', 'scoped');
  if (mode !== 'full' && mode !== 'scoped') throw new ControlError('dsh-control/key-invalid', 'mode is "full" or "scoped".', 400);
  const access = pick('access', 'read');
  if (access !== 'read' && access !== 'prompt') throw new ControlError('dsh-control/key-invalid', 'access is "read" or "prompt".', 400);
  const workspaces = cleanIds(pick('workspaces', []), 'workspaces');
  const sessions = cleanIds(pick('sessions', []), 'sessions');
  let expiresAt = pick('expiresAt', null);
  if (expiresAt !== null && expiresAt !== '') {
    const time = Date.parse(expiresAt);
    if (!Number.isFinite(time)) throw new ControlError('dsh-control/key-invalid', 'expiresAt must be an ISO date or null.', 400);
    expiresAt = new Date(time).toISOString();
  } else expiresAt = null;
  const flag = (field, fallback) => { const value = pick(field, fallback); if (typeof value !== 'boolean') throw new ControlError('dsh-control/key-invalid', `${field} must be true or false.`, 400); return value; };
  return { name, mode, access, workspaces, sessions, expiresAt, mcp: flag('mcp', true), api: flag('api', true), disabled: flag('disabled', false) };
}

/** Public view of a key: never the hash. */
export function publicKey(record) {
  const { hash, ...rest } = record;
  void hash;
  return { ...rest, expired: isExpired(record) };
}

export function isExpired(record, now = Date.now()) {
  return typeof record.expiresAt === 'string' && Date.parse(record.expiresAt) <= now;
}

export function parseStore(payload) {
  const keys = isRecord(payload) && Array.isArray(payload.keys) ? payload.keys : [];
  return keys.filter(key => isRecord(key) && typeof key.id === 'string' && typeof key.hash === 'string' && /^[0-9a-f]{64}$/.test(key.hash)).map(key => {
    try {
      return { id: key.id, hash: key.hash, prefix: String(key.prefix ?? ''), createdAt: String(key.createdAt ?? ''), lastUsedAt: key.lastUsedAt ?? null, ...normalizeKeyFields(key) };
    } catch {
      return { id: key.id, hash: key.hash, prefix: String(key.prefix ?? ''), createdAt: String(key.createdAt ?? ''), lastUsedAt: null, name: String(key.name ?? 'invalid key').slice(0, NAME_MAX) || 'invalid key', mode: 'scoped', access: 'read', workspaces: [], sessions: [], expiresAt: null, mcp: false, api: false, disabled: true };
    }
  });
}

/**
 * In-memory key registry. `persist(keys)` saves the full list; `onChange`
 * tells the access policy to recompute. Authentication is a hash lookup
 * followed by a constant-time compare.
 */
export function createKeyRegistry({ persist = async () => {}, onChange = () => {}, now = () => Date.now() } = {}) {
  let keys = [];
  const byHash = () => new Map(keys.map(key => [key.hash, key]));
  let index = byHash();
  const commit = async next => {
    const previous = keys;
    keys = next;
    index = byHash();
    try {
      await persist(keys);
    } catch (error) {
      keys = previous;
      index = byHash();
      throw error;
    }
    onChange();
  };
  return {
    load(stored) { keys = parseStore(stored); index = byHash(); onChange(); },
    list: () => keys.map(publicKey),
    get: id => keys.find(key => key.id === id),
    count: () => keys.length,
    /** The live key for a presented token, or undefined. Never throws. */
    authenticate(token) {
      if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length < 40) return undefined;
      const hash = hashToken(token);
      const key = index.get(hash);
      if (key === undefined) return undefined;
      if (!timingSafeEqual(Buffer.from(key.hash, 'hex'), Buffer.from(hash, 'hex'))) return undefined;
      if (key.disabled || isExpired(key, now())) return undefined;
      return key;
    },
    async create(fields) {
      if (keys.length >= MAX_KEYS) throw new ControlError('dsh-control/key-limit', `At most ${MAX_KEYS} keys.`, 409);
      const token = newKeyToken();
      const record = { id: randomUUID(), hash: hashToken(token), prefix: token.slice(0, 9), createdAt: new Date(now()).toISOString(), lastUsedAt: null, ...normalizeKeyFields(fields) };
      await commit([...keys, record]);
      return { key: publicKey(record), token };
    },
    async update(id, patch) {
      const current = keys.find(key => key.id === id);
      if (current === undefined) throw new ControlError('dsh-control/key-unknown', 'No such key.', 404);
      const record = { ...current, ...normalizeKeyFields(patch, current) };
      await commit(keys.map(key => (key.id === id ? record : key)));
      return publicKey(record);
    },
    async rotate(id) {
      const current = keys.find(key => key.id === id);
      if (current === undefined) throw new ControlError('dsh-control/key-unknown', 'No such key.', 404);
      const token = newKeyToken();
      const record = { ...current, hash: hashToken(token), prefix: token.slice(0, 9) };
      await commit(keys.map(key => (key.id === id ? record : key)));
      return { key: publicKey(record), token };
    },
    async remove(id) {
      if (!keys.some(key => key.id === id)) throw new ControlError('dsh-control/key-unknown', 'No such key.', 404);
      await commit(keys.filter(key => key.id !== id));
    },
    /** Best-effort usage stamp, persisted at most once a minute per key. */
    touch(key) {
      const stamp = now();
      if (key.lastUsedAt && stamp - Date.parse(key.lastUsedAt) < 60000) return;
      key.lastUsedAt = new Date(stamp).toISOString();
      persist(keys).catch(() => {});
    },
  };
}

// ── DSH remote-access policy ────────────────────────────────────────────────

export function keyPrincipal(key) {
  return Object.freeze({ kind: KEY_PRINCIPAL, keyId: key.id });
}

/**
 * The remote-access policy for scoped keys.
 * @param registry - key registry (reads the live record on every decision).
 * @param workspaces - `() => [{ id, sessionIds }]`, the live workspace registry.
 */
export function createScopedPolicy(registry, workspaces) {
  return {
    bindings(principal) {
      const key = registry.get(principal?.keyId);
      if (key === undefined || key.mode !== 'scoped' || key.disabled || isExpired(key)) return [];
      const prompt = key.access === 'prompt';
      const bindings = [{ role: ROLES.global, resource: { kind: 'global' } }];
      const sessionIds = new Set(key.sessions);
      const workspaceIds = new Set(key.workspaces);
      let registered = [];
      try { registered = workspaces(); } catch { registered = []; }
      for (const workspace of registered) {
        if (workspaceIds.has(workspace.id)) {
          // Follow the workspace: its current and future sessions.
          for (const id of workspace.sessionIds ?? []) sessionIds.add(id);
        } else if ((workspace.sessionIds ?? []).some(id => key.sessions.includes(id))) {
          // A workspace that holds an individually allowed session stays visible (filtered to that session).
          bindings.push({ role: ROLES.workspaceRead, resource: { kind: 'workspace', id: workspace.id } });
        }
      }
      for (const id of workspaceIds) {
        bindings.push({ role: ROLES.workspaceRead, resource: { kind: 'workspace', id } });
        if (prompt) bindings.push({ role: ROLES.workspacePrompt, resource: { kind: 'workspace', id } });
      }
      for (const id of sessionIds) {
        bindings.push({ role: ROLES.sessionRead, resource: { kind: 'session', id } });
        if (prompt) bindings.push({ role: ROLES.sessionPrompt, resource: { kind: 'session', id } });
      }
      return bindings;
    },
    /** Refusal reason string; DSH wraps it into `remote-access/denied` details. */
    explain(request) {
      const key = registry.get(request?.principal?.keyId);
      if (key === undefined || key.disabled || isExpired(key)) return 'dsh-control-key-inactive';
      if (!SCOPED_ACTIONS.includes(request.action)) return 'dsh-control-key-action-not-allowed';
      if (key.access === 'read' && [...SESSION_PROMPT_ACTIONS, ...WORKSPACE_PROMPT_ACTIONS].includes(request.action)) return 'dsh-control-key-read-only';
      return 'dsh-control-key-out-of-scope';
    },
  };
}

/**
 * Plugin-side pre-check for scoped keys, before a call reaches the gateway.
 * DSH's policy is the real gate; this only turns the common refusals into
 * clear messages and blocks endpoints no scoped role names.
 */
export function scopedPreCheck(key, endpoint) {
  if (key?.mode !== 'scoped') return;
  if (!SCOPED_ACTIONS.includes(endpoint)) {
    throw new ControlError('dsh-control/key-scope', `${endpoint} is not available to a scoped key. Scoped keys reach sessions, workspaces and model catalogs only; use a full-access key for this.`, 403);
  }
  if (key.access === 'read' && [...SESSION_PROMPT_ACTIONS, ...WORKSPACE_PROMPT_ACTIONS].includes(endpoint)) {
    throw new ControlError('dsh-control/key-read-only', `${endpoint} changes a session, and this key has read-only access.`, 403);
  }
}
