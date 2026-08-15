import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const files = (await readdir(new URL('../lib/', import.meta.url), { recursive: true }))
  .filter((entry) => entry.endsWith('.js'))

if (files.length === 0) throw new Error('lib contains no JavaScript build artifacts')

for (const relative of files) {
  const source = await readFile(join(new URL('../lib/', import.meta.url).pathname, relative), 'utf8')
  if (/from\s+['"]@deepseek-ai\/(?:dsh-tools|dsh-credentials)['"]/.test(source)) {
    throw new Error(`${relative} contains a forbidden runtime import of a DSH service-definition package`)
  }
}
