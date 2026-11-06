import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createPool, withTransaction } from "./db.js";
import { AppError } from "./errors.js";

const MIGRATION_LOCK_KEY = 726900;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export function computeSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function runMigrations(
  pool: Pool,
  migrationsDir = resolve(process.cwd(), "migrations"),
): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    // Acquire session advisory lock
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    // Bootstrap schema_migrations table idempotently
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Read applied migrations
    const { rows: appliedRows } = await client.query<{ version: string; sha256: string }>(
      "SELECT version, sha256 FROM schema_migrations ORDER BY version ASC",
    );
    const appliedMap = new Map<string, string>();
    for (const row of appliedRows) {
      appliedMap.set(row.version, row.sha256);
    }

    // Read migration files
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const filePath = join(migrationsDir, file);
      const sql = readFileSync(filePath, "utf-8");
      const sha256 = computeSha256(sql);
      const version = file.replace(/\.sql$/, "");

      if (appliedMap.has(version)) {
        const recordedSha = appliedMap.get(version);
        if (recordedSha !== sha256) {
          throw new AppError(
            "bad_request",
            500,
            `Migration ${version} checksum mismatch! Recorded: ${recordedSha}, current: ${sha256}. Refusing to run with modified applied migration.`,
          );
        }
        skipped.push(version);
      } else {
        // Apply migration in a transaction
        await withTransaction(client, async (tx: PoolClient) => {
          await tx.query(sql);
          await tx.query("INSERT INTO schema_migrations (version, sha256) VALUES ($1, $2)", [
            version,
            sha256,
          ]);
        });
        applied.push(version);
      }
    }

    return { applied, skipped };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } catch {
      // ignore unlock error on disconnect
    }
    client.release();
  }
}

// CLI entry point
if (process.argv[1]?.endsWith("migrate.ts") || process.argv[1]?.endsWith("migrate.js")) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const pool = createPool(dbUrl);
  try {
    const res = await runMigrations(pool);
    console.log(
      `Migrations complete. Applied: ${res.applied.join(", ") || "none"}. Skipped: ${res.skipped.join(", ") || "none"}`,
    );
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    await pool.end();
    process.exit(1);
  }
}
