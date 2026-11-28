# Harness control (MCP and API)

Lets MCP clients and other programs drive this DeepSeek Harness through the same API the web GUI uses.

## What you can do

- List, create and cancel sessions; send prompts and wait for the reply; read session history.
- List workspaces, models and plugins; enable or disable plugins.
- Reach every other harness action (schedules, goals, terminals, jobs, settings, plugin installs, …) through `dsh_call` and `dsh_stream`, or through the HTTP API.

## Turn it on

1. Open **Plugins → dsh-control-mcp**.
2. Switch on **MCP server**, **HTTP API**, or both. Both start off.
3. Copy the access token and a ready-made client configuration from the same page.

| Surface | Address |
|---|---|
| MCP (Streamable HTTP) | `<harness URL>/dsh-control-mcp/mcp` |
| HTTP API | `<harness URL>/dsh-control-mcp/api/v1` |
| MCP over stdio | `npx -y dsh-control-mcp` with `DSH_CONTROL_URL` and `DSH_CONTROL_TOKEN` |

Every call needs `Authorization: Bearer <token>`. **Rotate** issues a new token and invalidates the old one.

## API keys and scopes

Create one key per client under **API keys → New key**. A key has a name, MCP and/or HTTP API access, an optional expiry, and either:

- **Full access** to this harness, or
- **Only chosen workspaces and chats**: a workspace includes its current chats and chats added later. Pick **Read only** or **Read and prompt**.

A scoped key cannot see, list or touch any other chat, and cannot reach plugins, settings, credentials or other harness-wide actions. DSH's own access control enforces this (DSH 0.2.1 or later). The token is shown once; disable, rotate or delete a key at any time.

## Limit what clients may do

- **Read-only mode** refuses every call that changes harness state.
- **Blocked endpoints** hide and refuse endpoints by pattern, for example `account/*` or `pluginManager/removeBundle`.

## Limitations

- With full control on, a client holding the token can run prompts, and prompts can run tools and shell commands. Treat the token like a password.
- DSH listens on this machine only unless it was started with a trusted host; remote clients need a tunnel or a trusted-host setup.
- Calls never answer approvals or questions on your behalf; those still appear in the GUI.
