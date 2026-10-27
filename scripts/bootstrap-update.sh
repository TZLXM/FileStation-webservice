#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPOSITORY_ROOT="$(CDPATH= cd -- "$SCRIPT_ROOT/.." && pwd)"
ROOT="$REPOSITORY_ROOT"
SOURCE_ROOT="$PWD"
FORWARD=()

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
FileStation manual bootstrap

Prepare the old process identity before stopping it:
  scripts/bootstrap-update.sh --root /srv/filestation --source-root /srv/old \
    --old-pid 1234 --old-boot-identity <boot-id> \
    --old-process-created-at <process-creation-id> \
    --relative-path-policy preserve

The helper only probes the old identity; it never signals that process. Nginx
files and services are not modified or reloaded by this command.

Restore by stopping the managed process, reviewing
ROOT/backups/ID/MANIFEST.json, restoring legacy-source and env/legacy.env to a
separate path, and starting the old command from the original legacy root.
EOF
  exit 0
fi

while (($#)); do
  case "$1" in
    --root)
      ROOT="$2"
      shift 2
      ;;
    --source-root)
      SOURCE_ROOT="$2"
      shift 2
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
exec "$NODE_BIN" "$CLI" bootstrap --root "$ROOT" --source-root "$SOURCE_ROOT" "${FORWARD[@]}"
