import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTestContext, makePdf, makeMultipart } from "./helpers.js";
import { createStorage } from "../src/storage.js";
import { buildApp } from "../src/http.js";
import { Worker } from "../src/worker.js";
import { runRetention } from "../src/retention.js";
import { createDynamicForm, getDynamicFormByPublicId } from "../src/forms.js";
import type { AppConfig } from "../src/types.js";

describe("Phase 1: Dynamic Forms Integration Tests", { concurrency: 1 }, () => {
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
      ipHashSecret: "test_dynamic_hash_secret",
      outboundEnabled: true,
      trustedProxyCidrs: [],
      forms: ctx.forms,
      ...overrides,
    };
  }

  async function createAcquiredWorker(
    options: ConstructorParameters<typeof Worker>[0],
  ): Promise<Worker> {
    const worker = new Worker(options);
    const acquired = await worker.acquireLock();
    assert.equal(acquired, true, "Worker failed to acquire advisory lock in test helper");
    return worker;
  }

  test("D01: Form Registration Flow - Generates 192-bit ID, stores recipient privately, and sends activation email", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const res = await app.inject({
        method: "POST",
        url: "/api/forms",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        payload: {
          email: "developer@example.test",
        },
      });

      assert.equal(res.statusCode, 201);
      const data = JSON.parse(res.body);

      // Verify 192-bit Form ID structure
      assert.ok(data.form_id);
      assert.equal(data.form_id.length, 32);
      assert.match(data.form_id, /^[A-Za-z0-9_-]{32}$/);
      assert.equal(data.status, "pending_verification");
      assert.ok(data.management_token);
      assert.ok(data.html_snippet);

      // Privacy Check: Recipient email must NEVER appear in the public HTML snippet
      assert.equal(data.html_snippet.includes("developer@example.test"), false);
      assert.ok(data.html_snippet.includes(`/f/${data.form_id}`));

      // Database verification
      const dbForm = await getDynamicFormByPublicId(ctx.pool, data.form_id);
      assert.ok(dbForm);
      assert.equal(dbForm.recipient_email, "developer@example.test");
      assert.equal(dbForm.status, "pending_verification");
      assert.ok(dbForm.verification_token_hash);
      assert.ok(dbForm.management_token_hash);
      assert.equal(dbForm.verified_at, null);
    } finally {
      await ctx.cleanup();
    }
  });

  test("D02: Database Uniqueness and Concurrent Generation Integrity", async () => {
    const ctx = await createTestContext();
    try {
      // Concurrently create 10 forms
      const promises = Array.from({ length: 10 }, (_, i) =>
        createDynamicForm(ctx.pool, `user${i}@example.test`),
      );
      const results = await Promise.all(promises);

      const formIds = new Set(results.map((r) => r.formId));
      assert.equal(formIds.size, 10, "All concurrent Form IDs must be unique");

      // Verify PostgreSQL UNIQUE constraint enforcement on registered_forms.public_id
      const existing = results[0];
      await assert.rejects(
        async () => {
          await ctx.pool.query(
            `INSERT INTO registered_forms (
               id, public_id, recipient_email, status, management_token_hash
             ) VALUES (gen_random_uuid(), $1, 'duplicate@example.test', 'pending_verification', 'fake_hash')`,
            [existing.formId],
          );
        },
        (err: any) => {
          return err.code === "23505"; // PostgreSQL unique violation code
        },
      );
    } finally {
      await ctx.cleanup();
    }
  });

  test("D03: Pending Form Submissions are Held and Worker Does NOT Deliver Them", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      // Create a pending form
      const { formId } = await createDynamicForm(ctx.pool, "recipient@example.test");

      // Submit to pending form
      const res = await app.inject({
        method: "POST",
        url: `/f/${formId}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        payload: "name=Alice&email=alice@sender.test&message=Held+Test+Message",
      });

      assert.equal(res.statusCode, 202);
      const data = JSON.parse(res.body);
      const submissionId = data.submission_id;
      assert.ok(submissionId);

      // Verify notification is held_unverified
      const notifRes = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(notifRes.rows.length, 1);
      assert.equal(notifRes.rows[0].state, "held_unverified");

      // Run worker - must NOT claim or deliver held_unverified notification
      const worker = await createAcquiredWorker({
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

      const processed = await worker.processOne();
      assert.equal(processed, false, "Worker must not process held_unverified notifications");
      await worker.stop();
      await app.close();

      // State must STILL be held_unverified
      const notifAfter = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(notifAfter.rows[0].state, "held_unverified");
      assert.equal(notifAfter.rows[0].attempt_count, 0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("D04: Email Verification Flow Activates Form and Promotes Held Notifications", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      // 1. Create form
      const { formId, verificationToken } = await createDynamicForm(
        ctx.pool,
        "recipient@example.test",
      );

      // 2. Submit while unverified
      const subRes = await app.inject({
        method: "POST",
        url: `/f/${formId}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        payload: "name=Bob&email=bob@sender.test&message=Unfreeze+Me",
      });
      assert.equal(subRes.statusCode, 202);
      const submissionId = JSON.parse(subRes.body).submission_id;

      // Check notification is held_unverified
      const notifBefore = await ctx.pool.query(
        "SELECT state FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(notifBefore.rows[0].state, "held_unverified");

      // 3. User clicks activation link
      const verifyRes = await app.inject({
        method: "GET",
        url: `/verify?token=${verificationToken}`,
      });
      assert.equal(verifyRes.statusCode, 200);
      assert.ok(verifyRes.body.includes("Email Verified Successfully"));

      // 4. Verify DB: Form is active and notification is promoted to queued
      const dbForm = await getDynamicFormByPublicId(ctx.pool, formId);
      assert.equal(dbForm?.status, "active");
      assert.ok(dbForm?.verified_at);
      assert.equal(dbForm?.verification_token_hash, null);

      const notifAfter = await ctx.pool.query(
        "SELECT state FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(notifAfter.rows[0].state, "queued");

      // 5. Worker now processes and delivers the promoted notification
      const worker = await createAcquiredWorker({
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

      const processed = await worker.processOne();
      assert.equal(processed, true, "Worker must process queued notification");
      await worker.stop();
      await app.close();

      const notifFinal = await ctx.pool.query(
        "SELECT state FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(notifFinal.rows[0].state, "submitted");
    } finally {
      await ctx.cleanup();
    }
  });

  test("D05: Verification Token is Single-Use and Expired Tokens are Rejected", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const { verificationToken } = await createDynamicForm(ctx.pool, "recipient@example.test");

      // First verification succeeds
      const res1 = await app.inject({
        method: "GET",
        url: `/verify?token=${verificationToken}`,
      });
      assert.equal(res1.statusCode, 200);

      // Second verification with the same token must fail
      const res2 = await app.inject({
        method: "GET",
        url: `/verify?token=${verificationToken}`,
      });
      assert.equal(res2.statusCode, 404);
      assert.ok(res2.body.includes("Invalid or already used"));
    } finally {
      await ctx.cleanup();
    }
  });

  test("D06: FormSubmit Special Fields (_next redirect, _replyto, _subject, honeypot)", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const { formId, verificationToken } = await createDynamicForm(
        ctx.pool,
        "recipient@example.test",
      );
      // Activate form
      await app.inject({ method: "GET", url: `/verify?token=${verificationToken}` });

      // 1. Test _next redirect
      const redirectRes = await app.inject({
        method: "POST",
        url: `/f/${formId}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        payload:
          "name=Charlie&email=charlie@sender.test&message=Hi&_next=https://mysite.test/thank-you",
      });
      assert.equal(redirectRes.statusCode, 303);
      assert.equal(redirectRes.headers.location, "https://mysite.test/thank-you");

      // 2. Test honeypot spam discard (silent 202, no DB record)
      const submissionsCountBefore = (await ctx.pool.query("SELECT COUNT(*) FROM submissions"))
        .rows[0].count;
      const spamRes = await app.inject({
        method: "POST",
        url: `/f/${formId}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: "name=Bot&email=bot@spam.test&message=Buy+Crypto&_honey=iamabot",
      });
      assert.equal(spamRes.statusCode, 202);
      const submissionsCountAfter = (await ctx.pool.query("SELECT COUNT(*) FROM submissions"))
        .rows[0].count;
      assert.equal(
        submissionsCountAfter,
        submissionsCountBefore,
        "Honeypot submission must NOT create any submission record in the database",
      );
    } finally {
      await ctx.cleanup();
    }
  });

  test("D07: Multipart Submission with PDF Attachment to /f/:formId", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const { formId, verificationToken } = await createDynamicForm(
        ctx.pool,
        "recipient@example.test",
      );
      await app.inject({ method: "GET", url: `/verify?token=${verificationToken}` });

      const pdf = makePdf("Dynamic Form Attached CV");
      const mp = makeMultipart(
        {
          name: "Danielle",
          email: "danielle@sender.test",
          message: "Please find attached document",
          _subject: "Job Application Submission",
        },
        [
          {
            fieldName: "resume",
            filename: "applicant_cv.pdf",
            contentType: "application/pdf",
            content: pdf,
          },
        ],
      );

      const res = await app.inject({
        method: "POST",
        url: `/f/${formId}`,
        headers: {
          "content-type": mp.contentType,
          accept: "application/json",
        },
        payload: mp.buffer,
      });

      assert.equal(res.statusCode, 202);
      const data = JSON.parse(res.body);
      const submissionId = data.submission_id;

      // Verify attachment was staged and registered
      const attRes = await ctx.pool.query("SELECT * FROM attachments WHERE submission_id = $1", [
        submissionId,
      ]);
      assert.equal(attRes.rows.length, 1);
      assert.equal(attRes.rows[0].original_name, "applicant_cv.pdf");

      // Process with worker
      const worker = await createAcquiredWorker({
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

      const processed = await worker.processOne();
      assert.equal(processed, true, "Worker must process multipart notification");
      await worker.stop();
      await app.close();

      const notifRes = await ctx.pool.query(
        "SELECT state FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(notifRes.rows[0].state, "submitted");
    } finally {
      await ctx.cleanup();
    }
  });

  test("D08: Account-Free Form Deactivation", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const { formId, managementToken } = await createDynamicForm(
        ctx.pool,
        "recipient@example.test",
      );

      // Deactivation with wrong token fails
      const badDeactRes = await app.inject({
        method: "POST",
        url: `/f/${formId}/deactivate`,
        headers: { "content-type": "application/json" },
        payload: { management_token: "wrong_token_12345" },
      });
      assert.equal(badDeactRes.statusCode, 403);

      // Deactivation with correct token succeeds
      const deactRes = await app.inject({
        method: "POST",
        url: `/f/${formId}/deactivate`,
        headers: { "content-type": "application/json" },
        payload: { management_token: managementToken },
      });
      assert.equal(deactRes.statusCode, 200);

      // Subsequent submissions return 403
      const postDeactRes = await app.inject({
        method: "POST",
        url: `/f/${formId}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        payload: "name=Eve&message=Test",
      });
      assert.equal(postDeactRes.statusCode, 403);
      assert.ok(postDeactRes.body.includes("deactivated"));
    } finally {
      await ctx.cleanup();
    }
  });

  test("D09: 7-Day Retention Cleans Up Expired Held Submissions and Unverified Forms", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const { formId } = await createDynamicForm(ctx.pool, "unverified@example.test");

      // Submit while pending
      const subRes = await app.inject({
        method: "POST",
        url: `/f/${formId}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        payload: "name=Frank&message=Old+Submission",
      });
      const subId = JSON.parse(subRes.body).submission_id;

      // Age submission and form to 8 days in the past
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await ctx.pool.query("UPDATE submissions SET created_at = $1 WHERE id = $2", [
        eightDaysAgo,
        subId,
      ]);
      await ctx.pool.query(
        "UPDATE registered_forms SET created_at = $1, last_verification_sent_at = $1 WHERE public_id = $2",
        [eightDaysAgo, formId],
      );

      // Run retention
      const retentionResult = await runRetention(ctx.pool, storage, new Date());
      assert.ok(retentionResult.unverifiedCleaned >= 1);

      // Verify submission is tombstoned and notification cancelled
      const subRow = (
        await ctx.pool.query("SELECT deleted_at FROM submissions WHERE id = $1", [subId])
      ).rows[0];
      assert.ok(subRow.deleted_at);

      const notifRow = (
        await ctx.pool.query("SELECT state FROM notifications WHERE submission_id = $1", [subId])
      ).rows[0];
      assert.equal(notifRow.state, "cancelled");

      // Verify form is deactivated
      const formRow = await getDynamicFormByPublicId(ctx.pool, formId);
      assert.equal(formRow?.status, "deactivated");
    } finally {
      await ctx.cleanup();
    }
  });
});
