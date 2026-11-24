#!/usr/bin/env node
/**
 * stdio ⇄ HTTP bridge for MCP clients that only launch stdio servers.
 *
 *   DSH_CONTROL_URL=http://127.0.0.1:3080/dsh-control-mcp/mcp \
 *   DSH_CONTROL_TOKEN=dshc_… npx -y dsh-control-mcp
 *
 * Reads newline-delimited JSON-RPC from stdin, POSTs each message to the
 * harness's MCP endpoint with the bearer token, and writes the responses to
 * stdout. Diagnostics go to stderr only. Node built-ins only.
 */
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:3080/dsh-control-mcp/mcp';

export function bridgeConfig(env = process.env, argv = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const match = /^--(url|token)(?:=(.*))?$/.exec(argv[i]);
    if (match) flags[match[1]] = match[2] ?? argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') flags.help = true;
  }
  return { url: flags.url ?? env.DSH_CONTROL_URL ?? DEFAULT_URL, token: flags.token ?? env.DSH_CONTROL_TOKEN ?? '', help: flags.help === true };
}

function errorResponse(id, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message } };
}

export async function forward(message, { url, token, fetchImpl = fetch, protocolVersion }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
    },
    body: JSON.stringify(message),
  });
  if (response.status === 202) return undefined;
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try { detail = JSON.parse(text)?.error?.message ?? detail; } catch { /* plain text */ }
    const hint = response.status === 401 ? ' (check DSH_CONTROL_TOKEN)' : response.status === 404 ? ' (is MCP mode on in Plugins → dsh-control-mcp?)' : '';
    throw new Error(`harness answered ${response.status}: ${detail}${hint}`);
  }
  return JSON.parse(text);
}

async function main() {
  const config = bridgeConfig();
  if (config.help) {
    process.stderr.write('Usage: dsh-control-mcp [--url <mcp url>] [--token <token>]\nEnvironment: DSH_CONTROL_URL (default ' + DEFAULT_URL + '), DSH_CONTROL_TOKEN.\n');
    return;
  }
  if (!config.token) process.stderr.write('dsh-control-mcp: DSH_CONTROL_TOKEN is not set; requests will be refused. Copy the token from Plugins → dsh-control-mcp.\n');
  let protocolVersion;
  const write = value => { if (value !== undefined) process.stdout.write(`${JSON.stringify(value)}\n`); };
  let pending = 0;
  let closing = false;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', async line => {
    if (line.trim() === '') return;
    let message;
    try { message = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    pending += 1;
    try {
      const response = await forward(message, { ...config, protocolVersion });
      if (response?.result?.protocolVersion) protocolVersion = response.result.protocolVersion;
      write(response);
    } catch (error) {
      process.stderr.write(`dsh-control-mcp: ${error.message}\n`);
      if (message && typeof message === 'object' && !Array.isArray(message) && 'id' in message && typeof message.method === 'string') write(errorResponse(message.id, error.message));
    } finally {
      pending -= 1;
      if (closing && pending === 0) process.exit(0);
    }
  });
  lines.on('close', () => { closing = true; if (pending === 0) process.exit(0); });
}

function isMain() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  main().catch(error => { process.stderr.write(`dsh-control-mcp: ${error.message}\n`); process.exit(1); });
}
