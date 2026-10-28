import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createStorage } from "./storage.js";
import { buildApp } from "./http.js";

async function main() {
  const config = await loadConfig();
  const pool = createPool(config.databaseUrl);
  const storage = createStorage(config.storageDir);

  const app = buildApp({ config, pool, storage });

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`Received ${signal}. Shutting down HTTP server gracefully...`);
    try {
      await app.close();
      await pool.end();
      console.log("HTTP server shutdown complete.");
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ host: config.host, port: config.port });
    console.log(
      `Raxo Email Forms Core HTTP server listening on http://${config.host}:${config.port}`,
    );
  } catch (err) {
    console.error("Failed to start server:", err);
    await pool.end();
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
