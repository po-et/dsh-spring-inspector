# Security policy

## Supported versions

Only the latest tagged release receives security fixes while DeepSeek Harness
is in developer preview.

## Reporting a vulnerability

Please use GitHub's private **Security advisories → Report a vulnerability**
flow for this repository. Do not open a public issue containing credentials,
Actuator documents, internal routes, hostnames, or proof-of-concept secrets.

Include the plugin version, Node version, DSH version, minimal configuration
with secrets replaced, expected boundary, observed behavior, and reproduction
steps. You should receive an acknowledgement within seven days.

## Explicit non-goals

The plugin does not make an unsafe Actuator deployment safe. Operators remain
responsible for binding the management server to loopback, enabling only the
required endpoints, configuring Spring Security, and protecting the host.
