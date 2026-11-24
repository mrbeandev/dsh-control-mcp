#!/usr/bin/env node
/**
 * Browser smoke test of this plugin's page (Plugins → dsh-control-mcp)
 * against a running DSH Web. Use a disposable DSH_HOME (see LOCAL-SETUP.md).
 * Drives a headless Chrome over the DevTools protocol with Node built-ins only.
 *
 *   DSH_E2E_URL='http://127.0.0.1:18766/?token=…' npm run test:e2e
 *
 * Toggles MCP and the HTTP API on from the page, checks the token section,
 * reload persistence, read-only mode, blocked endpoint validation, token
 * rotation, then switches both surfaces off again.
 *
 * Optional: CHROME=/path/to/chrome, DSH_E2E_SHOTS=/dir for screenshots,
 * DSH_E2E_NARROW=1 for an extra 420 px viewport pass, DSH_E2E_ABSENT=1 to
 * check the page is gone (after uninstall).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DSH_E2E_URL;
if (!url) {
  console.error('Set DSH_E2E_URL to the dsh web URL printed at startup (including ?token=…).');
  process.exit(2);
}
const PACKAGE = 'dsh-control-mcp';
const TITLE = 'Harness control (MCP and API)';
const origin = new URL(url).origin;
const chromePath = process.env.CHROME ?? 'google-chrome';
const shots = process.env.DSH_E2E_SHOTS;
const absent = process.env.DSH_E2E_ABSENT === '1';
const profileDir = mkdtempSync(join(tmpdir(), 'dshc-chrome-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function target() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await target());
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const consoleErrors = [];
let dialogs = 0;
ws.onmessage = event => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
  if (msg.method === 'Page.javascriptDialogOpening') { dialogs += 1; void send('Page.handleJavaScriptDialog', { accept: true }); }
};
const send = (method, params = {}) => new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return res.result?.result?.value;
};
const waitFor = async (expression, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expression).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
};
const clickText = label => evaluate(`(() => {
  const want = ${JSON.stringify(label)};
  const all = [...document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], [role="option"], li, div, span')];
  const el = all.find(e => e.textContent.trim() === want && e.offsetParent !== null);
  if (!el) return false;
  (el.closest('button, a, [role="tab"], [role="menuitem"], [role="option"]') ?? el).click();
  return true;
})()`);
const shot = async name => {
  if (!shots) return;
  const res = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(res.result.data, 'base64'));
};
const PAGE = `document.querySelector('[data-${PACKAGE}]')`;
const SWITCH = field => `document.getElementById('${PACKAGE}-${field}')`;
const status = () => fetch(`${origin}/${PACKAGE}/status`).then(r => r.json()).then(b => b.value);
const toggle = async (field, want) => {
  const now = await evaluate(`${SWITCH(field)}?.checked`);
  if (now !== want) await evaluate(`${SWITCH(field)}?.click()`);
  return waitFor(`${SWITCH(field)}?.checked === ${want} && !${SWITCH(field)}?.disabled`, 10000);
};

async function openPage() {
  // A fresh profile shows a preview notice, and one without a model provider a
  // "Get started" dialog. Dismiss whatever modal is open before navigating.
  await waitFor(`!!document.querySelector('[role=dialog]')`, 4000);
  for (let i = 0; i < 8; i += 1) {
    const closed = await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role=dialog]')].find(d => d.offsetParent !== null || d.getClientRects().length);
      if (!dialog) return 'none';
      if (dialog.querySelector('[data-${PACKAGE}]')) return 'none';
      const buttons = [...dialog.querySelectorAll('button')];
      const target = buttons.find(b => b.textContent.trim() === 'Continue') ?? buttons.find(b => /close/i.test(b.getAttribute('aria-label') ?? '')) ?? buttons.find(b => b.textContent.trim() === '');
      if (target) { target.click(); return 'clicked'; }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'escape';
    })()`);
    if (closed === 'none') break;
    await sleep(600);
  }
  const panel = await evaluate(`(() => { const e = [...document.querySelectorAll('button, a, [role=button], [role=link]')].find(e => e.textContent.trim() === 'Plugins' && e.offsetParent !== null); e?.click(); return !!e; })()`);
  // Installed plugins → this bundle's card, found by its localized title.
  const card = `document.querySelector('button[aria-label="View ' + ${JSON.stringify(TITLE)} + '"]')`;
  await waitFor(`!!${card}`, 10000);
  const opened = await evaluate(`(() => { const el = ${card}; if (!el) return false; el.click(); return true; })()`);
  return { panel, opened };
}

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  check('DSH Web loads', await waitFor(`document.readyState === 'complete' && document.body.innerText.length > 50`, 30000));
  await sleep(1500);
  const nav = await openPage();
  check('Plugins panel opens', nav.panel);

  if (absent) {
    const page = await waitFor(`!!${PAGE}`, 5000);
    check('plugin page is gone after uninstall', !page && !nav.opened, nav.opened ? 'package still listed' : '');
    const res = await fetch(`${origin}/${PACKAGE}/status`);
    check('plugin routes are gone after uninstall', res.status !== 200 || !(await res.text()).includes('mcpEnabled'));
  } else {
    check(`${PACKAGE} is listed under Plugins`, nav.opened);
    check('plugin page renders', await waitFor(`!!${PAGE}`, 15000));
    await sleep(1000);
    const detail = await evaluate('document.body.innerText');
    check('bundle detail shows localized title, version and description', detail.includes(TITLE) && /v0\.\d+\.\d+/.test(detail) && /opt-in HTTP API/.test(detail));
    check('detail document renders', /Limit what clients may do/.test(detail));
    await shot('01-page');
    let text = await evaluate(`${PAGE}.innerText`);
    check('settings are writable (host plugin running)', !/not running|read-only in this browser/.test(text));
    check('no undefined/NaN/empty labels', !/undefined|NaN|\[object/.test(text));
    // Start from both surfaces off, whatever an earlier run left behind.
    for (const field of ['mcpEnabled', 'apiEnabled', 'readOnly', 'exposeAllEndpoints']) await toggle(field, false);
    check('token hidden while both surfaces are off', await waitFor(`/Turn on the MCP server or the HTTP API/.test(${PAGE}.innerText)`, 5000));

    for (const field of ['mcpEnabled', 'apiEnabled', 'readOnly', 'exposeAllEndpoints']) check(`switch ${field} present and labelled`, await evaluate(`!!${SWITCH(field)} && !!${SWITCH(field)}.getAttribute('aria-label')`));

    check('turn MCP on from the page', await toggle('mcpEnabled', true));
    check('turn API on from the page', await toggle('apiEnabled', true));
    const live = await status();
    check('Host sees both surfaces on without restart', live.mcpEnabled === true && live.apiEnabled === true);
    check('full-control warning shown', await waitFor(`/Full control is on/.test(${PAGE}.innerText)`, 5000));
    check('token loads on the page', await waitFor(`/dshc_/.test(${PAGE}.querySelector('input[aria-label="Access token"]')?.value ?? '')`, 10000));
    check('token is masked by default', await evaluate(`/•/.test(${PAGE}.querySelector('input[aria-label="Access token"]').value)`));
    check('snippet masks the token while hidden', !(await evaluate(`${PAGE}.querySelector('[data-dsh-control-mcp-snippet]')?.textContent ?? ''`)).match(/dshc_[A-Za-z0-9_-]{43}/));
    await clickText('Show');
    const token = await evaluate(`${PAGE}.querySelector('input[aria-label="Access token"]').value`);
    check('Show reveals the full token', /^dshc_[A-Za-z0-9_-]{43}$/.test(token));
    const snippet = await evaluate(`${PAGE}.querySelector('[data-dsh-control-mcp-snippet]')?.textContent ?? ''`);
    check('MCP HTTP snippet has the live URL and token', snippet.includes(`${origin}/${PACKAGE}/mcp`) && snippet.includes(token));
    const mcp = await fetch(`${origin}/${PACKAGE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    check('the page token works against MCP', mcp.status === 200);
    await clickText('MCP over stdio');
    check('stdio snippet switches', await waitFor(`/npx/.test(${PAGE}.querySelector('[data-dsh-control-mcp-snippet]')?.textContent ?? '')`, 3000));
    await shot('02-enabled');

    // read-only mode
    check('turn read-only on', await toggle('readOnly', true));
    const ro = await fetch(`${origin}/${PACKAGE}/api/v1/call/session/create`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"request":{}}' });
    check('read-only refuses a write over the API', ro.status === 403);
    check('warning hides in read-only mode', await waitFor(`!/Full control is on/.test(${PAGE}.innerText)`, 5000));
    check('turn read-only off', await toggle('readOnly', false));

    // blocked endpoints
    await evaluate(`(() => { const t = document.getElementById('${PACKAGE}-blocked'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'not a pattern'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check('invalid blocked pattern is flagged', await waitFor(`/Not a "namespace\\/method" pattern/.test(${PAGE}.innerText)`, 3000));
    await evaluate(`(() => { const t = document.getElementById('${PACKAGE}-blocked'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'account/*\\nsession/rename'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(200);
    await clickText('Save');
    await sleep(1000);
    const blocked = await fetch(`${origin}/${PACKAGE}/api/v1/call/account/getState`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    check('saved blocked pattern is enforced', blocked.status === 403);

    // persistence
    await send('Page.reload');
    await waitFor(`document.readyState === 'complete'`, 30000);
    await sleep(1500);
    await openPage();
    await waitFor(`!!${PAGE}`, 15000);
    check('switches persist after reload', await waitFor(`${SWITCH('mcpEnabled')}?.checked === true && ${SWITCH('apiEnabled')}?.checked === true`, 10000));
    check('blocked endpoints persist after reload', await waitFor(`document.getElementById('${PACKAGE}-blocked')?.value === 'account/*\\nsession/rename'`, 5000));

    // rotation
    await waitFor(`/dshc_/.test(${PAGE}.querySelector('input[aria-label="Access token"]')?.value ?? '')`, 10000);
    await clickText('Rotate');
    check('rotation asks for confirmation', await waitFor(`/New token issued/.test(${PAGE}.innerText)`, 10000) && dialogs >= 1);
    const rotated = await evaluate(`${PAGE}.querySelector('input[aria-label="Access token"]').value`);
    check('rotation shows a new token', /^dshc_/.test(rotated) && rotated !== token);
    const old = await fetch(`${origin}/${PACKAGE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    check('old token is refused after rotation', old.status === 401);
    await shot('03-rotated');

    if (process.env.DSH_E2E_NARROW === '1') {
      await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(800);
      const overflow = await evaluate(`${PAGE} ? ${PAGE}.scrollWidth - ${PAGE}.clientWidth : -1`);
      check('narrow layout does not overflow horizontally', overflow >= 0 && overflow <= 2, `overflow ${overflow}px`);
      await shot('04-narrow');
      await send('Emulation.clearDeviceMetricsOverride');
    }

    // restore defaults
    await evaluate(`(() => { const t = document.getElementById('${PACKAGE}-blocked'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(200);
    await clickText('Save');
    await sleep(800);
    await toggle('mcpEnabled', false);
    await toggle('apiEnabled', false);
    const off = await status();
    check('switching off takes effect at once', off.mcpEnabled === false && off.apiEnabled === false);
    const refused = await fetch(`${origin}/${PACKAGE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${rotated}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    check('MCP answers 404 once off', refused.status === 404);
  }

  const related = consoleErrors.filter(line => /control-mcp/i.test(String(line)));
  check('no console errors from this plugin', related.length === 0, related.slice(0, 3).join(' | '));
  if (consoleErrors.length) console.log(`(other console errors: ${consoleErrors.length})`);
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
