import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const [english, chinese, screenshot, preset, manifestText, reliabilitySpec, reliabilityAcceptance, interactionSpec] = await Promise.all([
  readFile(new URL('README.md', root), 'utf8'),
  readFile(new URL('README.zh.md', root), 'utf8'),
  readFile(new URL('docs/images/dsh-new-session-backends.jpg', root)),
  readFile(new URL('presets/relay-codex/preset.yml', root), 'utf8'),
  readFile(new URL('package.json', root), 'utf8'),
  readFile(new URL('docs/reliability-spec.md', root), 'utf8'),
  readFile(new URL('docs/reliability-acceptance.md', root), 'utf8'),
  readFile(new URL('docs/spec/dsh-interaction-bridge.md', root), 'utf8'),
])
const manifest = JSON.parse(manifestText)

test('English and Chinese READMEs form a complete newcomer path', () => {
  for (const readme of [english, chinese]) {
    assert.match(readme, /github:yangbobo2021\/relay-dsh-plugin-codex/)
    assert.match(readme, /relay-dsh-plugin-codex/)
    assert.match(readme, /0\.1\.1-rc\.2/)
    assert.match(readme, /b150a551/)
    assert.match(readme, /docs\/images\/dsh-new-session-backends\.jpg/)
    assert.match(readme, /Add workspace/)
    assert.match(readme, /New Session/)
    assert.match(readme, /Standard mode/)
    assert.match(readme, /https:\/\/github\.com\/yangbobo2021\/Relay/)
    assert.doesNotMatch(readme, /dsh-plugin-suite-demo\.(?:gif|mp4)/)
  }
  assert.match(english, /English \| \[中文\]\(README\.zh\.md\)/)
  assert.match(chinese, /\[English\]\(README\.md\) \| 中文/)
  assert.match(english, /dsh-plugin-manager-codex-install-demo\.en\.mp4\?raw=1/)
  assert.match(chinese, /dsh-plugin-manager-codex-install-demo\.zh\.mp4\?raw=1/)
  assert.match(english, /There is no separate activation command/)
  assert.match(chinese, /不需要单独的激活命令/)
  assert.match(english, /codex login/)
  assert.match(chinese, /codex login/)
  assert.match(english, /bundled\s+official `@openai\/codex` runtime/)
  assert.match(english, /RELAY_CODEX_COMMAND/)
  assert.match(chinese, /随插件安装的官方 `@openai\/codex` 运行时/)
  assert.match(chinese, /RELAY_CODEX_COMMAND/)
})

test('README screenshot and bilingual preset ship with the package', () => {
  assert.deepEqual([...screenshot.subarray(0, 3)], [0xff, 0xd8, 0xff])
  assert.ok(screenshot.length > 10_000)
  assert.match(preset, /Run and resume a Codex thread in DSH\./)
  assert.match(preset, /在 DSH 中运行并继续 Codex thread。/)
  assert.ok(manifest.files.includes('README.zh.md'))
  assert.ok(manifest.files.includes('docs/images'))
  assert.ok(manifest.files.includes('docs/reliability-spec.md'))
  assert.ok(manifest.files.includes('docs/reliability-acceptance.md'))
  assert.ok(manifest.files.includes('docs/spec/dsh-interaction-bridge.md'))
})

test('reliability spec, READMEs, and acceptance matrix describe the implemented contract', () => {
  for (const document of [english, chinese, reliabilitySpec, reliabilityAcceptance]) {
    assert.match(document, /rebind|required|重新绑定/i)
    assert.match(document, /Thread/)
  }
  assert.match(reliabilitySpec, /not-started/)
  assert.match(reliabilitySpec, /connection-failed/)
  assert.match(reliabilitySpec, /CODEX_STALE_APPROVAL/)
  assert.match(reliabilitySpec, /binding epoch/)
  assert.match(
    reliabilityAcceptance,
    /disconnect\s*\/\s*pending approval\s*\/\s*reconnect/i,
  )
  assert.match(reliabilityAcceptance, /b150a551/)
  assert.match(interactionSpec, /required Host injections/)
  assert.match(english, /DSH interaction bridge specification/)
  assert.match(chinese, /DSH 交互桥接规范/)
})

test('README preserves standalone scope and every supported installation source', () => {
  assert.match(english, /independently installable/i)
  assert.match(english, /no runtime dependency on the\s+Relay application, Relay Events, or another Relay plugin/i)
  const versionTag = new RegExp(
    `github:yangbobo2021/relay-dsh-plugin-codex#v${manifest.version.replaceAll('.', '\\.')}`,
  )
  for (const readme of [english, chinese]) {
    assert.match(readme, /https:\/\/www\.npmjs\.com\/package\/relay-dsh-plugin-codex/)
    assert.match(readme, /relay-dsh-plugin-codex@latest/)
    assert.match(readme, /relay-dsh-plugin-codex@next/)
    assert.match(readme, /github:yangbobo2021\/relay-dsh-plugin-codex#main/)
    assert.match(readme, versionTag)
  }
  assert.match(english, /DSH is currently a developer preview/)
})
