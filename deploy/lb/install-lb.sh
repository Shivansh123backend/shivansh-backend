#!/usr/bin/env bash
# One-shot installer for the SHIVANSH load balancer on the gateway VPS.
# Run as root on the box that should accept public traffic (typically VPS1).
#
#   curl -fsSL https://raw.githubusercontent.com/<repo>/main/deploy/lb/install-lb.sh | sudo bash
# OR after pulling the repo:
#   sudo bash /opt/shivansh/deploy/lb/install-lb.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/shivansh}"
LB_CONF="$APP_DIR/deploy/nginx/shivansh-lb.conf"
INITIAL_UPSTREAM="$APP_DIR/deploy/nginx/shivansh-upstream.conf.initial"
TARGET_UPSTREAM="/etc/nginx/conf.d/shivansh-upstream.conf"

log() { echo "── $*"; }
require_root() { [[ $EUID -eq 0 ]] || { echo "Run as root"; exit 1; }; }
require_root

log "1. Installing nginx + jq if missing"
if ! command -v nginx >/dev/null; then apt-get update && apt-get install -y nginx; fi
if ! command -v jq    >/dev/null; then apt-get install -y jq; fi

log "2. Ensuring log dir"
mkdir -p /var/log/shivansh /var/lib/shivansh-lb

log "3. Installing initial upstream conf"
if [[ ! -f "$TARGET_UPSTREAM" ]]; then
  cp "$INITIAL_UPSTREAM" "$TARGET_UPSTREAM"
fi

log "4. Installing site"
cp "$LB_CONF" /etc/nginx/sites-available/shivansh-lb
ln -sf /etc/nginx/sites-available/shivansh-lb /etc/nginx/sites-enabled/shivansh-lb
rm -f /etc/nginx/sites-enabled/default

log "5. Validating nginx config"
nginx -t

log "6. Reloading nginx"
systemctl reload nginx || systemctl restart nginx

log "7. Installing health-monitor systemd unit"
cp "$APP_DIR/deploy/lb/shivansh-lb-monitor.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now shivansh-lb-monitor

log "8. Smoke test"
sleep 2
curl -fsS http://localhost/lb/health || { echo "LB local health failed"; exit 1; }
echo
echo "✓ LB installed. Status: systemctl status shivansh-lb-monitor"
echo "  Tail logs:        tail -f /var/log/shivansh/lb-monitor.log"
echo "  Cluster JSON:     cat /var/lib/shivansh-lb/status.json"
