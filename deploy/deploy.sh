#!/usr/bin/env bash
# Deploy from Replit (or any dev box) to BOTH Hostinger VPS in one command.
#
# Required environment variables (set as Replit secrets):
#   VPS_1_HOST       primary VPS hostname or IP
#   VPS_2_HOST       secondary VPS hostname or IP
#   VPS_SSH_USER     SSH user (default: shivansh)
#   VPS_SSH_KEY      private key contents (full PEM body, including BEGIN/END lines)
#   GITHUB_REPO_URL  optional, only used for first-time clone reminder
#
# Optional:
#   VPS_SSH_PORT     SSH port (default: 22)
#   GIT_BRANCH       branch to deploy (default: main)
#   SKIP_PUSH=1      skip git push step (deploy whatever's already on remote)
#
# Usage:
#   bash deploy/deploy.sh

set -euo pipefail

: "${VPS_1_HOST:?VPS_1_HOST is required}"
: "${VPS_2_HOST:?VPS_2_HOST is required}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY is required (private key contents)}"
SSH_USER="${VPS_SSH_USER:-shivansh}"
SSH_PORT="${VPS_SSH_PORT:-22}"
GIT_BRANCH="${GIT_BRANCH:-main}"
APP_DIR="/opt/shivansh"

# 1. Write the SSH key to a temp file with locked-down perms.
#    Replit secret storage sometimes strips newlines from multi-line values,
#    so we reconstruct a valid OpenSSH PEM if needed.
KEY_FILE="$(mktemp)"
trap 'rm -f "$KEY_FILE"' EXIT
node -e '
const raw = process.env.VPS_SSH_KEY || "";
let body = raw
  .replace(/-----BEGIN[^-]+-----/g, "")
  .replace(/-----END[^-]+-----/g, "")
  .replace(/\s+/g, "");
const wrapped = body.match(/.{1,70}/g).join("\n");
const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + wrapped + "\n-----END OPENSSH PRIVATE KEY-----\n";
require("fs").writeFileSync(process.argv[1], pem, {mode:0o600});
' "$KEY_FILE"
chmod 600 "$KEY_FILE"

if ! ssh-keygen -y -f "$KEY_FILE" >/dev/null 2>&1; then
  echo "FATAL: VPS_SSH_KEY did not produce a valid OpenSSH key after reconstruction." >&2
  exit 1
fi

SSH_OPTS=(-i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15)

run_remote() {
  local host="$1"; shift
  echo ""
  echo "── [$host] $*"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$host" "$@"
}

deploy_to() {
  local host="$1"
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  Deploying to $host"
  echo "════════════════════════════════════════════════════════════"
  run_remote "$host" "set -e; cd $APP_DIR && \
    git fetch --all --quiet && \
    git reset --hard origin/$GIT_BRANCH && \
    pnpm install --frozen-lockfile && \
    pnpm --filter @workspace/api-server run build && \
    pm2 reload $APP_DIR/deploy/ecosystem.config.cjs --update-env && \
    pm2 save"

  # Health check
  echo "── [$host] Waiting 5s, then health check…"
  sleep 5
  if run_remote "$host" "curl -fsS http://localhost:8080/api/health"; then
    echo ""
    echo "✓ $host is healthy"
  else
    echo "✗ $host health check FAILED"
    return 1
  fi
}

# 2. Push code (unless skipped)
if [[ "${SKIP_PUSH:-0}" != "1" ]]; then
  echo "── Pushing local changes to origin/$GIT_BRANCH"
  git push origin "$GIT_BRANCH"
fi

# 3. Deploy primary, then secondary (sequential — easier rollback story)
deploy_to "$VPS_1_HOST"
deploy_to "$VPS_2_HOST"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  ✓ Deployment complete on both VPS"
echo "════════════════════════════════════════════════════════════"
