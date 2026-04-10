import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function globalErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  logger.error({ err, method: req.method, url: req.url }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
}
