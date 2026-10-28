import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { createHash, randomUUID } from "node:crypto";
import { buildNotification } from "../src/mime.js";
import { classifySmtpError } from "../src/smtp.js";
import { makePdf } from "./helpers.js";
import { AppError } from "../src/errors.js";
import type { FormConfig } from "../src/types.js";

describe("U05 & U06: MIME Generation and SMTP Outcome Classification", () => {
  const sampleForm: FormConfig = {
    id: "job-application",
    enabled: true,
    from: "notifications@example.test",
    recipient: "owner@example.test",
    subject_prefix: "Job application",
    reply_to_field: "email",
    success_url: null,
    allowed_origins: ["http://127.0.0.1:3000"],
    fields: [
      { name: "full_name", type: "text", required: true, max_length: 120 },
      { name: "email", type: "email", required: true, max_length: 254 },
      { name: "position", type: "text", required: true, max_length: 120 },
      { name: "portfolio", type: "url", required: false, max_length: 500 },
      { name: "message", type: "text", required: false, max_length: 4000 },
    ],
  };

  test("MIME: Parse generated notification with mailparser and verify all headers and attachments", async () => {
    const submissionId = randomUUID();
    const messageId = `<${randomUUID()}@notifications.example.test>`;
    const pdfBytes = makePdf("Alex Resume Fixture");
    const expectedPdfSha256 = createHash("sha256").update(pdfBytes).digest("hex");

    const mimeBuffer = await buildNotification(
      sampleForm,
      {
        submissionId,
        createdAt: new Date("2026-10-25T10:00:00Z"),
        fields: {
          full_name: "Alex Example",
          email: "alex@example.test",
          position: "Frontend Developer",
          portfolio: "https://example.test/alex",
          message: "Synthetic message text",
        },
        messageId,
      },
      [
        {
          filename: "alex_resume.pdf",
          content: pdfBytes,
        },
      ],
    );

    // Parse the generated raw MIME using mailparser
    const parsed = await simpleParser(mimeBuffer);

    // Assert From, To, Reply-To
    const toAddress = Array.isArray(parsed.to)
      ? parsed.to[0]?.value[0]?.address
      : parsed.to?.value[0]?.address;
    const fromAddress = Array.isArray(parsed.from)
      ? parsed.from[0]?.value[0]?.address
      : parsed.from?.value[0]?.address;
    const replyToAddress = Array.isArray(parsed.replyTo)
      ? parsed.replyTo[0]?.value[0]?.address
      : parsed.replyTo?.value[0]?.address;

    assert.equal(fromAddress, "notifications@example.test");
    assert.equal(toAddress, "owner@example.test");
    assert.equal(replyToAddress, "alex@example.test");

    // Assert Subject
    assert.equal(parsed.subject, `Job application — ${submissionId}`);

    // Assert Message-ID
    assert.equal(parsed.messageId, messageId);

    // Assert Plain-text Body
    assert.ok(parsed.text);
    assert.ok(parsed.text.includes("Receipt ID:"));
    assert.ok(parsed.text.includes(submissionId));
    assert.ok(parsed.text.includes("Alex Example"));
    assert.ok(parsed.text.includes("alex@example.test"));
    assert.ok(parsed.text.includes("Frontend Developer"));

    // Assert Attachment Checksum and Type
    assert.equal(parsed.attachments.length, 1);
    const att = parsed.attachments[0];
    assert.equal(att.filename, "alex_resume.pdf");
    assert.equal(att.contentType, "application/pdf");
    const parsedAttSha256 = createHash("sha256").update(att.content).digest("hex");
    assert.equal(parsedAttSha256, expectedPdfSha256);
  });

  test("MIME: Oversized MIME throws mime_too_large", async () => {
    const submissionId = randomUUID();
    const messageId = `<${randomUUID()}@notifications.example.test>`;
    const pdfBytes = Buffer.alloc(1000);

    await assert.rejects(
      async () => {
        await buildNotification(
          sampleForm,
          {
            submissionId,
            createdAt: new Date(),
            fields: { full_name: "Alex", email: "alex@example.test", position: "Dev" },
            messageId,
          },
          [{ filename: "large.pdf", content: pdfBytes }],
          500, // cap 500 bytes
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "mime_too_large");
        assert.equal(err.httpStatus, 413);
        return true;
      },
    );
  });

  test("U05: Explicit SMTP 4xx temporary failure maps to safe_retry", () => {
    const res421 = classifySmtpError({
      responseCode: 421,
      message: "421 Service not available, closing transmission channel",
    });
    assert.equal(res421.kind, "safe_retry");
    assert.equal(res421.code, "smtp_421");

    const res450 = classifySmtpError({ responseCode: 450, message: "450 Mailbox busy" });
    assert.equal(res450.kind, "safe_retry");
    assert.equal(res450.code, "smtp_450");
  });

  test("U05: Explicit SMTP 5xx permanent refusal maps to failed", () => {
    const res550 = classifySmtpError({ responseCode: 550, message: "550 User unknown" });
    assert.equal(res550.kind, "failed");
    assert.equal(res550.code, "smtp_550");

    const res554 = classifySmtpError({ responseCode: 554, message: "554 Transaction failed" });
    assert.equal(res554.kind, "failed");
    assert.equal(res554.code, "smtp_554");
  });

  test("U05: Pre-connect network failure maps to safe_retry", () => {
    const resConn = classifySmtpError({
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED 127.0.0.1:1025",
    });
    assert.equal(resConn.kind, "safe_retry");
    assert.equal(resConn.code, "econnrefused");
  });

  test("U05: Authentication failure maps to failed", () => {
    const resAuth = classifySmtpError({
      code: "EAUTH",
      message: "Invalid login: 535 Authentication failed",
    });
    assert.equal(resAuth.kind, "failed");
    assert.equal(resAuth.code, "eauth");
  });

  test("U06: Timeout or disconnect after/during DATA maps to unknown, never safe_retry", () => {
    // 1. Error with command DATA
    const resDataTimeout = classifySmtpError({
      command: "DATA",
      code: "ETIMEDOUT",
      message: "Connection timed out during DATA phase",
    });
    assert.equal(resDataTimeout.kind, "unknown");

    // 2. Error during end of DATA
    const resEndData = classifySmtpError({
      command: "END",
      code: "ECONNRESET",
      message: "Socket closed remotely after DATA transmission",
    });
    assert.equal(resEndData.kind, "unknown");

    // 3. Disconnect after DATA with ECONNRESET
    const resDataReset = classifySmtpError({
      command: "DATA",
      code: "ECONNRESET",
    });
    assert.equal(resDataReset.kind, "unknown");
    assert.equal(resDataReset.code, "econnreset");
  });

  test("U06: ETIMEDOUT with command=CONN and timeoutType=SOCKET_TIMEOUT maps to unknown", () => {
    // Nodemailer defaults command='CONN' even for generic SOCKET_TIMEOUT, which can occur during or after DATA.
    // Without reliable pre-submission evidence, it must remain unknown.
    const resSocketTimeout = classifySmtpError({
      code: "ETIMEDOUT",
      command: "CONN",
      timeoutType: "SOCKET_TIMEOUT",
    });
    assert.equal(resSocketTimeout.kind, "unknown");
    assert.equal(resSocketTimeout.code, "etimedout");
  });

  test("U06: Ambiguous ETIMEDOUT without reliable pre-submission timeoutType defaults to unknown", () => {
    // Missing timeoutType or command='CONN' alone cannot prove pre-submission stage
    const resNoCommand = classifySmtpError({
      code: "ETIMEDOUT",
    });
    assert.equal(resNoCommand.kind, "unknown");
    assert.equal(resNoCommand.code, "etimedout");

    const resConnNoType = classifySmtpError({
      code: "ETIMEDOUT",
      command: "CONN",
    });
    assert.equal(resConnNoType.kind, "unknown");
    assert.equal(resConnNoType.code, "etimedout");
  });

  test("U06: Proven pre-submission timeouts (CONNECT_TIMEOUT, GREETING_TIMEOUT, UPGRADE_TIMEOUT) map to safe_retry", () => {
    const resConnect = classifySmtpError({
      code: "ETIMEDOUT",
      timeoutType: "CONNECT_TIMEOUT",
    });
    assert.equal(resConnect.kind, "safe_retry");
    assert.equal(resConnect.code, "etimedout");

    const resGreeting = classifySmtpError({
      code: "ETIMEDOUT",
      timeoutType: "GREETING_TIMEOUT",
    });
    assert.equal(resGreeting.kind, "safe_retry");
    assert.equal(resGreeting.code, "etimedout");

    const resUpgrade = classifySmtpError({
      code: "ETIMEDOUT",
      timeoutType: "UPGRADE_TIMEOUT",
    });
    assert.equal(resUpgrade.kind, "safe_retry");
    assert.equal(resUpgrade.code, "etimedout");
  });

  test("U06: Unrecognized arbitrary error maps to unknown, never safe_retry", () => {
    const resUnknown = classifySmtpError({
      message: "Something strange happened inside internal transport",
    });
    assert.equal(resUnknown.kind, "unknown");
  });
});
