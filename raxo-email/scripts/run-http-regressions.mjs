import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import pg from "pg";
const { Pool } = pg;

import { buildApp } from "./dist/src/http.js";
import { createStorage } from "./dist/src/storage.js";
import { runMigrations } from "./dist/src/migrate.js";

function makePdf(padBytes = 1000000) {
  const header = "%PDF-1.4\n";
  const body = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${padBytes} >>\nstream\n${"A".repeat(padBytes)}\nendstream\nendobj\n`;
  const xref = "xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n300\n%%EOF\n";
  return Buffer.from(header + body + xref);
}

function makeMultipartHeadersAndBody(boundary, fields, file) {
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
  chunks.push(file.content);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function run() {
  console.log("=== Starting Real-HTTP Regressions ===");
  const dbTestUrl = process.env.DB_TEST_URL || "postgres://raxo_demo:local_demo_only@127.0.0.1:55432/raxo_email_test";
  const schema = `test_reg_${crypto.randomBytes(6).toString("hex")}`;
  const rootPool = new Pool({ connectionString: dbTestUrl, max: 2 });

  await rootPool.query(`CREATE SCHEMA ${schema};`);
  const pool = new Pool({
    connectionString: dbTestUrl,
    options: `-c search_path=${schema},public`,
    max: 10,
  });

  await runMigrations(pool);

  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "raxo_http_reg_"));
  const storage = createStorage(storageDir);

  const forms = new Map();
  forms.set("job-application", {
    id: "job-application",
    enabled: true,
    from: "notifications@notify.example.test",
    recipient: "kumudu.uog@gmail.com",
    subject_prefix: "Job application",
    reply_to_field: "email",
    success_url: null,
    allowed_origins: [], // Will be populated with ephemeral port URL
    fields: [
      { name: "full_name", type: "text", required: true, max_length: 120 },
      { name: "email", type: "email", required: true, max_length: 254 },
      { name: "position", type: "text", required: true, max_length: 120 },
    ],
  });

  const config = {
    nodeEnv: "development",
    host: "127.0.0.1",
    port: 0,
    databaseUrl: dbTestUrl,
    formsConfigPath: "config/forms.example.json",
    storageDir,
    smtpHost: "127.0.0.1",
    smtpPort: 1025,
    smtpTlsMode: "plain_local",
    smtpMaxMessageBytes: 20971520,
    maxFileSize: 10485760,
    maxTotalSize: 10485760,
    clamdHost: "127.0.0.1",
    clamdPort: 3310,
    forms,
    ipHashSecret: "test_secret_for_regressions",
    demoMode: true,
  };

  const app = buildApp({ config, pool, storage });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const serverPort = app.server.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  forms.get("job-application").allowed_origins = [baseUrl];
  console.log(`Isolated Fastify HTTP server listening on ${baseUrl}`);

  const results = {
    test1_valid_1mb: false,
    test2_oversized_chunked: false,
    test3_aborted_cleanup: false,
  };

  try {
    // -------------------------------------------------------------
    // Test 1: Valid upload around 1 MB
    // -------------------------------------------------------------
    console.log("\n[Test 1] Valid upload around 1 MB with real HTTP streaming...");
    const pdf1Mb = makePdf(1000000);
    const pdfHash = crypto.createHash("sha256").update(pdf1Mb).digest("hex");
    const boundary1 = "----BoundaryTest1" + crypto.randomBytes(6).toString("hex");
    const body1 = makeMultipartHeadersAndBody(
      boundary1,
      { full_name: "Kumudu UOG", email: "kumudu.uog@gmail.com", position: "Lead Reviewer" },
      { fieldName: "attachments", filename: "test_1mb.pdf", contentType: "application/pdf", content: pdf1Mb }
    );

    const res1 = await new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/forms/job-application`,
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary1}`,
            "Content-Length": body1.length,
            Origin: baseUrl,
            Accept: "application/json",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        }
      );
      req.on("error", reject);
      req.end(body1);
    });

    console.log("Test 1 Response:", res1.status, res1.body);
    assert.equal(res1.status, 202, "Expected HTTP 202 for valid 1MB upload");
    const json1 = JSON.parse(res1.body);
    assert.equal(json1.status, "received");
    assert.ok(json1.submission_id, "Expected valid submission_id");

    const quarantineFiles = fs.readdirSync(path.join(storageDir, "quarantine"));
    assert.equal(quarantineFiles.length, 1, "Expected 1 quarantine file");
    const quarantinedPath = path.join(storageDir, "quarantine", quarantineFiles[0]);
    const fileStat = fs.statSync(quarantinedPath);
    console.log("Stored file size:", fileStat.size, "bytes, expected:", pdf1Mb.length);
    assert.equal(fileStat.size, pdf1Mb.length, "File size in quarantine matches exactly");
    const storedHash = crypto.createHash("sha256").update(fs.readFileSync(quarantinedPath)).digest("hex");
    assert.equal(storedHash, pdfHash, "SHA-256 matches bit-for-bit");

    results.test1_valid_1mb = true;
    console.log("✓ Test 1 PASSED: Valid 1MB upload processed and staged without stalls.");

    // -------------------------------------------------------------
    // Test 2: Oversized chunked upload without Content-Length (> 11 MiB)
    // Specifically exercises the 11 MiB AGGREGATE limit without hitting the 10 MB per-file limit.
    // Preamble: 2 MB of multipart preamble data (RFC 2046).
    // File: Streamed PDF attachment.
    // When aggregate reaches 11 MiB, file size is only ~9.4 MB (< 10 MB per-file limit).
    // -------------------------------------------------------------
    console.log("\n[Test 2] Oversized chunked upload exercising aggregate limit without Content-Length (> 11 MiB)...");
    const boundary2 = "----BoundaryTest2" + crypto.randomBytes(6).toString("hex");

    let responseReceived = false;
    const res2 = await new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/forms/job-application`,
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary2}`,
            "Transfer-Encoding": "chunked", // NO Content-Length header!
            Origin: baseUrl,
            Accept: "application/json",
          },
        },
        (res) => {
          responseReceived = true;
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        }
      );

      req.on("error", (err) => {
        if (!responseReceived) {
          reject(err);
        }
      });

      // Stream asynchronously
      (async () => {
        try {
          // 1. Send 2 MB of multipart preamble (RFC 2046 preamble before first boundary)
          const preamble = Buffer.alloc(2 * 1024 * 1024, 0x20);
          let ok = req.write(preamble);
          if (!ok && !responseReceived) {
            await new Promise((r) => req.once("drain", r));
          }

          // 2. Start multipart body with form fields and PDF attachment
          const headerPrefix = `--${boundary2}\r\nContent-Disposition: form-data; name="full_name"\r\n\r\nAlex\r\n--${boundary2}\r\nContent-Disposition: form-data; name="attachments"; filename="large.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstream\n`;
          ok = req.write(Buffer.from(headerPrefix));
          if (!ok && !responseReceived) {
            await new Promise((r) => req.once("drain", r));
          }

          // 3. Stream 256 KB chunks of file data until 12 MB total aggregate is sent
          const chunk = Buffer.alloc(256 * 1024, 0x41);
          let sent = preamble.length + Buffer.byteLength(headerPrefix);
          const totalTarget = 12 * 1024 * 1024;

          while (sent < totalTarget && !responseReceived) {
            sent += chunk.length;
            ok = req.write(chunk);
            if (!ok && !responseReceived) {
              await new Promise((r) => {
                const cleanup = () => {
                  req.off("drain", onDrain);
                  req.off("response", onRes);
                };
                const onDrain = () => { cleanup(); r(); };
                const onRes = () => { cleanup(); r(); };
                req.once("drain", onDrain);
                req.once("response", onRes);
              });
            }
          }

          if (!responseReceived) {
            try {
              req.end(`\r\n--${boundary2}--\r\n`);
            } catch {}
          }
        } catch {
          // Ignore stream write errors if server aborted/closed with response
        }
      })();
    });

    console.log("Test 2 Response:", res2.status, res2.body);
    assert.equal(res2.status, 413, `Expected HTTP 413 for oversized aggregate upload, got: ${res2.status}`);
    const json2 = JSON.parse(res2.body);
    assert.equal(json2.error.code, "file_too_large");
    assert.match(json2.error.message, /aggregate limit/i, "Error message explicitly references aggregate limit");

    // Allow server async pipeline cleanup to finish unlinking tmp file
    await new Promise((r) => setTimeout(r, 300));

    // 1. Verify cleanup: tmp/ directory must have 0 orphaned files
    const tmpFilesAfterOversized = fs.readdirSync(path.join(storageDir, "tmp"));
    assert.equal(tmpFilesAfterOversized.length, 0, "No orphaned tmp files after oversized chunked upload");

    // 2. Verify quarantine: only Test 1's file is present; any staged file from Test 2 was cleaned up
    const quarantineFilesAfter = fs.readdirSync(path.join(storageDir, "quarantine"));
    assert.equal(quarantineFilesAfter.length, 1, "Quarantine only contains Test 1 file; rejected upload cleaned up");

    // 3. Verify absence of accepted submissions / notifications in database
    const subCount = await pool.query("SELECT COUNT(*) FROM submissions;");
    assert.equal(Number(subCount.rows[0].count), 1, "Only Test 1 submission exists in database");
    const notifCount = await pool.query("SELECT COUNT(*) FROM notifications;");
    assert.equal(Number(notifCount.rows[0].count), 1, "Only Test 1 notification exists in database");

    // 4. Verify service health afterward
    const liveRes = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(liveRes.statusCode, 200, "Service remains alive and healthy after rejection");
    const liveJson = JSON.parse(liveRes.body);
    assert.equal(liveJson.status, "ok");

    results.test2_oversized_chunked = true;
    console.log("✓ Test 2 PASSED: 11 MiB aggregate limit returned HTTP 413, connection clean, zero orphaned files, zero DB records, service healthy.");

    // -------------------------------------------------------------
    // Test 3: Aborted upload cleanup (client socket disconnect)
    // -------------------------------------------------------------
    console.log("\n[Test 3] Aborted upload cleanup (client socket disconnect)...");
    const boundary3 = "----BoundaryTest3" + crypto.randomBytes(6).toString("hex");

    await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: serverPort }, () => {
        socket.on("error", () => {}); // Handle intentional error on client destroy
        const httpHeader = [
          "POST /forms/job-application HTTP/1.1",
          `Host: 127.0.0.1:${serverPort}`,
          `Content-Type: multipart/form-data; boundary=${boundary3}`,
          `Origin: ${baseUrl}`,
          "Transfer-Encoding: chunked",
          "Accept: application/json",
          "\r\n",
        ].join("\r\n");

        socket.write(httpHeader);

        // Send valid prefix and start of PDF
        const initialBody = `--${boundary3}\r\nContent-Disposition: form-data; name="full_name"\r\n\r\nAlex\r\n--${boundary3}\r\nContent-Disposition: form-data; name="attachments"; filename="abort.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n`;
        const chunkSizeHex = Buffer.byteLength(initialBody).toString(16);
        socket.write(`${chunkSizeHex}\r\n${initialBody}\r\n`);

        // Send 500 KB of file content
        const partialData = Buffer.alloc(500 * 1024, 0x42);
        socket.write(`${partialData.length.toString(16)}\r\n`);
        socket.write(partialData);
        socket.write("\r\n");

        // Abruptly destroy the socket mid-stream (simulating mobile drop or network abort)
        setTimeout(() => {
          socket.destroy(new Error("ECONNRESET: simulated client abort"));
          resolve();
        }, 50);
      });
    });

    // Wait 300ms for server to process socket closure and run cleanup
    await new Promise((r) => setTimeout(r, 300));

    const tmpFilesAfterAbort = fs.readdirSync(path.join(storageDir, "tmp"));
    console.log("Tmp files after client abort:", tmpFilesAfterAbort);
    assert.equal(tmpFilesAfterAbort.length, 0, "All tmp files cleaned up after client disconnect");

    // Verify subsequent request still succeeds (server not wedged, parser released)
    const boundaryAfter = "----BoundaryAfter" + crypto.randomBytes(6).toString("hex");
    const bodyAfter = makeMultipartHeadersAndBody(
      boundaryAfter,
      { full_name: "Followup User", email: "followup@example.test", position: "Tester" },
      { fieldName: "attachments", filename: "followup.pdf", contentType: "application/pdf", content: makePdf(50000) }
    );

    const resAfter = await new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/forms/job-application`,
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundaryAfter}`,
            "Content-Length": bodyAfter.length,
            Origin: baseUrl,
            Accept: "application/json",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        }
      );
      req.on("error", reject);
      req.end(bodyAfter);
    });

    console.log("Followup Request Status:", resAfter.status);
    assert.equal(resAfter.status, 202, "Server recovered and accepted subsequent valid submission");
    results.test3_aborted_cleanup = true;
    console.log("✓ Test 3 PASSED: Aborted upload cleanly unlinked tmp files and freed parser slot.");

  } finally {
    await app.close();
    await pool.end();
    await rootPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
    await rootPool.end();
    fs.rmSync(storageDir, { recursive: true, force: true });
    console.log("=== All test resources cleaned up ===");
  }

  console.log("\nREGRESSION SUMMARY:");
  console.log("1. Valid 1MB upload:", results.test1_valid_1mb ? "PASSED" : "FAILED");
  console.log("2. Oversized chunked upload (> 11 MiB):", results.test2_oversized_chunked ? "PASSED" : "FAILED");
  console.log("3. Aborted upload cleanup:", results.test3_aborted_cleanup ? "PASSED" : "FAILED");
  if (results.test1_valid_1mb && results.test2_oversized_chunked && results.test3_aborted_cleanup) {
    console.log("\nALL REAL-HTTP REGRESSIONS PASSED SUCCESSFULLY.");
  } else {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("REGRESSION FAILED:", err);
  process.exit(1);
});
