#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPOSITORY_ROOT="$(CDPATH= cd -- "$SCRIPT_ROOT/.." && pwd)"
ROOT="$REPOSITORY_ROOT"
FORWARD=()

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/start-filestation.sh --root /srv/filestation
  bash scripts/start-filestation.sh --root /srv/filestation --dry-run
  bash scripts/start-filestation.sh --root /srv/filestation --bynginx

Root .env values load before server modules; the calling process environment
wins. Managed metadata, cwd, current release and canonical paths are validated
before any directory/database write.
EOF
  exit 0
fi

while (($#)); do
  case "$1" in
    --root)
      ROOT="$2"
      shift 2
      ;;
    --bynginx)
      export FILESTATION_SERVE_STATIC=false
      export FILESTATION_HOST=127.0.0.1
      shift
      ;;
    *)
      FORWARD+=("$1")
      shift
      ;;
  esac
done

NODE_BIN="${FILESTATION_NODE:-node}"
"$NODE_BIN" -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&(b>17||(b===17&&c>=0)))?0:1)' || {
  echo "FileStation requires Node.js 20.17.0 or newer." >&2
  exit 1
}
CLI="$REPOSITORY_ROOT/apps/updater/dist/cli.js"
if [[ ! -f "$CLI" ]]; then
  echo "Updater CLI is not built. Run: npm run build --workspace=@filestation/updater" >&2
  exit 1
fi
ROOT="$(CDPATH= cd -- "$ROOT" && pwd)"
cd -- "$ROOT"
exec "$NODE_BIN" "$CLI" launch --root "$ROOT" "${FORWARD[@]}"
