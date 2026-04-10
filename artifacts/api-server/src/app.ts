import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// All REST API routes
app.use("/api", router);

// In production, serve the built React dashboard as static files
// and fall back to index.html for client-side routing (SPA)
if (process.env.NODE_ENV === "production") {
  const dashboardDist = path.join(process.cwd(), "artifacts/dashboard/dist/public");

  app.use(express.static(dashboardDist));

  // SPA catch-all — any non-API route returns index.html
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
}

export default app;
