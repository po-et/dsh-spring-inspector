import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { collectCliInventory, observeHmr, writeDiagnostic } from './dsh-smoke-diagnostics.mjs'

const PACKAGE_NAMES = ['dsh', 'dsh-app-boot', 'cordis-plugin-hmr', 'cordis-plugin-loader', 'cordis']
const CANARY = 'secret-value-not-for-diagnostics'

function fixture() {
  // Retained for failure diagnosis; no recursive fixture cleanup.
  const root = mkdtempSync(join(tmpdir(), 'spring-inspector-diagnostics-'))
  const modules = join(root, 'node_modules', '@deepseek-ai')
  for (const name of PACKAGE_NAMES) {
    const directory = join(modules, name)
    mkdirSync(join(directory, 'lib'), { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name: `@deepseek-ai/${name}`,
      version: '0.1.0-rc.6',
      main: './lib/index.js',
      token: CANARY,
      configuration: { privatePath: root, password: CANARY },
    }))
    writeFileSync(join(directory, 'lib', 'index.js'), `throw new Error('${CANARY}: SDK code must not run')\n`)
  }
  const argv1 = join(modules, 'dsh', 'lib', 'bin.js')
  writeFileSync(argv1, "throw new Error('CLI must not run')\n")
  return { root, modules, argv1 }
}

class LegacyHmr extends Service {
  constructor(ctx) { super(ctx, 'hmr') }
}
class ModernHmr extends Service {
  constructor(ctx) { super(ctx, 'hmr') }
  registerConfig() { throw new Error('diagnostics must never call registerConfig') }
}

test('real Cordis lifecycle reports missing, legacy, removed and modern HMR without invoking it', async () => {
  const ctx = new Context()
  const records = []
  try {
    await ctx.plugin({ name: 'passive-observer', apply: child => observeHmr(child, record => records.push(record)) })
    assert.deepEqual(records[0], { kind: 'hmr-capability', phase: 'initial', root: { present: false } })
    const legacy = await ctx.plugin(LegacyHmr)
    assert.equal(records.at(-1).phase, 'service-event')
    assert.equal(records.at(-1).eventRaw.registerConfigType, 'undefined')
    assert.equal(records.at(-1).root.registerConfigType, 'undefined')
    await legacy.dispose()
    assert.equal(records.at(-1).eventRaw.present, false)
    const modern = await ctx.plugin(ModernHmr)
    assert.equal(records.at(-1).eventRaw.registerConfigType, 'function')
    assert.equal(records.at(-1).root.registerConfigType, 'function')
    assert.equal(records.at(-1).eventRaw.constructor, 'ModernHmr')
    await modern.dispose()
    assert.equal(ctx.get('hmr'), undefined)
    assert.equal(records.length, 5, 'later lifecycle events must respect the output cap')
    assert.ok(!JSON.stringify(records).includes(CANARY))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('an existing service is sampled and the observer listener is disposed with its real Cordis fiber', async () => {
  const ctx = new Context()
  const records = []
  try {
    const modern = await ctx.plugin(ModernHmr)
    const observer = await ctx.plugin({ name: 'disposable-observer', apply: child => observeHmr(child, record => records.push(record)) })
    assert.equal(records[0].root.registerConfigType, 'function')
    assert.equal(records.length, 1)
    await observer.dispose()
    await modern.dispose()
    await ctx.plugin(LegacyHmr)
    assert.equal(records.length, 1, 'the disposed observer must not receive service changes')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('diagnostic sink and capability getter failures do not break real Cordis service activation', async () => {
  const ctx = new Context()
  const records = []
  class UnreadableHmr extends Service {
    constructor(child) { super(child, 'hmr') }
    get registerConfig() { throw new Error(CANARY) }
  }
  try {
    await ctx.plugin({ apply: child => observeHmr(child, record => records.push(record)) })
    await ctx.plugin({ apply: child => observeHmr(child, () => { throw new Error(CANARY) }) })
    const provider = await ctx.plugin(UnreadableHmr)
    assert.equal(provider.state, 2)
    assert.deepEqual(records.at(-1).eventRaw, { present: true, capability: 'unavailable' })
    assert.ok(!JSON.stringify(records).includes(CANARY))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('unrelated events are ignored and a long event stream has bounded output', () => {
  let listener
  const records = []
  const ctx = { get: () => undefined, on: (_name, callback) => { listener = callback } }
  observeHmr(ctx, record => records.push(record))
  listener('credentials', { token: CANARY })
  assert.equal(records.length, 1)
  for (let index = 0; index < 100; index += 1) listener('hmr', { registerConfig: null, token: CANARY })
  assert.equal(records.length, 5)
  assert.ok(!JSON.stringify(records).includes(CANARY))
  assert.doesNotThrow(() => observeHmr({ on: () => { throw new Error(CANARY) } }))
  assert.doesNotThrow(() => observeHmr({ on: () => {}, get: () => { throw new Error(CANARY) } }))
  assert.doesNotThrow(() => writeDiagnostic({ toJSON() { throw new Error(CANARY) } }))
})

test('CLI inventory reads only five allowlisted packages and hashes entries without executing SDK code', () => {
  const { root, argv1 } = fixture()
  const result = collectCliInventory(argv1)
  assert.equal(result.kind, 'cli-resolver-inventory')
  assert.equal(result.status, 'collected')
  assert.deepEqual(result.packages.map(pkg => pkg.package), PACKAGE_NAMES.map(name => `@deepseek-ai/${name}`))
  assert.ok(result.packages.every(pkg => pkg.version === '0.1.0-rc.6' && /^[0-9a-f]{64}$/.test(pkg.entrySha256)))
  assert.equal(result.packages[0].entrySha256, createHash('sha256').update("throw new Error('CLI must not run')\n").digest('hex'))
  assert.ok(!JSON.stringify(result).includes(CANARY))
  assert.ok(!JSON.stringify(result).includes(root), 'absolute paths and manifest config are not diagnostics')
})

test('missing or unrelated CLI anchors remain unavailable without exposing paths or errors', () => {
  assert.deepEqual(collectCliInventory(undefined), { kind: 'cli-resolver-inventory', status: 'unavailable', packages: [] })
  assert.deepEqual(collectCliInventory(join(tmpdir(), CANARY, 'missing.js')), { kind: 'cli-resolver-inventory', status: 'unavailable', packages: [] })
  const { root } = fixture()
  const unrelated = join(root, 'unrelated.js')
  writeFileSync(unrelated, CANARY)
  assert.deepEqual(collectCliInventory(unrelated), { kind: 'cli-resolver-inventory', status: 'unavailable', packages: [] })
})

test('wrong package identity and oversized manifests are rejected without exposing manifest data', () => {
  const { modules, argv1 } = fixture()
  writeFileSync(join(modules, 'cordis', 'package.json'), JSON.stringify({ name: 'wrong', version: CANARY, main: './lib/index.js' }))
  writeFileSync(join(modules, 'dsh-app-boot', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: '1.0.0', main: './lib/index.js', secret: CANARY, padding: 'x'.repeat(65_536) }))
  const result = collectCliInventory(argv1)
  for (const name of ['cordis', 'dsh-app-boot']) {
    assert.deepEqual(result.packages.find(pkg => pkg.package === `@deepseek-ai/${name}`), { package: `@deepseek-ai/${name}`, status: 'unavailable' })
  }
  assert.ok(!JSON.stringify(result).includes(CANARY))
})

test('a resolved SDK entry outside the actual CLI installation is not read into inventory', () => {
  const { modules, argv1 } = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'spring-inspector-outside-'))
  const entry = join(outside, 'private.js')
  writeFileSync(entry, CANARY)
  symlinkSync(entry, join(modules, 'cordis', 'lib', 'outside.js'))
  writeFileSync(join(modules, 'cordis', 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.1', main: './lib/outside.js' }))
  const result = collectCliInventory(argv1)
  assert.deepEqual(result.packages.find(pkg => pkg.package === '@deepseek-ai/cordis'), { package: '@deepseek-ai/cordis', status: 'unavailable' })
  assert.ok(!JSON.stringify(result).includes(CANARY))
  assert.ok(!JSON.stringify(result).includes(outside))
})
