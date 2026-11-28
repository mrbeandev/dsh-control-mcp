import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, SCOPED_ACTIONS, SESSION_PROMPT_ACTIONS, createKeyRegistry, createScopedPolicy, hashToken, keyPrincipal,
  normalizeKeyFields, parseStore, scopedPreCheck,
} from '../lib/access.mjs';

const allowsOn = (bindings, action, resource) => bindings.some(b => b.resource.kind === resource.kind && b.resource.id === resource.id && b.role.actions.includes(action));

describe('key fields', () => {
  it('validates and normalizes', () => {
    assert.deepEqual(normalizeKeyFields({ name: ' Bot ', workspaces: ['w1', 'w1', ' '], sessions: ['s1'] }), {
      name: 'Bot', mode: 'scoped', access: 'read', workspaces: ['w1'], sessions: ['s1'], expiresAt: null, mcp: true, api: true, disabled: false,
    });
    assert.throws(() => normalizeKeyFields({ name: '' }), /name/);
    assert.throws(() => normalizeKeyFields({ name: 'x', mode: 'root' }), /mode/);
    assert.throws(() => normalizeKeyFields({ name: 'x', access: 'admin' }), /access/);
    assert.throws(() => normalizeKeyFields({ name: 'x', sessions: ['../etc'] }), /invalid id/);
    assert.throws(() => normalizeKeyFields({ name: 'x', expiresAt: 'soon' }), /expiresAt/);
    assert.throws(() => normalizeKeyFields({ name: 'x', mcp: 'yes' }), /mcp/);
  });

  it('patches keep fields the patch omits', () => {
    const previous = normalizeKeyFields({ name: 'A', access: 'prompt', sessions: ['s1'] });
    assert.deepEqual(normalizeKeyFields({ disabled: true }, previous), { ...previous, disabled: true });
  });

  it('drops corrupt stored records to disabled instead of trusting them', () => {
    const [bad] = parseStore({ keys: [{ id: 'k', hash: 'a'.repeat(64), name: 'x', mode: 'root' }] });
    assert.equal(bad.disabled, true);
    assert.equal(bad.mcp, false);
    assert.equal(parseStore({ keys: [{ id: 'k', hash: 'nothex' }] }).length, 0);
    assert.deepEqual(parseStore(undefined), []);
  });
});

describe('key registry', () => {
  it('stores only hashes, authenticates live keys, and refuses disabled, expired, rotated and deleted ones', async () => {
    let saved;
    let now = Date.parse('2026-01-01T00:00:00Z');
    const registry = createKeyRegistry({ persist: async keys => { saved = JSON.stringify(keys); }, now: () => now });
    const { key, token } = await registry.create({ name: 'k', sessions: ['s1'] });
    assert.ok(!saved.includes(token), 'token never persisted');
    assert.ok(saved.includes(hashToken(token)));
    assert.equal('hash' in key, false);
    assert.equal(registry.authenticate(token)?.id, key.id);
    assert.equal(registry.authenticate(token + 'x'), undefined);
    assert.equal(registry.authenticate('nope'), undefined);
    await registry.update(key.id, { disabled: true });
    assert.equal(registry.authenticate(token), undefined);
    await registry.update(key.id, { disabled: false, expiresAt: '2026-01-02T00:00:00Z' });
    assert.ok(registry.authenticate(token));
    now = Date.parse('2026-01-03T00:00:00Z');
    assert.equal(registry.authenticate(token), undefined);
    assert.equal(registry.list()[0].expired, true);
    await registry.update(key.id, { expiresAt: null });
    const rotated = await registry.rotate(key.id);
    assert.equal(registry.authenticate(token), undefined);
    assert.ok(registry.authenticate(rotated.token));
    await registry.remove(key.id);
    assert.equal(registry.authenticate(rotated.token), undefined);
  });

  it('rolls back when persisting fails', async () => {
    const registry = createKeyRegistry({ persist: async () => { throw new Error('disk full'); } });
    await assert.rejects(registry.create({ name: 'k' }), /disk full/);
    assert.equal(registry.count(), 0);
  });

  it('survives a reload from storage', async () => {
    let stored;
    const a = createKeyRegistry({ persist: async keys => { stored = JSON.parse(JSON.stringify({ version: 1, keys })); } });
    const { token } = await a.create({ name: 'k', mode: 'full' });
    const b = createKeyRegistry();
    b.load(stored);
    assert.equal(b.authenticate(token)?.mode, 'full');
  });
});

describe('scoped policy', () => {
  const workspaces = () => [{ id: 'wA', sessionIds: ['a1', 'a2'] }, { id: 'wB', sessionIds: ['b1'] }];
  const registryWith = fields => {
    const record = { id: 'k1', ...normalizeKeyFields({ name: 'k', ...fields }) };
    return { get: id => (id === 'k1' ? record : undefined) };
  };

  it('a session-scoped read key reads exactly its session and its workspace listing', () => {
    const bindings = createScopedPolicy(registryWith({ sessions: ['a1'] }), workspaces).bindings(keyPrincipal({ id: 'k1' }));
    assert.ok(allowsOn(bindings, 'session/page', { kind: 'session', id: 'a1' }));
    assert.ok(!allowsOn(bindings, 'session/page', { kind: 'session', id: 'a2' }));
    assert.ok(!allowsOn(bindings, 'session/page', { kind: 'session', id: 'b1' }));
    assert.ok(!allowsOn(bindings, 'session/prompt', { kind: 'session', id: 'a1' }));
    assert.ok(allowsOn(bindings, 'workspace/follow', { kind: 'workspace', id: 'wA' }));
    assert.ok(!allowsOn(bindings, 'workspace/follow', { kind: 'workspace', id: 'wB' }));
    assert.ok(!allowsOn(bindings, 'session/create', { kind: 'workspace', id: 'wA' }));
  });

  it('a workspace-scoped prompt key follows the workspace and may create sessions there', () => {
    const live = [{ id: 'wA', sessionIds: ['a1'] }];
    const policy = createScopedPolicy(registryWith({ workspaces: ['wA'], access: 'prompt' }), () => live);
    assert.ok(!allowsOn(policy.bindings(keyPrincipal({ id: 'k1' })), 'session/prompt', { kind: 'session', id: 'a9' }));
    live[0].sessionIds.push('a9');
    const bindings = policy.bindings(keyPrincipal({ id: 'k1' }));
    assert.ok(allowsOn(bindings, 'session/prompt', { kind: 'session', id: 'a9' }), 'later sessions are in scope');
    assert.ok(allowsOn(bindings, 'session/create', { kind: 'workspace', id: 'wA' }));
    assert.ok(!allowsOn(bindings, 'session/create', { kind: 'workspace', id: 'wB' }));
  });

  it('grants nothing to disabled, expired, full-mode or unknown keys', () => {
    for (const fields of [{ disabled: true, sessions: ['a1'] }, { expiresAt: '2000-01-01T00:00:00Z', sessions: ['a1'] }, { mode: 'full' }]) {
      assert.deepEqual(createScopedPolicy(registryWith(fields), workspaces).bindings(keyPrincipal({ id: 'k1' })), []);
    }
    assert.deepEqual(createScopedPolicy(registryWith({}), workspaces).bindings({ kind: 'dsh-control-key', keyId: 'other' }), []);
  });

  it('never grants harness-wide changes through any role', () => {
    const roleActions = Object.values(ROLES).flatMap(role => role.actions);
    for (const action of ['pluginManager/setPluginEnabled', 'pluginManager/installBundle', 'settings/mutate', 'credentials/set', 'workspace/delete', 'workspace/create', 'terminal/create', 'account/signOut', 'schedule/create', 'job/kill', 'dynamicCordisRunner/invoke']) {
      assert.ok(!roleActions.includes(action), action);
    }
    const globalActions = ROLES.global.actions;
    assert.ok(globalActions.every(action => !SESSION_PROMPT_ACTIONS.includes(action)), 'global role never changes a session');
  });

  it('explains refusals with reason strings', () => {
    const policy = createScopedPolicy(registryWith({ sessions: ['a1'] }), workspaces);
    assert.equal(policy.explain({ principal: { keyId: 'k1' }, action: 'session/prompt' }), 'dsh-control-key-read-only');
    assert.equal(policy.explain({ principal: { keyId: 'k1' }, action: 'settings/mutate' }), 'dsh-control-key-action-not-allowed');
    assert.equal(policy.explain({ principal: { keyId: 'k1' }, action: 'session/page' }), 'dsh-control-key-out-of-scope');
  });
});

describe('pre-check', () => {
  it('blocks unlisted endpoints and writes for read keys, and leaves full keys alone', () => {
    const read = { mode: 'scoped', access: 'read' };
    assert.throws(() => scopedPreCheck(read, 'settings/mutate'), err => err.code === 'dsh-control/key-scope');
    assert.throws(() => scopedPreCheck(read, 'session/prompt'), err => err.code === 'dsh-control/key-read-only');
    assert.doesNotThrow(() => scopedPreCheck(read, 'session/page'));
    assert.doesNotThrow(() => scopedPreCheck({ mode: 'scoped', access: 'prompt' }, 'session/prompt'));
    assert.doesNotThrow(() => scopedPreCheck({ mode: 'full' }, 'settings/mutate'));
    assert.ok(SCOPED_ACTIONS.includes('session/list'));
  });
});
