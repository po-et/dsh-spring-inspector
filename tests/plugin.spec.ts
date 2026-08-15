import type { Context } from '@deepseek-ai/cordis'
import {
  assertSupportedJsonSchema,
  renderToolsSdk,
  renderToolsSdkPy,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/index.js'
import { projectMetric } from '../src/projections.js'
import { redactSensitive } from '../src/redact.js'

const config = {
  targets: [{ id: 'local', actuatorUrl: 'http://127.0.0.1:8080/actuator' }],
  timeoutMs: 5_000,
  maxResponseBytes: 262_144,
  defaultLimit: 25,
  maxLimit: 100,
}

describe('DSH plugin contract', () => {
  it('exports a named function plugin and registers exactly five tools', () => {
    const definitions: ToolDefinition[] = []
    const ctx = {
      tools: { register: vi.fn((definition: ToolDefinition) => { definitions.push(definition); return () => undefined }) },
      get: vi.fn(() => undefined),
    } as unknown as Context

    apply(ctx, config)
    expect(name).toBe('spring-inspector')
    expect(inject).toEqual(['tools'])
    expect(definitions.map((definition) => definition.name)).toEqual([
      'spring_health',
      'spring_route_search',
      'spring_bean_search',
      'spring_condition_report',
      'spring_metric_read',
    ])
    for (const definition of definitions) {
      expect(definition.output.schema).toBeDefined()
      expect(definition.output.render).toBeTypeOf('function')
      expect(definition.timeoutMs).toBe(6_000)
    }
  })

  it('keeps every raw schema compatible with the rc.6 Code Mode SDKs', () => {
    const definitions: ToolDefinition[] = []
    const ctx = {
      tools: { register: (definition: ToolDefinition) => { definitions.push(definition); return () => undefined } },
      get: vi.fn(() => undefined),
    } as unknown as Context

    apply(ctx, config)
    const schemas = definitions.map((definition) => {
      assertSupportedJsonSchema(definition.parameters)
      assertSupportedJsonSchema(definition.output.schema)
      return {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: definition.output.schema,
      }
    })

    const typescriptSdk = renderToolsSdk(schemas)
    const typescriptArgs = typescriptSdk.slice(
      typescriptSdk.indexOf('interface ToolArgsMap'),
      typescriptSdk.indexOf('interface ToolOutputMap'),
    )
    const pythonSdk = renderToolsSdkPy(schemas)

    expect(definitions).toHaveLength(5)
    for (const definition of definitions) {
      const argsType = definition.name
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join('') + 'Args'
      expect(typescriptArgs).toContain(`${definition.name}: {`)
      expect(typescriptArgs).not.toContain(`${definition.name}: unknown;`)
      expect(pythonSdk).toContain(`class ${argsType}(TypedDict):`)
      expect(pythonSdk).toContain(`async def ${definition.name}(self, args: ${argsType})`)
      expect(pythonSdk).not.toContain(`async def ${definition.name}(self, args: Any)`)
    }
  })

  it('applies schema defaults and fails closed on remote targets', () => {
    expect(Config()).toMatchObject({
      targets: [{ id: 'local', actuatorUrl: 'http://127.0.0.1:8080/actuator' }],
      timeoutMs: 5_000,
      defaultLimit: 25,
    })
    const ctx = {
      tools: { register: vi.fn() },
      get: vi.fn(() => undefined),
    } as unknown as Context
    expect(() => apply(ctx, { ...config, targets: [{ id: 'prod', actuatorUrl: 'http://10.0.0.8/actuator' }] }))
      .toThrow(/must use localhost/)
  })

  it('validates raw arguments before starting I/O', async () => {
    const definitions: ToolDefinition[] = []
    const get = vi.fn(() => undefined)
    const ctx = {
      tools: { register: (definition: ToolDefinition) => { definitions.push(definition); return () => undefined } },
      get,
    } as unknown as Context
    apply(ctx, config)
    const health = definitions.find((definition) => definition.name === 'spring_health')
    expect(health).toBeDefined()
    await expect(health!.execute({ target: 'local', url: 'http://attacker' }, {
      signal: new AbortController().signal,
    } as never)).rejects.toThrow(/unknown tool argument/)
    expect(get).not.toHaveBeenCalled()
  })

  it('looks up the optional credential service for each authorized call', async () => {
    const definitions: ToolDefinition[] = []
    const provider = { resolve: vi.fn(() => Promise.resolve(undefined)) }
    const get = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(provider)
    const ctx = {
      tools: { register: (definition: ToolDefinition) => { definitions.push(definition); return () => undefined } },
      get,
    } as unknown as Context
    apply(ctx, {
      ...config,
      targets: [{
        id: 'local',
        actuatorUrl: 'http://127.0.0.1:8080/actuator',
        authorizationRef: 'SPRING_ACTUATOR_AUTHORIZATION',
      }],
    })
    const health = definitions.find((definition) => definition.name === 'spring_health')
    expect(health).toBeDefined()
    expect(get).not.toHaveBeenCalled()

    const exec = { signal: new AbortController().signal } as never
    await expect(health!.execute({ target: 'local' }, exec)).rejects.toThrow(/could not be resolved/)
    await expect(health!.execute({ target: 'local' }, exec)).rejects.toThrow(/is not configured/)
    expect(get).toHaveBeenCalledTimes(2)
    expect(provider.resolve).toHaveBeenCalledOnce()
  })

  it('renders compact bounded text after canonical and projection redaction', () => {
    const definitions: ToolDefinition[] = []
    const ctx = {
      tools: { register: (definition: ToolDefinition) => { definitions.push(definition); return () => undefined } },
      get: vi.fn(() => undefined),
    } as unknown as Context
    apply(ctx, config)
    const metric = definitions.find((definition) => definition.name === 'spring_metric_read')
    const health = definitions.find((definition) => definition.name === 'spring_health')
    expect(metric).toBeDefined()
    expect(health).toBeDefined()

    const marker = 'TOP_SECRET_render_marker'
    const redacted = redactSensitive({
      name: 'test.metric',
      availableTags: [{ tag: 'apiKey', values: [marker] }],
    })
    const projected = projectMetric(redacted.value, 'local', 200, redacted.redactedCount)
    const rendered = metric!.output.render({}, projected)
    const renderedText = rendered.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
    expect(JSON.stringify(redacted.value)).not.toContain(marker)
    expect(JSON.stringify(projected)).not.toContain(marker)
    expect(renderedText).not.toContain(marker)
    expect(renderedText).not.toContain('\n')

    const oversized = {
      target: 'local',
      statusCode: 200,
      status: 'UP',
      health: { padding: 'x'.repeat(300_000) },
      redactedCount: 0,
    }
    const bounded = health!.output.render({}, oversized)
    const boundedText = bounded.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
    expect(Buffer.byteLength(boundedText)).toBeLessThanOrEqual(262_144)
    expect(JSON.parse(boundedText)).toMatchObject({ renderOmitted: true, maxBytes: 262_144 })
  })
})
