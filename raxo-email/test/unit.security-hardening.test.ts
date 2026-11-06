import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { validateNextUrl } from "../src/http.js";

describe("Security Hardening Unit Tests", () => {
  test("Open Redirect Protection: validateNextUrl rejects dangerous schemes and protocol-relative URLs", () => {
    // Protocol-relative URLs
    assert.equal(validateNextUrl("//attacker.com"), null);
    assert.equal(validateNextUrl("//attacker.com/thanks"), null);
    assert.equal(validateNextUrl("\\\\attacker.com"), null);
    assert.equal(validateNextUrl("/\\attacker.com"), null);

    // Dangerous pseudo-protocols
    assert.equal(validateNextUrl("javascript:alert(1)"), null);
    assert.equal(validateNextUrl("data:text/html,<script>alert(1)</script>"), null);
    assert.equal(validateNextUrl("file:///etc/passwd"), null);

    // Empty or non-string
    assert.equal(validateNextUrl(""), null);
    assert.equal(validateNextUrl("   "), null);
    assert.equal(validateNextUrl(null), null);
    assert.equal(validateNextUrl(undefined), null);
  });

  test("Open Redirect Protection: validateNextUrl permits safe relative paths", () => {
    assert.equal(validateNextUrl("/"), "/");
    assert.equal(validateNextUrl("/thanks"), "/thanks");
    assert.equal(validateNextUrl("/thank-you.html?status=ok"), "/thank-you.html?status=ok");
  });

  test("Open Redirect Protection: validateNextUrl verifies host against Origin/Referer for dynamic forms", () => {
    const origin = "https://mybusiness.com";

    // Same host matches
    assert.equal(
      validateNextUrl("https://mybusiness.com/thanks.html", origin),
      "https://mybusiness.com/thanks.html",
    );
    // Subdomain matches
    assert.equal(
      validateNextUrl("https://app.mybusiness.com/welcome", origin),
      "https://app.mybusiness.com/welcome",
    );

    // Host mismatch is strictly blocked
    assert.equal(
      validateNextUrl("https://evil-phishing.com/harvest", origin),
      null,
      "External attacker domain must be blocked as an open redirect",
    );
  });

  test("Open Redirect Protection: validateNextUrl respects explicit form allowed_origins", () => {
    const allowedOrigins = ["https://partner.com", "https://trusted.org"];

    assert.equal(
      validateNextUrl("https://partner.com/done", undefined, undefined, allowedOrigins),
      "https://partner.com/done",
    );
    assert.equal(
      validateNextUrl("https://trusted.org/receipt", undefined, undefined, allowedOrigins),
      "https://trusted.org/receipt",
    );
    assert.equal(
      validateNextUrl("https://untrusted.com/page", undefined, undefined, allowedOrigins),
      null,
    );
  });
});
