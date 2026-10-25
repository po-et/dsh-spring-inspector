import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ActuatorClient } from '../src/client.js'
import { normalizeTargets } from '../src/security.js'

const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout
const servers: Server[] = []
type Outcome<T> = { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'pending' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail })
  return { promise, resolve, reject }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { realSetTimeout(resolve, ms) })
}

async function settleWithin<T>(pending: Promise<T>, watchdogMs = 250): Promise<Outcome<T>> {
  let watchdog: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      pending.then(value => ({ kind: 'resolved' as const, value }), error => ({ kind: 'rejected' as const, error })),
      new Promise<Outcome<T>>(resolve => { watchdog = realSetTimeout(() => resolve({ kind: 'pending' }), watchdogMs) }),
    ])
  } finally {
    if (watchdog !== undefined) realClearTimeout(watchdog)
  }
}

function expectFailure<T>(outcome: Outcome<T>, pattern: RegExp) {
  expect(outcome.kind).toBe('rejected')
  if (outcome.kind === 'rejected') {
    expect(outcome.error).toBeInstanceOf(Error)
    expect((outcome.error as Error).message).toMatch(pattern)
    expect((outcome.error as Error).message).not.toContain('PRIVATE')
  }
}

async function startServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/actuator`
}

function client(url: string, resolve: () => Promise<string | undefined>, timeoutMs = 30) {
  return new ActuatorClient({
    targets: normalizeTargets([{ id: 'local', actuatorUrl: url, authorizationRef: 'TEST_REF' }]),
    timeoutMs,
    maxResponseBytes: 1000,
    resolveAuthorization: resolve,
  })
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

describe('credential resolution participates in the request lifecycle', () => {
  it.each(['caller abort', 'timeout'])('settles during pending credentials on %s', async mode => {
    let requests = 0
    const url = await startServer((_request, response) => {
      requests++
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    const credentials = deferred<string | undefined>()
    const controller = new AbortController()
    const pending = client(url, () => credentials.promise).get('local', ['health'], controller.signal)
    try {
      if (mode === 'caller abort') controller.abort(new Error('PRIVATE_ABORT_REASON'))
      expectFailure(await settleWithin(pending), mode === 'caller abort' ? /aborted/ : /timed out/)
      expect(requests).toBe(0)
    } finally {
      credentials.resolve(undefined)
      await pending.catch(() => undefined)
    }
  })

  it.each(['caller abort', 'timeout'])('does not start HTTP when credentials resolve after %s', async mode => {
    let requests = 0
    const url = await startServer((_request, response) => {
      requests++
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    const credentials = deferred<string | undefined>()
    const controller = new AbortController()
    const pending = client(url, () => credentials.promise).get('local', ['health'], controller.signal)
    try {
      if (mode === 'caller abort') controller.abort()
      expectFailure(await settleWithin(pending), mode === 'caller abort' ? /aborted/ : /timed out/)
      credentials.resolve('Bearer synthetic-late-value')
      await delay(20)
      expect(requests).toBe(0)
    } finally {
      credentials.resolve(undefined)
      await pending.catch(() => undefined)
    }
  })

  it.each(['caller abort', 'timeout'])('handles credentials rejecting after %s without an unhandled rejection', async mode => {
    const url = await startServer((_request, response) => response.end('{}'))
    const credentials = deferred<string | undefined>()
    const controller = new AbortController()
    const unhandled: unknown[] = []
    const record = (error: unknown) => { unhandled.push(error) }
    process.on('unhandledRejection', record)
    const pending = client(url, () => credentials.promise).get('local', ['health'], controller.signal)
    try {
      if (mode === 'caller abort') controller.abort()
      expectFailure(await settleWithin(pending), mode === 'caller abort' ? /aborted/ : /timed out/)
      credentials.reject(new Error('PRIVATE_PROVIDER_ERROR'))
      await delay(20)
      expect(unhandled).toEqual([])
    } finally {
      credentials.reject(new Error('PRIVATE_CLEANUP_REASON'))
      await pending.catch(() => undefined)
      process.removeListener('unhandledRejection', record)
    }
  })

  it('uses one deadline across credentials and the HTTP response, retaining close-before-settle ordering', async () => {
    const events: string[] = []
    const seenRequest = deferred<void>()
    let finishBody = () => {}
    const url = await startServer((request, response) => {
      request.once('aborted', () => events.push('server-observed-close'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"status":')
      const bodyTimer = realSetTimeout(() => { response.end('"UP"}') }, 160)
      finishBody = () => {
        realClearTimeout(bodyTimer)
        if (!response.writableEnded && !response.destroyed) response.end('"UP"}')
      }
      seenRequest.resolve()
    })
    const credentials = deferred<string | undefined>()
    const pending = client(url, () => credentials.promise, 200)
      .get('local', ['health'], new AbortController().signal)
      .catch((error: unknown) => { events.push('client-promise-settled'); throw error })
    const observed = settleWithin(pending, 1000)
    try {
      await delay(80)
      credentials.resolve('Bearer synthetic-value')
      await seenRequest.promise
      expectFailure(await observed, /timed out after 200ms/)
      expect(events).toEqual(['server-observed-close', 'client-promise-settled'])
    } finally {
      credentials.resolve(undefined)
      finishBody()
      await pending.catch(() => undefined)
    }
  })

  it('keeps caller cancellation when the resolver aborts and rejects in the same turn', async () => {
    const url = await startServer((_request, response) => response.end('{}'))
    const controller = new AbortController()
    const pending = client(url, async () => {
      controller.abort(new Error('PRIVATE_ABORT_REASON'))
      throw new Error('PRIVATE_PROVIDER_ERROR')
    }).get('local', ['health'], controller.signal)
    expectFailure(await settleWithin(pending), /aborted/)
  })

  it('waits for successful asynchronous credentials and refreshes them for each request', async () => {
    const authorizations: (string | undefined)[] = []
    const url = await startServer((request, response) => {
      authorizations.push(request.headers.authorization)
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"UP"}')
    })
    const credentials = [deferred<string | undefined>(), deferred<string | undefined>()]
    let reads = 0
    const instance = client(url, () => credentials[reads++]!.promise, 1000)
    for (let i = 0; i < credentials.length; i++) {
      const pending = instance.get('local', ['health'], new AbortController().signal)
      expect(authorizations).toHaveLength(i)
      credentials[i]!.resolve(`Bearer synthetic-${i}`)
      await expect(pending).resolves.toMatchObject({ statusCode: 200, data: { status: 'UP' } })
    }
    expect(reads).toBe(2)
    expect(authorizations).toEqual(['Bearer synthetic-0', 'Bearer synthetic-1'])
  })
})

