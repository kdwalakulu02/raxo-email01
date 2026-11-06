import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, utimesSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createTestContext, makePdf, makeMultipart } from "./helpers.js";
import { createStorage } from "../src/storage.js";
import { buildApp } from "../src/http.js";
import { Worker } from "../src/worker.js";
import { runCli } from "../src/cli.js";
import { runRetention } from "../src/retention.js";
import type { AppConfig } from "../src/types.js";

describe("R01–R05: Retention and Deletion Integration Tests", () => {
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

  test("R01: Delete queued record -> Tombstone immediate, no new handoff", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("PDF for R01");
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

      const submissionId = JSON.parse(res.body).submission_id;

      // Verify notification is queued
      const notifBefore = (
        await ctx.pool.query("SELECT state FROM notifications WHERE submission_id = $1", [
          submissionId,
        ])
      ).rows[0];
      assert.equal(notifBefore.state, "queued");

      // Delete via CLI with --confirm
      const deleteExit = await runCli(["submissions", "delete", submissionId, "--confirm"], {
        config,
        pool: ctx.pool,
        storage,
      });
      assert.equal(deleteExit, 0);

      // Verify submission is tombstoned and notification is cancelled
      const subAfter = (
        await ctx.pool.query("SELECT deleted_at FROM submissions WHERE id = $1", [submissionId])
      ).rows[0];
      assert.ok(subAfter.deleted_at !== null);

      const notifAfter = (
        await ctx.pool.query("SELECT state FROM notifications WHERE submission_id = $1", [
          submissionId,
        ])
      ).rows[0];
      assert.equal(notifAfter.state, "cancelled");

      // Worker runs: should NOT process cancelled notification
      const worker = new Worker({
        pool: ctx.pool,
        storage,
        smtpConfig: {
          host: config.smtpHost,
          port: config.smtpPort,
          tlsMode: config.smtpTlsMode,
        },
        scannerHost: config.clamdHost,
        scannerPort: config.clamdPort,
      });

      const didProcess = await worker.processOne();
      assert.equal(didProcess, false, "Worker must not hand off a deleted/cancelled notification");

      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("R02: Disk deletion fails once -> cleanup_done=false then true after retry", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("PDF for R02");
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
      const submissionId = JSON.parse(res.body).submission_id;

      // Tombstone submission
      await runCli(["submissions", "delete", submissionId, "--confirm"], {
        config,
        pool: ctx.pool,
        storage,
      });

      // Get attachment key and file path
      const attRow = (
        await ctx.pool.query(
          "SELECT storage_key, original_name FROM attachments WHERE submission_id = $1",
          [submissionId],
        )
      ).rows[0];
      const attPath = join(ctx.storageDir, "quarantine", attRow.storage_key);
      assert.ok(existsSync(attPath), "Attachment file must exist before retention");

      // Inject real EACCES syscall failure by making the quarantine directory read-only (0555)
      const quarantineDir = join(ctx.storageDir, "quarantine");
      chmodSync(quarantineDir, 0o555);

      try {
        // Run retention with REAL storage adapter (no replacement deleter)
        await runRetention(ctx.pool, storage, new Date());
      } finally {
        // Restore permissions
        chmodSync(quarantineDir, 0o700);
      }

      // Verify bytes remain and cleanup_done is false
      assert.ok(existsSync(attPath), "Attachment file must remain after failed deletion");
      const subFail = (
        await ctx.pool.query("SELECT cleanup_done, fields FROM submissions WHERE id = $1", [
          submissionId,
        ])
      ).rows[0];
      assert.equal(subFail.cleanup_done, false);
      assert.ok(subFail.fields !== null);

      const attFail = (
        await ctx.pool.query(
          "SELECT original_name, scan_state FROM attachments WHERE submission_id = $1",
          [submissionId],
        )
      ).rows[0];
      assert.equal(
        attFail.original_name,
        "doc.pdf",
        "Original name must NOT be redacted when deletion fails",
      );

      // Remove the fault and rerun retention
      await runRetention(ctx.pool, storage, new Date());

      // Verify bytes are absent, cleanup_done is true, and original_name/fields are redacted
      assert.equal(existsSync(attPath), false, "Attachment file must be deleted after retry");
      const subSuccess = (
        await ctx.pool.query("SELECT cleanup_done, fields FROM submissions WHERE id = $1", [
          submissionId,
        ])
      ).rows[0];
      assert.equal(subSuccess.cleanup_done, true);
      assert.equal(subSuccess.fields, null);

      const attSuccess = (
        await ctx.pool.query(
          "SELECT original_name, scan_state FROM attachments WHERE submission_id = $1",
          [submissionId],
        )
      ).rows[0];
      assert.equal(attSuccess.original_name, "[redacted]");
      assert.equal(attSuccess.scan_state, "deleted");

      // Repeat retention safely (idempotent run)
      await runRetention(ctx.pool, storage, new Date());

      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("R03: 90-day boundary -> Only expired content removed", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      // Submission A: 91 days ago
      const mpA = makeMultipart({
        full_name: "Alex Old",
        email: "old@example.test",
        position: "Dev",
      });
      const resA = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mpA.contentType, origin: "http://127.0.0.1:3000" },
        payload: mpA.buffer,
      });
      const subIdA = JSON.parse(resA.body).submission_id;

      // Submission B: 89 days ago
      const mpB = makeMultipart({
        full_name: "Alex Recent",
        email: "recent@example.test",
        position: "Dev",
      });
      const resB = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mpB.contentType, origin: "http://127.0.0.1:3000" },
        payload: mpB.buffer,
      });
      const subIdB = JSON.parse(resB.body).submission_id;

      const now = new Date();
      const date91DaysAgo = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
      const date89DaysAgo = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000);

      await ctx.pool.query("UPDATE submissions SET created_at = $1 WHERE id = $2", [
        date91DaysAgo,
        subIdA,
      ]);
      await ctx.pool.query("UPDATE submissions SET created_at = $1 WHERE id = $2", [
        date89DaysAgo,
        subIdB,
      ]);

      // Run retention relative to now
      await runRetention(ctx.pool, storage, now);

      // Submission A (91 days old) must be cleaned
      const checkA = (
        await ctx.pool.query(
          "SELECT deleted_at, cleanup_done, fields FROM submissions WHERE id = $1",
          [subIdA],
        )
      ).rows[0];
      assert.ok(checkA.deleted_at !== null);
      assert.equal(checkA.cleanup_done, true);
      assert.equal(checkA.fields, null);

      // Submission B (89 days old) must remain untouched
      const checkB = (
        await ctx.pool.query(
          "SELECT deleted_at, cleanup_done, fields FROM submissions WHERE id = $1",
          [subIdB],
        )
      ).rows[0];
      assert.equal(checkB.deleted_at, null);
      assert.equal(checkB.cleanup_done, false);
      assert.ok(checkB.fields !== null);

      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("R04: F01 — protect live quarantine files from orphan cleanup", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      // 1. Create real PostgreSQL attachment row + referenced quarantined file
      const pdf = makePdf("Referenced Quarantined File");
      const mp = makeMultipart(
        { full_name: "Alex Example", email: "alex@example.test", position: "Dev" },
        [
          {
            fieldName: "attachments",
            filename: "ref.pdf",
            contentType: "application/pdf",
            content: pdf,
          },
        ],
      );
      const res = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mp.contentType, origin: "http://127.0.0.1:3000" },
        payload: mp.buffer,
      });
      const subId = JSON.parse(res.body).submission_id;
      const attRow = (
        await ctx.pool.query("SELECT storage_key FROM attachments WHERE submission_id = $1", [
          subId,
        ])
      ).rows[0];
      const refQuarantineKey = attRow.storage_key;
      const refQuarantinePath = join(ctx.storageDir, "quarantine", refQuarantineKey);
      assert.ok(existsSync(refQuarantinePath), "Referenced file must exist in quarantine");

      // Age the referenced quarantine file to 25 hours ago
      const refDate = new Date();
      const past25hSec = (refDate.getTime() - 25 * 60 * 60 * 1000) / 1000;
      utimesSync(refQuarantinePath, past25hSec, past25hSec);

      // 2. Create unreferenced quarantined file aged 25 hours
      const unrefOldQuarantineKey = randomUUID();
      const unrefOldQuarantinePath = join(ctx.storageDir, "quarantine", unrefOldQuarantineKey);
      writeFileSync(unrefOldQuarantinePath, "unreferenced quarantine aged 25h");
      utimesSync(unrefOldQuarantinePath, past25hSec, past25hSec);

      // 3. Create fresh unreferenced file in quarantine (< 1 hour old)
      const unrefFreshQuarantineKey = randomUUID();
      const unrefFreshQuarantinePath = join(ctx.storageDir, "quarantine", unrefFreshQuarantineKey);
      writeFileSync(unrefFreshQuarantinePath, "unreferenced fresh in quarantine");

      // 4. Test failed reference query: a database error must NOT become permission to delete quarantine files
      const faultyPool = {
        query: async (queryText: string, params?: any[]) => {
          if (typeof queryText === "string" && queryText.includes("FROM attachments")) {
            throw new Error("Simulated DB connection error during attachments reference query");
          }
          return (ctx.pool as any).query(queryText, params);
        },
      } as any;

      await assert.rejects(
        runRetention(faultyPool, storage, refDate),
        /Simulated DB connection error/,
        "Retention must fail closed on database reference query error",
      );

      // Verify that after failed reference query, NONE of the quarantine files were deleted
      assert.equal(
        existsSync(refQuarantinePath),
        true,
        "Referenced quarantine file must remain after DB error",
      );
      assert.equal(
        existsSync(unrefOldQuarantinePath),
        true,
        "Unreferenced quarantine file must NOT be deleted on DB error",
      );
      assert.equal(
        existsSync(unrefFreshQuarantinePath),
        true,
        "Fresh unreferenced quarantine file must remain",
      );

      // 5. Create aged temporary file in tmp/ (aged 25 hours)
      const oldTmpKey = randomUUID();
      const oldTmpPath = join(ctx.storageDir, "tmp", oldTmpKey);
      writeFileSync(oldTmpPath, "aged temporary staging file in tmp");
      utimesSync(oldTmpPath, past25hSec, past25hSec);

      // 6. Run retention with real pool and referenceDate
      const result = await runRetention(ctx.pool, storage, refDate);

      // Assertions:
      // - Only the old unreferenced quarantine file and old temporary file disappear
      assert.equal(
        existsSync(unrefOldQuarantinePath),
        false,
        "Old unreferenced quarantine file must be swept",
      );
      assert.equal(existsSync(oldTmpPath), false, "Old temporary staging file must be swept");

      // - Referenced 25h quarantine file MUST be kept regardless of state
      assert.equal(
        existsSync(refQuarantinePath),
        true,
        "Referenced 25h quarantine file must be preserved",
      );

      // - Fresh unreferenced quarantine file MUST be kept
      assert.equal(
        existsSync(unrefFreshQuarantinePath),
        true,
        "Fresh unreferenced quarantine file must be preserved",
      );

      assert.equal(
        result.orphansSwept,
        2,
        "Exactly 2 orphan files (old unref quarantine + old tmp) swept",
      );

      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("R05: Repost ID after deletion within 24h -> 410, no new notification", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const clientSubId = randomUUID();
      const mp1 = makeMultipart({
        _submission_id: clientSubId,
        full_name: "Alex Example",
        email: "alex@example.test",
        position: "Dev",
      });

      const res1 = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mp1.contentType, origin: "http://127.0.0.1:3000" },
        payload: mp1.buffer,
      });
      assert.equal(res1.statusCode, 202);
      const subId = JSON.parse(res1.body).submission_id;

      // Tombstone the submission
      await runCli(["submissions", "delete", subId, "--confirm"], {
        config,
        pool: ctx.pool,
        storage,
      });

      // Count notifications before repost
      const countBefore = (await ctx.pool.query("SELECT count(*)::int as c FROM notifications"))
        .rows[0].c;

      // Repost the exact same _submission_id within 24h
      const mp2 = makeMultipart({
        _submission_id: clientSubId,
        full_name: "Alex Example",
        email: "alex@example.test",
        position: "Dev",
      });

      const res2 = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mp2.contentType, origin: "http://127.0.0.1:3000" },
        payload: mp2.buffer,
      });

      // Must return HTTP 410 Gone / idempotency_conflict
      assert.equal(res2.statusCode, 410);

      // Verify no new notification was created
      const countAfter = (await ctx.pool.query("SELECT count(*)::int as c FROM notifications"))
        .rows[0].c;
      assert.equal(countAfter, countBefore);

      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });
});
