# SHIVANSH — Hostinger VPS Deployment

Two-VPS production setup. Replit stays as the dev/control layer; the VPS pair runs the call processor and API in production.

```
┌──────────┐  git push  ┌─────────────────┐
│  Replit  ├───────────►│  GitHub origin  │
└──────────┘            └────────┬────────┘
       │  ssh + pm2 reload       │
       ├──────────────►  VPS 1 (primary)   ← takes all calls
       └──────────────►  VPS 2 (secondary) ← standby + auto-promotes if VPS 1 dies
```

## One-time setup (per VPS)

On each fresh Hostinger VPS (Ubuntu 22.04+), as root:

```bash
# Primary
curl -fsSL https://raw.githubusercontent.com/<your-org>/<your-repo>/main/deploy/vps-bootstrap.sh \
  | sudo bash -s -- primary https://github.com/<your-org>/<your-repo>.git

# Secondary
curl -fsSL https://raw.githubusercontent.com/<your-org>/<your-repo>/main/deploy/vps-bootstrap.sh \
  | sudo bash -s -- secondary https://github.com/<your-org>/<your-repo>.git
```

Then on each VPS:

```bash
# Copy your .env to /opt/shivansh/deploy/.env (use .env.example as template)
sudo -u shivansh nano /opt/shivansh/deploy/.env
sudo chmod 600 /opt/shivansh/deploy/.env

# First-time install + start
sudo -u shivansh bash /opt/shivansh/deploy/install-and-start.sh
```

On the **secondary** VPS only, also start the failover monitor:

```bash
sudo -u shivansh pm2 start /opt/shivansh/deploy/failover-monitor.sh \
  --name shivansh-failover --interpreter bash
sudo -u shivansh pm2 save
```

## Replit secrets to add

Add these in Replit → Secrets:

| Secret             | Value                                                                |
| ------------------ | -------------------------------------------------------------------- |
| `VPS_1_HOST`       | primary VPS IP                                                       |
| `VPS_2_HOST`       | secondary VPS IP                                                     |
| `VPS_SSH_USER`     | `shivansh` (or your chosen user)                                     |
| `VPS_SSH_KEY`      | full private key body (incl. `-----BEGIN ... PRIVATE KEY-----` lines) |
| `VPS_SSH_PORT`     | optional, defaults to 22                                             |
| `GITHUB_REPO_URL`  | for documentation only                                               |

The matching public key must be in `~shivansh/.ssh/authorized_keys` on each VPS.

## Deploying updates

From Replit shell:

```bash
bash deploy/deploy.sh
```

This will:

1. `git push` your local branch to GitHub
2. SSH into VPS 1 → `git pull` → `pnpm install` → build → `pm2 reload`
3. Health-check VPS 1 (`/api/health`)
4. Same for VPS 2

If a health check fails the script aborts so the bad VPS doesn't take traffic.

Skip the push step (deploy what's already on `origin/main`) with:

```bash
SKIP_PUSH=1 bash deploy/deploy.sh
```

## Logs

```bash
# On the VPS
pm2 logs shivansh-api
pm2 logs shivansh-worker
pm2 logs shivansh-failover    # secondary only
pm2 monit                      # live dashboard
```

PM2 also writes to `/var/log/shivansh/{api,worker}.{out,err}.log`.

## Failover behaviour

- Primary handles all calls when healthy.
- Secondary's worker boots with `WORKER_ENABLED=false` (standby).
- Failover monitor pings `http://VPS_1:8080/api/health` every 30s.
- After 3 consecutive failures it flips `WORKER_ENABLED=true` on the secondary and PM2-reloads the worker.
- When the primary recovers the secondary worker is demoted back to standby automatically.

## Health endpoint

`GET /api/health` returns:

```json
{
  "status": "ok",
  "uptime": 12345.6,
  "pid": 4711,
  "node": "v20.x.x",
  "timestamp": "2026-04-20T10:00:00.000Z"
}
```

## Rollback

```bash
# On the offending VPS, pin to a known-good commit:
sudo -u shivansh bash -c "cd /opt/shivansh && git fetch && git reset --hard <commit-sha> && pnpm install && pnpm --filter @workspace/api-server run build && pm2 reload deploy/ecosystem.config.cjs"
```

## Notes

- The repo is built with pnpm workspaces — do **not** run `npm install` on the VPS.
- The `worker` script in `@workspace/api-server` must exist; if you haven't split a separate worker entry yet, set `WORKER_ENABLED=true` only on the primary and let the API process handle background tasks.
- Database migrations run automatically on API boot (Drizzle push); coordinate deploys to avoid two VPS racing on the same migration. Recommended: set `RUN_MIGRATIONS=true` only on the primary's env.
