import { describe, expect, it } from 'vitest'
import { parseConditionArgs, parseMetricArgs, parseSearchArgs, parseTargetArgs } from '../src/inputs.js'

describe('raw JSON-Schema argument guards', () => {
  it('rejects missing, unknown, and over-limit search arguments', () => {
    expect(() => parseTargetArgs({})).toThrow(/target/)
    expect(() => parseTargetArgs({ target: 'local', url: 'http://attacker' })).toThrow(/unknown/)
    expect(() => parseSearchArgs({ target: 'local', query: 'Order', limit: 101 }, 25, 100)).toThrow(/between/)
  })

  it('normalizes condition defaults', () => {
    expect(parseConditionArgs({ target: 'local' }, 25, 100)).toEqual({
      target: 'local', query: '', outcome: 'all', limit: 25,
    })
  })

  it('allows metric names and tag filters but not path-like names', () => {
    expect(parseMetricArgs({ target: 'local', metric: 'jvm.memory.used', tags: ['area:heap'] }))
      .toEqual({ target: 'local', metric: 'jvm.memory.used', tags: ['area:heap'] })
    expect(() => parseMetricArgs({ target: 'local', metric: '../env' })).toThrow(/unsupported/)
    expect(() => parseMetricArgs({ target: 'local', metric: '.' })).toThrow(/unsupported/)
    expect(() => parseMetricArgs({ target: 'local', metric: '..' })).toThrow(/unsupported/)
    expect(() => parseMetricArgs({ target: 'local', metric: 'jvm.memory', tags: ['invalid'] })).toThrow(/key:value/)
  })
})
