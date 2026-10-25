import { createServer } from 'node:http'
import { collectCliInventory, observeHmr, writeDiagnostic } from './dsh-smoke-diagnostics.mjs'

export const name = 'spring-inspector-smoke-probe'
export const inject = ['tools']

const EXPECTED_TOOLS = [
  'spring_health',
  'spring_route_search',
  'spring_bean_search',
  'spring_condition_report',
  'spring_metric_read',
]

function exit(code, message) {
  process.stdout.write(`${message}\n`, () => process.exit(code))
}

async function waitForTools(ctx) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const names = new Set(ctx.tools.schemas().map((schema) => schema.name))
    if (EXPECTED_TOOLS.every((tool) => names.has(tool))) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const names = ctx.tools.schemas().map((schema) => schema.name).join(', ')
  throw new Error(`registered tool set did not converge; visible: ${names}`)
}

export function apply(ctx) {
  const deadline = setTimeout(() => exit(1, 'SPRING_INSPECTOR_SMOKE_FAILED: timed out'), 10_000)
  observeHmr(ctx)
  writeDiagnostic(collectCliInventory())
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"unexpected request"}')
      return
    }
    const bodies = new Map([
      ['/actuator/health', {
        status: 'UP',
        accessToken: 'smoke-secret',
        components: { database: { status: 'UP', details: { password: 'smoke-secret' } } },
      }],
      ['/actuator/mappings', {
        contexts: { application: { mappings: { dispatcherServlets: { dispatcherServlet: [{
          handler: 'com.example.OrderController#create',
          predicate: '{POST [/orders]}',
          details: {
            handlerMethod: { className: 'com.example.OrderController', name: 'create' },
            requestMappingConditions: { methods: ['POST'], patterns: ['/orders'] },
          },
        }] } } } },
      }],
      ['/actuator/beans', {
        contexts: { application: { beans: { orderService: {
          aliases: [],
          scope: 'singleton',
          type: 'com.example.OrderService',
          dependencies: ['orderRepository'],
        } } } },
      }],
      ['/actuator/conditions', {
        contexts: { application: {
          positiveMatches: {},
          negativeMatches: { RedisAutoConfiguration: [{ condition: 'OnClassCondition', message: 'not found' }] },
        } },
      }],
      ['/actuator/metrics/jvm.memory.used', {
        name: 'jvm.memory.used',
        description: 'JVM memory used',
        baseUnit: 'bytes',
        measurements: [{ statistic: 'VALUE', value: 42 }],
        availableTags: [
          { tag: 'area', values: ['heap'] },
          { tag: 'apiKey', values: ['smoke-secret'] },
        ],
      }],
    ])
    const body = bodies.get(url.pathname)
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"unexpected request"}')
      return
    }
    response.writeHead(200, { 'content-type': 'application/vnd.spring-boot.actuator.v3+json' })
    response.end(JSON.stringify(body))
  })

  server.once('error', (error) => {
    clearTimeout(deadline)
    exit(1, `SPRING_INSPECTOR_SMOKE_FAILED: ${error.message}`)
  })
  server.listen(18_081, '127.0.0.1', async () => {
    try {
      await waitForTools(ctx)

      const calls = [
        ['spring_health', { target: 'smoke' }],
        ['spring_route_search', { target: 'smoke', query: 'order' }],
        ['spring_bean_search', { target: 'smoke', query: 'service' }],
        ['spring_condition_report', { target: 'smoke', outcome: 'negative' }],
        ['spring_metric_read', { target: 'smoke', metric: 'jvm.memory.used', tags: ['area:heap'] }],
      ]
      for (const [index, [toolName, argumentsValue]] of calls.entries()) {
        const result = await ctx.tools.execute({
          callId: `spring-inspector-smoke-${index + 1}`,
          name: toolName,
          arguments: argumentsValue,
          signal: new AbortController().signal,
        })
        if (result.isError) throw new Error(`${toolName}: ${result.error.message}`)
        const serialized = JSON.stringify(result.value)
        if (serialized.includes('smoke-secret')) throw new Error(`${toolName} canonical value leaked a secret`)
        if (result.value.sourceTruncated !== false) throw new Error(`${toolName} reported unexpected source truncation`)
        if (toolName === 'spring_health' && result.value.status !== 'UP') {
          throw new Error(`unexpected health result ${serialized}`)
        }
        if (toolName !== 'spring_health' && result.value.returned === 0 && toolName !== 'spring_metric_read') {
          throw new Error(`${toolName} returned no projected rows`)
        }
      }

      const invalid = await ctx.tools.execute({
        callId: 'spring-inspector-smoke-invalid',
        name: 'spring_health',
        arguments: { target: 'smoke', url: 'http://attacker.invalid' },
        signal: new AbortController().signal,
      })
      if (!invalid.isError || !invalid.error.message.includes('unknown tool argument')) {
        throw new Error('raw argument guard did not fail closed')
      }

      clearTimeout(deadline)
      server.close(() => exit(0, 'SPRING_INSPECTOR_SMOKE_OK'))
    } catch (error) {
      clearTimeout(deadline)
      server.close(() => exit(1, `SPRING_INSPECTOR_SMOKE_FAILED: ${error instanceof Error ? error.message : String(error)}`))
    }
  })
}
