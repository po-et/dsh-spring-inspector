import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

const PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/cordis-plugin-hmr',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis',
]
const MAX_HMR_RECORDS = 5

function inside(root, filename) {
  const path = relative(root, filename)
  return path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)
}

function packageDirectory(filename, name) {
  for (let directory = dirname(filename), depth = 0; depth < 8; depth += 1, directory = dirname(directory)) {
    if (basename(directory) === name.split('/')[1]
      && basename(dirname(directory)) === '@deepseek-ai'
      && basename(dirname(dirname(directory))) === 'node_modules') return directory
  }
  throw new Error('package root unavailable')
}

function readBounded(filename, maxBytes) {
  const stat = statSync(filename)
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('metadata unavailable')
  return readFileSync(filename)
}

/** File-resolution inventory, not the identity of the running ESM provider. */
export function collectCliInventory(argv1 = process.argv[1]) {
  const record = { kind: 'cli-resolver-inventory', status: 'unavailable', packages: [] }
  try {
    if (typeof argv1 !== 'string') return record
    const cliEntry = realpathSync(argv1)
    const cliRoot = packageDirectory(cliEntry, PACKAGES[0])
    const modulesRoot = dirname(dirname(cliRoot))
    const require = createRequire(join(cliRoot, 'package.json'))
    record.packages = PACKAGES.map(name => {
      try {
        const entry = name === PACKAGES[0] ? cliEntry : realpathSync(require.resolve(name))
        const root = packageDirectory(entry, name)
        if (!inside(modulesRoot, root) || !inside(root, entry) || !/\.(?:c|m)?js$/.test(entry)) {
          throw new Error('entry unavailable')
        }
        const manifestPath = realpathSync(join(root, 'package.json'))
        if (!inside(root, manifestPath)) throw new Error('manifest unavailable')
        const manifest = readBounded(manifestPath, 65_536)
        const pkg = JSON.parse(manifest)
        if (pkg.name !== name || typeof pkg.version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(pkg.version)) {
          throw new Error('package unavailable')
        }
        return {
          package: name,
          version: pkg.version,
          entrySha256: createHash('sha256').update(readBounded(entry, 1_048_576)).digest('hex'),
        }
      } catch {
        return { package: name, status: 'unavailable' }
      }
    })
    record.status = 'collected'
  } catch {
    // Diagnostics cannot replace the real smoke result or expose exception data.
  }
  return record
}

function capability(value) {
  if (value === undefined || value === null) return { present: false }
  try {
    const constructor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), 'constructor')?.value
    const name = typeof constructor === 'function' ? constructor.name : ''
    return {
      present: true,
      registerConfigType: typeof value.registerConfig,
      constructor: /^[A-Za-z_$][0-9A-Za-z_$]{0,63}$/.test(name) ? name : 'unknown',
    }
  } catch {
    return { present: true, capability: 'unavailable' }
  }
}

export function writeDiagnostic(record) {
  try {
    process.stdout.write(`SPRING_INSPECTOR_SMOKE_DIAGNOSTIC ${JSON.stringify(record)}\n`)
  } catch {
    // An unavailable diagnostic sink must not change the smoke gate.
  }
}

/** Observe capabilities only: get() may return a context-tracing proxy. */
export function observeHmr(ctx, emit = writeDiagnostic) {
  let count = 0
  const report = (phase, eventValue) => {
    if (count >= MAX_HMR_RECORDS) return
    count += 1
    try {
      const root = ctx.root ?? ctx
      const record = { kind: 'hmr-capability', phase, root: capability(root.get('hmr')) }
      if (phase === 'service-event') record.eventRaw = capability(eventValue)
      emit(record)
    } catch {
      // Never throw into Cordis service notification or the actual tool probe.
    }
  }
  try {
    ctx.on('internal/service', (name, value) => {
      if (name === 'hmr') report('service-event', value)
    })
    report('initial')
  } catch {
    // ctx.on owns listener disposal; no new service or required injection exists.
  }
}
