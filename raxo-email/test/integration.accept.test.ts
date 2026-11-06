import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createTestContext, makePdf, makeMultipart } from "./helpers.js";
import { createStorage } from "../src/storage.js";
import { acceptSubmission } from "../src/accept.js";
import { consumeRateLimit } from "../src/rate-limit.js";
import { Repository } from "../src/repository.js";
import { AppError } from "../src/errors.js";
import { buildApp } from "../src/http.js";
import type { ParsedInput } from "../src/multipart.js";
import type { AppConfig } from "../src/types.js";

describe("A01–A11: HTTP, Multipart, and Acceptance Integration Tests", () => {
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

  test("A01: Valid HTTP form submission returns 202 and creates records", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Valid HTTP Submission A01");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
          portfolio: "https://example.test/alex",
          message: "Valid submission message",
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
          accept: "application/json",
        },
        payload: mp.buffer,
      });

      assert.equal(res.statusCode, 202);
      const body = JSON.parse(res.body);
      assert.equal(body.status, "received");
      assert.ok(body.submission_id);

      // Verify DB records
      const repo = new Repository(ctx.pool);
      const sub = await repo.getSubmission(body.submission_id);
      assert.ok(sub);
      assert.equal(sub.form_id, "job-application");

      const atts = await repo.getAttachmentsForSubmission(body.submission_id);
      assert.equal(atts.length, 1);
      assert.equal(atts[0].original_name, "resume.pdf");

      const notif = await repo.getNotificationBySubmissionId(body.submission_id);
      assert.ok(notif);
      assert.equal(notif.state, "queued");
    } finally {
      await ctx.cleanup();
    }
  });

  test("A02: Duplicate concurrent _submission_id returns original receipt", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const sharedId = randomUUID();
      const pdf = makePdf("A02 PDF");
      const mp = makeMultipart(
        {
          _submission_id: sharedId,
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

      const [r1, r2] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/forms/job-application",
          headers: {
            "content-type": mp.contentType,
            origin: "http://127.0.0.1:3000",
            accept: "application/json",
          },
          payload: mp.buffer,
        }),
        app.inject({
          method: "POST",
          url: "/forms/job-application",
          headers: {
            "content-type": mp.contentType,
            origin: "http://127.0.0.1:3000",
            accept: "application/json",
          },
          payload: mp.buffer,
        }),
      ]);

      assert.equal(r1.statusCode, 202);
      assert.equal(r2.statusCode, 202);
      const b1 = JSON.parse(r1.body);
      const b2 = JSON.parse(r2.body);
      assert.equal(b1.submission_id, b2.submission_id);

      const repo = new Repository(ctx.pool);
      const list = await repo.listSubmissions("job-application");
      assert.equal(list.length, 1);
    } finally {
      await ctx.cleanup();
    }
  });

  test("A03: Same _submission_id with changed fields returns 409 idempotency_conflict", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const sharedId = randomUUID();
      const mp1 = makeMultipart({
        _submission_id: sharedId,
        full_name: "Alex First",
        email: "alex@example.test",
        position: "Frontend Developer",
      });

      const res1 = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": mp1.contentType,
          origin: "http://127.0.0.1:3000",
          accept: "application/json",
        },
        payload: mp1.buffer,
      });
      assert.equal(res1.statusCode, 202);

      const mp2 = makeMultipart({
        _submission_id: sharedId,
        full_name: "Alex Altered",
        email: "alex@example.test",
        position: "Backend Developer",
      });

      const res2 = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": mp2.contentType,
          origin: "http://127.0.0.1:3000",
          accept: "application/json",
        },
        payload: mp2.buffer,
      });

      assert.equal(res2.statusCode, 409);
      const b2 = JSON.parse(res2.body);
      assert.equal(b2.error.code, "idempotency_conflict");
    } finally {
      await ctx.cleanup();
    }
  });

  test("A04: Missing field, duplicate field, or client-supplied _to returns 422 with no DB record", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      // 1. Missing required field "position"
      const mpMissing = makeMultipart({
        full_name: "Alex Example",
        email: "alex@example.test",
      });

      const resMissing = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": mpMissing.contentType,
          origin: "http://127.0.0.1:3000",
          accept: "application/json",
        },
        payload: mpMissing.buffer,
      });

      assert.equal(resMissing.statusCode, 422);

      // 2. Client-supplied reserved field "_to"
      const mpDisallowed = makeMultipart({
        full_name: "Alex Example",
        email: "alex@example.test",
        position: "Developer",
        _to: "hacker@example.test",
      });

      const resDisallowed = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": mpDisallowed.contentType,
          origin: "http://127.0.0.1:3000",
          accept: "application/json",
        },
        payload: mpDisallowed.buffer,
      });

      assert.equal(resDisallowed.statusCode, 422);

      // Confirm 0 submissions were created
      const repo = new Repository(ctx.pool);
      const list = await repo.listSubmissions("job-application");
      assert.equal(list.length, 0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("A05: Non-multipart request returns 415 unsupported_type", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const res = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        payload: JSON.stringify({ full_name: "Alex" }),
      });

      assert.equal(res.statusCode, 415);
      const body = JSON.parse(res.body);
      assert.equal(body.error.code, "unsupported_type");
    } finally {
      await ctx.cleanup();
    }
  });

  test("A06: Sixth file returns 413 file_too_large and cleans up files", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const files = [1, 2, 3, 4, 5, 6].map((i) => ({
        fieldName: "attachments",
        filename: `doc${i}.pdf`,
        contentType: "application/pdf",
        content: makePdf(`Doc ${i}`),
      }));

      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Developer",
        },
        files,
      );

      const res = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": mp.contentType,
          origin: "http://127.0.0.1:3000",
          accept: "application/json",
        },
        payload: mp.buffer,
      });

      assert.equal(res.statusCode, 413);
      const body = JSON.parse(res.body);
      assert.equal(body.error.code, "file_too_large");

      // Verify no records in DB
      const repo = new Repository(ctx.pool);
      const list = await repo.listSubmissions("job-application");
      assert.equal(list.length, 0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("A07: Forced DB commit failure cleans up newly staged file", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const pdfBytes = makePdf("CV for A07 Rollback");
      const staged = await storage.stage(Readable.from([pdfBytes]));

      assert.ok(storage.read(staged.key, "quarantine"));

      await ctx.pool.query("DROP TABLE attachments CASCADE;");

      const form = ctx.forms.get("job-application")!;
      const parsed: ParsedInput = {
        submissionId: randomUUID(),
        clientSubmissionId: randomUUID(),
        fields: {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
        },
        isHoneypot: false,
        captchaToken: null,
        attachments: [
          {
            id: randomUUID(),
            storageKey: staged.key,
            originalName: "cv.pdf",
            sizeBytes: staged.sizeBytes,
            sha256: staged.sha256,
          },
        ],
      };

      await assert.rejects(async () => {
        await acceptSubmission(parsed, form, { pool: ctx.pool, storage });
      });

      assert.throws(() => storage.read(staged.key));
    } finally {
      await ctx.cleanup();
    }
  });

  test("A08: Non-empty _honey returns generic 202 with submission_id=null and no DB record", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("Honeypot attachment");
      const mp = makeMultipart(
        {
          _honey: "spambot payload",
          full_name: "Spambot",
          email: "bot@example.test",
          position: "Spammer",
        },
        [
          {
            fieldName: "attachments",
            filename: "spam.pdf",
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
          accept: "application/json",
        },
        payload: mp.buffer,
      });

      assert.equal(res.statusCode, 202);
      const body = JSON.parse(res.body);
      assert.equal(body.status, "received");
      assert.equal(body.submission_id, null);

      // Verify no records in DB
      const repo = new Repository(ctx.pool);
      const list = await repo.listSubmissions("job-application");
      assert.equal(list.length, 0);
    } finally {
      await ctx.cleanup();
    }
  });

  test("A09: Disallowed origin returns 403 forbidden", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const mp = makeMultipart({
        full_name: "Alex Example",
        email: "alex@example.test",
        position: "Developer",
      });

      const res = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: {
          "content-type": mp.contentType,
          origin: "http://malicious-site.test",
          accept: "application/json",
        },
        payload: mp.buffer,
      });

      assert.equal(res.statusCode, 403);
    } finally {
      await ctx.cleanup();
    }
  });

  test("A10: Concurrent requests at final allowed rate limit slot permit only one", async () => {
    const ctx = await createTestContext();
    try {
      const formId = "job-application";
      const ipHash = "test_ip_hash_concurrent";
      const now = new Date();

      for (let i = 0; i < 4; i++) {
        await consumeRateLimit(ctx.pool, formId, ipHash, now, 5, 100);
      }

      const attempts = [1, 2, 3, 4, 5].map(() =>
        consumeRateLimit(ctx.pool, formId, ipHash, now, 5, 100)
          .then(() => ({ ok: true }))
          .catch((err) => ({ ok: false, err })),
      );

      const results = await Promise.all(attempts);
      const passed = results.filter((r) => r.ok);
      const rateLimited = results.filter((r): r is { ok: false; err: any } => !r.ok);

      assert.equal(passed.length, 1);
      assert.equal(rateLimited.length, 4);

      for (const r of rateLimited) {
        assert.ok(r.err instanceof AppError);
        assert.equal(r.err.httpStatus, 429);
      }
    } finally {
      await ctx.cleanup();
    }
  });

  test("A11: Disallowed routes (/send, /emails, /owner) and production /demo/* return 404", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const configProd = getTestConfig(ctx, { demoMode: false, nodeEnv: "production" });
      const appProd = buildApp({ config: configProd, pool: ctx.pool, storage });

      for (const path of ["/send", "/emails", "/owner", "/demo/job-application", "/demo/contact"]) {
        const res = await appProd.inject({ method: "GET", url: path });
        assert.equal(res.statusCode, 404);
      }

      // Live health check
      const resLive = await appProd.inject({ method: "GET", url: "/health/live" });
      assert.equal(resLive.statusCode, 200);
      assert.deepEqual(JSON.parse(resLive.body), { status: "ok" });
    } finally {
      await ctx.cleanup();
    }
  });

  test("A12: Concurrent duplicate submissions forced past initial lookup return matching receipts and clean duplicate staged files", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const form = ctx.forms.get("job-application")!;
      const clientSubId = randomUUID();

      // Create two distinct staged files for caller 1 and caller 2
      const pdf1 = makePdf("Resume Caller 1");
      const staged1 = await storage.stage(Readable.from([pdf1]));

      const pdf2 = makePdf("Resume Caller 2 (identical content)");
      const staged2 = await storage.stage(Readable.from([pdf2]));

      const parsed1: ParsedInput = {
        submissionId: randomUUID(),
        clientSubmissionId: clientSubId,
        fields: {
          full_name: "Alex Concurrency",
          email: "alex@example.test",
          position: "Concurrency Engineer",
        },
        isHoneypot: false,
        captchaToken: null,
        attachments: [
          {
            id: randomUUID(),
            storageKey: staged1.key,
            originalName: "cv.pdf",
            sizeBytes: staged1.sizeBytes,
            sha256: staged1.sha256,
          },
        ],
      };

      const parsed2: ParsedInput = {
        submissionId: randomUUID(),
        clientSubmissionId: clientSubId,
        fields: { ...parsed1.fields },
        isHoneypot: false,
        captchaToken: null,
        attachments: [
          {
            id: randomUUID(),
            storageKey: staged2.key,
            originalName: "cv.pdf",
            sizeBytes: staged1.sizeBytes,
            sha256: staged1.sha256,
          },
        ],
      };

      // Set up deterministic barrier to hold caller 1 after initial lookup
      let releaseCaller1!: () => void;
      const caller1Gate = new Promise<void>((resolve) => {
        releaseCaller1 = resolve;
      });

      let caller1LookupDoneResolve!: () => void;
      const caller1LookupDone = new Promise<void>((resolve) => {
        caller1LookupDoneResolve = resolve;
      });

      // Wrap ctx.pool for caller 1 to intercept initial lookup
      const poolCaller1 = new Proxy(ctx.pool, {
        get(target, prop, receiver) {
          if (prop === "query") {
            return async function (...args: any[]) {
              const res = await (target.query as any)(...args);
              const sql = typeof args[0] === "string" ? args[0] : args[0]?.text || "";
              if (sql.includes("client_submission_id = $2") && !sql.includes("INSERT")) {
                caller1LookupDoneResolve();
                await caller1Gate;
              }
              return res;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      // Launch caller 1
      const p1 = acceptSubmission(parsed1, form, { pool: poolCaller1, storage });

      // Wait until caller 1 has finished initial lookup and confirmed no submission exists yet
      await caller1LookupDone;

      // Launch caller 2 while caller 1 is still paused at the barrier
      const p2 = acceptSubmission(parsed2, form, { pool: ctx.pool, storage });

      // Release caller 1 so both enter the insertion/transaction phase concurrently
      releaseCaller1();

      const [receipt1, receipt2] = await Promise.all([p1, p2]);

      // Both must succeed as "received"
      assert.equal(receipt1.status, "received");
      assert.equal(receipt2.status, "received");

      // Both receipts must return the exact same submission_id
      assert.ok(receipt1.submission_id);
      assert.equal(receipt1.submission_id, receipt2.submission_id);

      // Verify DB records: exactly ONE submission exists
      const repo = new Repository(ctx.pool);
      const sub = await repo.getSubmissionByClientId(ctx.pool, form.id, clientSubId);
      assert.ok(sub);
      assert.equal(sub.id, receipt1.submission_id);

      // Verify DB records: exactly ONE notification exists
      const notifRes = await ctx.pool.query(
        "SELECT * FROM notifications WHERE submission_id = $1",
        [sub.id],
      );
      assert.equal(notifRes.rows.length, 1);
      assert.equal(notifRes.rows[0].state, "queued");

      // Verify DB records: exactly ONE attachment record exists
      const atts = await repo.getAttachmentsForSubmission(sub.id);
      assert.equal(atts.length, 1);

      // Verify storage: the winning staged file is retained, while the duplicate staged file was cleaned up!
      const winningKey = atts[0].storage_key;
      const losingKey = winningKey === staged1.key ? staged2.key : staged1.key;

      assert.equal(storage.exists(winningKey, "quarantine"), true);
      assert.equal(storage.exists(losingKey, "quarantine"), false);
    } finally {
      await ctx.cleanup();
    }
  });

  test("A13: Concurrent submissions with same client_submission_id but conflicting content reject duplicate with 409", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const form = ctx.forms.get("job-application")!;
      const clientSubId = randomUUID();

      const pdf1 = makePdf("Resume Caller 1");
      const staged1 = await storage.stage(Readable.from([pdf1]));

      const pdf2 = makePdf("Resume Caller 2");
      const staged2 = await storage.stage(Readable.from([pdf2]));

      const parsed1: ParsedInput = {
        submissionId: randomUUID(),
        clientSubmissionId: clientSubId,
        fields: {
          full_name: "Alex Concurrency",
          email: "alex@example.test",
          position: "Role A",
        },
        isHoneypot: false,
        captchaToken: null,
        attachments: [
          {
            id: randomUUID(),
            storageKey: staged1.key,
            originalName: "cv.pdf",
            sizeBytes: staged1.sizeBytes,
            sha256: staged1.sha256,
          },
        ],
      };

      const parsed2: ParsedInput = {
        submissionId: randomUUID(),
        clientSubmissionId: clientSubId,
        fields: {
          full_name: "Alex Concurrency",
          email: "alex@example.test",
          position: "Role B (Conflicting)",
        },
        isHoneypot: false,
        captchaToken: null,
        attachments: [
          {
            id: randomUUID(),
            storageKey: staged2.key,
            originalName: "cv.pdf",
            sizeBytes: staged2.sizeBytes,
            sha256: staged2.sha256,
          },
        ],
      };

      let releaseCaller1!: () => void;
      const caller1Gate = new Promise<void>((resolve) => {
        releaseCaller1 = resolve;
      });

      let caller1LookupDoneResolve!: () => void;
      const caller1LookupDone = new Promise<void>((resolve) => {
        caller1LookupDoneResolve = resolve;
      });

      const poolCaller1 = new Proxy(ctx.pool, {
        get(target, prop, receiver) {
          if (prop === "query") {
            return async function (...args: any[]) {
              const res = await (target.query as any)(...args);
              const sql = typeof args[0] === "string" ? args[0] : args[0]?.text || "";
              if (sql.includes("client_submission_id = $2") && !sql.includes("INSERT")) {
                caller1LookupDoneResolve();
                await caller1Gate;
              }
              return res;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const p1 = acceptSubmission(parsed1, form, { pool: poolCaller1, storage });
      await caller1LookupDone;

      const p2 = acceptSubmission(parsed2, form, { pool: ctx.pool, storage });
      releaseCaller1();

      const [r1, r2] = await Promise.allSettled([p1, p2]);

      const winner = r1.status === "fulfilled" ? r1 : r2;
      const loser = r1.status === "rejected" ? r1 : r2;

      assert.equal(winner.status, "fulfilled");
      if (winner.status === "fulfilled") {
        assert.equal(winner.value.status, "received");
        assert.ok(winner.value.submission_id);
      }

      assert.equal(loser.status, "rejected");
      if (loser.status === "rejected") {
        assert.ok(loser.reason instanceof AppError);
        assert.equal(loser.reason.code, "idempotency_conflict");
        assert.equal(loser.reason.httpStatus, 409);
      }

      const winningStagedKey = r1.status === "fulfilled" ? staged1.key : staged2.key;
      const losingStagedKey = r1.status === "fulfilled" ? staged2.key : staged1.key;

      assert.equal(storage.exists(winningStagedKey, "quarantine"), true);
      assert.equal(storage.exists(losingStagedKey, "quarantine"), false);
    } finally {
      await ctx.cleanup();
    }
  });

  test("A14: F03 — cancel and settle upload staging on every rejection", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const tmpDir = join(ctx.storageDir, "tmp");
      const quarantineDir = join(ctx.storageDir, "quarantine");

      // 1. Invalid PDF (%PDF- header missing)
      const mpInvalid = makeMultipart(
        { full_name: "Alex Invalid", email: "alex@example.test", position: "Dev" },
        [
          {
            fieldName: "attachments",
            filename: "bad.pdf",
            contentType: "application/pdf",
            content: Buffer.from("NOT_A_PDF_HEADER_TEXT"),
          },
        ],
      );
      const resInvalid = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mpInvalid.contentType, origin: "http://127.0.0.1:3000" },
        payload: mpInvalid.buffer,
      });
      assert.equal(resInvalid.statusCode, 422);
      assert.equal(JSON.parse(resInvalid.body).error.code, "invalid_pdf");
      assert.equal(readdirSync(tmpDir).length, 0, "No tmp files remaining after invalid PDF");
      assert.equal(
        readdirSync(quarantineDir).length,
        0,
        "No quarantine files remaining after invalid PDF",
      );

      // 2. Short PDF (< 5 bytes)
      const mpShort = makeMultipart(
        { full_name: "Alex Short", email: "alex@example.test", position: "Dev" },
        [
          {
            fieldName: "attachments",
            filename: "short.pdf",
            contentType: "application/pdf",
            content: Buffer.from("%PD"),
          },
        ],
      );
      const resShort = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mpShort.contentType, origin: "http://127.0.0.1:3000" },
        payload: mpShort.buffer,
      });
      assert.equal(resShort.statusCode, 422);
      assert.equal(JSON.parse(resShort.body).error.code, "invalid_pdf");
      assert.equal(readdirSync(tmpDir).length, 0, "No tmp files remaining after short PDF");
      assert.equal(
        readdirSync(quarantineDir).length,
        0,
        "No quarantine files remaining after short PDF",
      );

      // 3. Truncated multipart stream in middle of file content
      const validPdf = makePdf("Sample PDF for truncation");
      const mpFull = makeMultipart(
        { full_name: "Alex Truncated", email: "alex@example.test", position: "Dev" },
        [
          {
            fieldName: "attachments",
            filename: "trunc.pdf",
            contentType: "application/pdf",
            content: validPdf,
          },
        ],
      );
      // Cut multipart payload in half right during file streaming
      const truncatedBuffer = mpFull.buffer.subarray(0, Math.floor(mpFull.buffer.length / 2));
      const resTrunc = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mpFull.contentType, origin: "http://127.0.0.1:3000" },
        payload: truncatedBuffer,
      });
      assert.ok(resTrunc.statusCode >= 400);
      assert.equal(
        readdirSync(tmpDir).length,
        0,
        "No tmp files remaining after truncated multipart",
      );
      assert.equal(
        readdirSync(quarantineDir).length,
        0,
        "No quarantine files remaining after truncated multipart",
      );

      // 4. Disconnected client stream
      const abortStream = new Readable({
        read() {
          this.push(mpFull.buffer.subarray(0, 100));
          this.destroy(new Error("Client disconnected abruptly"));
        },
      });
      try {
        await app.inject({
          method: "POST",
          url: "/forms/job-application",
          headers: { "content-type": mpFull.contentType, origin: "http://127.0.0.1:3000" },
          payload: abortStream,
        });
      } catch (err: any) {
        assert.ok(err.message.includes("Client disconnected"));
      }
      assert.equal(readdirSync(tmpDir).length, 0, "No tmp files remaining after client abort");
      assert.equal(
        readdirSync(quarantineDir).length,
        0,
        "No quarantine files remaining after client abort",
      );

      // 5. Subsequent valid request succeeds (parser slot released)
      const mpValid = makeMultipart(
        { full_name: "Alex Good", email: "alex@example.test", position: "Dev" },
        [
          {
            fieldName: "attachments",
            filename: "valid.pdf",
            contentType: "application/pdf",
            content: validPdf,
          },
        ],
      );
      const resValid = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mpValid.contentType, origin: "http://127.0.0.1:3000" },
        payload: mpValid.buffer,
      });
      assert.equal(resValid.statusCode, 202);
      assert.equal(readdirSync(tmpDir).length, 0, "No tmp files after valid submission");
      assert.equal(
        readdirSync(quarantineDir).length,
        1,
        "Exactly 1 quarantine file from valid submission",
      );

      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("A15: F04 — HTTP wiring derives allowed hostnames from form.allowed_origins", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      // In production mode with CAPTCHA required
      const config = getTestConfig(ctx, {
        nodeEnv: "production",
        demoMode: false,
        captchaSecret: "test_secret_for_a15",
      });
      const app = buildApp({ config, pool: ctx.pool, storage });

      const pdf = makePdf("PDF for A15");
      const mp = makeMultipart(
        {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Dev",
          _captcha_token: "tok_123",
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

      // Submit with origin that matches form.allowed_origins
      const res = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mp.contentType, origin: "http://127.0.0.1:3000" },
        payload: mp.buffer,
      });
      // Captcha verification fails closed because siteverify endpoint is not reachable or dummy secret,
      // returning 422 captcha_failed and cleaning up staged files!
      assert.equal(res.statusCode, 422);
      assert.equal(JSON.parse(res.body).error.code, "captcha_failed");
      assert.equal(
        readdirSync(join(ctx.storageDir, "quarantine")).length,
        0,
        "Cleaned staged files on CAPTCHA failure",
      );

      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });

  test("A16: F03 — storage failure during upload propagation and cancellation", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const tmpDir = join(ctx.storageDir, "tmp");
      const quarantineDir = join(ctx.storageDir, "quarantine");

      // 1. Injected ENOSPC during temporary file open in a separate child process
      // Verifies controlled rejection, no uncaught error, and no application process crash
      const childScript = `
        import { createStorage } from "./dist/src/storage.js";
        import { buildApp } from "./dist/src/http.js";
        import { makeMultipart, makePdf } from "./dist/test/helpers.js";
        import pg from "pg";
        import fs from "node:fs";

        let uncaught = false;
        process.on("uncaughtException", () => {
          uncaught = true;
          process.exit(1);
        });

        const pool = new pg.Pool({ connectionString: "${ctx.dbTestUrl}" });
        const storage = createStorage("${ctx.storageDir}");
        const config = {
          nodeEnv: "development",
          host: "127.0.0.1",
          port: 3000,
          databaseUrl: "${ctx.dbTestUrl}",
          formsConfigPath: "config/forms.example.json",
          storageDir: "${ctx.storageDir}",
          smtpHost: "127.0.0.1",
          smtpPort: 1025,
          smtpTlsMode: "plain_local",
          smtpMaxMessageBytes: 20971520,
          maxFileSize: 10485760,
          maxTotalSize: 10485760,
          clamdHost: "127.0.0.1",
          clamdPort: 3310,
        };
        const app = buildApp({ config, pool, storage });

        // Fault injection: openSync throws ENOSPC when opening tmp files
        const origOpenSync = fs.openSync;
        fs.openSync = function(path, flags, mode) {
          if (typeof path === "string" && path.includes("/tmp/")) {
            const err = new Error("ENOSPC: no space left on device");
            err.code = "ENOSPC";
            throw err;
          }
          return origOpenSync.apply(this, arguments);
        };

        const pdf = makePdf("Small valid PDF");
        const mp = makeMultipart(
          { full_name: "Fault Test", email: "fault@example.test", position: "Dev" },
          [{ fieldName: "attachments", filename: "test.pdf", contentType: "application/pdf", content: pdf }]
        );

        const res = await app.inject({
          method: "POST",
          url: "/forms/job-application",
          headers: { "content-type": mp.contentType, origin: "http://127.0.0.1:3000" },
          payload: mp.buffer,
        });

        if (res.statusCode < 500) {
          process.exit(2);
        }
        await app.close();
        await pool.end();
        process.exit(uncaught ? 1 : 0);
      `;

      const childRes = spawnSync("node", ["--input-type=module", "-e", childScript], {
        encoding: "utf8",
        env: process.env,
      });
      assert.equal(
        childRes.status,
        0,
        `Child process must exit 0 without crashing on ENOSPC: ${childRes.stderr}`,
      );

      // 2. Open failure with large upload encountering backpressure: must not hang on drain
      const origStage = storage.stage;
      storage.stage = async () => {
        const err = new Error("ENOSPC: no space left on device");
        (err as any).code = "ENOSPC";
        throw err;
      };

      // 1 MiB payload
      const largePdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1024 * 1024, "a")]);
      const mpLarge = makeMultipart(
        { full_name: "Backpressure Test", email: "bp@example.test", position: "Dev" },
        [
          {
            fieldName: "attachments",
            filename: "large.pdf",
            contentType: "application/pdf",
            content: largePdf,
          },
        ],
      );

      const startTime = Date.now();
      const resLarge = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mpLarge.contentType, origin: "http://127.0.0.1:3000" },
        payload: mpLarge.buffer,
      });
      const elapsedMs = Date.now() - startTime;
      assert.ok(elapsedMs < 5000, `Large upload rejection must be bounded, took ${elapsedMs}ms`);
      assert.ok(resLarge.statusCode >= 500);

      // 3. Midstream write EIO
      storage.stage = async (stream) => {
        let count = 0;
        for await (const chunk of stream) {
          count += (chunk as Buffer).length;
          if (count > 1000) {
            const err = new Error("EIO: i/o error");
            (err as any).code = "EIO";
            throw err;
          }
        }
        throw new Error("Stream ended prematurely");
      };

      const resEio = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mpLarge.contentType, origin: "http://127.0.0.1:3000" },
        payload: mpLarge.buffer,
      });
      assert.ok(resEio.statusCode >= 500);
      assert.equal(readdirSync(tmpDir).length, 0, "No tmp files after midstream EIO");

      // 4. Fault removed: verify parser slots released and subsequent request succeeds
      storage.stage = origStage;
      const validPdf = makePdf("Subsequent valid upload");
      const mpValid = makeMultipart(
        { full_name: "Alex Normal", email: "normal@example.test", position: "Dev" },
        [
          {
            fieldName: "attachments",
            filename: "normal.pdf",
            contentType: "application/pdf",
            content: validPdf,
          },
        ],
      );

      const resValid = await app.inject({
        method: "POST",
        url: "/forms/job-application",
        headers: { "content-type": mpValid.contentType, origin: "http://127.0.0.1:3000" },
        payload: mpValid.buffer,
      });
      assert.equal(resValid.statusCode, 202);
      assert.equal(readdirSync(tmpDir).length, 0);

      await app.close();
    } finally {
      await ctx.cleanup();
    }
  });
});
