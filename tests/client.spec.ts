import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ActuatorClient } from '../src/client.js'
import { normalizeTargets } from '../src/security.js'

const servers: Server[] = []

async function startServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/actuator`
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function client(actuatorUrl: string, options: { maxResponseBytes?: number; timeoutMs?: number; authorizationRef?: string; resolve?: () => Promise<string | undefined> } = {}) {
  return new ActuatorClient({
    targets: normalizeTargets([{
      id: 'local',
      actuatorUrl,
      ...(options.authorizationRef === undefined ? {} : { authorizationRef: options.authorizationRef }),
    }]),
    timeoutMs: options.timeoutMs ?? 1_000,
    maxResponseBytes: options.maxResponseBytes ?? 10_000,
    resolveAuthorization: options.resolve ?? (() => Promise.resolve(undefined)),
  })
}

describe('loopback HTTP client', () => {
  it('uses fixed GET paths, identity encoding, per-call credentials, and canonical redaction', async () => {
    let credentialReads = 0
    const actuatorUrl = await startServer((request, response) => {
      expect(request.method).toBe('GET')
      expect(request.url).toBe('/actuator/health')
      expect(request.headers['accept-encoding']).toBe('identity')
      expect(request.headers.authorization).toBe(`Bearer token-${credentialReads}`)
      response.writeHead(200, { 'content-type': 'application/vnd.spring-boot.actuator.v3+json' })
      response.end(JSON.stringify({ status: 'UP', accessToken: 'must-not-leak' }))
    })
    const instance = client(actuatorUrl, {
      authorizationRef: 'SPRING_AUTHORIZATION',
      resolve: () => Promise.resolve(`Bearer token-${++credentialReads}`),
    })

    const first = await instance.get('local', ['health'], new AbortController().signal)
    const second = await instance.get('local', ['health'], new AbortController().signal)
    expect(credentialReads).toBe(2)
    expect(first).toMatchObject({ statusCode: 200, redactedCount: 1, data: { accessToken: '[REDACTED]' } })
    expect(JSON.stringify([first, second])).not.toContain('must-not-leak')
  })

  it('returns a 503 health document only when the caller explicitly accepts it', async () => {
    const actuatorUrl = await startServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end('{"status":"DOWN"}')
    })
    const instance = client(actuatorUrl)
    await expect(instance.get('local', ['health'], new AbortController().signal))
      .rejects.toThrow(/HTTP 503/)
    await expect(instance.get('local', ['health'], new AbortController().signal, undefined, [503]))
      .resolves.toMatchObject({ statusCode: 503, data: { status: 'DOWN' } })
  })

  it('refuses redirects without following their Location', async () => {
    const actuatorUrl = await startServer((_request, response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
      response.end()
    })
    await expect(client(actuatorUrl).get('local', ['health'], new AbortController().signal))
      .rejects.toThrow(/redirect refused/)
  })

  it('rejects chunked responses beyond the byte budget', async () => {
    const actuatorUrl = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"value":"')
      response.end(`${'界'.repeat(100)}"}`)
    })
    await expect(client(actuatorUrl, { maxResponseBytes: 64 }).get('local', ['health'], new AbortController().signal))
      .rejects.toThrow(/exceeded 64 bytes/)
  })

  it('reports when canonicalization reaches its global node budget', async () => {
    const actuatorUrl = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(Array.from({ length: 10_050 }, () => null)))
    })
    await expect(client(actuatorUrl, { maxResponseBytes: 100_000 })
      .get('local', ['health'], new AbortController().signal))
      .resolves.toMatchObject({ sourceTruncated: true })
  })

  it.each([
    ['text/html', undefined],
    ['application/json', 'gzip'],
  ])('rejects unsafe representation %s / %s', async (contentType, contentEncoding) => {
    const actuatorUrl = await startServer((_request, response) => {
      response.writeHead(200, {
        'content-type': contentType,
        ...(contentEncoding === undefined ? {} : { 'content-encoding': contentEncoding }),
      })
      response.end('{}')
    })
    await expect(client(actuatorUrl).get('local', ['health'], new AbortController().signal)).rejects.toThrow()
  })

  it('honors caller cancellation while waiting for the response body', async () => {
    const events: string[] = []
    const actuatorUrl = await startServer((request, response) => {
      request.once('aborted', () => events.push('server-observed-close'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"status":"')
    })
    const controller = new AbortController()
    const pending = client(actuatorUrl).get('local', ['health'], controller.signal).catch((error: unknown) => {
      events.push('client-promise-settled')
      throw error
    })
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toThrow(/aborted/)
    expect(events).toEqual(['server-observed-close', 'client-promise-settled'])
  })

  it('settles a timed-out call only after its loopback socket has closed', async () => {
    const events: string[] = []
    const actuatorUrl = await startServer((request, response) => {
      request.once('aborted', () => events.push('server-observed-close'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"status":"')
    })
    const pending = client(actuatorUrl, { timeoutMs: 30 })
      .get('local', ['health'], new AbortController().signal)
      .catch((error: unknown) => {
        events.push('client-promise-settled')
        throw error
      })

    await expect(pending).rejects.toThrow(/timed out/)
    expect(events).toEqual(['server-observed-close', 'client-promise-settled'])
  })

  it('does not start I/O when cancellation lands during credential resolution', async () => {
    let requests = 0
    const actuatorUrl = await startServer((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    const controller = new AbortController()
    const instance = client(actuatorUrl, {
      authorizationRef: 'SPRING_AUTHORIZATION',
      resolve: async () => {
        controller.abort()
        return 'Bearer token'
      },
    })
    await expect(instance.get('local', ['health'], controller.signal)).rejects.toThrow(/aborted/)
    expect(requests).toBe(0)
  })

  it('rejects invalid Authorization header bytes without echoing the credential', async () => {
    const actuatorUrl = await startServer((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const secret = 'Bearer hidden\0value'
    const pending = client(actuatorUrl, {
      authorizationRef: 'SPRING_AUTHORIZATION',
      resolve: () => Promise.resolve(secret),
    }).get('local', ['health'], new AbortController().signal)
    await expect(pending).rejects.toThrow(/invalid Authorization value/)
    await expect(pending).rejects.not.toThrow(/hidden/)
  })

  it('does not expose credential-provider errors', async () => {
    const actuatorUrl = await startServer((_request, response) => {
      response.writeHead(500)
      response.end()
    })
    const pending = client(actuatorUrl, {
      authorizationRef: 'SPRING_AUTHORIZATION',
      resolve: () => Promise.reject(new Error('provider failed with TOP_SECRET_7f6d')),
    }).get('local', ['health'], new AbortController().signal)
    await expect(pending).rejects.toThrow(/could not be resolved/)
    await expect(pending).rejects.not.toThrow(/TOP_SECRET_7f6d/)
  })
})
