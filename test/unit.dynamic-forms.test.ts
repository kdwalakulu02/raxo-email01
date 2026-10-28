import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  generate192BitFormId,
  generateToken,
  computeTokenHash,
  validateRecipientEmail,
  generateHtmlSnippet,
} from "../src/forms.js";
import { AppError } from "../src/errors.js";

describe("Phase 1: Dynamic Forms Unit Tests", () => {
  test("Form ID Generation: 192-bit cryptographic randomness and URL-safety", () => {
    const id = generate192BitFormId();
    // 192 bits = 24 bytes base64url encoded = 32 characters
    assert.equal(id.length, 32);
    assert.match(id, /^[A-Za-z0-9_-]{32}$/, "Must only contain URL-safe base64url characters");

    // Test uniqueness across 5,000 generations
    const set = new Set<string>();
    const count = 5000;
    for (let i = 0; i < count; i++) {
      const generated = generate192BitFormId();
      assert.equal(generated.length, 32);
      set.add(generated);
    }
    assert.equal(set.size, count, "All 5,000 generated 192-bit IDs must be strictly unique");
  });

  test("Token Generation: 256-bit single-use tokens and SHA-256 hash digests", () => {
    const { token, hash } = generateToken(32);
    // 256 bits = 32 bytes base64url = ~43 chars
    assert.ok(token.length >= 42);
    assert.equal(hash.length, 64, "SHA-256 hash must be 64 hex characters");
    assert.equal(computeTokenHash(token), hash, "Token hash must match deterministic SHA-256");

    // Modifying one character must produce completely different hash
    const modifiedToken = token.slice(0, -1) + (token.slice(-1) === "a" ? "b" : "a");
    assert.notEqual(computeTokenHash(modifiedToken), hash);
  });

  test("Recipient Email Validation: RFC format, length limits, and CRLF injection rejection", () => {
    // Valid emails
    assert.equal(validateRecipientEmail("alex@example.com"), "alex@example.com");
    assert.equal(
      validateRecipientEmail("  User.Name+tag@Sub.Domain.co.uk  "),
      "user.name+tag@sub.domain.co.uk",
    );
    assert.equal(validateRecipientEmail("dev@test.local.corp"), "dev@test.local.corp");

    // Invalid format
    assert.throws(
      () => validateRecipientEmail("plainaddress"),
      (err: unknown) =>
        err instanceof AppError && err.safeMessage.includes("Invalid recipient email format"),
    );
    assert.throws(
      () => validateRecipientEmail("@missing-username.com"),
      (err: unknown) =>
        err instanceof AppError && err.safeMessage.includes("Invalid recipient email format"),
    );
    assert.throws(
      () => validateRecipientEmail("username@.com"),
      (err: unknown) =>
        err instanceof AppError && err.safeMessage.includes("Invalid recipient email format"),
    );

    // Empty or non-string
    assert.throws(
      () => validateRecipientEmail(""),
      (err: unknown) => err instanceof AppError && err.safeMessage.includes("cannot be empty"),
    );
    assert.throws(
      () => validateRecipientEmail(null),
      (err: unknown) => err instanceof AppError && err.safeMessage.includes("is required"),
    );

    // CRLF injection attempt
    assert.throws(
      () => validateRecipientEmail("victim@example.com\r\nBcc: attacker@example.com"),
      (err: unknown) =>
        err instanceof AppError && err.safeMessage.includes("forbidden control characters"),
    );
    assert.throws(
      () => validateRecipientEmail("victim@example.com\nSubject: Injected"),
      (err: unknown) =>
        err instanceof AppError && err.safeMessage.includes("forbidden control characters"),
    );

    // Excessive length (>254 chars)
    const longLocal = "a".repeat(250);
    assert.throws(
      () => validateRecipientEmail(`${longLocal}@example.com`),
      (err: unknown) => err instanceof AppError && err.safeMessage.includes("maximum length"),
    );
  });

  test("HTML Snippet Generation: Privacy and standard form compliance", () => {
    const formId = "dGVzdC0xOTItYml0LWZvcm0taWQxMjM0";
    const snippet = generateHtmlSnippet("https://forms.example.com", formId);

    // Form action must point to /f/:formId
    assert.ok(
      snippet.includes('action="https://forms.example.com/f/dGVzdC0xOTItYml0LWZvcm0taWQxMjM0"'),
    );
    assert.ok(snippet.includes('method="POST"'));

    // Privacy verification: receiving email must NEVER be present in the snippet
    const receivingEmail = "owner-private@business.test";
    assert.equal(snippet.includes(receivingEmail), false);
    assert.equal(snippet.includes("mailto:"), false);

    // Honeypot field must be present
    assert.ok(snippet.includes('name="_honey"'));

    // Standard required fields present
    assert.ok(snippet.includes('name="name"'));
    assert.ok(snippet.includes('name="email"'));
    assert.ok(snippet.includes('name="message"'));
  });
});
