import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { allowedOrigins } from "./lib/deployment";
import { authMiddleware } from "./middlewares/authMiddleware";
import { csrfOriginGuard } from "./middlewares/csrf";

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
// Trust the first proxy hop so req.secure reflects the client-facing
// protocol behind TLS-terminating proxies (Replit, nginx, Cloudflare).
app.set("trust proxy", 1);

// Credentialed CORS is restricted to the configured frontend origin
// (split-origin deployments). In same-origin mode no origin is allowed —
// cross-origin browser calls are blocked, same-origin calls don't need CORS.
const allowed = allowedOrigins();
app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      callback(null, !origin || allowed.includes(origin));
    },
  }),
);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(csrfOriginGuard);
app.use(authMiddleware);

app.use("/api", router);

export default app;
