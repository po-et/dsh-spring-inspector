# Architecture and threat model

## Source-audit decisions

DeepSeek Harness is a Cordis composition in which plugins register reversible
effects against service seams. The `tools` service accepts a `ToolDefinition`,
tracks registrations in the calling fiber, validates canonical outputs, and
projects those values to Native or Code Mode.

This package follows four constraints discovered in the upstream source:

1. It is an installable profile bundle declared by `dsh.bundle.patch`.
2. It is a function plugin with named `name`, `inject`, `Config`, and `apply`
   exports and no default export.
3. It registers tool effects through `ctx.tools.register()` and lets the
   Cordis fiber own their disposal.
4. Raw JSON-Schema registration does not validate arguments, so every execute
   function calls a strict local guard before credentials or I/O.

The raw registration is deliberate. `@deepseek-ai/dsh-tools` and
`@deepseek-ai/dsh-credentials` are development-only type sources. Their imports
are erased from the JavaScript artifact, preventing the plugin from installing
a second runtime service-definition module into an rc.6 profile. The build gate
fails if either runtime import appears.

Relevant upstream references:

- [Contribution policy](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)
- [Plugin packaging](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [Tool authoring](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)
- [Credentials seam](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/credentials.md)

## Data flow

1. The operator configures one or more local `actuatorUrl` values.
2. Configuration load validates and normalizes every URL. Exact `localhost` is
   replaced with `127.0.0.1`.
3. The model supplies only a target id and tool-specific filters.
4. A tool maps to an internal endpoint allowlist.
5. Node `http.request()` sends one GET with `agent: false`, JSON accept headers,
   no body, and optional credential-provider-backed Authorization.
6. The response passes status, representation, byte, UTF-8, and JSON gates.
7. Sensitive keys, descriptor-shaped values, and common secret-bearing strings
   are redacted under a global canonical-node budget.
8. Endpoint-specific projection removes unused Actuator detail and applies
   result limits.
9. DSH validates the canonical value; compact model rendering has an independent
   byte budget.

## Trust boundaries

### Operator configuration

The target URL is trusted only after validation. The following are rejected:

- non-HTTP schemes;
- every non-loopback host, including private networks and cloud metadata IPs;
- userinfo, query strings, fragments, encoded path separators, and unsafe path
  segments;
- duplicate or malformed target ids;
- malformed credential references.

### Model arguments

Model arguments are untrusted. Unknown keys fail. Strings and arrays have
explicit size/count limits. Metric names cannot contain path separators. No
argument can select a method, URL, header, or unlisted endpoint.

### Actuator response

The local application can still be compromised or misconfigured, so its
response is untrusted. The client rejects redirects, compression, non-JSON
media types, malformed UTF-8/JSON, and oversized bodies. It never includes an
error response body in an exception.

`health` status 503 is the one explicit non-2xx exception because Spring uses
503 for `DOWN`; it is still subject to every representation, size, and
redaction gate.

### Secrets

Configuration stores only a reference matching a POSIX environment-variable
identifier. When authorization is configured, the plugin resolves the optional
DSH credentials service and its value once per operation without caching the
provider. The value is used only as the loopback request's Authorization header
and is never logged, returned, or interpolated into a URL.

Key-based redaction cannot prove that arbitrary free text contains no secret.
That is why health details are discarded, and sensitive Actuator endpoints are
absent rather than merely redacted.

## Endpoint projections

| Tool | Fixed endpoint | Projection |
| --- | --- | --- |
| `spring_health` | `health` | status plus at most 200 component statuses over six levels; details dropped |
| `spring_route_search` | `mappings` | context, dispatcher, predicate, handler, controller, method, methods, patterns |
| `spring_bean_search` | `beans` | context, name, type, scope, resource, aliases, dependencies |
| `spring_condition_report` | `conditions` | context, configuration, outcome, condition, message |
| `spring_metric_read` | `metrics/<encoded name>` | name, description, unit, measurements, available tags |

## Compatibility and release gates

- Node 22.19, 24, and 26 run typecheck, unit/integration tests, build, artifact
  import checks, and package creation.
- Tests use real loopback sockets for the HTTP contract.
- `lib/` is committed so pinned GitHub installs need no install-time script.
- `pnpm pack` is checked for the bundle patch, runtime JavaScript, type
  declarations, documentation, and license.
- A release is tested in an isolated DSH rc.6 profile before tagging.

DeepSeek Harness remains a developer preview. Any new release candidate is
treated as a compatibility event, not assumed compatible.
