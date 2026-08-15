import { describe, expect, it } from 'vitest'
import { CANONICAL_NODE_LIMIT, redactSensitive } from '../src/redact.js'
import type { JsonValue } from '../src/types.js'

function nodeCount(value: JsonValue): number {
  if (value === null || typeof value !== 'object') return 1
  let count = 1
  const entries = Array.isArray(value) ? value : Object.values(value)
  for (const entry of entries) count += nodeCount(entry)
  return count
}

describe('canonical JSON redaction', () => {
  it('redacts sensitive keys before canonical values reach the model', () => {
    const result = redactSensitive({
      password: 'hunter2',
      nested: [{ accessToken: 'abc' }, { 'client.secret': 'xyz' }],
      safe: 'Bearer hidden-token',
      url: 'http://service/path?api_key=hidden&mode=ok',
    })

    expect(result.redactedCount).toBe(5)
    expect(JSON.stringify(result.value)).not.toContain('hunter2')
    expect(JSON.stringify(result.value)).not.toContain('hidden-token')
    expect(JSON.stringify(result.value)).not.toContain('api_key=hidden')
    expect(result.value).toMatchObject({
      password: '[REDACTED]',
      nested: [{ accessToken: '[REDACTED]' }, { 'client.secret': '[REDACTED]' }],
      safe: 'Bearer [REDACTED]',
    })
  })

  it('redacts values paired with sensitive descriptor names', () => {
    const marker = 'TOP_SECRET_descriptor_marker'
    const result = redactSensitive({
      availableTags: [
        { tag: 'apiKey', values: [marker] },
        { tag: 'region', values: ['eu-west-1'] },
      ],
      property: { name: 'DB_PASSWORD', currentValue: marker },
      entry: { key: 'authorization', value: marker },
    })

    expect(result.redactedCount).toBe(3)
    expect(JSON.stringify(result.value)).not.toContain(marker)
    expect(result.value).toMatchObject({
      availableTags: [
        { tag: 'apiKey', values: '[REDACTED]' },
        { tag: 'region', values: ['eu-west-1'] },
      ],
      property: { name: 'DB_PASSWORD', currentValue: '[REDACTED]' },
      entry: { key: 'authorization', value: '[REDACTED]' },
    })
  })

  it('normalizes non-lossless numbers and handles __proto__ as data', () => {
    const source = JSON.parse('{"__proto__":{"token":"secret"},"minusZero":-0,"huge":1e400}') as unknown
    const result = redactSensitive(source)
    const value = result.value as Record<string, unknown>
    expect(Object.getPrototypeOf(value)).toBeNull()
    expect(value.minusZero).toBe(0)
    expect(value.huge).toBeNull()
    expect(JSON.stringify(value)).not.toContain('secret')
  })

  it('bounds deeply nested JSON without overflowing the stack', () => {
    let value: unknown = 'leaf'
    for (let index = 0; index < 200; index += 1) value = { child: value }
    const result = redactSensitive(value)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result.value)).toContain('TRUNCATED: depth limit')
  })

  it('stops cloning a large collection at one global node budget', () => {
    const result = redactSensitive(Array.from({ length: 50_000 }, () => ({})))
    const serialized = JSON.stringify(result.value)

    expect(result.truncated).toBe(true)
    expect(nodeCount(result.value)).toBeLessThanOrEqual(CANONICAL_NODE_LIMIT + 1)
    expect(serialized.match(/TRUNCATED: node limit/g)).toHaveLength(1)
  })
})
