import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseFormsConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { createTestContext } from "./helpers.js";
import { runMigrations } from "../src/migrate.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("U01 & U02: Configuration and Migration Unit Tests", () => {
  test("U01: Production + DEMO_MODE=true is rejected", async () => {
    await assert.rejects(
      async () => {
        await loadConfig({
          NODE_ENV: "production",
          DEMO_MODE: "true",
          DATABASE_URL: "postgres://raxo_demo:local_demo_only@127.0.0.1:55432/raxo_email_test",
          FORMS_CONFIG_PATH: "config/forms.example.json",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.match(err.safeMessage, /DEMO_MODE.*production/i);
        return true;
      },
    );
  });

  test("U01: DEMO_MODE=true on non-loopback host is rejected", async () => {
    await assert.rejects(
      async () => {
        await loadConfig({
          NODE_ENV: "development",
          DEMO_MODE: "true",
          HOST: "0.0.0.0",
          DATABASE_URL: "postgres://raxo_demo:local_demo_only@127.0.0.1:55432/raxo_email_test",
          FORMS_CONFIG_PATH: "config/forms.example.json",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.match(err.safeMessage, /requires loopback HOST/i);
        return true;
      },
    );
  });

  test("U01: Production rejects plain_local SMTP_TLS_MODE", async () => {
    await assert.rejects(
      async () => {
        await loadConfig({
          NODE_ENV: "production",
          DEMO_MODE: "false",
          HOST: "127.0.0.1",
          SMTP_TLS_MODE: "plain_local",
          IP_HASH_SECRET: "some-secret",
          CAPTCHA_SECRET: "some-captcha",
          DATABASE_URL: "postgres://raxo_demo:local_demo_only@127.0.0.1:55432/raxo_email_test",
          FORMS_CONFIG_PATH: "config/forms.example.json",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.match(err.safeMessage, /rejects plain_local/i);
        return true;
      },
    );
  });

  test("U02: Unknown config field, duplicate ID, bad address, invalid limits fail validation", () => {
    // Unknown field in forms.json
    assert.throws(
      () => {
        parseFormsConfig(
          JSON.stringify({
            version: 1,
            forms: [
              {
                id: "contact",
                enabled: true,
                from: "test@example.test",
                recipient: "owner@example.test",
                subject_prefix: "Test",
                reply_to_field: null,
                success_url: null,
                allowed_origins: ["http://127.0.0.1:3000"],
                fields: [],
                extra_unknown_field: "disallowed",
              },
            ],
          }),
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        return true;
      },
    );

    // Duplicate form IDs
    assert.throws(
      () => {
        parseFormsConfig(
          JSON.stringify({
            version: 1,
            forms: [
              {
                id: "contact",
                enabled: true,
                from: "test@example.test",
                recipient: "owner@example.test",
                subject_prefix: "Test 1",
                reply_to_field: null,
                success_url: null,
                allowed_origins: ["http://127.0.0.1:3000"],
                fields: [],
              },
              {
                id: "contact",
                enabled: true,
                from: "test@example.test",
                recipient: "owner@example.test",
                subject_prefix: "Test 2",
                reply_to_field: null,
                success_url: null,
                allowed_origins: ["http://127.0.0.1:3000"],
                fields: [],
              },
            ],
          }),
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.match(err.safeMessage, /Duplicate form id/i);
        return true;
      },
    );

    // Bad address with CRLF
    assert.throws(
      () => {
        parseFormsConfig(
          JSON.stringify({
            version: 1,
            forms: [
              {
                id: "contact",
                enabled: true,
                from: "test@example.test\r\nBcc: evil@example.test",
                recipient: "owner@example.test",
                subject_prefix: "Test",
                reply_to_field: null,
                success_url: null,
                allowed_origins: ["http://127.0.0.1:3000"],
                fields: [],
              },
            ],
          }),
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        return true;
      },
    );

    // Reserved field name
    assert.throws(
      () => {
        parseFormsConfig(
          JSON.stringify({
            version: 1,
            forms: [
              {
                id: "contact",
                enabled: true,
                from: "test@example.test",
                recipient: "owner@example.test",
                subject_prefix: "Test",
                reply_to_field: null,
                success_url: null,
                allowed_origins: ["http://127.0.0.1:3000"],
                fields: [{ name: "attachments", type: "text", required: true, max_length: 100 }],
              },
            ],
          }),
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.match(err.safeMessage, /reserved/i);
        return true;
      },
    );

    // reply_to_field not referencing an email field
    assert.throws(
      () => {
        parseFormsConfig(
          JSON.stringify({
            version: 1,
            forms: [
              {
                id: "contact",
                enabled: true,
                from: "test@example.test",
                recipient: "owner@example.test",
                subject_prefix: "Test",
                reply_to_field: "non_existent_email",
                success_url: null,
                allowed_origins: ["http://127.0.0.1:3000"],
                fields: [{ name: "some_field", type: "text", required: true, max_length: 100 }],
              },
            ],
          }),
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.match(err.safeMessage, /reply_to_field/i);
        return true;
      },
    );
  });

  test("Gate: Migration idempotence and checksum modification rejection", async () => {
    const ctx = await createTestContext();
    try {
      // Second run on the same pool/schema must apply 0 and skip 1
      const res = await runMigrations(ctx.pool);
      assert.equal(res.applied.length, 0);
      assert.deepEqual(res.skipped, ["001_initial", "002_dynamic_forms", "003_security_hardening", "004_scan_results"]);

      // Verify deliberately modified migration checksum fails
      const tempMigDir = mkdtempSync(join(tmpdir(), "raxo_mig_test_"));
      try {
        writeFileSync(join(tempMigDir, "001_initial.sql"), "-- modified migration sql\nSELECT 1;");
        await assert.rejects(
          async () => {
            await runMigrations(ctx.pool, tempMigDir);
          },
          (err: unknown) => {
            assert.ok(err instanceof AppError);
            assert.match(err.safeMessage, /checksum mismatch/i);
            return true;
          },
        );
      } finally {
        rmSync(tempMigDir, { recursive: true, force: true });
      }
    } finally {
      await ctx.cleanup();
    }
  });

  test("U08: F09 - Runtime directory isolation (.gitignore & .dockerignore for data/ and storage/)", () => {
    const gitignoreContent = readFileSync(resolve(process.cwd(), ".gitignore"), "utf8");
    const lines = gitignoreContent.split("\n").map((l) => l.trim());
    assert.ok(lines.includes("data/"), ".gitignore must include data/");
    assert.ok(lines.includes("storage/"), ".gitignore must include storage/");

    const dockerignoreContent = readFileSync(resolve(process.cwd(), ".dockerignore"), "utf8");
    const dlines = dockerignoreContent.split("\n").map((l) => l.trim());
    assert.ok(dlines.includes("data/"), ".dockerignore must include data/");
    assert.ok(dlines.includes("storage/"), ".dockerignore must include storage/");
  });
});
