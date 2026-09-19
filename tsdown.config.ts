import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const ID = 'relay-dsh-plugin-codex'
const ROOT = dirname(fileURLToPath(import.meta.url))
const CSS_MODULE = '\0relay-css-module:'
const GLOBAL_CSS = '\0relay-global-css:'
const VIRTUAL_SUFFIX = '.mjs'
const EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

function injectionModule(file: string, css: string, classMap?: Record<string, string>): string {
  const tagId = `${ID}/${basename(file)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

const HOST_EXTERNALS = [
  /^node:/,
  /^@deepseek-ai\//,
  /^@anthropic-ai\/claude-agent-sdk$/,
  /^zod$/,
]

const hostConfig: UserConfig = {
  name: `${ID}/host`,
  entry: {
    'host-plugin': 'host-plugin.js',
    'typert.host': 'typert.host.js',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: specifier => HOST_EXTERNALS.some(pattern => pattern.test(specifier)),
    alwaysBundle: specifier => !HOST_EXTERNALS.some(pattern => pattern.test(specifier)),
  },
}

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: specifier => EXTERNALS.has(specifier),
    alwaysBundle: specifier => !EXTERNALS.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'relay-dsh-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      return CSS_MODULE + (importer === undefined ? source : resolve(dirname(importer), source)) + VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_MODULE)) return null
      const file = virtualId.slice(CSS_MODULE.length, -VIRTUAL_SUFFIX.length)
      this.addWatchFile(file)
      const source = await readFile(file)
      const output = transform({
        filename: stableFilename(file),
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, value] of Object.entries(output.exports ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
        classMap[local] = value.name
      }
      return injectionModule(file, output.code.toString(), classMap)
    },
  }, {
    name: 'relay-dsh-global-css',
    async resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      const file = resolved?.id ?? (importer === undefined ? source : resolve(dirname(importer), source))
      return GLOBAL_CSS + file + VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(GLOBAL_CSS)) return null
      const file = virtualId.slice(GLOBAL_CSS.length, -VIRTUAL_SUFFIX.length)
      this.addWatchFile(file)
      const source = await readFile(file)
      const output = transform({ filename: stableFilename(file), code: source, minify: true })
      return injectionModule(file, output.code.toString())
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [hostConfig, clientConfig]

function stableFilename(file: string): string {
  return relative(ROOT, file).split('\\').join('/')
}
