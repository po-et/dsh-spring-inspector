import { describe, expect, it } from 'vitest'
import { projectBeans, projectConditions, projectHealth, projectMappings, projectMetric } from '../src/projections.js'
import type { JsonValue } from '../src/types.js'

const mappingsFixture: JsonValue = {
  contexts: {
    application: {
      mappings: {
        dispatcherServlets: {
          dispatcherServlet: [
            {
              handler: 'com.example.OrderController#create',
              predicate: '{POST [/orders]}',
              details: {
                handlerMethod: { className: 'com.example.OrderController', name: 'create' },
                requestMappingConditions: { methods: ['POST'], patterns: ['/orders'] },
              },
            },
            { handler: 'com.example.HealthController#ready', predicate: '{GET [/ready]}' },
          ],
        },
      },
    },
  },
}

const beansFixture: JsonValue = {
  contexts: {
    application: {
      beans: {
        orderService: {
          aliases: [],
          scope: 'singleton',
          type: 'com.example.OrderService',
          resource: 'class path resource [app.xml]',
          dependencies: ['orderRepository'],
        },
      },
    },
  },
}

const conditionsFixture: JsonValue = {
  contexts: {
    application: {
      positiveMatches: {
        DataSourceAutoConfiguration: [{ condition: 'OnClassCondition', message: 'found DataSource' }],
      },
      negativeMatches: {
        RedisAutoConfiguration: [{ condition: 'OnClassCondition', message: 'did not find RedisOperations' }],
      },
    },
  },
}

describe('bounded Actuator projections', () => {
  it('projects only a bounded health status tree and drops arbitrary details', () => {
    const marker = 'TOP_SECRET_health_marker'
    const result = projectHealth({
      status: 'UP',
      components: {
        db: { status: 'UP', details: { value: marker } },
        cache: {
          status: 'DOWN',
          components: {
            redis: { status: 'DOWN', details: { message: marker } },
          },
        },
      },
      details: { message: marker },
    }, 'local', 503, 2)

    expect(result).toMatchObject({
      target: 'local',
      statusCode: 503,
      status: 'UP',
      redactedCount: 2,
      health: {
        status: 'UP',
        returnedComponents: 3,
        truncated: false,
        components: [
          { name: 'db', status: 'UP' },
          { name: 'cache', status: 'DOWN', components: [{ name: 'redis', status: 'DOWN' }] },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(JSON.stringify(result)).not.toContain('details')
  })

  it('caps health component count, depth, names, and statuses', () => {
    const long = 'x'.repeat(10_000)
    const wide = Object.fromEntries(Array.from({ length: 205 }, (_, index) => [
      `${index}-${long}`,
      { status: long },
    ])) as JsonValue
    const wideResult = projectHealth({ status: long, components: wide }, 'local', 200, 0)
    const wideHealth = wideResult.health as Record<string, JsonValue>
    const wideComponents = wideHealth.components as Array<Record<string, JsonValue>>
    expect(wideHealth).toMatchObject({ returnedComponents: 200, truncated: true })
    expect(wideComponents).toHaveLength(200)
    expect((wideResult.status as string).length).toBeLessThanOrEqual(64)
    expect(wideComponents.every((component) => (
      (component.name as string).length <= 200
      && (component.status as string).length <= 64
    ))).toBe(true)

    let nested: JsonValue = { status: 'UP' }
    for (let depth = 7; depth >= 0; depth -= 1) {
      nested = { status: 'UP', components: { [`level${depth}`]: nested } }
    }
    const deepResult = projectHealth(nested, 'local', 200, 0)
    expect((deepResult.health as Record<string, JsonValue>).truncated).toBe(true)
    expect(JSON.stringify(deepResult)).toContain('level5')
    expect(JSON.stringify(deepResult)).not.toContain('level6')
  })

  it('searches route mappings without returning the raw details tree', () => {
    const result = projectMappings(mappingsFixture, 'local', 200, 'order', 10, 0)
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      context: 'application',
      controller: 'com.example.OrderController',
      httpMethods: ['POST'],
      patterns: ['/orders'],
    })
    expect(JSON.stringify(result)).not.toContain('requestMappingConditions')
  })

  it('searches beans and reports truncation metadata', () => {
    const result = projectBeans(beansFixture, 'local', 200, 'service', 1, 2)
    expect(result).toMatchObject({ total: 1, returned: 1, truncated: false, sourceTruncated: false, redactedCount: 2 })
    expect(result.items[0]).toMatchObject({ name: 'orderService', dependencies: ['orderRepository'] })

    const sourceLimited = projectBeans(beansFixture, 'local', 200, 'service', 1, 2, true)
    expect(sourceLimited).toMatchObject({ sourceTruncated: true, truncated: true })
  })

  it('filters negative condition outcomes', () => {
    const result = projectConditions(conditionsFixture, 'local', 200, '', 'negative', 10, 0)
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({ configuration: 'RedisAutoConfiguration', outcome: 'negative' })
  })

  it('projects only bounded metric fields', () => {
    const marker = 'TOP_SECRET_metric_marker'
    const result = projectMetric({
      name: 'jvm.memory.used',
      description: 'JVM memory used',
      baseUnit: 'bytes',
      measurements: [{ statistic: 'VALUE', value: 42 }],
      availableTags: [
        { tag: 'area', values: ['heap'] },
        { tag: 'apiKey', values: [marker] },
      ],
      unexpected: 'not returned',
    }, 'local', 200, 1)
    expect(result).toMatchObject({ target: 'local', statusCode: 200, name: 'jvm.memory.used', redactedCount: 1 })
    expect(result.availableTags).toEqual([
      { tag: 'area', values: ['heap'] },
      { tag: 'apiKey', values: [] },
    ])
    expect(result).not.toHaveProperty('unexpected')
    expect(JSON.stringify(result)).not.toContain(marker)
  })

  it('bounds dynamic object keys before repeating them in projected output', () => {
    const long = 'k'.repeat(10_000)
    const mappings = projectMappings({
      contexts: {
        [long]: {
          mappings: {
            [long]: {
              [long]: [{ handler: 'handler' }],
            },
          },
        },
      },
    }, 'local', 200, '', 10, 0)
    const beans = projectBeans({
      contexts: { [long]: { beans: { [long]: { type: 'type' } } } },
    }, 'local', 200, '', 10, 0)
    const conditions = projectConditions({
      contexts: { [long]: { positiveMatches: { [long]: [{ condition: 'condition' }] } } },
    }, 'local', 200, '', 'positive', 10, 0)

    const mapping = mappings.items[0] as Record<string, JsonValue>
    const bean = beans.items[0] as Record<string, JsonValue>
    const condition = conditions.items[0] as Record<string, JsonValue>
    for (const value of [mapping.context, mapping.dispatcher, bean.context, bean.name, condition.context, condition.configuration]) {
      expect((value as string).length).toBeLessThanOrEqual(200)
    }
    expect(JSON.stringify([mappings, beans, conditions]).length).toBeLessThan(5_000)
  })
})
