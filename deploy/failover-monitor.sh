#!/usr/bin/env bash
# Failover monitor — runs on the SECONDARY VPS, checks the primary every 30s.
# If the primary fails 3 health checks in a row, this VPS promotes its worker
# from standby to active (sets WORKER_ENABLED=true and reloads PM2).
#
# Install with PM2 alongside the main apps:
#   pm2 start deploy/failover-monitor.sh --name shivansh-failover --interpreter bash
#   pm2 save
#
# Required env (set in deploy/.env on the secondary VPS):
#   PRIMARY_HOST   IP/hostname of VPS 1
#   PRIMARY_PORT   API port (default: 8080)

set -euo pipefail

PRIMARY_HOST="${PRIMARY_HOST:?PRIMARY_HOST required}"
PRIMARY_PORT="${PRIMARY_PORT:-8080}"
CHECK_INTERVAL="${CHECK_INTERVAL:-30}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
URL="http://$PRIMARY_HOST:$PRIMARY_PORT/api/health"

fail_count=0
promoted=0

log() { echo "[failover $(date -Iseconds)] $*"; }

while true; do
  if curl -fsS --max-time 8 "$URL" >/dev/null 2>&1; then
    if [[ $fail_count -gt 0 ]]; then
      log "Primary recovered after $fail_count failed checks"
    fi
    fail_count=0

    # If we previously promoted, demote back to standby
    if [[ $promoted -eq 1 ]]; then
      log "Demoting secondary worker back to standby"
      pm2 set shivansh-worker:WORKER_ENABLED false || true
      pm2 reload shivansh-worker --update-env || true
      promoted=0
    fi
  else
    fail_count=$((fail_count + 1))
    log "Primary health check FAILED ($fail_count/$FAIL_THRESHOLD)"

    if [[ $fail_count -ge $FAIL_THRESHOLD && $promoted -eq 0 ]]; then
      log "*** PROMOTING secondary worker to active ***"
      pm2 set shivansh-worker:WORKER_ENABLED true || true
      pm2 reload shivansh-worker --update-env || true
      promoted=1
    fi
  fi

  sleep "$CHECK_INTERVAL"
done
