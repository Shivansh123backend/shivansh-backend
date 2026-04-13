import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import pinoHttp from "pino-http";
import { createProxyMiddleware } from "http-proxy-middleware";
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
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// All REST API routes
app.use("/api", router);

if (process.env.NODE_ENV === "production") {
  // Production: serve the compiled React dashboard as static files
  // with index.html fallback for client-side routing (SPA).
  // Use DASHBOARD_DIST env if set, otherwise resolve relative to workspace root.
  const dashboardDist =
    process.env.DASHBOARD_DIST ||
    path.join(process.cwd(), "artifacts/dashboard/dist/public");

  logger.info({ dashboardDist }, "Serving dashboard static files");

  app.use(express.static(dashboardDist));
  app.get("/{*path}", (_req, res) => {
    const indexFile = path.join(dashboardDist, "index.html");
    res.sendFile(indexFile, (err) => {
      if (err) {
        logger.error({ err, indexFile }, "Failed to send index.html");
        res.status(500).json({ error: "Dashboard not built", indexFile });
      }
    });
  });
} else {
  // Development: proxy all non-API requests to the Vite dev server
  // so any route (e.g. /settings, /campaigns) that reaches Express
  // is transparently forwarded to the React SPA.
  // NOTE: /ws/eleven/* is excluded — those are raw Telnyx media forks handled in index.ts.
  const VITE_PORT = process.env.VITE_PORT ?? "23183";
  app.use(
    createProxyMiddleware({
      target: `http://localhost:${VITE_PORT}`,
      changeOrigin: false,
      ws: false,           // WebSocket upgrades handled manually in index.ts (not via this proxy)
      pathFilter: (path) => !path.startsWith("/ws/eleven/"),
      logger: console,
    })
  );
}

export default app;
