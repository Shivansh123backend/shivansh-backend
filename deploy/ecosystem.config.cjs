// PM2 process manifest for SHIVANSH on each Hostinger VPS.
// Deploy with: pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
//
// Reads from a `.env` file in the same directory and merges into env at
// config-load time. PM2's native `env_file` option is unreliable across
// versions, so we parse the file manually.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(__dirname, ".env");

function loadEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = loadEnvFile(ENV_FILE);

// Role-gated apps. VPS_ROLE comes from .env on each box: "primary" or "secondary".
// Only the secondary VPS runs the failover monitor (it has no work to do on primary).
const VPS_ROLE = (fileEnv.VPS_ROLE || process.env.VPS_ROLE || "primary").toLowerCase();
const isSecondary = VPS_ROLE === "secondary";

const apps = [
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
      env: {
        ...fileEnv,
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
      script: "pnpm",
      args: "--filter @workspace/api-server run worker",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "1G",
      autorestart: true,
      watch: false,
      env: {
        ...fileEnv,
        NODE_ENV: "production",
        WORKER_ENABLED: "true",
      },
      out_file: "/var/log/shivansh/worker.out.log",
      error_file: "/var/log/shivansh/worker.err.log",
      time: true,
      kill_timeout: 15000,
    },
];

if (isSecondary) {
  apps.push({
    name: "shivansh-failover",
    cwd: __dirname,
    script: "bash",
    args: "failover-monitor.sh",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    env: {
      ...fileEnv,
    },
    out_file: "/var/log/shivansh/failover.out.log",
    error_file: "/var/log/shivansh/failover.err.log",
    time: true,
  });
}

module.exports = { apps };
