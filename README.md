# dsh-control-mcp

Control [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) **itself** from MCP clients and an opt-in HTTP API.

[![npm version](https://img.shields.io/npm/v/dsh-control-mcp.svg)](https://www.npmjs.com/package/dsh-control-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.1%20%E2%86%92%20%3C0.3.0-informational.svg)](#supported-dsh-versions)
[![Check](https://github.com/mrbeandev/dsh-control-mcp/actions/workflows/check.yml/badge.svg)](https://github.com/mrbeandev/dsh-control-mcp/actions/workflows/check.yml)
[![M8ven Score](https://m8ven.ai/badge/mcp/mrbeandev-dsh-control-mcp-g2w9ga?v=bec14d640395728ccc6282305ded6632)](https://m8ven.ai/mcp/mrbeandev-dsh-control-mcp-g2w9ga?s=readme)

- **Source code:** [github.com/mrbeandev/dsh-control-mcp](https://github.com/mrbeandev/dsh-control-mcp)
- **npm package:** [npmjs.com/package/dsh-control-mcp](https://www.npmjs.com/package/dsh-control-mcp)
- **Issues:** [github.com/mrbeandev/dsh-control-mcp/issues](https://github.com/mrbeandev/dsh-control-mcp/issues)

Once you switch it on, an MCP client (Claude Code, Claude Desktop, Codex, Cursor, another DSH…) or your own script can list and create sessions, send prompts and read the replies, and manage workspaces, models, plugins, schedules, goals, terminals and settings. It speaks the same Remote API the DSH web GUI uses, so every call gets the same validation and has the same effect as the matching click in the GUI.

- **MCP server**: Streamable HTTP at `/dsh-control-mcp/mcp`, plus a bundled stdio bridge (`npx -y dsh-control-mcp`).
- **HTTP API**: JSON and Server-Sent Events at `/dsh-control-mcp/api/v1`.
- **Off by default.** Turn each surface on in **Plugins → dsh-control-mcp**; changes apply at once.
- **Multiple API keys**, one per client, each with its own token, name, MCP/API switches and optional expiry. Disable, rotate or delete any key without touching the others.
- **Scoped keys** reach only the workspaces and chats you pick, read only or read and prompt. Everything else is invisible to them, in every list and every call (DSH 0.2.1+).
- **Read-only mode** and **blocked endpoint patterns** limit what clients may do.

## Supported DSH versions

**Supported range: DSH `0.2.0-rc.1` up to (not including) `0.3.0`** (`engines.dsh: ">=0.2.0-0 <0.3.0-0"`, prereleases included). Check yours with `dsh --version`.

| DSH version | npm tag (at the time of this release) | Status |
|---|---|---|
| `0.2.3-alpha.2` | `alpha` | ✅ Tested |
| `0.2.2-rc.5` | `latest`, `next` | ✅ Tested |
| `0.2.2-rc.3` | — | ✅ Tested |
| `0.2.1-rc.5` | — | ✅ Tested |
| `0.2.0-rc.2` | — | ✅ Tested |
| other releases from `0.2.0-rc.1` up to `0.3.0` | — | ⚠️ Untested, expected to work |
| older than `0.2.0-rc.1` (0.1.x) | — | ❌ Not supported |
| `0.3.0` and newer (prereleases included) | — | ❌ Refused by DSH until tested |

"Tested" means the packed tarball was installed into a disposable DSH home for that exact version, and both the headless-Chrome page test and the live MCP/API test passed (see [LOCAL-SETUP.md](./LOCAL-SETUP.md)).

What differs between versions:

| Feature | 0.2.0 | 0.2.1 | 0.2.2+ |
|---|---|---|---|
| All endpoints, `dsh_call`, `dsh_stream`, HTTP API | ✅ | ✅ | ✅ |
| `dsh_send_prompt` with `wait` | ✅ polls `session/list` | ✅ polls `session/list` | ✅ native `session/wait` |
| Calls run as a dedicated peer that never answers approvals | — (runs as the operator) | ✅ | ✅ |
| Long detail page under Plugins | README only | README only | ✅ |
| Full-access API keys | ✅ | ✅ | ✅ |
| Scoped API keys (chosen workspaces and chats) | ❌ refused | ✅ | ✅ |

Each harness version exposes its own set of endpoints; `dsh_list_endpoints` always shows what *your* DSH offers.

**Node.js:** `^22.19.0` or `>=24.0.0`. The plugin has no runtime dependencies and needs no other community plugin.

## Install

```sh
dsh plugin --profile web add dsh-control-mcp
```

Or open **Plugins → Add plugin** in the GUI and enter `dsh-control-mcp`. Restart DSH if the plugin page does not appear.

See [Supported DSH versions](#supported-dsh-versions).

## API keys and scopes

Open **Plugins → dsh-control-mcp → API keys → New key**. Each key has:

| Setting | Choices |
|---|---|
| Name | Any label, e.g. "Claude on my phone" |
| Surfaces | MCP, HTTP API, or both |
| Access | **Only chosen workspaces and chats**, or **Full access to this harness** |
| Inside its chats | **Read only** (history, state, replies), or **Read and prompt** (also send messages, stop, rename, start chats in its workspaces) |
| Workspaces | Each chosen workspace includes its current chats **and chats added to it later** |
| Chats | Individual chats, from any workspace |
| Expires | Optional date |

The token is shown **once** when you create or rotate a key; the harness stores only its SHA-256 fingerprint. Changes to a key (narrowing its scope, disabling it, expiry) apply to the very next request.

### How scoping is enforced

A scoped key does not run as you. It runs as its own principal (`dsh-control-key`), and DSH's own remote-access engine, the one that confines Liveshare viewers, decides every call. Every session and workspace endpoint names the resource it touches, and DSH checks it before the call runs. List and stream endpoints (`session/list`, `session/search`, `session/control`, `workspace/follow`) filter each item, so a scoped key never even learns that other chats exist. The plugin adds a second, earlier check with clear error messages, and it never offers a scoped key a tool it cannot use.

What a scoped key can reach:

| | Read only | Read and prompt |
|---|---|---|
| Model and provider catalogs, agent presets | ✅ | ✅ |
| Its chats: list, history, state, wait, follow, goals, commands, skills, terminal list | ✅ | ✅ |
| Its chats: send prompts, steer, stop, rename, choose model, edit queue, upload attachments | — | ✅ |
| Start new chats inside its workspaces | — | ✅ |
| Other chats and workspaces | ❌ invisible | ❌ invisible |
| Plugins, settings, credentials, accounts, schedules, jobs, terminals (create), workspace create/delete | ❌ | ❌ |

Use a full-access key for harness-wide administration. On DSH 0.2.0, which has no remote-access engine, scoped keys are refused with a clear error and full-access keys keep working.

### Owner token

The plugin page also shows a built-in **owner token** with full access, the token from version 0.1. It keeps working; prefer named keys so you can scope and revoke each client.

## Turn it on

1. Open **Plugins → dsh-control-mcp**.
2. Switch on **MCP server** and/or **HTTP API**. Changes apply immediately, without a restart.
3. Under **Client setup**, copy the configuration for your client.

### MCP over HTTP (Claude Code, Cursor, Codex, any Streamable HTTP client)

```json
{
  "mcpServers": {
    "dsh-control": {
      "type": "http",
      "url": "http://127.0.0.1:3080/dsh-control-mcp/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Claude Code: `claude mcp add --transport http dsh-control http://127.0.0.1:3080/dsh-control-mcp/mcp --header "Authorization: Bearer <token>"`.

### MCP over stdio (Claude Desktop and other stdio-only clients)

```json
{
  "mcpServers": {
    "dsh-control": {
      "command": "npx",
      "args": ["-y", "dsh-control-mcp"],
      "env": {
        "DSH_CONTROL_URL": "http://127.0.0.1:3080/dsh-control-mcp/mcp",
        "DSH_CONTROL_TOKEN": "<token>"
      }
    }
  }
}
```

The bridge relays newline-delimited JSON-RPC from stdin to the HTTP endpoint. It uses only Node.js built-ins.

Use the address of *your* DSH web server; the plugin page fills it in for you.

## MCP tools

| Tool | What it does |
|---|---|
| `dsh_overview` | Version, control mode, namespaces and endpoint counts. Start here. |
| `dsh_list_sessions` | Sessions with id, title, directory and running state. |
| `dsh_create_session` | New session in a directory or workspace, optionally with an agent preset. |
| `dsh_send_prompt` | Send a message (`queue` or `steer`); with `wait: true`, return the reply. |
| `dsh_wait_session` | Wait until a session is idle or needs input. |
| `dsh_read_session` | Latest messages as role/text pairs (or raw page records). |
| `dsh_cancel_session` | Stop the running turn. |
| `dsh_list_workspaces` | Workspaces with ids, paths and sessions. |
| `dsh_list_models` | Every model the harness can route to. |
| `dsh_list_plugins` | Plugins and their state. |
| `dsh_list_endpoints` | Every harness endpoint, filterable, optionally with JSON Schemas. |
| `dsh_describe_endpoint` | One endpoint's argument schema. |
| `dsh_call` | Call any unary endpoint, e.g. `pluginManager/setPluginEnabled`. |
| `dsh_stream` | Read a stream endpoint (e.g. `job/list`) for a bounded time. |

**One MCP tool per endpoint** on the plugin page also lists every endpoint (150–220 depending on DSH version and plugins) as its own `dsh__<namespace>__<method>` tool. Many clients handle the 14 tools above better.

In read-only mode, write tools are hidden and write calls are refused.

## HTTP API

Every request needs `Authorization: Bearer <token>`: an API key enabled for the HTTP API, or the owner token. Responses are `{"ok": true, "value": …}` or `{"ok": false, "error": {"code", "message"}}` with a matching HTTP status.

| Method and path | Purpose |
|---|---|
| `GET /dsh-control-mcp/api/v1/info` | Harness and plugin versions, mode, endpoint count. |
| `GET /dsh-control-mcp/api/v1/endpoints?namespace=&q=&schemas=1` | Endpoint catalog. |
| `GET /dsh-control-mcp/api/v1/endpoints/<ns>/<method>` | One endpoint with argument and result schemas. |
| `POST /dsh-control-mcp/api/v1/call/<ns>/<method>` | Call a unary endpoint. Body: its named arguments. |
| `POST /dsh-control-mcp/api/v1/stream/<ns>/<method>` | Body `{"args", "maxItems", "timeoutMs"}`. Returns collected items, or a live SSE relay with `Accept: text/event-stream`. |
| `GET /dsh-control-mcp/api/v1/tools`, `POST …/tools/<name>` | The curated tools above, over HTTP. |
| `GET /dsh-control-mcp/status` | Unauthenticated: which surfaces are on. No secrets. |

```sh
TOKEN=…; BASE=http://127.0.0.1:3080/dsh-control-mcp/api/v1
curl -s -H "Authorization: Bearer $TOKEN" $BASE/info
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"_request":{}}' $BASE/call/session/list
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"sessionId":"<id>","text":"Summarize the README","wait":true}' $BASE/tools/dsh_send_prompt
curl -N -X POST -H "Authorization: Bearer $TOKEN" -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"args":{}}' $BASE/stream/workspace/follow
```

Endpoint arguments are named exactly as the harness declares them. Check `GET …/endpoints/<ns>/<method>`. An argument resolved by the `agent` lookup (for example `agentId`) takes a session id.

## Security

- **Full control means full control.** A prompt can run tools and shell commands. Anyone with the token, and network access to DSH, can do what you can do in the GUI. Treat the token like a password, rotate it if it leaks, and prefer read-only mode when a client only needs to look.
- Both surfaces are off until you turn them on, and turning one off takes effect on the next request.
- Tokens are 256-bit random values. Key tokens are stored only as SHA-256 fingerprints and shown once; the owner token is compared in constant time. Key management and the owner token are served only to your signed-in DSH browser session from the same origin; bearer tokens, even full-access ones, cannot create or list keys.
- Scoped keys are confined by DSH's remote-access engine, not only by this plugin. They run as their own principal, never as the owner.
- Requests with a cross-site `Origin` are refused, so a web page you visit cannot use the API even if it guesses the URL.
- Calls run as a dedicated in-process owner peer that **never answers approvals or questions**; those still appear in the GUI. (`userQuestions/answer` remains callable explicitly.)
- DSH binds to loopback by default. For remote clients use an SSH tunnel or DSH's own `trustedHosts`/TLS options. Do not expose it publicly without TLS.
- The Host side makes no outbound network requests.

## How it works

The Host plugin (`index.mjs`) registers one prefix route, `/dsh-control-mcp`, on the DSH web server. Requests are dispatched through `ctx.typertGateway.invoke()` and `ctx.typertGateway.stream()` with an owner `Peer` created by `ctx.connection.createPeer()`. Endpoint discovery and argument schemas come from the live Typert registry (`ctx.typert.local.list()`), so endpoints added by other plugins appear automatically.

| Identity | Value |
|---|---|
| npm package, bundle, Loader entry id/name, Host plugin name | `dsh-control-mcp` |
| Client module id and `plugins.bundle.config` key | `dsh-control-mcp` |
| Web route prefix | `/dsh-control-mcp` |
| Credential records | `dsh-control-mcp/access-token` (owner token), `dsh-control-mcp/api-keys` (key fingerprints and scopes) |
| Remote-access principal | `dsh-control-key` (scoped keys), roles `dsh-control-mcp:*` |
| Config fields (all volatile) | `mcpEnabled`, `apiEnabled`, `readOnly`, `exposeAllEndpoints`, `blockedEndpoints`, `maxResultBytes` |
| Log prefix | `dsh-control-mcp:` |
| Injected Host services | `typert`, `typertGateway`, `connection`, `webServer`; optional `credentials`, `connection.authentication` (DSH 0.2.3+) |
| Injected client packages | `@deepseek-ai/dsh-client-ui-settings`, `@deepseek-ai/dsh-client-ui-plugin-manager` |

### Source layout

| Path | Role |
|---|---|
| `index.mjs` | Host entry: Config, token store, gateway bridge, route registration. |
| `lib/core.mjs` | Transport-independent catalog, policy, curated tools and MCP JSON-RPC. |
| `lib/http.mjs` | HTTP routing, auth, MCP Streamable HTTP, REST and SSE, key management routes. |
| `lib/access.mjs` | API key registry, scoped roles and the remote-access policy. |
| `client/index.mjs` | Plugin page source (source of truth). |
| `lib/client.js` | **Generated** by `npm run build` from `client/index.mjs`. Do not edit. |
| `bin/dsh-control-mcp.mjs` | stdio bridge. |

## Development

```sh
npm run verify     # build client bundle, unit tests, release gate (metadata, identities, packed files)
npm pack --dry-run
scripts/version-matrix.sh ./dsh-control-mcp-X.Y.Z.tgz /path/to/dsh/bin [port]   # one DSH version: page, live and scope-isolation tests
```

`LOCAL-SETUP.md` covers testing against a disposable DSH profile, including the live MCP/API smoke test (`npm run test:live`) and the headless-Chrome page test (`npm run test:e2e`).

## License

MIT
