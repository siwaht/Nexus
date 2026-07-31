import { initVectorStore } from "@workspace/db";

import app from "./app";
import { logger } from "./lib/logger";
import { mediaToolsAvailable } from "./lib/ingest";
import { browserCapabilities } from "./lib/browser";
import { stdioAvailable } from "./lib/mcp";
import { initStorage } from "./lib/storage";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Probe the optional capabilities once at boot and log what's actually
 * available, so a missing pgvector extension or absent ffmpeg shows up in the
 * logs rather than as a confusing runtime error later.
 */
async function bootstrap(): Promise<void> {
  await initStorage();

  const [vectorDriver, media] = await Promise.all([
    initVectorStore(),
    mediaToolsAvailable(),
  ]);
  const browser = browserCapabilities();

  logger.info(
    {
      vectorDriver,
      ffmpeg: media.ffmpeg,
      browserDriver: browser.driver,
      browserControl: browser.canControl,
      mcpStdio: stdioAvailable(),
    },
    "Capabilities resolved",
  );

  if (vectorDriver === "json") {
    logger.warn(
      "pgvector is unavailable — embeddings are stored as JSON and similarity runs in-process. Fine for a few thousand chunks; install the pgvector extension for larger libraries.",
    );
  }
  if (!media.ffmpeg) {
    logger.warn(
      "ffmpeg not found — video ingestion and long-audio chunking are disabled. Install ffmpeg or set FFMPEG_PATH.",
    );
  }
}

bootstrap()
  .catch((err) => {
    // A failed probe must not stop the server: every dependent feature already
    // degrades with a clear message of its own.
    logger.error({ err }, "Capability bootstrap failed");
  })
  .finally(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");
    });
  });
