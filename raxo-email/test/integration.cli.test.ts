import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
const { Pool } = pg;
import { createTestContext, makePdf, makeEicarPdf, makeMultipart } from "./helpers.js";
import { createStorage } from "../src/storage.js";
import { buildApp } from "../src/http.js";
import { runCli } from "../src/cli.js";
import type { AppConfig } from "../src/types.js";

describe("C01–C04: Operator CLI Integration Tests", () => {
  function getTestConfig(ctx: any, overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      nodeEnv: "development",
      host: "127.0.0.1",
      port: 3000,
      databaseUrl: ctx.dbTestUrl,
      dbTestUrl: ctx.dbTestUrl,
      formsConfigPath: "config/forms.example.json",
      storageDir: ctx.storageDir,
      smtpHost: "127.0.0.1",
      smtpPort: 1025,
      smtpTlsMode: "plain_local",
      smtpMaxMessageBytes: 20971520,
      messageIdDomain: "notifications.example.test",
      clamdHost: "127.0.0.1",
      clamdPort: 3310,
      demoMode: true,
      ipHashSecret: "test_hash_secret",
      outboundEnabled: true,
      trustedProxyCidrs: [],
      forms: ctx.forms,
      ...overrides,
    };
  }

  test("C01: list/show/export valid record with exact checksum match", async () => {
    const ctx = await createTestContext();
    const tempDir = mkdtempSync(join(tmpdir(), "raxo_cli_test_"));

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Valid PDF for C01");
      const originalSha256 = createHash("sha256").update(pdf).digest("hex");

      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
          portfolio: "https://example.test/alex",
          message: "Synthetic application",
        },
        [
          {
            fieldName: "attachments",
            filename: "resume.pdf",
            contentType: "application/pdf",
            content: pdf,
          },
        ],
      );

      const res = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": mp.contentType,
          origin: "http://127.0.0.1:3000",
        },
        payload: mp.buffer,
      });

      assert.equal(res.statusCode, 202);
      const submissionId = JSON.parse(res.body).submission_id;

      // 1. submissions list
      const listCode = await runCli(
        ["submissions", "list", "--form", "job-application", "--limit", "10", "--json"],
        {
          config,
          pool: ctx.pool,
          storage,
        },
      );
      assert.equal(listCode, 0);

      // 2. submissions show
      const showCode = await runCli(["submissions", "show", submissionId, "--json"], {
        config,
        pool: ctx.pool,
        storage,
      });
      assert.equal(showCode, 0);

      // Get attachment ID
      const attRes = await ctx.pool.query("SELECT id FROM attachments WHERE submission_id = $1", [
        submissionId,
      ]);
      assert.equal(attRes.rows.length, 1);
      const attachmentId = attRes.rows[0].id;

      // 3. attachments export
      const exportPath = join(tempDir, "exported_resume.pdf");
      const exportCode = await runCli(
        ["attachments", "export", attachmentId, "--out", exportPath],
        {
          config,
          pool: ctx.pool,
          storage,
        },
      );
      assert.equal(exportCode, 0);

      // Verify file exists and checksum matches
      assert.ok(existsSync(exportPath));
      const exportedContent = readFileSync(exportPath);
      const exportedSha256 = createHash("sha256").update(exportedContent).digest("hex");
      assert.equal(exportedSha256, originalSha256);

      // Check file permissions (mode 0600 -> 0o100600 on POSIX)
      const stats = statSync(exportPath);
      assert.equal(stats.mode & 0o777, 0o600);

      await app.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      await ctx.cleanup();
    }
  });

  test("C02: Export blocked or missing file fails with nonzero exit", async () => {
    const ctx = await createTestContext();
    const tempDir = mkdtempSync(join(tmpdir(), "raxo_cli_test_"));

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      // Create submission with EICAR PDF
      const eicarPdf = makeEicarPdf();
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
        },
        [
          {
            fieldName: "attachments",
            filename: "eicar.pdf",
            contentType: "application/pdf",
            content: eicarPdf,
          },
        ],
      );

      const res = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": mp.contentType,
          origin: "http://127.0.0.1:3000",
        },
        payload: mp.buffer,
      });

      const submissionId = JSON.parse(res.body).submission_id;
      const attId = (
        await ctx.pool.query("SELECT id FROM attachments WHERE submission_id = $1", [submissionId])
      ).rows[0].id;

      // Attempt export of un-scanned (stale/new) EICAR file: export will trigger scan, detect malware, and fail
      const outPath = join(tempDir, "eicar_out.pdf");
      const exportBlockedCode = await runCli(["attachments", "export", attId, "--out", outPath], {
        config,
        pool: ctx.pool,
        storage,
      });

      // Must exit 3 (blocked object) and NO file should be created
      assert.equal(exportBlockedCode, 3);
      assert.equal(existsSync(outPath), false);

      // Attempt export of nonexistent attachment UUID
      const nonExistentId = "00000000-0000-0000-0000-000000000000";
      const missingCode = await runCli(
        ["attachments", "export", nonExistentId, "--out", join(tempDir, "missing.pdf")],
        {
          config,
          pool: ctx.pool,
          storage,
        },
      );
      assert.equal(missingCode, 3);

      await app.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      await ctx.cleanup();
    }
  });

  test("C03: Export to existing output or storage dir is rejected", async () => {
    const ctx = await createTestContext();
    const tempDir = mkdtempSync(join(tmpdir(), "raxo_cli_test_"));

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("PDF for C03");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
        },
        [
          {
            fieldName: "attachments",
            filename: "doc.pdf",
            contentType: "application/pdf",
            content: pdf,
          },
        ],
      );

      const res = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": mp.contentType,
          origin: "http://127.0.0.1:3000",
        },
        payload: mp.buffer,
      });
      const subId = JSON.parse(res.body).submission_id;
      const attId = (
        await ctx.pool.query("SELECT id FROM attachments WHERE submission_id = $1", [subId])
      ).rows[0].id;

      // 1. Existing file
      const existingFile = join(tempDir, "already_exists.pdf");
      writeFileSync(existingFile, "original content");

      const codeExisting = await runCli(["attachments", "export", attId, "--out", existingFile], {
        config,
        pool: ctx.pool,
        storage,
      });
      assert.equal(codeExisting, 2);
      assert.equal(readFileSync(existingFile, "utf8"), "original content"); // unmodified

      // 2. Storage dir output attempt
      const storageFile = join(ctx.storageDir, "clean", "escaped.pdf");
      const codeStorage = await runCli(["attachments", "export", attId, "--out", storageFile], {
        config,
        pool: ctx.pool,
        storage,
      });
      assert.equal(codeStorage, 2);
      assert.equal(existsSync(storageFile), false);

      await app.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      await ctx.cleanup();
    }
  });

  test("C04: Bad args, missing ID, and offline DB yield exit codes 2, 3, 4 respectively", async () => {
    const ctx = await createTestContext();

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);

      // 1. Bad args -> exit 2
      const badCmd = await runCli(["nonexistent", "command"], { config, pool: ctx.pool, storage });
      assert.equal(badCmd, 2);

      const missingForm = await runCli(["submissions", "list"], {
        config,
        pool: ctx.pool,
        storage,
      });
      assert.equal(missingForm, 2);

      const badLimit = await runCli(
        ["submissions", "list", "--form", "job-application", "--limit", "999"],
        {
          config,
          pool: ctx.pool,
          storage,
        },
      );
      assert.equal(badLimit, 2);

      const badUuid = await runCli(["submissions", "show", "not-a-uuid"], {
        config,
        pool: ctx.pool,
        storage,
      });
      assert.equal(badUuid, 2);

      const missingConfirm = await runCli(
        ["submissions", "delete", "00000000-0000-0000-0000-000000000000"],
        {
          config,
          pool: ctx.pool,
          storage,
        },
      );
      assert.equal(missingConfirm, 2);

      // 2. Missing ID -> exit 3
      const missingSub = await runCli(
        ["submissions", "show", "00000000-0000-0000-0000-000000000000"],
        {
          config,
          pool: ctx.pool,
          storage,
        },
      );
      assert.equal(missingSub, 3);

      const missingNotif = await runCli(
        ["notifications", "show", "00000000-0000-0000-0000-000000000000"],
        {
          config,
          pool: ctx.pool,
          storage,
        },
      );
      assert.equal(missingNotif, 3);

      // 3. Offline DB -> exit 4
      const offlinePool = new Pool({
        connectionString: "postgres://raxo_demo:local_demo_only@127.0.0.1:54321/raxo_email_test",
        connectionTimeoutMillis: 500,
      });

      const offlineCode = await runCli(["submissions", "list", "--form", "job-application"], {
        config,
        pool: offlinePool,
        storage,
      });
      assert.equal(offlineCode, 4);

      await offlinePool.end();
    } finally {
      await ctx.cleanup();
    }
  });
});
