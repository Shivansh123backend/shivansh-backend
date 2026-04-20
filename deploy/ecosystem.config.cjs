// PM2 process manifest for SHIVANSH on each Hostinger VPS.
// Deploy with: pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
//
// Reads from a `.env` file in the same directory (loaded by dotenv via cwd).
// Each VPS gets its own VPS_ROLE = "primary" | "secondary" so the worker
// knows whether to act as primary call processor or overflow / backup.

const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");

module.exports = {
  apps: [
    {
      name: "shivansh-api",
      cwd: ROOT,
      script: "pnpm",
      args: "--filter @workspace/api-server run start",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "1G",
      autorestart: true,
      watch: false,
      env_file: path.join(__dirname, ".env"),
      env: {
        NODE_ENV: "production",
      },
      out_file: "/var/log/shivansh/api.out.log",
      error_file: "/var/log/shivansh/api.err.log",
      time: true,
      kill_timeout: 8000,
    },
    {
      name: "shivansh-worker",
      cwd: ROOT,
      // Worker is the long-running call processor. It pulls jobs from the
      // queue (Redis) when WORKER_ENABLED=true. On the secondary VPS it can
      // be started in standby mode and auto-promoted by the failover monitor.
      script: "pnpm",
      args: "--filter @workspace/api-server run worker",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "1G",
      autorestart: true,
      watch: false,
      env_file: path.join(__dirname, ".env"),
      env: {
        NODE_ENV: "production",
        WORKER_ENABLED: "true",
      },
      out_file: "/var/log/shivansh/worker.out.log",
      error_file: "/var/log/shivansh/worker.err.log",
      time: true,
      kill_timeout: 15000,
    },
  ],
};
