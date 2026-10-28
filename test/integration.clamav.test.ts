import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanStoredPdf, scanStream } from "../src/scanner.js";
import { createStorage } from "../src/storage.js";
import { makePdf, makeEicarPdf, startClamdPeer } from "./helpers.js";

const EICAR_TEST_STRING = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

describe("S01, S02, S03: ClamAV Integration Tests", () => {
  const clamdHost = process.env.CLAMD_HOST || "127.0.0.1";
  const clamdPort = parseInt(process.env.CLAMD_PORT || "3310", 10);

  test("S01: Real generated clean PDF scans clean with version", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "raxo_clamav_clean_"));
    try {
      const storage = createStorage(tempDir);
      const pdfBytes = makePdf("Clean PDF for ClamAV S01");
      const staged = await storage.stage(Readable.from([pdfBytes]));

      const result = await scanStoredPdf(staged.key, storage, { host: clamdHost, port: clamdPort });
      assert.equal(result.kind, "clean");
      assert.ok(result.version.includes("ClamAV"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("S02: Stale signatures (>48h) or protocol errors fail closed and cannot become clean", async () => {
    // 1. Stale signature date: 5 days ago
    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const stalePeer = await startClamdPeer({
      versionResponse: `ClamAV 1.4.1/28000/${oldDate.toUTCString()}\n`,
      streamResponse: "OK",
    });

    try {
      const pdfBytes = makePdf("Test stale scanner");
      const res = await scanStream(Readable.from([pdfBytes]), {
        host: "127.0.0.1",
        port: stalePeer.port,
        timeoutMs: 2000,
      });

      assert.equal(res.kind, "error");
      assert.match(res.reason, /older than 48 hours/i);
    } finally {
      await stalePeer.close();
    }

    // 2. Abrupt connection close
    const dropPeer = await startClamdPeer({
      versionResponse: `ClamAV 1.4.1/28000/${new Date().toUTCString()}\n`,
      streamResponse: "CLOSE",
    });

    try {
      const pdfBytes = makePdf("Test dropped scanner");
      const res = await scanStream(Readable.from([pdfBytes]), {
        host: "127.0.0.1",
        port: dropPeer.port,
        timeoutMs: 2000,
      });

      assert.equal(res.kind, "error");
    } finally {
      await dropPeer.close();
    }
  });

  test("S03: Standard scanner detection fixture is blocked", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "raxo_clamav_eicar_"));
    try {
      const storage = createStorage(tempDir);
      // Embed standard EICAR string into valid PDF
      const eicarPdf = makeEicarPdf();
      const staged = await storage.stage(Readable.from([eicarPdf]));

      const result = await scanStoredPdf(staged.key, storage, { host: clamdHost, port: clamdPort });
      assert.equal(result.kind, "blocked");
      assert.match(result.reason, /FOUND/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
