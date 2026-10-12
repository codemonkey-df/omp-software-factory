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
mkdir -p "$repo/.omp/skills" "$repo/.omp/agents" "$repo/.omp/commands"
rm -rf "$repo/.omp/skills/factory"
cp -R "$here/skills/factory" "$repo/.omp/skills/factory"
find "$repo/.omp/skills/factory" -name __pycache__ -type d -prune -exec rm -rf {} +
cp "$here"/agents/*.md "$repo/.omp/agents/"
cp "$here/commands/factory.md" "$repo/.omp/commands/factory.md"
echo "Installed into $repo/.omp. In that repo: omp, then /factory init"
