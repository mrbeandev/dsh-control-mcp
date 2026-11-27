# Release checklist

## Current candidate: 0.1.0 (not published)

First release. The npm name `dsh-mcp` was already taken by an unrelated MCP
management plugin, so this package is `dsh-control-mcp` (`dsh-harness-mcp` and
`dsh-self-mcp` were also free when checked on 2026-11-24 and were left unclaimed).

### Version matrix (2026-11-27, Node 24, Linux, `scripts/version-matrix.sh`)

| DSH | Page test | Live MCP/API test |
|---|---|---|
| 0.2.3-alpha.2 | 37/37 | 28/28 |
| 0.2.2-rc.5 | 37/37 | 28/28 |
| 0.2.1-rc.5 | 37/37 | 27/27 (no `session/state` endpoint) |
| 0.2.0-rc.2 | 37/37 | 27/27 (no `session/state` endpoint) |

Compatibility fixes made for this matrix: prerelease-inclusive range
(`>=0.2.0-0 <0.3.0-0`; every DSH release so far is a prerelease, and
`>=0.2.0` rejected 0.2.0-rc.*), DSH 0.2.0 without the Peer API, 0.2.0 without
precomputed JSON Schemas, 0.2.0/0.2.1 without `session/wait`/`session/state`
and with a required `throughSeq`, and 0.2.3's anonymous route policy and
`connection.authentication` service.

### Verified locally (2026-11-24, DSH 0.2.2-rc.3, Node 24, Linux)

- `npm run verify`: unit tests, release gate, packed file list.
- Tarball installed into a disposable `DSH_HOME` with `dsh plugin --profile web add`,
  served on a separate port; the primary profile was not touched.
- `npm run test:live` against that server: MCP handshake, all curated tools,
  workspace/session create → state → rename → archive → workspace delete,
  streams, API errors, SSE, and the stdio bridge.
- `npm run test:e2e` in headless Chrome: page, toggles, token, read-only, blocked
  endpoints, reload persistence, rotation, narrow layout, no console errors.

- `npx dsh-control-mcp` from the installed tarball (the release gate now refuses any
  package.json field npm would auto-correct on publish; a `./bin/…` path was dropped).
- Coexistence with the unrelated `dsh-mcp@1.15.4` in the same profile: no shared ids.
- Uninstall: page and routes are gone and DSH starts despite the leftover config row.

Not yet verified: a real model turn through `dsh_send_prompt` (the disposable
profile has no provider), registry install after publication, desktop (Electron)
builds.

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
