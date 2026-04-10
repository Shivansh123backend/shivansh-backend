import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import usersRouter from "./users.js";
import agentsRouter from "./agents.js";
import voicesRouter from "./voices.js";
import campaignsRouter from "./campaigns.js";
import numbersRouter from "./numbers.js";
import leadsRouter from "./leads.js";
import callsRouter from "./calls.js";
import agentStatusRouter from "./agentStatus.js";
import manualCallRouter from "./manualCall.js";
import callLogsRouter from "./callLogs.js";
import { globalErrorHandler } from "../lib/errors.js";
import type { Request, Response, NextFunction } from "express";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(agentsRouter);
router.use(voicesRouter);
router.use(campaignsRouter);
router.use(numbersRouter);
router.use(leadsRouter);
router.use(callsRouter);
router.use(agentStatusRouter);
router.use(manualCallRouter);
router.use(callLogsRouter);

router.use((err: Error, req: Request, res: Response, next: NextFunction) => globalErrorHandler(err, req, res, next));

export default router;
