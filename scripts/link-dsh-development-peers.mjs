import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = process.env.DSH_ROOT ? [resolve(process.env.DSH_ROOT)] : [
  resolve(root, '../../upstream/deepseek-harness'),
  resolve(root, 'upstream/deepseek-harness'),
  resolve(root, '../Relay/upstream/deepseek-harness'),
];
const dsh = candidates.find(path => existsSync(join(path, 'apps/cli/package.json')));
if (!dsh) throw new Error('Set DSH_ROOT to a prepared official deepseek-harness checkout.');
const version = JSON.parse(readFileSync(join(dsh, 'apps/cli/package.json'), 'utf8')).version;
const verifiedVersions = new Set(['0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-rc.1', '0.1.5-rc.2', '0.1.6-alpha.1']);
if (!verifiedVersions.has(version)) {
  throw new Error(`Expected a verified DSH release, found ${version}. Select an audited official checkout.`);
}
const sourceRoot = join(dsh, 'node_modules/.pnpm/node_modules/@deepseek-ai');
const targetRoot = join(root, 'node_modules/@deepseek-ai');
const prepared = new Map();
for (const name of readdirSync(sourceRoot)) {
  const source = join(sourceRoot, name);
  if (existsSync(join(source, 'package.json'))) prepared.set(name, realpathSync(source));
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const required = new Set([
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...(manifest.dsh?.client?.inject ?? []),
].filter(name => name.startsWith('@deepseek-ai/')).map(name => name.slice('@deepseek-ai/'.length)));
for (const name of required) {
  if (!prepared.has(name)) throw new Error(`Missing prepared official DSH peer ${name}. Run pnpm install and build in DSH_ROOT.`);
}
mkdirSync(targetRoot, { recursive: true });
// Remove obsolete development links so a deleted package cannot resolve from
// this plugin's previous DSH installation. Do not alter the official checkout.
for (const name of readdirSync(targetRoot)) {
  if ((name.startsWith('dsh-') || ['cordis', 'cosmokit'].includes(name)) && !prepared.has(name)) {
    rmSync(join(targetRoot, name), { recursive: true, force: true });
  }
}
// Link the official graph, including transitive type/brand owners. Frontend
// consumers must not silently resolve a second, older DSH from a parent tree.
for (const [name, source] of prepared) {
  const target = join(targetRoot, name);
  if (existsSync(target) && realpathSync(target) === source) continue;
  rmSync(target, { recursive: true, force: true });
  symlinkSync(source, target, 'dir');
}
const result = spawnSync(process.execPath, [join(root, 'scripts/dsh-type-paths.mjs'), dsh], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Could not prepare official DSH declaration paths.');

// An explicit public-contract checkout is optional; standalone installs use the
// registry dependency already recorded in this plugin's lockfile.
if (process.env.SESSION_IMPORT_ROOT) {
  const source = resolve(process.env.SESSION_IMPORT_ROOT);
  if (!existsSync(join(source, 'package.json'))) throw new Error('Invalid SESSION_IMPORT_ROOT.');
  const target = join(root, 'node_modules/relay-dsh-plugin-session-import');
  if (!existsSync(target) || realpathSync(target) !== realpathSync(source)) {
    rmSync(target, { recursive: true, force: true });
    symlinkSync(source, target, 'dir');
  }
}
