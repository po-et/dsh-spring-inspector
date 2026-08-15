import type { NormalizedTarget, TargetConfig } from './types.js'

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const TARGET_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
const ENCODED_PATH_SEPARATOR_PATTERN = /%(?:2f|5c)/i

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1'
}

function validatePath(pathname: string, targetId: string): void {
  if (ENCODED_PATH_SEPARATOR_PATTERN.test(pathname)) {
    throw new TypeError(`target "${targetId}" actuatorUrl must not contain encoded path separators`)
  }
  for (const encodedSegment of pathname.split('/')) {
    let segment: string
    try {
      segment = decodeURIComponent(encodedSegment)
    } catch {
      throw new TypeError(`target "${targetId}" actuatorUrl contains invalid percent-encoding`)
    }
    if (segment === '.' || segment === '..' || segment.includes('\0') || segment.includes('\\')) {
      throw new TypeError(`target "${targetId}" actuatorUrl contains an unsafe path segment`)
    }
  }
}

export function normalizeTargets(configured: readonly TargetConfig[]): readonly NormalizedTarget[] {
  if (configured.length === 0) throw new TypeError('targets must contain at least one Spring Boot application')

  const seen = new Set<string>()
  return configured.map((target) => {
    if (!TARGET_ID_PATTERN.test(target.id)) {
      throw new TypeError(`target id "${target.id}" must match ${String(TARGET_ID_PATTERN)}`)
    }
    if (seen.has(target.id)) throw new TypeError(`duplicate target id "${target.id}"`)
    seen.add(target.id)

    let url: URL
    try {
      url = new URL(target.actuatorUrl)
    } catch {
      throw new TypeError(`target "${target.id}" actuatorUrl must be an absolute URL`)
    }
    if (target.actuatorUrl.length > 2_048) {
      throw new TypeError(`target "${target.id}" actuatorUrl must be at most 2048 characters`)
    }
    if (url.protocol !== 'http:') {
      throw new TypeError(`target "${target.id}" actuatorUrl must use http`)
    }
    if (url.username !== '' || url.password !== '') {
      throw new TypeError(`target "${target.id}" actuatorUrl must not contain credentials`)
    }
    if (url.search !== '' || url.hash !== '') {
      throw new TypeError(`target "${target.id}" actuatorUrl must not contain a query or fragment`)
    }
    if (!isLoopbackHostname(url.hostname)) {
      throw new TypeError(`target "${target.id}" must use localhost, 127.0.0.1, or [::1]`)
    }
    validatePath(url.pathname, target.id)

    // Eliminate DNS from the default path. IPv6-only users can configure [::1].
    if (url.hostname.toLowerCase() === 'localhost') url.hostname = '127.0.0.1'
    if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`

    const authorizationRef = target.authorizationRef
    if (authorizationRef !== undefined && !CREDENTIAL_REF_PATTERN.test(authorizationRef)) {
      throw new TypeError(`target "${target.id}" authorizationRef must match ${String(CREDENTIAL_REF_PATTERN)}`)
    }

    return Object.freeze({
      id: target.id,
      actuatorUrl: url,
      ...(authorizationRef === undefined ? {} : { authorizationRef }),
    })
  })
}

export function endpointUrl(target: NormalizedTarget, segments: readonly string[], query?: URLSearchParams): URL {
  if (segments.length === 0) throw new TypeError('an Actuator endpoint is required')
  const encoded = segments.map((segment) => {
    if (segment.length === 0 || segment.length > 256) throw new TypeError('invalid Actuator endpoint segment')
    return encodeURIComponent(segment)
  }).join('/')
  const url = new URL(encoded, target.actuatorUrl)
  if (url.origin !== target.actuatorUrl.origin || !url.pathname.startsWith(target.actuatorUrl.pathname)) {
    throw new TypeError('Actuator endpoint escaped the configured base path')
  }
  if (query !== undefined) url.search = query.toString()
  return url
}
