# Release checklist

## Current candidate: 0.1.0 (not published)

First release. The npm name `dsh-mcp` was already taken by an unrelated MCP
management plugin, so this package is `dsh-control-mcp` (`dsh-harness-mcp` and
`dsh-self-mcp` were also free when checked on 2026-11-24 and were left unclaimed).

### Verified locally (2026-11-24, DSH 0.2.2-rc.3, Node 24, Linux)

- `npm run verify`: unit tests, release gate, packed file list.
- Tarball installed into a disposable `DSH_HOME` with `dsh plugin --profile web add`,
  served on a separate port; the primary profile was not touched.
- `npm run test:live` against that server: MCP handshake, all curated tools,
  workspace/session create → state → rename → archive → workspace delete,
  streams, API errors, SSE, and the stdio bridge.
- `npm run test:e2e` in headless Chrome: page, toggles, token, read-only, blocked
  endpoints, reload persistence, rotation, narrow layout, no console errors.

Not yet verified: a real model turn through `dsh_send_prompt` (the disposable
profile has no provider), registry install after publication, desktop (Electron)
builds, DSH 0.2.0/0.2.1.

### Before publishing

```sh
npm run verify
npm pack --dry-run
npm publish --dry-run --json
```

Then a clean working tree, a pushed `v0.1.0` tag, and npm authentication.
Never publish without the maintainer's explicit go-ahead.

### After publishing

1. `npm view dsh-control-mcp`.
2. Install from the registry into a clean profile, restart, and repeat
   `test:e2e` and `test:live`.
3. Check `npx -y dsh-control-mcp --help`.
4. Uninstall and run `DSH_E2E_ABSENT=1 npm run test:e2e`.
