import { describe, expect, it } from 'vitest'
import { endpointUrl, normalizeTargets } from '../src/security.js'

describe('target URL policy', () => {
  it('rewrites localhost to a numeric loopback address and normalizes the base path', () => {
    const [target] = normalizeTargets([{ id: 'local', actuatorUrl: 'http://localhost:8080/manage' }])
    expect(target?.actuatorUrl.href).toBe('http://127.0.0.1:8080/manage/')
  })

  it('accepts numeric IPv4 and IPv6 loopback targets', () => {
    const targets = normalizeTargets([
      { id: 'v4', actuatorUrl: 'http://127.0.0.1:8080/actuator/' },
      { id: 'v6', actuatorUrl: 'http://[::1]:8081/actuator' },
    ])
    expect(targets.map((target) => target.actuatorUrl.hostname)).toEqual(['127.0.0.1', '[::1]'])
  })

  it('judges alternate IPv4 spelling after WHATWG normalization', () => {
    const [target] = normalizeTargets([{ id: 'local', actuatorUrl: 'http://127.1:8080/actuator' }])
    expect(target?.actuatorUrl.hostname).toBe('127.0.0.1')
  })

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/actuator',
    'http://0.0.0.0/actuator',
    'http://localhost./actuator',
    'http://[::ffff:127.0.0.1]/actuator',
    'https://127.0.0.1/actuator',
    'file:///actuator',
    'http://user:secret@127.0.0.1/actuator',
    'http://127.0.0.1/actuator?endpoint=env',
    'http://127.0.0.1/actuator#health',
    'http://127.0.0.1/actuator%2Fhidden',
  ])('rejects unsafe actuatorUrl %s', (actuatorUrl) => {
    expect(() => normalizeTargets([{ id: 'local', actuatorUrl }])).toThrow()
  })

  it('rejects duplicate ids and invalid credential references', () => {
    expect(() => normalizeTargets([
      { id: 'local', actuatorUrl: 'http://127.0.0.1:8080/actuator' },
      { id: 'local', actuatorUrl: 'http://127.0.0.1:8081/actuator' },
    ])).toThrow(/duplicate target/)
    expect(() => normalizeTargets([
      { id: 'local', actuatorUrl: 'http://127.0.0.1:8080/actuator', authorizationRef: 'not-a-ref' },
    ])).toThrow(/authorizationRef/)
  })

  it('keeps endpoint segments under the configured Actuator base path', () => {
    const [target] = normalizeTargets([{ id: 'local', actuatorUrl: 'http://127.0.0.1:8080/manage' }])
    expect(target).toBeDefined()
    expect(endpointUrl(target!, ['metrics', 'jvm.memory.used']).href)
      .toBe('http://127.0.0.1:8080/manage/metrics/jvm.memory.used')
    expect(() => endpointUrl(target!, ['..'])).toThrow(/escaped/)
  })
})
