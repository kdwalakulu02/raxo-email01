import { resolve, isAbsolute } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { loadConfig } from "./config.js";
import { createPool, withTransaction } from "./db.js";
import { createStorage } from "./storage.js";
import { scanStoredPdf } from "./scanner.js";
import { runRetention } from "./retention.js";
import { Repository } from "./repository.js";
import type { AppConfig, Attachment, FormConfig } from "./types.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CliContext {
  config: AppConfig;
  pool: Pool;
  storage: ReturnType<typeof createStorage>;
}

export async function runCli(args: string[], ctxOverride?: Partial<CliContext>): Promise<number> {
  // args are the positional/flag arguments after "cli", e.g. ["forms", "validate"] or ["submissions", "list", ...]
  if (args.length === 0) {
    console.error("Error: No command specified.");
    return 2;
  }

  const primary = args[0];
  const secondary = args[1];

  // 1. forms validate
  if (primary === "forms" && secondary === "validate") {
    try {
      const config = ctxOverride?.config ?? (await loadConfig());
      console.log(
        JSON.stringify({
          status: "ok",
          forms_config_path: config.formsConfigPath,
          form_count: config.forms.size,
          forms: Array.from(config.forms.keys()),
        }),
      );
      return 0;
    } catch (err) {
      console.error("Configuration validation error:", err);
      return 2;
    }
  }

  // For other commands, we need DB and storage
  let config: AppConfig;
  let pool: Pool;
  let storage: ReturnType<typeof createStorage>;

  try {
    config = ctxOverride?.config ?? (await loadConfig());
    storage = ctxOverride?.storage ?? createStorage(config.storageDir);
    pool = ctxOverride?.pool ?? createPool(config.databaseUrl);
  } catch (err) {
    console.error("Failed to initialize configuration or storage:", err);
    return 4;
  }

  try {
    // Test database connection
    await pool.query("SELECT 1;");
  } catch (err) {
    console.error("Database connection failure:", err);
    return 4;
  }

  try {
    // 2. submissions list --form <form-id> [--limit <n>] [--json]
    if (primary === "submissions" && secondary === "list") {
      let formId: string | null = null;
      let limit = 20;

      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--form" && args[i + 1]) {
          formId = args[++i];
        } else if (args[i] === "--limit" && args[i + 1]) {
          const parsed = parseInt(args[++i], 10);
          if (isNaN(parsed) || parsed < 1 || parsed > 100) {
            console.error("Error: --limit must be an integer between 1 and 100.");
            return 2;
          }
          limit = parsed;
        } else if (args[i] === "--json") {
          // accepted flag
        } else {
          console.error(`Error: Unrecognized option '${args[i]}'`);
          return 2;
        }
      }

      if (!formId) {
        console.error("Error: --form <form-id> is required.");
        return 2;
      }

      const res = await pool.query(
        `SELECT s.id, s.form_id, s.client_submission_id, s.fingerprint, s.created_at,
                count(a.id)::int as attachment_count,
                n.state as notification_state
         FROM submissions s
         LEFT JOIN attachments a ON a.submission_id = s.id
         LEFT JOIN notifications n ON n.submission_id = s.id
         WHERE s.form_id = $1 AND s.deleted_at IS NULL
         GROUP BY s.id, n.state
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT $2`,
        [formId, limit],
      );

      console.log(JSON.stringify(res.rows, null, 2));
      return 0;
    }

    // 3. submissions show <uuid> [--json]
    if (primary === "submissions" && secondary === "show") {
      const uuid = args[2];
      if (!uuid || !UUID_REGEX.test(uuid)) {
        console.error("Error: Valid submission UUID is required.");
        return 2;
      }

      const subRes = await pool.query(
        `SELECT id, form_id, client_submission_id, fingerprint, fields, created_at, deleted_at
         FROM submissions
         WHERE id = $1`,
        [uuid],
      );

      if (subRes.rows.length === 0 || subRes.rows[0].deleted_at !== null) {
        console.error(`Error: Submission ${uuid} not found or has been deleted.`);
        return 3;
      }

      const sub = subRes.rows[0];

      const attRes = await pool.query(
        `SELECT id, original_name, size_bytes, sha256, scan_state, scanned_at, created_at
         FROM attachments
         WHERE submission_id = $1
         ORDER BY created_at ASC`,
        [uuid],
      );

      const notifRes = await pool.query(
        `SELECT id, state, attempt_count, next_attempt_at, last_error_code, smtp_receipt, created_at, updated_at
         FROM notifications
         WHERE submission_id = $1`,
        [uuid],
      );

      const output = {
        submission: {
          id: sub.id,
          form_id: sub.form_id,
          client_submission_id: sub.client_submission_id,
          fingerprint: sub.fingerprint,
          fields: sub.fields,
          created_at: sub.created_at,
        },
        attachments: attRes.rows,
        notification: notifRes.rows[0] ?? null,
      };

      console.log(JSON.stringify(output, null, 2));
      return 0;
    }

    // 4. attachments export <uuid> --out <path>
    if (primary === "attachments" && secondary === "export") {
      const uuid = args[2];
      if (!uuid || !UUID_REGEX.test(uuid)) {
        console.error("Error: Valid attachment UUID is required.");
        return 2;
      }

      let outPath: string | null = null;
      for (let i = 3; i < args.length; i++) {
        if (args[i] === "--out" && args[i + 1]) {
          outPath = args[++i];
        } else {
          console.error(`Error: Unrecognized option '${args[i]}'`);
          return 2;
        }
      }

      if (!outPath) {
        console.error("Error: --out <path> is required.");
        return 2;
      }

      const resolvedOut = resolve(process.cwd(), outPath);
      const resolvedStorage = resolve(process.cwd(), config.storageDir);

      // Output path cannot be inside STORAGE_DIR
      if (resolvedOut === resolvedStorage || resolvedOut.startsWith(resolvedStorage + "/")) {
        console.error("Error: Output path cannot be located inside STORAGE_DIR.");
        return 2;
      }

      // Output file must not already exist (no overwrite)
      if (existsSync(resolvedOut)) {
        console.error(`Error: Output file already exists: ${resolvedOut}`);
        return 2;
      }

      const attRes = await pool.query<Attachment & { deleted_at: Date | null }>(
        `SELECT a.*, s.deleted_at
         FROM attachments a
         JOIN submissions s ON s.id = a.submission_id
         WHERE a.id = $1`,
        [uuid],
      );

      if (attRes.rows.length === 0 || attRes.rows[0].deleted_at !== null) {
        console.error(`Error: Attachment ${uuid} not found or parent submission was deleted.`);
        return 3;
      }

      const att = attRes.rows[0];

      if (att.scan_state === "blocked") {
        console.error("Error: Attachment is blocked by scanner and cannot be exported.");
        return 3;
      }

      if (att.scan_state === "deleted") {
        console.error("Error: Attachment has been deleted.");
        return 3;
      }

      // Check if scan is stale (> 48h) or not clean yet
      const isCleanFresh =
        att.scan_state === "clean" &&
        att.scanned_at &&
        Date.now() - new Date(att.scanned_at).getTime() <= 48 * 60 * 60 * 1000;

      if (!isCleanFresh) {
        let scanResult;
        try {
          scanResult = await scanStoredPdf(att.storage_key, storage, {
            host: config.clamdHost,
            port: config.clamdPort,
          });
        } catch (err) {
          console.error("Dependency failure: Scanner unreachable:", err);
          return 4;
        }

        if (scanResult.kind === "error") {
          console.error("Dependency failure: Scanner error:", scanResult.reason);
          return 4;
        }

        if (scanResult.kind === "blocked") {
          await new Repository(pool).updateAttachmentScan(pool, att.id, "blocked");
          console.error(`Error: Attachment scan blocked: ${scanResult.reason}`);
          return 3;
        }

        storage.moveToClean(att.storage_key);
        await new Repository(pool).updateAttachmentScan(pool, att.id, "clean", scanResult.version);
      }

      // Read file and verify checksum
      let content: Buffer;
      try {
        content = storage.read(att.storage_key, "clean");
      } catch (err) {
        console.error("Error reading file from storage:", err);
        return 3;
      }

      const digest = createHash("sha256").update(content).digest("hex");
      if (digest !== att.sha256) {
        console.error("Error: Stored file SHA-256 checksum mismatch.");
        return 3;
      }

      // Write file exclusively with mode 0600
      try {
        writeFileSync(resolvedOut, content, { flag: "wx", mode: 0o600 });
        console.log(
          JSON.stringify({
            status: "exported",
            attachment_id: att.id,
            out: resolvedOut,
            size_bytes: content.length,
            sha256: digest,
          }),
        );
        return 0;
      } catch (err) {
        console.error("Failed to write output file:", err);
        return 2;
      }
    }

    // 5. submissions delete <uuid> --confirm
    if (primary === "submissions" && secondary === "delete") {
      const uuid = args[2];
      if (!uuid || !UUID_REGEX.test(uuid)) {
        console.error("Error: Valid submission UUID is required.");
        return 2;
      }

      const hasConfirm = args.includes("--confirm");
      if (!hasConfirm) {
        console.error("Error: --confirm flag is required to delete submission.");
        return 2;
      }

      const deleteResult = await withTransaction(pool, async (client) => {
        // F07: Lock notification first (if exists)
        const notifRes = await client.query<{ id: string; state: string }>(
          `SELECT id, state FROM notifications WHERE submission_id = $1 FOR UPDATE`,
          [uuid],
        );

        // F07: Lock submission second
        const subRes = await client.query<{ id: string; deleted_at: Date | null }>(
          `SELECT id, deleted_at FROM submissions WHERE id = $1 FOR UPDATE`,
          [uuid],
        );

        if (subRes.rows.length === 0) {
          return { notFound: true };
        }

        if (subRes.rows[0].deleted_at === null) {
          await client.query(`UPDATE submissions SET deleted_at = now() WHERE id = $1`, [uuid]);
        }

        if (notifRes.rows.length > 0) {
          const state = notifRes.rows[0].state;
          if (["queued", "retry_wait", "preparing"].includes(state)) {
            await client.query(
              `UPDATE notifications SET state = 'cancelled', updated_at = now() WHERE id = $1`,
              [notifRes.rows[0].id],
            );
          }
        }

        return { notFound: false };
      });

      if (deleteResult.notFound) {
        console.error(`Error: Submission ${uuid} not found.`);
        return 3;
      }

      console.log(
        JSON.stringify({
          status: "tombstoned",
          submission_id: uuid,
        }),
      );
      return 0;
    }

    // 6. retention run [--now <ISO-UTC>]
    if (primary === "retention" && secondary === "run") {
      let refDate = new Date();
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--now" && args[i + 1]) {
          const raw = args[++i];
          const parsed = new Date(raw);
          if (isNaN(parsed.getTime())) {
            console.error("Error: Invalid ISO-UTC timestamp for --now.");
            return 2;
          }
          refDate = parsed;
        } else {
          console.error(`Error: Unrecognized option '${args[i]}'`);
          return 2;
        }
      }

      const result = await runRetention(pool, storage, refDate);
      console.log(JSON.stringify({ status: "completed", ...result }));
      return 0;
    }

    // 7. notifications show <uuid> [--json]
    if (primary === "notifications" && secondary === "show") {
      const uuid = args[2];
      if (!uuid || !UUID_REGEX.test(uuid)) {
        console.error("Error: Valid notification UUID is required.");
        return 2;
      }

      const notifRes = await pool.query(
        `SELECT n.*, s.form_id
         FROM notifications n
         JOIN submissions s ON s.id = n.submission_id
         WHERE n.id = $1`,
        [uuid],
      );

      if (notifRes.rows.length === 0) {
        console.error(`Error: Notification ${uuid} not found.`);
        return 3;
      }

      const attemptsRes = await pool.query(
        `SELECT id, attempt_number, outcome, error_code, receipt, started_at, finished_at
         FROM send_attempts
         WHERE notification_id = $1
         ORDER BY attempt_number ASC`,
        [uuid],
      );

      console.log(
        JSON.stringify(
          {
            notification: notifRes.rows[0],
            attempts: attemptsRes.rows,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    console.error(`Error: Unknown command '${primary} ${secondary || ""}'`);
    return 2;
  } catch (err) {
    console.error("Internal command error:", err);
    return 4;
  }
}

if (process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  const cliArgs = process.argv.slice(2);
  runCli(cliArgs)
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error("Fatal CLI error:", err);
      process.exit(4);
    });
}
