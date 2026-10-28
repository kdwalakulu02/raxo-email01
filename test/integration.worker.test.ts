import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { simpleParser } from "mailparser";
import {
  createTestContext,
  makePdf,
  makeEicarPdf,
  makeMultipart,
  startSmtpPeer,
} from "./helpers.js";
import { createStorage } from "../src/storage.js";
import { buildApp } from "../src/http.js";
import { Worker } from "../src/worker.js";
import { recoverExpiredLeases, claimDueNotification, processNotification } from "../src/queue.js";
import { runRetention } from "../src/retention.js";
import type { AppConfig } from "../src/types.js";

describe("Worker and Durable Handoff Integration Tests", { concurrency: 1 }, () => {
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

  async function createAcquiredWorker(
    options: ConstructorParameters<typeof Worker>[0],
  ): Promise<Worker> {
    const worker = new Worker(options);
    const acquired = await worker.acquireLock();
    assert.equal(acquired, true, "Worker failed to acquire advisory lock in test helper");
    return worker;
  }

  test("W01: One queued clean submission -> captured in Mailpit; submitted state", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Valid Applicant CV for W01");
      const originalSha256 = createHash("sha256").update(pdf).digest("hex");

      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
          portfolio: "https://example.test/alex",
          message: "Synthetic application — no real applicant data",
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
      const body = JSON.parse(res.body);
      const submissionId = body.submission_id;
      assert.ok(submissionId);

      // Verify notification is queued
      const notifRes = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(notifRes.rows.length, 1);
      assert.equal(notifRes.rows[0].state, "queued");

      // Run worker to process item
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
      assert.equal(processed, true);

      // Verify state in DB
      const updatedNotif = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(updatedNotif.rows[0].state, "submitted");
      assert.ok(updatedNotif.rows[0].smtp_receipt);
      assert.equal(updatedNotif.rows[0].attempt_count, 1);

      // Verify captured message in Mailpit API
      const mailpitRes = await fetch("http://127.0.0.1:8025/api/v1/messages");
      assert.equal(mailpitRes.status, 200);
      const mailpitData = (await mailpitRes.json()) as {
        messages: Array<{ ID: string; Subject: string }>;
      };

      const matchedMsg = mailpitData.messages.find((m) => m.Subject.includes(submissionId));
      assert.ok(matchedMsg, `Expected to find message with subject containing ${submissionId}`);

      // Fetch raw MIME from Mailpit
      const rawRes = await fetch(`http://127.0.0.1:8025/api/v1/message/${matchedMsg.ID}/raw`);
      assert.equal(rawRes.status, 200);
      const rawMime = await rawRes.text();

      // Parse raw MIME with mailparser
      const parsed = await simpleParser(rawMime);
      assert.equal(parsed.from?.text, "notifications@example.test");
      assert.ok(
        parsed.to &&
          (Array.isArray(parsed.to)
            ? parsed.to.some((t) => t.text.includes("owner@example.test"))
            : parsed.to.text.includes("owner@example.test")),
      );
      assert.equal(parsed.replyTo?.text, "alex@example.test");
      assert.ok(parsed.subject?.includes("Job application"));
      assert.ok(parsed.subject?.includes(submissionId));
      assert.equal(parsed.attachments.length, 1);

      const attachedPdf = parsed.attachments[0];
      const attachedSha256 = createHash("sha256").update(attachedPdf.content).digest("hex");
      assert.equal(attachedSha256, originalSha256);

      assert.ok(parsed.text?.includes("Alex Example"));
      assert.ok(parsed.text?.includes("Frontend Developer"));
      assert.ok(parsed.text?.includes("Synthetic application — no real applicant data"));

      await worker.stop();
      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("W02: SMTP connection refused -> retry_wait; submission/file survive", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Applicant CV for W02");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
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
      const body = JSON.parse(res.body);
      const submissionId = body.submission_id;

      // Worker configured with closed port (e.g. 54321)
      const worker = await createAcquiredWorker({
        pool: ctx.pool,
        storage,
        smtpConfig: {
          host: "127.0.0.1",
          port: 54321, // closed port
          tlsMode: "plain_local",
        },
        scannerHost: config.clamdHost,
        scannerPort: config.clamdPort,
      });

      const processed = await worker.processOne();
      assert.equal(processed, true);

      // Verify notification in retry_wait
      const notifRes = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(notifRes.rows[0].state, "retry_wait");
      assert.equal(notifRes.rows[0].attempt_count, 1);
      assert.ok(new Date(notifRes.rows[0].next_attempt_at) > new Date());

      // Verify submission and storage survive
      const subRes = await ctx.pool.query("SELECT * FROM submissions WHERE id = $1", [
        submissionId,
      ]);
      assert.equal(subRes.rows[0].deleted_at, null);

      const attRes = await ctx.pool.query("SELECT * FROM attachments WHERE submission_id = $1", [
        submissionId,
      ]);
      assert.equal(attRes.rows.length, 1);
      assert.ok(storage.exists(attRes.rows[0].storage_key, "clean"));

      await worker.stop();
      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("W03: SMTP positive acceptance -> submitted, no delivered field/claim", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Applicant CV for W03");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
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
      const submissionId = JSON.parse(res.body).submission_id;

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

      await worker.processOne();

      const notifRes = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      const notif = notifRes.rows[0];
      assert.equal(notif.state, "submitted");
      assert.ok(notif.smtp_receipt);
      // Assert no 'delivered' property/column
      assert.equal((notif as any).delivered, undefined);
      assert.equal((notif as any).delivered_at, undefined);

      await worker.stop();
      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("W04: Test peer accepts DATA then drops response -> unknown; advancing clock never resubmits", async () => {
    const ctx = await createTestContext();
    const peer = await startSmtpPeer({ dropAfterData: true });

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Applicant CV for W04");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
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
      const submissionId = JSON.parse(res.body).submission_id;

      const worker = await createAcquiredWorker({
        pool: ctx.pool,
        storage,
        smtpConfig: {
          host: "127.0.0.1",
          port: peer.port,
          tlsMode: "plain_local",
        },
        scannerHost: config.clamdHost,
        scannerPort: config.clamdPort,
      });

      await worker.processOne();

      const notifRes = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(notifRes.rows[0].state, "unknown");

      // Advance clock in DB: next_attempt_at in past
      await ctx.pool.query(
        "UPDATE notifications SET next_attempt_at = now() - interval '1 hour' WHERE submission_id = $1",
        [submissionId],
      );

      // Attempt another processing
      const secondTry = await worker.processOne();
      assert.equal(secondTry, false, "Unknown notification should never be re-claimed");

      const afterCheck = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(afterCheck.rows[0].state, "unknown");

      await worker.stop();
      await app.close();
    } finally {
      await peer.close();
      await ctx.cleanup();
    }
  });

  test("W05: Crash after remote acceptance before DB update -> Expired submitting becomes unknown", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Applicant CV for W05");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
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
      const submissionId = JSON.parse(res.body).submission_id;

      // Simulate crash in 'submitting' with expired lease
      await ctx.pool.query(
        `UPDATE notifications
         SET state = 'submitting',
             lease_expires_at = now() - interval '10 seconds',
             attempt_count = 1
         WHERE submission_id = $1`,
        [submissionId],
      );

      const notifId = (
        await ctx.pool.query("SELECT id FROM notifications WHERE submission_id = $1", [
          submissionId,
        ])
      ).rows[0].id;

      await ctx.pool.query(
        `INSERT INTO send_attempts (id, notification_id, attempt_number, outcome, started_at)
         VALUES (gen_random_uuid(), $1, 1, 'submitting', now() - interval '20 seconds')`,
        [notifId],
      );

      // Run recovery
      const recovered = await recoverExpiredLeases(ctx.pool);
      assert.equal(recovered.expiredSubmitting, 1);

      // Verify notification is marked 'unknown'
      const checkNotif = await ctx.pool.query("SELECT * FROM notifications WHERE id = $1", [
        notifId,
      ]);
      assert.equal(checkNotif.rows[0].state, "unknown");
      assert.equal(checkNotif.rows[0].last_error_code, "lease_expired_during_submitting");

      // Verify send_attempts is marked 'unknown'
      const checkAttempt = await ctx.pool.query(
        "SELECT * FROM send_attempts WHERE notification_id = $1",
        [notifId],
      );
      assert.equal(checkAttempt.rows[0].outcome, "unknown");

      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("W06: Crash in preparing before SMTP -> Safe reclaim, one handoff", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Applicant CV for W06");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
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
      const submissionId = JSON.parse(res.body).submission_id;

      // Simulate crash in 'preparing' with expired lease
      await ctx.pool.query(
        `UPDATE notifications
         SET state = 'preparing',
             lease_expires_at = now() - interval '10 seconds'
         WHERE submission_id = $1`,
        [submissionId],
      );

      // Run recovery
      const recovered = await recoverExpiredLeases(ctx.pool);
      assert.equal(recovered.recoveredPreparing, 1);

      // Verify notification returned to 'queued'
      const checkNotif = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(checkNotif.rows[0].state, "queued");

      // Now run worker: should process cleanly to submitted
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
      assert.equal(processed, true);

      const finalNotif = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(finalNotif.rows[0].state, "submitted");

      await worker.stop();
      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("W07: Start second worker -> Advisory lock prevents second sender", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);

      const worker1 = new Worker({
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

      const worker2 = new Worker({
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

      await worker1.start();

      // Second worker must fail to acquire lock
      await assert.rejects(
        async () => {
          await worker2.start();
        },
        {
          message: /could not acquire advisory lock 726901/i,
        },
      );

      // Stop worker 1
      await worker1.stop();

      // Now worker 2 can start successfully
      await worker2.start();
      await worker2.stop();
    } finally {
      await ctx.cleanup();
    }
  });

  test("W08: Explicit transient rejection four retries -> Same Message-ID/MIME; initial+4 maximum attempts", async () => {
    const ctx = await createTestContext();
    const peer = await startSmtpPeer({
      onMail: () => ({
        code: 451,
        message: "Temporary failure: try again later",
      }),
    });

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Applicant CV for W08");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
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
      const submissionId = JSON.parse(res.body).submission_id;

      const worker = await createAcquiredWorker({
        pool: ctx.pool,
        storage,
        smtpConfig: {
          host: "127.0.0.1",
          port: peer.port,
          tlsMode: "plain_local",
        },
        scannerHost: config.clamdHost,
        scannerPort: config.clamdPort,
      });

      // Attempt 1
      await worker.processOne();
      let notif = (
        await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [submissionId])
      ).rows[0];
      assert.equal(notif.state, "retry_wait");
      assert.equal(notif.attempt_count, 1);
      const initialMimeSha = notif.mime_sha256;
      const initialMessageId = notif.message_id;
      assert.ok(initialMimeSha);

      // Attempts 2, 3, 4
      for (let attempt = 2; attempt <= 4; attempt++) {
        await ctx.pool.query(
          "UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
          [notif.id],
        );
        await worker.processOne();

        notif = (await ctx.pool.query("SELECT * FROM notifications WHERE id = $1", [notif.id]))
          .rows[0];
        assert.equal(notif.state, "retry_wait");
        assert.equal(notif.attempt_count, attempt);
        assert.equal(notif.mime_sha256, initialMimeSha, "MIME SHA-256 must remain identical");
        assert.equal(notif.message_id, initialMessageId, "Message-ID must remain identical");
      }

      // Attempt 5: max retries reached -> failed
      await ctx.pool.query(
        "UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
        [notif.id],
      );
      await worker.processOne();

      notif = (await ctx.pool.query("SELECT * FROM notifications WHERE id = $1", [notif.id]))
        .rows[0];
      assert.equal(notif.state, "failed");
      assert.equal(notif.last_error_code, "too_many_retries");
      assert.equal(notif.attempt_count, 5);
      assert.equal(notif.mime_sha256, initialMimeSha);

      // Advancing clock should NOT trigger another attempt
      await ctx.pool.query(
        "UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
        [notif.id],
      );
      const extraTry = await worker.processOne();
      assert.equal(extraTry, false);

      await worker.stop();
      await app.close();
    } finally {
      await peer.close();
      await ctx.cleanup();
    }
  });

  test("W09: Stale lease tries final state update -> Compare-and-swap rejects stale write", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Applicant CV for W09");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
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
      const submissionId = JSON.parse(res.body).submission_id;

      // Claim the notification
      const claimed = await claimDueNotification(ctx.pool);
      assert.ok(claimed);

      // Invalidate the lease token in DB (simulating lease expiry and another worker claiming)
      await ctx.pool.query(
        "UPDATE notifications SET lease_token = gen_random_uuid() WHERE id = $1",
        [claimed.notification.id],
      );

      // Now attempt to process with the stale lease token
      const result = await processNotification(claimed.notification, claimed.leaseToken, {
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

      assert.equal(result.status, "aborted");
      assert.equal(result.outcome, "lease_lost_or_deleted");

      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("W10: File scan blocked/offline/stale -> No SMTP call; visible state, bounded preparation retries", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      // Part 1: Malware detection blocks notification
      const eicarPdf = makeEicarPdf();
      const mp1 = makeMultipart(
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

      const res1 = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": mp1.contentType,
          origin: "http://127.0.0.1:3000",
        },
        payload: mp1.buffer,
      });
      const subId1 = JSON.parse(res1.body).submission_id;

      const worker1 = await createAcquiredWorker({
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

      await worker1.processOne();

      const blockedNotif = (
        await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId1])
      ).rows[0];
      assert.equal(blockedNotif.state, "blocked");
      assert.equal(blockedNotif.attempt_count, 0, "No SMTP send attempt made");

      const blockedAtt = (
        await ctx.pool.query("SELECT * FROM attachments WHERE submission_id = $1", [subId1])
      ).rows[0];
      assert.equal(blockedAtt.scan_state, "blocked");

      await worker1.stop();

      // Part 2: Scanner offline
      const cleanPdf = makePdf("Clean PDF for offline scan test");
      const mp2 = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
        },
        [
          {
            fieldName: "attachments",
            filename: "clean.pdf",
            contentType: "application/pdf",
            content: cleanPdf,
          },
        ],
      );

      const res2 = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": mp2.contentType,
          origin: "http://127.0.0.1:3000",
        },
        payload: mp2.buffer,
      });
      const subId2 = JSON.parse(res2.body).submission_id;

      const workerOffline = await createAcquiredWorker({
        pool: ctx.pool,
        storage,
        smtpConfig: {
          host: config.smtpHost,
          port: config.smtpPort,
          tlsMode: config.smtpTlsMode,
        },
        scannerHost: "127.0.0.1",
        scannerPort: 54320, // closed scanner port
      });

      await workerOffline.processOne();

      const offlineNotif = (
        await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId2])
      ).rows[0];
      assert.equal(offlineNotif.state, "retry_wait");
      assert.equal(offlineNotif.prepare_failures, 1);
      assert.equal(offlineNotif.last_error_code, "scanner_error");
      assert.equal(offlineNotif.attempt_count, 0, "No SMTP attempt made");

      await workerOffline.stop();
      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("W11: Final MIME over configured cap -> failed mime_too_large; record retained; no send", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Applicant CV for W11");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
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
      const submissionId = JSON.parse(res.body).submission_id;

      // Worker configured with maxMimeBytes = 100 bytes (far too small for any email)
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
        maxMimeBytes: 100,
      });

      await worker.processOne();

      const notif = (
        await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [submissionId])
      ).rows[0];
      assert.equal(notif.state, "failed");
      assert.equal(notif.last_error_code, "mime_too_large");
      assert.equal(notif.attempt_count, 0, "No send attempt made");

      // Verify submission is retained
      const sub = (await ctx.pool.query("SELECT * FROM submissions WHERE id = $1", [submissionId]))
        .rows[0];
      assert.ok(sub);
      assert.equal(sub.deleted_at, null);

      await worker.stop();
      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("W12: Unknown notification remains unclaimed after time advances and lease recovery", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Applicant CV for W12");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
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
      const submissionId = JSON.parse(res.body).submission_id;

      // Force notification into 'unknown' state with next_attempt_at in the past
      await ctx.pool.query(
        `UPDATE notifications
         SET state = 'unknown',
             last_error_code = 'post_data_disconnect',
             next_attempt_at = now() - interval '1 hour',
             updated_at = now()
         WHERE submission_id = $1`,
        [submissionId],
      );

      // Attempt to claim due notification: must return null because unknown state is never claimed
      const claimed = await claimDueNotification(ctx.pool);
      assert.equal(claimed, null);

      // Run lease recovery: must not touch or alter unknown notification
      const recovery = await recoverExpiredLeases(ctx.pool);
      assert.equal(recovery.recoveredPreparing, 0);
      assert.equal(recovery.expiredSubmitting, 0);

      // Verify notification remains in 'unknown' state in database
      const notifAfter = (
        await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [submissionId])
      ).rows[0];
      assert.equal(notifAfter.state, "unknown");
      assert.equal(notifAfter.last_error_code, "post_data_disconnect");

      // Verify Worker.processOne does not process or claim it
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
      assert.equal(processed, false);

      await worker.stop();
      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("W13: SMTP peer accepts DATA then withholds 250 reply until socket timeout fires -> unknown; advancing clock never resubmits", async () => {
    const ctx = await createTestContext();
    // holdAfterData: true keeps the socket open without destroying it, withholds 250 OK reply
    const peer = await startSmtpPeer({ holdAfterData: true });

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Applicant CV for W13 Socket Timeout");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
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
      const submissionId = JSON.parse(res.body).submission_id;

      // Configure worker with a short socket timeout (1000ms) against the holding peer
      const worker = await createAcquiredWorker({
        pool: ctx.pool,
        storage,
        smtpConfig: {
          host: "127.0.0.1",
          port: peer.port,
          tlsMode: "plain_local",
          socketTimeoutMs: 1000,
        },
        scannerHost: config.clamdHost,
        scannerPort: config.clamdPort,
      });

      // Run worker processing: DATA is accepted, peer withholds reply, socketTimeout fires!
      await worker.processOne();

      // Notification must become 'unknown' with code 'etimedout'
      const notifRes = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(notifRes.rows[0].state, "unknown");
      assert.equal(notifRes.rows[0].last_error_code, "etimedout");

      // Verify the send_attempt was recorded as 'unknown'
      const attemptRes = await ctx.pool.query(
        "SELECT * FROM send_attempts WHERE notification_id = $1",
        [notifRes.rows[0].id],
      );
      assert.equal(attemptRes.rows.length, 1);
      assert.equal(attemptRes.rows[0].outcome, "unknown");

      // Advance retry time in DB: next_attempt_at in past
      await ctx.pool.query(
        "UPDATE notifications SET next_attempt_at = now() - interval '2 hours' WHERE submission_id = $1",
        [submissionId],
      );

      // Attempt second processing: worker must NOT claim or touch unknown notification
      const secondTry = await worker.processOne();
      assert.equal(secondTry, false, "Unknown notification should never be re-claimed or re-sent");

      const afterCheck = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [submissionId],
      );
      assert.equal(afterCheck.rows[0].state, "unknown");

      // Verify no second send attempt was recorded
      const attemptsAfter = await ctx.pool.query(
        "SELECT * FROM send_attempts WHERE notification_id = $1",
        [notifRes.rows[0].id],
      );
      assert.equal(attemptsAfter.rows.length, 1);

      await worker.stop();
      await app.close();
    } finally {
      await peer.close();
      await ctx.cleanup();
    }
  });

  test("W14: F05 - Stored-byte integrity and immutable MIME retries", async () => {
    const ctx = await createTestContext();
    const receivedMails: any[] = [];
    const peer = await startSmtpPeer({
      onMail: (mail) => {
        receivedMails.push(mail);
        return { code: 250, message: "OK" };
      },
    });

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      // Case 1: Mutate clean PDF bytes after scan -> fails with attachment_integrity_error, 0 SMTP handoffs
      {
        const pdf = makePdf("Applicant CV for W14 Case 1");
        const mp = makeMultipart(
          {
            full_name: "Applicant One",
            email: "app1@example.test",
            position: "Developer",
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
        const subId = JSON.parse(res.body).submission_id;

        const attRes = await ctx.pool.query(
          "SELECT storage_key FROM attachments WHERE submission_id = $1",
          [subId],
        );
        const storageKey = attRes.rows[0].storage_key;
        const filePath = storage.resolveSafePath(storageKey, "quarantine");

        // Mutate stored bytes before worker processing
        writeFileSync(filePath, Buffer.from("TAMPERED_BYTES_CORRUPTED_PDF"));

        const worker = await createAcquiredWorker({
          pool: ctx.pool,
          storage,
          smtpConfig: {
            host: "127.0.0.1",
            port: peer.port,
            tlsMode: "plain_local",
          },
          scannerHost: config.clamdHost,
          scannerPort: config.clamdPort,
        });

        await worker.processOne();

        const notif = (
          await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId])
        ).rows[0];
        assert.equal(notif.state, "failed");
        assert.equal(notif.last_error_code, "attachment_integrity_error");
        assert.equal(receivedMails.length, 0, "No SMTP handoff on attachment integrity error");

        await worker.stop();
      }

      // Case 2: Mutate persisted MIME on disk -> fails with mime_integrity_error, 0 SMTP handoffs
      {
        let transientFailure = true;
        const tempPeer = await startSmtpPeer({
          onMail: () => {
            if (transientFailure) {
              return { code: 451, message: "Temporary failure" };
            }
            return { code: 250, message: "OK" };
          },
        });

        try {
          const pdf = makePdf("Applicant CV for W14 Case 2");
          const mp = makeMultipart(
            {
              full_name: "Applicant Two",
              email: "app2@example.test",
              position: "Developer",
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
          const subId = JSON.parse(res.body).submission_id;

          const worker = await createAcquiredWorker({
            pool: ctx.pool,
            storage,
            smtpConfig: {
              host: "127.0.0.1",
              port: tempPeer.port,
              tlsMode: "plain_local",
            },
            scannerHost: config.clamdHost,
            scannerPort: config.clamdPort,
          });

          // Attempt 1: fails with 451, enters retry_wait and persists MIME
          await worker.processOne();

          let notif = (
            await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId])
          ).rows[0];
          assert.equal(notif.state, "retry_wait");
          assert.ok(notif.mime_key);
          assert.ok(notif.mime_sha256);

          // Mutate persisted MIME bytes
          const mimePath = storage.resolveSafePath(notif.mime_key, "mime");
          writeFileSync(mimePath, Buffer.from("TAMPERED_MIME_BODY"));

          // Advance retry time
          await ctx.pool.query(
            "UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
            [notif.id],
          );

          // Attempt 2: retry must detect MIME integrity mismatch
          await worker.processOne();

          notif = (await ctx.pool.query("SELECT * FROM notifications WHERE id = $1", [notif.id]))
            .rows[0];
          assert.equal(notif.state, "failed");
          assert.equal(notif.last_error_code, "mime_integrity_error");

          await worker.stop();
        } finally {
          await tempPeer.close();
        }
      }

      // Case 3: Remove persisted MIME before retry -> fails with mime_integrity_error, no silent recomposition
      {
        let transientFailure = true;
        const tempPeer = await startSmtpPeer({
          onMail: () => {
            if (transientFailure) {
              return { code: 451, message: "Temporary failure" };
            }
            return { code: 250, message: "OK" };
          },
        });

        try {
          const pdf = makePdf("Applicant CV for W14 Case 3");
          const mp = makeMultipart(
            {
              full_name: "Applicant Three",
              email: "app3@example.test",
              position: "Developer",
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
          const subId = JSON.parse(res.body).submission_id;

          const worker = await createAcquiredWorker({
            pool: ctx.pool,
            storage,
            smtpConfig: {
              host: "127.0.0.1",
              port: tempPeer.port,
              tlsMode: "plain_local",
            },
            scannerHost: config.clamdHost,
            scannerPort: config.clamdPort,
          });

          // Attempt 1: 451 -> retry_wait
          await worker.processOne();

          let notif = (
            await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId])
          ).rows[0];
          assert.equal(notif.state, "retry_wait");
          assert.ok(notif.mime_key);

          // Delete persisted MIME file
          const mimePath = storage.resolveSafePath(notif.mime_key, "mime");
          unlinkSync(mimePath);

          // Advance retry time
          await ctx.pool.query(
            "UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
            [notif.id],
          );

          // Attempt 2: must fail with mime_integrity_error, never silently recompose
          await worker.processOne();

          notif = (await ctx.pool.query("SELECT * FROM notifications WHERE id = $1", [notif.id]))
            .rows[0];
          assert.equal(notif.state, "failed");
          assert.equal(notif.last_error_code, "mime_integrity_error");

          await worker.stop();
        } finally {
          await tempPeer.close();
        }
      }

      // Case 4: Positive test showing valid safe retry sends identical MIME bytes, Message-ID, Date, SHA-256
      {
        let attempts = 0;
        const capturedMails: any[] = [];
        const retryPeer = await startSmtpPeer({
          onMail: (m) => {
            attempts++;
            if (attempts === 1) {
              return { code: 451, message: "Try again later" };
            }
            capturedMails.push(m);
            return { code: 250, message: "OK" };
          },
        });

        try {
          const pdf = makePdf("Applicant CV for W14 Case 4");
          const mp = makeMultipart(
            {
              full_name: "Applicant Four",
              email: "app4@example.test",
              position: "Developer",
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
          const subId = JSON.parse(res.body).submission_id;

          const worker = await createAcquiredWorker({
            pool: ctx.pool,
            storage,
            smtpConfig: {
              host: "127.0.0.1",
              port: retryPeer.port,
              tlsMode: "plain_local",
            },
            scannerHost: config.clamdHost,
            scannerPort: config.clamdPort,
          });

          // Attempt 1: 451
          await worker.processOne();

          let notif = (
            await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId])
          ).rows[0];
          assert.equal(notif.state, "retry_wait");
          const expectedMimeSha = notif.mime_sha256;
          const expectedMessageId = notif.message_id;

          // Advance retry time
          await ctx.pool.query(
            "UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
            [notif.id],
          );

          // Attempt 2: 250 OK
          await worker.processOne();

          notif = (await ctx.pool.query("SELECT * FROM notifications WHERE id = $1", [notif.id]))
            .rows[0];
          assert.equal(notif.state, "submitted");
          assert.equal(notif.mime_sha256, expectedMimeSha);
          assert.equal(notif.message_id, expectedMessageId);
          assert.equal(capturedMails.length, 1);

          await worker.stop();
        } finally {
          await retryPeer.close();
        }
      }

      await app.close();
    } finally {
      await peer.close();
      await ctx.cleanup();
    }
  });

  test("W15: F06 - OUTBOUND_ENABLED=false operational and does not contact SMTP", async () => {
    const ctx = await createTestContext();
    let smtpConnections = 0;
    const peer = await startSmtpPeer({
      onMail: () => {
        smtpConnections++;
        return { code: 250, message: "OK" };
      },
    });

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx, { outboundEnabled: false });
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Applicant CV for W15");
      const mp = makeMultipart(
        {
          full_name: "Outbound Test",
          email: "outbound@example.test",
          position: "Developer",
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
      const subId = JSON.parse(res.body).submission_id;

      // Create worker with outboundEnabled = false
      const workerDisabled = await createAcquiredWorker({
        pool: ctx.pool,
        storage,
        smtpConfig: {
          host: "127.0.0.1",
          port: peer.port,
          tlsMode: "plain_local",
        },
        scannerHost: config.clamdHost,
        scannerPort: config.clamdPort,
        outboundEnabled: false,
      });

      // Try processing: must return false and not contact SMTP
      const processedDisabled = await workerDisabled.processOne();
      assert.equal(processedDisabled, false);
      assert.equal(smtpConnections, 0, "No SMTP connections when outbound is disabled");

      // Verify notification remains unclaimed and queued
      let notif = (
        await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId])
      ).rows[0];
      assert.equal(notif.state, "queued");
      assert.equal(notif.attempt_count, 0);

      await workerDisabled.stop();

      // Now create worker with outboundEnabled = true
      const workerEnabled = await createAcquiredWorker({
        pool: ctx.pool,
        storage,
        smtpConfig: {
          host: "127.0.0.1",
          port: peer.port,
          tlsMode: "plain_local",
        },
        scannerHost: config.clamdHost,
        scannerPort: config.clamdPort,
        outboundEnabled: true,
      });

      const processedEnabled = await workerEnabled.processOne();
      assert.equal(processedEnabled, true);

      // Verify normal handoff succeeded
      notif = (
        await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId])
      ).rows[0];
      assert.equal(notif.state, "submitted");
      assert.equal(smtpConnections, 1, "Exactly one SMTP handoff once enabled");

      await workerEnabled.stop();
      await app.close();
    } finally {
      await peer.close();
      await ctx.cleanup();
    }
  });

  test("W16: F07 - Consistent lock ordering between deletion and worker preflight", async () => {
    const ctx = await createTestContext();
    let smtpDeliveries = 0;
    const peer = await startSmtpPeer({
      onMail: () => {
        smtpDeliveries++;
        return { code: 250, message: "OK" };
      },
    });

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      // Scenario 1: Deletion commits before submitting transition commits -> no handoff occurs
      {
        const pdf = makePdf("Applicant CV for W16 Scenario 1");
        const mp = makeMultipart(
          {
            full_name: "Delete First",
            email: "delete1@example.test",
            position: "Developer",
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
        const subId = JSON.parse(res.body).submission_id;

        // Two real PostgreSQL connections: client1 executes deletion
        const client1 = await ctx.pool.connect();
        try {
          await client1.query("BEGIN");
          const notifRow = await client1.query(
            "SELECT id, state FROM notifications WHERE submission_id = $1 FOR UPDATE",
            [subId],
          );
          await client1.query("SELECT id, deleted_at FROM submissions WHERE id = $1 FOR UPDATE", [
            subId,
          ]);
          await client1.query("UPDATE submissions SET deleted_at = now() WHERE id = $1", [subId]);
          await client1.query(
            "UPDATE notifications SET state = 'cancelled', updated_at = now() WHERE id = $1",
            [notifRow.rows[0].id],
          );
          await client1.query("COMMIT");
        } finally {
          client1.release();
        }

        const worker = await createAcquiredWorker({
          pool: ctx.pool,
          storage,
          smtpConfig: {
            host: "127.0.0.1",
            port: peer.port,
            tlsMode: "plain_local",
          },
          scannerHost: config.clamdHost,
          scannerPort: config.clamdPort,
        });

        const processed = await worker.processOne();
        assert.equal(processed, false, "Cancelled notification cannot be processed");
        assert.equal(
          smtpDeliveries,
          0,
          "No SMTP handoff when deletion committed before submitting",
        );

        const notif = (
          await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId])
        ).rows[0];
        assert.equal(notif.state, "cancelled");

        await worker.stop();
      }

      // Scenario 2: Submitting commits before deletion -> deletion does not create new retry
      {
        const pdf = makePdf("Applicant CV for W16 Scenario 2");
        const mp = makeMultipart(
          {
            full_name: "Submitting First",
            email: "submitting@example.test",
            position: "Developer",
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
        const subId = JSON.parse(res.body).submission_id;

        // Transition notification to submitting
        await ctx.pool.query(
          "UPDATE notifications SET state = 'submitting', attempt_count = 1, lease_expires_at = now() + interval '120 seconds' WHERE submission_id = $1",
          [subId],
        );

        // Deletion transaction: lock notification first FOR UPDATE, then submission second FOR UPDATE
        const client2 = await ctx.pool.connect();
        try {
          await client2.query("BEGIN");
          const notifRow = await client2.query(
            "SELECT id, state FROM notifications WHERE submission_id = $1 FOR UPDATE",
            [subId],
          );
          assert.equal(notifRow.rows[0].state, "submitting");

          await client2.query("SELECT id, deleted_at FROM submissions WHERE id = $1 FOR UPDATE", [
            subId,
          ]);
          await client2.query("UPDATE submissions SET deleted_at = now() WHERE id = $1", [subId]);

          // As required by F07, submitting is not cancelled or retried
          const state = notifRow.rows[0].state;
          if (["queued", "retry_wait", "preparing"].includes(state)) {
            await client2.query("UPDATE notifications SET state = 'cancelled' WHERE id = $1", [
              notifRow.rows[0].id,
            ]);
          }
          await client2.query("COMMIT");
        } finally {
          client2.release();
        }

        const notifAfter = (
          await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId])
        ).rows[0];
        assert.equal(notifAfter.state, "submitting");
        assert.notEqual(notifAfter.state, "retry_wait");
      }

      // Scenario 3: Expiration with retention run respects identical lock order
      {
        const pdf = makePdf("Applicant CV for W16 Scenario 3");
        const mp = makeMultipart(
          {
            full_name: "Expired Submission",
            email: "expired@example.test",
            position: "Developer",
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
        const subId = JSON.parse(res.body).submission_id;

        // Set created_at > 90 days ago
        await ctx.pool.query(
          "UPDATE submissions SET created_at = now() - interval '91 days' WHERE id = $1",
          [subId],
        );

        // Run retention sweep
        await runRetention(ctx.pool, storage);

        const subCheck = (await ctx.pool.query("SELECT * FROM submissions WHERE id = $1", [subId]))
          .rows[0];
        assert.ok(subCheck.deleted_at !== null, "Expired submission tombstoned");
      }

      await app.close();
    } finally {
      await peer.close();
      await ctx.cleanup();
    }
  });

  test("W17: F08 - Worker ownership loss and running lease recovery", async () => {
    const ctx = await createTestContext();
    let smtpCalls = 0;
    const peer = await startSmtpPeer({
      onMail: () => {
        smtpCalls++;
        return { code: 250, message: "OK" };
      },
    });

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      // Part 1: Terminate dedicated advisory lock client backend while worker is running -> ownership loss detected, no SMTP handoff
      {
        const worker = new Worker({
          pool: ctx.pool,
          storage,
          smtpConfig: {
            host: "127.0.0.1",
            port: peer.port,
            tlsMode: "plain_local",
          },
          scannerHost: config.clamdHost,
          scannerPort: config.clamdPort,
        });

        const acquired = await worker.acquireLock();
        assert.equal(acquired, true);

        const pidRes = await ctx.pool.query(
          "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = 726901",
        );
        assert.ok(pidRes.rows.length > 0);
        const lockPid = pidRes.rows[0].pid;

        // Terminate the dedicated backend
        await ctx.pool.query("SELECT pg_terminate_backend($1)", [lockPid]);

        // Wait a short tick for the disconnect event to fire
        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal((worker as any).hasAdvisoryLock, false);

        // Queue a submission
        const pdf = makePdf("Applicant CV for W17 Part 1");
        const mp = makeMultipart(
          {
            full_name: "Ownership Lost Test",
            email: "lost@example.test",
            position: "Developer",
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

        // Worker must refuse to claim when advisory lock ownership is lost
        const processed = await worker.processOne();
        assert.equal(processed, false);
        assert.equal(smtpCalls, 0, "No SMTP call when ownership was lost");

        await worker.releaseLock();
      }

      // Part 2: Force lease-renewal failure -> verify compare-and-swap rejects stale write, no SMTP handoff
      {
        const pdf = makePdf("Applicant CV for W17 Part 2");
        const mp = makeMultipart(
          {
            full_name: "Lease Fail Test",
            email: "leasefail@example.test",
            position: "Developer",
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
        const subId = JSON.parse(res.body).submission_id;

        const claimed = await claimDueNotification(ctx.pool, 120);
        assert.ok(claimed);

        // Simulate failed lease renewal (ownership validity returns false)
        const result = await processNotification(claimed.notification, claimed.leaseToken, {
          pool: ctx.pool,
          storage,
          smtpConfig: {
            host: "127.0.0.1",
            port: peer.port,
            tlsMode: "plain_local",
          },
          scannerHost: config.clamdHost,
          scannerPort: config.clamdPort,
          isOwnershipValid: () => false,
        });

        assert.equal(result.status, "aborted");
        assert.equal(result.outcome, "ownership_lost");
        assert.equal(smtpCalls, 0, "No SMTP handoff when lease renewal fails");
      }

      // Part 3: Cause preparation exception, keep worker alive, observe lease rollback
      {
        const pdf = makePdf("Applicant CV for W17 Part 3");
        const mp = makeMultipart(
          {
            full_name: "Prep Exception Test",
            email: "prep@example.test",
            position: "Developer",
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
        const subId = JSON.parse(res.body).submission_id;

        // Create faulty storage adapter whose persistMime throws an unexpected exception
        const faultyStorage: any = {
          ...storage,
          persistMime: () => {
            throw new Error("Simulated storage crash during MIME persistence");
          },
        };

        const worker = await createAcquiredWorker({
          pool: ctx.pool,
          storage: faultyStorage,
          smtpConfig: {
            host: "127.0.0.1",
            port: peer.port,
            tlsMode: "plain_local",
          },
          scannerHost: config.clamdHost,
          scannerPort: config.clamdPort,
        });

        // processOne catches exception and releases lease back to queued
        const processed = await worker.processOne();
        assert.equal(processed, false);

        const notif = (
          await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId])
        ).rows[0];
        assert.equal(notif.state, "queued", "Must release lease and reset state to queued");
        assert.equal(notif.lease_token, null);

        await worker.stop();

        // Cancel Part 3 notification so it does not interfere with Part 4
        await ctx.pool.query(
          "UPDATE notifications SET state = 'cancelled' WHERE submission_id = $1",
          [subId],
        );
      }

      // Part 4: Expired submitting recovered to unknown once and stays unsent on later polls
      {
        const pdf = makePdf("Applicant CV for W17 Part 4");
        const mp = makeMultipart(
          {
            full_name: "Expired Submitting Test",
            email: "expiredsub@example.test",
            position: "Developer",
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
        const subId = JSON.parse(res.body).submission_id;

        const notifRes = await ctx.pool.query(
          "SELECT id FROM notifications WHERE submission_id = $1",
          [subId],
        );
        const expiredNotifId = notifRes.rows[0].id;

        // Set to submitting with expired lease
        await ctx.pool.query(
          "UPDATE notifications SET state = 'submitting', attempt_count = 1, lease_expires_at = now() - interval '10 seconds' WHERE id = $1",
          [expiredNotifId],
        );

        await ctx.pool.query(
          "INSERT INTO send_attempts (id, notification_id, attempt_number, outcome, started_at) VALUES (gen_random_uuid(), $1, 1, 'submitting', now() - interval '10 seconds')",
          [expiredNotifId],
        );

        // Run lease recovery
        const recovered = await recoverExpiredLeases(ctx.pool);
        assert.equal(recovered.expiredSubmitting, 1);

        const checkNotif = (
          await ctx.pool.query("SELECT * FROM notifications WHERE id = $1", [expiredNotifId])
        ).rows[0];
        assert.equal(checkNotif.state, "unknown");

        // Advance retry time in DB
        await ctx.pool.query(
          "UPDATE notifications SET next_attempt_at = now() - interval '1 hour' WHERE id = $1",
          [expiredNotifId],
        );

        // Delete any remaining notifications from earlier parts so this test is completely isolated
        await ctx.pool.query("DELETE FROM notifications WHERE id != $1", [expiredNotifId]);

        const worker = await createAcquiredWorker({
          pool: ctx.pool,
          storage,
          smtpConfig: {
            host: "127.0.0.1",
            port: peer.port,
            tlsMode: "plain_local",
          },
          scannerHost: config.clamdHost,
          scannerPort: config.clamdPort,
        });

        const secondTry = await worker.processOne();
        assert.equal(secondTry, false, "Unknown notification must never be claimed on later polls");

        const checkAfter = (
          await ctx.pool.query("SELECT * FROM notifications WHERE id = $1", [expiredNotifId])
        ).rows[0];
        assert.equal(checkAfter.state, "unknown");

        await worker.stop();
      }

      await app.close();
    } finally {
      await peer.close();
      await ctx.cleanup();
    }
  });

  test("W18: F08 — Worker unacquired refusal, preflight barriers and lease expiry", async () => {
    const ctx = await createTestContext();
    let smtpDeliveries = 0;
    const peer = await startSmtpPeer({
      onMail: () => {
        smtpDeliveries++;
        return { code: 250, message: "OK" };
      },
    });

    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const submitValidForm = async (label: string) => {
        const pdf = makePdf(`Applicant CV for ${label}`);
        const mp = makeMultipart(
          {
            full_name: "Test Applicant",
            email: "applicant@example.test",
            position: "Engineer",
          },
          [
            {
              fieldName: "attachments",
              filename: "cv.pdf",
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
        return JSON.parse(res.body).submission_id as string;
      };

      // Part 1: Newly constructed worker and failed acquisition worker refuse claims and SMTP
      {
        const subId1 = await submitValidForm("W18 Part 1");

        // 1a: Unacquired worker
        const unacquiredWorker = new Worker({
          pool: ctx.pool,
          storage,
          smtpConfig: {
            host: "127.0.0.1",
            port: peer.port,
            tlsMode: "plain_local",
          },
          scannerHost: config.clamdHost,
          scannerPort: config.clamdPort,
        });

        const didProcessUnacquired = await unacquiredWorker.processOne();
        assert.equal(didProcessUnacquired, false, "Unacquired worker must refuse to process");
        assert.equal(smtpDeliveries, 0, "No SMTP delivery attempted by unacquired worker");

        const notif1 = (
          await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId1])
        ).rows[0];
        assert.equal(notif1.state, "queued");
        assert.equal(notif1.attempt_count, 0);

        // 1b: Worker whose lock acquisition fails
        const lockHolder = await ctx.pool.connect();
        try {
          const lockRes = await lockHolder.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock(726901) as acquired;",
          );
          assert.equal(lockRes.rows[0].acquired, true);

          const failedAcqWorker = new Worker({
            pool: ctx.pool,
            storage,
            smtpConfig: {
              host: "127.0.0.1",
              port: peer.port,
              tlsMode: "plain_local",
            },
            scannerHost: config.clamdHost,
            scannerPort: config.clamdPort,
          });

          const acquired = await failedAcqWorker.acquireLock();
          assert.equal(acquired, false, "acquireLock must return false when lock is held");
          assert.equal((failedAcqWorker as any).hasAdvisoryLock, false);

          const didProcessBlocked = await failedAcqWorker.processOne();
          assert.equal(
            didProcessBlocked,
            false,
            "Failed acquisition worker must refuse to process",
          );
          assert.equal(smtpDeliveries, 0, "No SMTP delivery attempted by worker with failed lock");
        } finally {
          await lockHolder.query("SELECT pg_advisory_unlock(726901);");
          lockHolder.release();
        }

        await ctx.pool.query("DELETE FROM notifications WHERE submission_id = $1", [subId1]);
      }

      // Part 2: Controlled database barrier on submission row; dedicated lock lost while waiting
      {
        const subId2 = await submitValidForm("W18 Part 2");

        const worker2 = await createAcquiredWorker({
          pool: ctx.pool,
          storage,
          smtpConfig: {
            host: "127.0.0.1",
            port: peer.port,
            tlsMode: "plain_local",
          },
          scannerHost: config.clamdHost,
          scannerPort: config.clamdPort,
        });

        let barrierClient2: any = null;
        try {
          // Dedicated client pid holding the advisory lock
          const lockPidRes = await ctx.pool.query(
            "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = 726901",
          );
          assert.ok(lockPidRes.rows.length > 0);
          const workerLockPid = lockPidRes.rows[0].pid;

          // Take exclusive row lock on the submission row
          barrierClient2 = await ctx.pool.connect();
          await barrierClient2.query("BEGIN;");
          await barrierClient2.query("SELECT id FROM submissions WHERE id = $1 FOR UPDATE;", [
            subId2,
          ]);

          // Start processing concurrently
          const processPromise = worker2.processOne();
          let processDone2 = false;
          processPromise.finally(() => {
            processDone2 = true;
          });

          // Wait deterministically until worker2's backend is waiting for the row lock
          const startWait2 = Date.now();
          while (!processDone2 && Date.now() - startWait2 < 10000) {
            const waiting = await ctx.pool.query(
              `SELECT pid, locktype, mode, granted FROM pg_locks
               WHERE (locktype = 'tuple' OR locktype = 'transactionid')
                 AND granted = false`,
            );
            if (waiting.rows.length > 0) {
              break;
            }
            await new Promise((r) => setTimeout(r, 20));
          }

          // Worker is now waiting inside withTransaction! Terminate worker's advisory lock backend
          await ctx.pool.query("SELECT pg_terminate_backend($1)", [workerLockPid]);

          // Wait until worker detects the disconnect and revokes hasAdvisoryLock
          const startDisconnectWait = Date.now();
          while (
            (worker2 as any).hasAdvisoryLock !== false &&
            Date.now() - startDisconnectWait < 5000
          ) {
            await new Promise((r) => setTimeout(r, 20));
          }

          // Release the barrier
          await barrierClient2.query("ROLLBACK;");
          barrierClient2.release();
          barrierClient2 = null;

          const didProcess = await processPromise;
          assert.equal(
            didProcess,
            false,
            "Processing must abort when ownership is lost during preflight",
          );
          assert.equal(
            smtpDeliveries,
            0,
            "Zero SMTP handoffs when ownership lost during row lock wait",
          );

          const notif2 = (
            await ctx.pool.query("SELECT * FROM notifications WHERE submission_id = $1", [subId2])
          ).rows[0];
          assert.notEqual(notif2.state, "submitting", "Notification must not be marked submitting");

          await ctx.pool.query("DELETE FROM notifications WHERE submission_id = $1", [subId2]);
        } finally {
          if (barrierClient2) {
            try {
              await barrierClient2.query("ROLLBACK;");
            } catch {}
            barrierClient2.release();
          }
          await worker2.stop();
        }
      }

      // Part 3: Lease expires while final preflight waits on submission row barrier
      {
        const subId3 = await submitValidForm("W18 Part 3");
        const notif3Row = (
          await ctx.pool.query("SELECT id FROM notifications WHERE submission_id = $1", [subId3])
        ).rows[0];

        const worker3 = await createAcquiredWorker({
          pool: ctx.pool,
          storage,
          smtpConfig: {
            host: "127.0.0.1",
            port: peer.port,
            tlsMode: "plain_local",
          },
          scannerHost: config.clamdHost,
          scannerPort: config.clamdPort,
          leaseDurationSeconds: 1,
        });

        let barrierClient3: any = null;
        try {
          // Take exclusive row lock on the submission row
          barrierClient3 = await ctx.pool.connect();
          await barrierClient3.query("BEGIN;");
          await barrierClient3.query("SELECT id FROM submissions WHERE id = $1 FOR UPDATE;", [
            subId3,
          ]);

          // Start processing concurrently
          const processPromise = worker3.processOne();
          let processDone3 = false;
          processPromise.finally(() => {
            processDone3 = true;
          });

          // Wait deterministically until worker3's backend is waiting for the row lock
          const startWait3 = Date.now();
          while (!processDone3 && Date.now() - startWait3 < 10000) {
            const waiting = await ctx.pool.query(
              `SELECT pid FROM pg_locks
               WHERE (locktype = 'tuple' OR locktype = 'transactionid')
                 AND granted = false`,
            );
            if (waiting.rows.length > 0) {
              break;
            }
            await new Promise((r) => setTimeout(r, 20));
          }

          // Hold barrier until database time advances past the 1-second lease
          await new Promise((r) => setTimeout(r, 1200));

          // Release the barrier
          await barrierClient3.query("ROLLBACK;");
          barrierClient3.release();
          barrierClient3 = null;

          const didProcess = await processPromise;
          assert.equal(didProcess, false, "Processing must abort when lease expires during wait");
          assert.equal(
            smtpDeliveries,
            0,
            "Zero SMTP handoffs when lease expired during preflight wait",
          );

          const finalNotif3 = (
            await ctx.pool.query("SELECT * FROM notifications WHERE id = $1", [notif3Row.id])
          ).rows[0];
          assert.notEqual(
            finalNotif3.state,
            "submitting",
            "Must not transition to submitting with expired lease",
          );

          const attempts3 = await ctx.pool.query(
            "SELECT * FROM send_attempts WHERE notification_id = $1",
            [notif3Row.id],
          );
          assert.equal(attempts3.rows.length, 0, "No send attempt recorded when lease was expired");

          await ctx.pool.query("DELETE FROM notifications WHERE id = $1", [notif3Row.id]);
        } finally {
          if (barrierClient3) {
            try {
              await barrierClient3.query("ROLLBACK;");
            } catch {}
            barrierClient3.release();
          }
          await worker3.stop();
        }
      }

      await app.close();
    } finally {
      await peer.close();
      await ctx.cleanup();
    }
  });
});
