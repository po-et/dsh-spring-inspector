# DeepSeek Harness source and contribution analysis

Historical source-audit snapshot: 2026-08-15, upstream commit `47f943859b`.
At that snapshot, GitHub `master` declared `0.1.0-rc.5`; `0.1.0-rc.6` was the
smoke-test target, not a confirmed compatible host.

Compatibility update, 2026-10-25: the [CI run for plugin commit `7c4812f`](https://github.com/po-et/dsh-spring-inspector/actions/runs/40197520714)
passed the Node 22.19, 24, and 26 package verification jobs, but the real rc.6
host failed at startup with `TypeError: hmr.registerConfig is not a function`.
The five-tool acceptance checks did not run. The diagnostic CLI-resolver
inventory reported app-boot `0.1.0-rc.8`, HMR `1.0.20`, loader `1.0.6`, and
Cordis `4.0.5`. That inventory records file resolution, not the exact source
identity of the active ESM service provider. It does not establish that a
particular package version caused the failure. See the
[preview compatibility status](../README.md#preview-compatibility-status).

## Contribution route

The upstream [`CONTRIBUTING.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)
said at that snapshot that external pull requests were not accepted. Its
supported external route was an independent plugin repository with the
`dsh-plugin` GitHub topic.
That makes a standalone installable bundle more likely to create real user
value than an unmergeable source patch.

## Architectural findings

### The product is a plugin composition

The CLI resolves an ordered profile into a Cordis plugin tree. Core runtime,
LLM providers, tools, persistence, credentials, sandbox policy, Web UI, TUI,
and subagents are all rows in that tree rather than one inseparable application.
Activation is service-availability-driven; file order is not a dependency
contract.

### Bundle and profile are different artifacts

A bundle contributes a patch layer through `package.json#dsh.bundle.patch`.
A profile lists bundles and owns the user's final `cordis.patch.yml`. Layers are
applied in order, and a later row override replaces that row's complete config
rather than deep-merging it.

For an external contribution, the bundle is the publishable unit. It must ship
the patch and loadable JavaScript. A GitHub-installed TypeScript package either
needs an install-time `prepare` script plus pnpm `allowBuilds`, or must commit
prebuilt artifacts. This repository chooses the latter.

### Services are the extension boundary

Capabilities are exposed as Cordis services (`ctx.tools`, `ctx.credentials`,
and others). Consumers inject the service name and register scoped effects.
When the owning fiber unloads or HMR replaces a row, those registrations are
disposed with it.

This plugin injects only `tools`. The credentials seam is optional and looked up
again for each authorized operation, so unauthenticated targets do not require
it and provider replacement/rotation is not cached. An authorized call fails
closed if the service is unavailable.

### Tool values have two faces

A tool body returns canonical lossless JSON. Its `output.schema` is enforced by
the registry, while `output.render` creates the model-facing Native projection.
Code Mode receives the canonical value. Therefore redacting only rendered text
would be a security defect; redaction must happen before the body returns.

The convenient `defineTool()` helper validates arguments, but importing the
service-definition package at runtime can create a second `dsh-tools` module in
some rc.6 third-party profile layouts. Raw `ctx.tools.register()` avoids that
runtime edge, but raw argument schemas are descriptive only: each body must
validate `unknown` itself. The implementation and package checks cover those
guards and erased imports. The real-host smoke is intended to check the
installed-profile path, but its five-tool acceptance gate has not yet passed.

### Timeout metadata is not a hard kill

`ToolDefinition.timeoutMs` is policy metadata. Cooperative code must still
observe `exec.signal`, forward cancellation into owned I/O, and reach
quiescence. This plugin also maintains a local total HTTP deadline because a
profile may omit or replace the standard timeout policy.

### The sandbox does not secure network tools

Workspace sandboxing constrains subprocess/filesystem effects, not an in-process
HTTP client. An external plugin must own its SSRF boundary. That is why this
plugin does not accept private-network targets as a convenience: it uses only
numeric loopback and fixed endpoint mappings.

## Opportunity filtering

Live ecosystem searches showed multiple mature or exact implementations for
telemetry redaction, GitHub intelligence, context inspection, budget guards,
TUI, memory, and Codex/Claude product-subagent bundles. Publishing another thin
configuration wrapper in those categories would create little differentiation.

The `dsh-plugin` topic searches for Spring, Actuator, JVM, Maven, Gradle, and
ArchUnit returned no directly comparable runtime diagnostic plugin. A
Spring-focused contribution also lets Java engineers contribute response
fixtures, security patterns, and framework-specific projections without first
learning the entire Harness frontend.

## Contribution roadmap

1. **v0.1 — local runtime inspection:** the five fixed Actuator tools in this
   repository, threat model, and English/Chinese docs. The real rc.6
   packed-profile smoke remains failing; host compatibility is unresolved.
2. **v0.2 — fixture depth:** WebFlux variants, parent application contexts,
   additional Spring Boot 3/4 response fixtures, projection confidence metadata.
3. **v0.3 — adapter split:** extract a DSH-independent HTTP/projection core and
   add an MCP adapter for Codex and Claude Code without weakening the local
   network boundary.
4. **Later, separately reviewed:** authenticated remote deployments only after
   redirect, DNS pinning, TLS trust, proxy, credential destination, and audit
   semantics have a dedicated threat model.

## Upstream documentation finding

`examples/mcp-memory/README.md` states that the generic MCP client does not
automatically reconnect. The current `packages/mcp/mcp-client/README.md`
documents default automatic reconnect with a retry budget. Because upstream
does not accept external PRs, the appropriate action is a concise Discussion
report linking both locations rather than opening a pull request that cannot be
reviewed.
