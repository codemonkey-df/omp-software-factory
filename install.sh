#!/usr/bin/env bash
# Install the software factory into OMP.
#   ./install.sh            link as a user plugin: /factory works in every repo
#   ./install.sh <repo>     copy into <repo>/.omp/ (pinned copy for that repo only)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -eq 0 ]]; then
  omp plugin link "$here"
  echo "Linked. In any repo: omp, then /factory init"
  exit 0
fi

repo="$(cd "$1" && git rev-parse --show-toplevel)"
omp_dir="$repo/.omp"
ext="$omp_dir/extensions/sw-factory"
mkdir -p "$omp_dir/skills" "$omp_dir/agents" "$omp_dir/commands" "$ext"
rm -rf "$omp_dir/skills/factory" "$ext/src" "$ext/templates"
cp -R "$here/skills/factory" "$omp_dir/skills/factory"
cp "$here"/agents/*.md "$omp_dir/agents/"
cp "$here/commands/factory.md" "$omp_dir/commands/factory.md"
cp -R "$here/src" "$here/templates" "$ext/"
printf '{\n  "name": "omp-sw-factory",\n  "type": "module",\n  "omp": { "extensions": ["./src/index.ts"] }\n}\n' >"$ext/package.json"
echo "Installed into $omp_dir. In that repo: omp, then /factory init"
