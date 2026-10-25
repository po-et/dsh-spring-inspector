#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
smoke_home="$(mktemp -d /tmp/dsh-spring-inspector-smoke.XXXXXX)"
profile_dir="$smoke_home/profiles/spring-smoke"

mkdir -p "$project_root/artifacts"
pnpm --dir "$project_root" pack --pack-destination "$project_root/artifacts"
archive_name="$(node -e 'const p = require(process.argv[1]); process.stdout.write(`${p.name}-${p.version}.tgz`)' "$project_root/package.json")"
archive="$project_root/artifacts/$archive_name"
test -f "$archive"
DSH_HOME="$smoke_home" npx -y @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile spring-smoke add "$archive"
pnpm --dir "$profile_dir" peers check
mkdir -p "$profile_dir/scripts"
ln -s "$project_root/scripts/dsh-smoke-probe.mjs" "$profile_dir/scripts/dsh-smoke-probe.mjs"
ln -s "$project_root/scripts/dsh-smoke-diagnostics.mjs" "$profile_dir/scripts/dsh-smoke-diagnostics.mjs"
DSH_HOME="$smoke_home" npx -y @deepseek-ai/dsh@0.1.0-rc.6 \
  --profile spring-smoke --patch "$project_root/scripts/dsh-smoke.patch.yml"

echo "Isolated smoke profile retained at: $smoke_home"
