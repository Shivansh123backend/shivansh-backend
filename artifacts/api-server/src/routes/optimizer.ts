/**
 * GET /optimizer/insights — recent call analytics for refining the AI script.
 * GET /optimizer/daily    — daily average score series for charting.
 *
 * Read-only. Admin-protected. Does not modify campaigns or prompts.
 */

import { Router, type IRouter } from "express";
import { authenticate, requireRole } from "../middlewares/auth.js";

const requireAdmin = requireRole("admin");
import { computeInsights, dailyAverageScores } from "../services/optimizer.js";
import { listVariations } from "../services/scriptOptimizer.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.get("/optimizer/insights", authenticate, requireAdmin, async (req, res): Promise<void> => {
  try {
    const windowDays = req.query.windowDays ? parseInt(String(req.query.windowDays), 10) : 7;
    const campaignIdRaw = req.query.campaignId;
    const campaignId = campaignIdRaw ? parseInt(String(campaignIdRaw), 10) : null;

    const insights = await computeInsights({
      windowDays: isNaN(windowDays) ? 7 : windowDays,
      campaignId: campaignId && !isNaN(campaignId) ? campaignId : null,
    });
    res.json(insights);
  } catch (err) {
    logger.error({ err: String(err) }, "Optimizer insights failed");
    res.status(500).json({ error: "Failed to compute insights" });
  }
});

router.get("/optimizer/daily", authenticate, requireAdmin, async (req, res): Promise<void> => {
  try {
    const windowDays = req.query.windowDays ? parseInt(String(req.query.windowDays), 10) : 14;
    const campaignIdRaw = req.query.campaignId;
    const campaignId = campaignIdRaw ? parseInt(String(campaignIdRaw), 10) : null;

    const series = await dailyAverageScores({
      windowDays: isNaN(windowDays) ? 14 : windowDays,
      campaignId: campaignId && !isNaN(campaignId) ? campaignId : null,
    });
    res.json(series);
  } catch (err) {
    logger.error({ err: String(err) }, "Optimizer daily failed");
    res.status(500).json({ error: "Failed to compute daily series" });
  }
});

router.get("/optimizer/variations/:campaignId", authenticate, requireAdmin, async (req, res): Promise<void> => {
  try {
    const campaignId = parseInt(String(req.params.campaignId), 10);
    if (isNaN(campaignId)) { res.status(400).json({ error: "Invalid campaignId" }); return; }
    const rows = await listVariations(campaignId);
    res.json(rows.map((r) => ({
      id: r.id,
      slot: r.slot,
      text: r.text,
      isOriginal: r.isOriginal,
      uses: r.uses,
      avgScore: r.uses > 0 ? Math.round((r.totalScore / r.uses) * 10) / 10 : null,
      promotedAt: r.promotedAt,
      createdAt: r.createdAt,
    })));
  } catch (err) {
    logger.error({ err: String(err) }, "List variations failed");
    res.status(500).json({ error: "Failed to list variations" });
  }
});

export default router;
