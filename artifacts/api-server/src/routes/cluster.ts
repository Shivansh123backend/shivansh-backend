// Admin-only cluster status endpoint.
// Reads the LB monitor's state file (written by deploy/lb/health-monitor.sh)
// and reports the dispatch limiter's current state. Read-only.

import { Router, type IRouter } from "express";
import { readFile } from "node:fs/promises";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { dispatchLimiterStatus } from "../lib/dispatchLimiter.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const LB_STATUS_FILE = process.env.LB_STATUS_FILE ?? "/var/lib/shivansh-lb/status.json";

interface NodeStatus {
  id: string;
  status: "up" | "down";
  fail_count: number;
  ok_count: number;
}

interface LbStatus {
  updated_at: string;
  nodes: NodeStatus[];
}

router.get(
  "/admin/cluster/status",
  authenticate,
  requireRole("admin"),
  async (_req, res): Promise<void> => {
    let lb: LbStatus | { error: string } = { error: "lb-monitor not running on this host" };
    try {
      const raw = await readFile(LB_STATUS_FILE, "utf8");
      lb = JSON.parse(raw) as LbStatus;
    } catch (err) {
      logger.debug({ err: String(err) }, "cluster/status: LB status file unavailable");
    }

    res.json({
      lb,
      dispatch_limiter: dispatchLimiterStatus(),
      this_host: {
        pid: process.pid,
        node: process.version,
        uptime_sec: Math.floor(process.uptime()),
        mem_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    });
  }
);

export default router;
