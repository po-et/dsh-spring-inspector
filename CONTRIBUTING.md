# Contributing

Issues and pull requests are welcome for reproducible defects, new Actuator
response fixtures, documentation, and security-preserving improvements.

Before opening a pull request:

```sh
pnpm install
pnpm check
pnpm pack
```

New tools must remain read-only and fixed-purpose. Proposals that introduce an
arbitrary URL/path, write endpoint, command execution, redirect following,
remote target, or sensitive Actuator endpoint need a threat model before code.

Never commit real Actuator documents without removing organization names,
routes, class names, credentials, tokens, hostnames, and business data.
