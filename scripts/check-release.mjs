#!/usr/bin/env node
/**
 * Release gate: run by `prepublishOnly` and `npm run verify`.
 *
 * Checks package metadata and identities, that the generated client bundle
 * matches its source, that every module parses, that no forbidden mechanism or
 * private detail crept in, and that the packed file list holds every runtime
 * file and nothing private.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };
const NAME = 'dsh-control-mcp';

// ── metadata ────────────────────────────────────────────────────────────────
check(pkg.name === NAME, `package name must be ${NAME}`);
check(pkg.license === 'MIT', 'license must be MIT');
check(pkg.repository?.url === `git+https://github.com/mrbeandev/${NAME}.git`, 'repository URL must point to the public repository');
check(pkg.homepage?.startsWith(`https://github.com/mrbeandev/${NAME}`), 'homepage must point to the public repository');
check(pkg.bugs?.url === `https://github.com/mrbeandev/${NAME}/issues`, 'bugs URL must point to the public repository');
check(pkg.type === 'module', 'package must be ESM');
check(pkg.exports?.['.'] === './index.mjs' && pkg.exports?.['./client'] === './lib/client.js', 'exports must expose ./index.mjs and ./client');
check(pkg.exports?.['./locale/*.json'] === './locale/*.json' && pkg.exports?.['./icon'] === './icon.svg', 'exports must expose locale and icon');
check(pkg.bin?.[NAME] === './bin/dsh-control-mcp.mjs', 'bin must expose the stdio bridge');
check(pkg.publishConfig?.access === 'public', 'publishConfig.access must be public');
check(pkg.engines?.node !== undefined, 'engines.node is required');
check(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0, 'runtime dependencies are not allowed; harness packages come from the running dsh');
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must be ./cordis.patch.yml');
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web');
for (const injected of ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager']) {
  check(pkg.dsh?.client?.inject?.includes(injected), `dsh.client.inject must include ${injected} (the plugin page uses it)`);
}
const { SUPPORTED_DSH_RANGE } = await import(pathToFileURL(join(root, 'index.mjs')).href);
const range = `>=${SUPPORTED_DSH_RANGE.min} <${SUPPORTED_DSH_RANGE.below}`;
check(pkg.peerDependencies?.['@deepseek-ai/dsh'] === range, `peerDependencies["@deepseek-ai/dsh"] must be "${range}"`);
check(pkg.dsh?.engines?.dsh === range, `dsh.engines.dsh must be "${range}"`);

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
check(/id: dsh-control-mcp\n\s+name: dsh-control-mcp/.test(patch), 'cordis.patch.yml must insert entry id/name dsh-control-mcp');
check(!/mcpEnabled:\s*true|apiEnabled:\s*true/.test(patch), 'the bundle patch must not switch MCP or API on by default');

for (const locale of ['en', 'zh']) {
  const meta = JSON.parse(readFileSync(join(root, `locale/${locale}.json`), 'utf8')).meta;
  check(typeof meta?.title === 'string' && meta.title.length > 3, `locale/${locale}.json needs meta.title`);
  check(typeof meta?.description === 'string' && meta.description.length > 40, `locale/${locale}.json needs meta.description`);
  check(meta?.detail === 'docs/DETAIL.md', `locale/${locale}.json meta.detail must be docs/DETAIL.md`);
}
const icon = readFileSync(join(root, 'icon.svg'), 'utf8');
check(icon.startsWith('<svg') && icon.length < 256 * 1024, 'icon.svg must be an SVG under 256 KiB');

for (const doc of ['README.md', 'RELEASE.md', 'LOCAL-SETUP.md', 'docs/DETAIL.md']) {
  const text = readFileSync(join(root, doc), 'utf8');
  if (/\/home\/[a-z]|\/mnt\/main_disk|\/Users\/[A-Za-z]/.test(text)) problems.push(`${doc}: contains an absolute user path`);
  if (/dshc_[A-Za-z0-9_-]{43}/.test(text)) problems.push(`${doc}: contains what looks like a real access token`);
}

// ── generated client bundle is current ──────────────────────────────────────
const { createClientPlugin } = await import(pathToFileURL(join(root, 'client/index.mjs')).href);
const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8');
check(bundle.includes(`id: '${NAME}'`), `lib/client.js must register id ${NAME}`);
check(bundle.includes(createClientPlugin.toString()), 'lib/client.js is stale: run npm run build');

// ── forbidden mechanisms and private details in source ──────────────────────
const listed = dir => readdirSync(join(root, dir)).filter(file => file.endsWith('.mjs')).map(file => `${dir}/${file}`);
const sources = ['index.mjs', 'lib/core.mjs', 'lib/http.mjs', 'client/index.mjs', 'bin/dsh-control-mcp.mjs', ...listed('scripts'), ...listed('test')];
// Host runtime: never reaches out to the network on its own.
const hostRuntime = new Set(['index.mjs', 'lib/core.mjs', 'lib/http.mjs']);
for (const file of sources) {
  const text = readFileSync(join(root, file), 'utf8');
  if (/\/home\/[a-z]|\/mnt\/main_disk|\/Users\/[A-Za-z]|C:\\\\Users/.test(text)) problems.push(`${file}: contains an absolute user path`);
  if (/session-[0-9a-f]{8}-[0-9a-f]{4}|req_[0-9A-Za-z]{16,}/.test(text)) problems.push(`${file}: contains a real session or request id`);
  if (file !== 'scripts/check-release.mjs') {
    check(!/\beval\s*\(|new Function\s*\(/.test(text), `${file}: no dynamic code evaluation`);
    check(!/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(text), `${file}: UI renders text only`);
  }
  if (hostRuntime.has(file)) check(!/\bfetch\s*\(|node:https?['"]\s*;?\s*$|XMLHttpRequest|new WebSocket/m.test(text), `${file}: Host runtime must make no outbound network requests`);
  if (hostRuntime.has(file)) check(!/console\.log\(/.test(text), `${file}: use ctx.logger, not console.log`);
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`${file}: syntax error: ${error.stderr?.toString().trim()}`);
  }
}
// The client may only talk to its own same-origin route.
const client = readFileSync(join(root, 'client/index.mjs'), 'utf8');
for (const match of client.matchAll(/fetch\(([^,)]+)/g)) check(/ROUTE/.test(match[1]), `client/index.mjs: fetch must target the plugin's own route (${match[1]})`);

// ── packed file list ────────────────────────────────────────────────────────
let packed = [];
try {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  packed = JSON.parse(output)[0].files.map(file => file.path);
} catch (error) {
  problems.push(`npm pack --dry-run failed: ${error.message}`);
}
if (packed.length > 0) {
  const required = ['index.mjs', 'lib/core.mjs', 'lib/http.mjs', 'lib/client.js', 'client/index.mjs', 'bin/dsh-control-mcp.mjs', 'locale/en.json', 'locale/zh.json', 'docs/DETAIL.md', 'icon.svg', 'package.json', 'README.md', 'LICENSE', 'cordis.patch.yml'];
  for (const file of required) check(packed.includes(file), `packed artifact is missing ${file}`);
  const forbidden = /\.(jsonl|tgz|log|png|yaml)$|(^|\/)(test|scripts|fixtures|\.private|\.env|\.cache|\.e2e|\.github)(\/|$)|\.npmrc$|LOCAL-SETUP\.md$|RELEASE\.md$|\.credentials/;
  for (const file of packed) check(!forbidden.test(file), `packed artifact must not contain ${file}`);
}

if (problems.length > 0) {
  console.error(`${NAME} release check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`${NAME} release check passed (${packed.length} files packed).`);
