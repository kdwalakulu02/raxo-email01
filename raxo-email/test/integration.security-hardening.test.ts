import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createTestContext } from "./helpers.js";
import { createStorage } from "../src/storage.js";
import { buildApp } from "../src/http.js";
import { createDynamicForm, getDynamicFormByPublicId } from "../src/forms.js";
import type { AppConfig } from "../src/types.js";

describe("Security Hardening & Abuse Protection Integration Tests", () => {
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
  test("S01: Link prefetching (Purpose: prefetch) does NOT activate form or burn verification token", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      // Create pending form
      const { formId, verificationToken } = await createDynamicForm(
        ctx.pool,
        "owner-prefetch@business.test",
      );

      // Automated scanner sends GET with Purpose: prefetch
      const prefetchRes = await app.inject({
        method: "GET",
        url: `/verify?token=${verificationToken}`,
        headers: {
          purpose: "prefetch",
        },
      });

      assert.equal(prefetchRes.statusCode, 200);
      assert.equal(prefetchRes.headers["x-robots-tag"], "noindex, nofollow");
      assert.ok(
        prefetchRes.body.includes("Link prefetch detected") ||
          prefetchRes.body.includes("Confirm Email Verification"),
        "Must render prefetch confirmation rather than auto-activating",
      );

      // Verify form is STILL pending and token is NOT consumed
      const formStillPending = await getDynamicFormByPublicId(ctx.pool, formId);
      assert.equal(formStillPending?.status, "pending_verification");
      assert.ok(
        formStillPending?.verification_token_hash !== null,
        "Token hash must remain unburned after prefetch",
      );

      // Subsequent genuine verification succeeds
      const genuineRes = await app.inject({
        method: "GET",
        url: `/verify?token=${verificationToken}`,
      });
      assert.equal(genuineRes.statusCode, 200);
      assert.ok(genuineRes.body.includes("Email Verified Successfully"));

      const formActivated = await getDynamicFormByPublicId(ctx.pool, formId);
      assert.equal(formActivated?.status, "active");
    } finally {
      await ctx.cleanup();
    }
  });

  test("S02: Explicit POST /verify endpoint activates form and promotes held notifications", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const { formId, verificationToken } = await createDynamicForm(
        ctx.pool,
        "owner-postverify@business.test",
      );

      // Submit while pending -> held_unverified
      await app.inject({
        method: "POST",
        url: `/f/${formId}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "name=David&email=david@sender.test&message=Holding",
      });

      // Activate via explicit POST /verify with JSON accept
      const verifyRes = await app.inject({
        method: "POST",
        url: "/verify",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        payload: JSON.stringify({ token: verificationToken }),
      });

      assert.equal(verifyRes.statusCode, 200);
      const body = JSON.parse(verifyRes.body);
      assert.equal(body.status, "verified");
      assert.equal(body.form_id, formId);
      assert.equal(body.promoted_notifications, 1);

      // Check DB
      const form = await getDynamicFormByPublicId(ctx.pool, formId);
      assert.equal(form?.status, "active");
    } finally {
      await ctx.cleanup();
    }
  });

  test("S03: Open redirect protection on POST /f/:formId ignores external attacker URL", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const { formId, verificationToken } = await createDynamicForm(
        ctx.pool,
        "owner-redirect@business.test",
      );
      // Activate
      await app.inject({ method: "GET", url: `/verify?token=${verificationToken}` });

      // Attacker attempts open redirect to https://evil-phishing.test/harvest
      const attackRes = await app.inject({
        method: "POST",
        url: `/f/${formId}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://legit-site.test",
        },
        payload:
          "name=Eve&email=eve@attacker.test&message=Test&_next=https://evil-phishing.test/harvest",
      });

      // Must NOT redirect with 303 to evil-phishing.test
      assert.notEqual(attackRes.statusCode, 303);
      assert.equal(attackRes.statusCode, 202);
      assert.ok(
        attackRes.headers.location === undefined ||
          !attackRes.headers.location.includes("evil-phishing.test"),
        "Must not redirect to untrusted origin",
      );

      // Legitimate same-origin redirect succeeds with 303
      const legitRes = await app.inject({
        method: "POST",
        url: `/f/${formId}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://legit-site.test",
        },
        payload:
          "name=Alice&email=alice@sender.test&message=Hi&_next=https://legit-site.test/thank-you",
      });
      assert.equal(legitRes.statusCode, 303);
      assert.equal(legitRes.headers.location, "https://legit-site.test/thank-you");
    } finally {
      await ctx.cleanup();
    }
  });

  test("S04: Per-recipient registration rate limit prevents mail-bombing", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const targetEmail = "victim@target-corp.test";

      // 3 registrations permitted
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/forms",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": `198.51.100.${i + 1}`, // different IPs
          },
          payload: JSON.stringify({ email: targetEmail }),
        });
        assert.equal(res.statusCode, 201);
      }

      // 4th registration for the SAME email must be rate-limited
      const spamRes = await app.inject({
        method: "POST",
        url: "/api/forms",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.99",
        },
        payload: JSON.stringify({ email: targetEmail }),
      });

      assert.equal(spamRes.statusCode, 429);
      const body = JSON.parse(spamRes.body);
      assert.equal(body.error.code, "rate_limited");
      assert.ok(body.error.message.includes("email address"));
    } finally {
      await ctx.cleanup();
    }
  });

  test("S05: Deactivation endpoint enforces rate limits on brute-force attempts", async () => {
    const ctx = await createTestContext();
    try {
      const storage = createStorage(ctx.storageDir);
      const config = getTestConfig(ctx);
      const app = buildApp({ config, pool: ctx.pool, storage });

      const { formId } = await createDynamicForm(ctx.pool, "owner-bruteforce@business.test");

      // 5 failed deactivation attempts
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: "POST",
          url: `/f/${formId}/deactivate`,
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ management_token: `wrong-token-guess-${i}` }),
        });
        assert.equal(res.statusCode, 403);
      }

      // 6th attempt must be rate-limited with 429
      const blockedRes = await app.inject({
        method: "POST",
        url: `/f/${formId}/deactivate`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ management_token: "wrong-token-guess-6" }),
      });
      assert.equal(blockedRes.statusCode, 429);
      const body = JSON.parse(blockedRes.body);
      assert.equal(body.error.code, "rate_limited");
    } finally {
      await ctx.cleanup();
    }
  });
});
