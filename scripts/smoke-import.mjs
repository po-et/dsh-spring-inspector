const plugin = await import('../lib/index.js')

if (plugin.default !== undefined) throw new Error('function plugin must not export default')
if (plugin.name !== 'spring-inspector') throw new Error('unexpected plugin name')
if (typeof plugin.apply !== 'function') throw new Error('plugin apply export is missing')
if (!Array.isArray(plugin.inject) || plugin.inject.length !== 1 || plugin.inject[0] !== 'tools') {
  throw new Error('plugin injection contract is incomplete')
}
