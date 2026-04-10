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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// All REST API routes
app.use("/api", router);

if (process.env.NODE_ENV === "production") {
  // Production: serve the compiled React dashboard as static files
  // with index.html fallback for client-side routing (SPA)
  const dashboardDist = path.join(process.cwd(), "artifacts/dashboard/dist/public");
  app.use(express.static(dashboardDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
} else {
  // Development: proxy all non-API requests to the Vite dev server
  // so any route (e.g. /settings, /campaigns) that reaches Express
  // is transparently forwarded to the React SPA.
  const VITE_PORT = process.env.VITE_PORT ?? "23183";
  app.use(
    createProxyMiddleware({
      target: `http://localhost:${VITE_PORT}`,
      changeOrigin: false,
      ws: true,
      logger: console,
    })
  );
}

export default app;
