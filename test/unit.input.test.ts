import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeText,
  normalizeEmail,
  normalizeUrl,
  sanitizeFilename,
  detectPdfBuffer,
} from "../src/multipart.js";
import { createStorage } from "../src/storage.js";
import { AppError } from "../src/errors.js";
import { makePdf } from "./helpers.js";

describe("U03 & U04: Input Validation, Sanitization, and Storage Primitives", () => {
  test("U03: CR/LF in email fields is rejected", () => {
    assert.throws(
      () => normalizeEmail("user@example.test\r\nBcc: victim@example.test"),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "invalid_form_data");
        assert.match(err.safeMessage, /header injection/i);
        return true;
      },
    );

    assert.throws(
      () => normalizeEmail("user<evil>@example.test"),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "invalid_form_data");
        return true;
      },
    );
  });

  test("U03: Path traversal filename is sanitized to safe display name", () => {
    const s1 = sanitizeFilename("../../../etc/passwd.pdf");
    assert.equal(s1, "______etc_passwd.pdf");
    assert.ok(!s1.includes("/"));
    assert.ok(!s1.includes(".."));

    const s2 = sanitizeFilename("test\r\nfile.PDF");
    assert.equal(s2, "testfile.pdf");

    // Overly long filename truncated to 120 chars
    const longName = "a".repeat(200) + ".pdf";
    const sanitizedLong = sanitizeFilename(longName);
    assert.equal(sanitizedLong.length, 120);
    assert.ok(sanitizedLong.endsWith(".pdf"));
  });

  test("U03: HTML and script text is retained inertly without interpretation", () => {
    const raw = "<script>alert('xss')</script> & <b>bold</b>";
    const normalized = normalizeText(raw);
    assert.equal(normalized, "<script>alert('xss')</script> & <b>bold</b>");
  });

  test("U04: Code point and UTF-8 byte limits enforced", () => {
    // Exceeding code points
    const longString = "A".repeat(4001);
    assert.throws(
      () => normalizeText(longString, 4000),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.httpStatus, 422);
        assert.match(err.safeMessage, /code points/i);
        return true;
      },
    );

    // Valid within limits
    const validString = "Hello \r\nWorld";
    assert.equal(normalizeText(validString), "Hello \nWorld");
  });

  test("U04: Non-PDF bytes rejected by detector", async () => {
    const nonPdf = Buffer.from("<html>not a pdf</html>", "utf8");
    const isPdf = await detectPdfBuffer(nonPdf);
    assert.equal(isPdf, false);

    const validPdf = makePdf("Test PDF");
    const isRealPdf = await detectPdfBuffer(validPdf);
    assert.equal(isRealPdf, true);
  });

  test("Storage: Stage, read, checksum round-trip and idempotent deletion", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "raxo_storage_unit_"));
    try {
      const storage = createStorage(tempDir);
      const pdfBytes = makePdf("Test Storage Roundtrip");
      const expectedSha256 = createHash("sha256").update(pdfBytes).digest("hex");

      const stream = Readable.from([pdfBytes]);
      const staged = await storage.stage(stream);

      assert.equal(staged.sizeBytes, pdfBytes.length);
      assert.equal(staged.sha256, expectedSha256);

      // Read from quarantine
      const readBytes = storage.read(staged.key, "quarantine");
      assert.deepEqual(readBytes, pdfBytes);

      // Move to clean
      storage.moveToClean(staged.key);
      const cleanBytes = storage.read(staged.key, "clean");
      assert.deepEqual(cleanBytes, pdfBytes);

      // Idempotent delete
      storage.delete(staged.key);
      storage.delete(staged.key); // second call does not throw

      // After delete, read throws 404
      assert.throws(
        () => storage.read(staged.key),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.httpStatus, 404);
          return true;
        },
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("Storage: Path traversal attempt is rejected", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "raxo_storage_unit_"));
    try {
      const storage = createStorage(tempDir);
      assert.throws(
        () => storage.resolveSafePath("../../etc/passwd", "clean"),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, "bad_request");
          return true;
        },
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("Storage: Exceeding max file size throws 413 file_too_large", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "raxo_storage_unit_"));
    try {
      const storage = createStorage(tempDir);
      const largeBytes = Buffer.alloc(100);
      const stream = Readable.from([largeBytes]);

      await assert.rejects(
        async () => {
          await storage.stage(stream, 50); // limit 50 bytes
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.httpStatus, 413);
          assert.equal(err.code, "file_too_large");
          return true;
        },
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
