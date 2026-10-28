import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { createStorage } from "../src/storage.js";
import { buildApp } from "../src/http.js";
import { Worker } from "../src/worker.js";
import { runCli } from "../src/cli.js";
import { makePdf, makeMultipart } from "../test/helpers.js";

async function runDemo(): Promise<void> {
  console.log("=== Raxo Email Deterministic Local Demo Verification ===");

  // 1. Verify DEMO_MODE and loopback targets
  const config = await loadConfig();

  if (!config.demoMode) {
    console.error("FATAL: Demo requires DEMO_MODE=true in .env");
    process.exit(1);
  }

  const loopbacks = ["127.0.0.1", "localhost", "::1"];
  const dbHost = new URL(config.databaseUrl).hostname;
  if (!loopbacks.includes(dbHost)) {
    console.error(`FATAL: Database host '${dbHost}' is not a loopback address.`);
    process.exit(1);
  }
  if (!loopbacks.includes(config.smtpHost)) {
    console.error(`FATAL: SMTP host '${config.smtpHost}' is not a loopback address.`);
    process.exit(1);
  }
  if (!loopbacks.includes(config.clamdHost)) {
    console.error(`FATAL: ClamAV host '${config.clamdHost}' is not a loopback address.`);
    process.exit(1);
  }

  console.log("✔ Loopback environment and DEMO_MODE verified.");

  // 2. Setup DB, migrations, and storage
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  const storage = createStorage(config.storageDir);

  // 3. Generate small synthetic PDF fixture
  const pdfBuffer = makePdf("Raxo Email synthetic CV fixture");
  const originalSha256 = createHash("sha256").update(pdfBuffer).digest("hex");
  console.log(`✔ Generated synthetic PDF (${pdfBuffer.length} bytes, SHA-256: ${originalSha256})`);

  // 4. Start HTTP App and Worker
  const app = buildApp({ config, pool, storage });
  await app.listen({ host: config.host, port: config.port });
  console.log(`✔ HTTP server listening on http://${config.host}:${config.port}`);

  const worker = new Worker({
    pool,
    storage,
    smtpConfig: {
      host: config.smtpHost,
      port: config.smtpPort,
      tlsMode: config.smtpTlsMode,
    },
    scannerHost: config.clamdHost,
    scannerPort: config.clamdPort,
    pollIntervalMs: 500,
  });

  await worker.start();
  console.log("✔ Background worker started with advisory lock 726901.");

  const tempDir = mkdtempSync(join(tmpdir(), "raxo_demo_verify_"));
  const clientSubmissionId = randomUUID();

  try {
    // 5. Submit valid job application multipart form
    const mp = makeMultipart(
      {
        _submission_id: clientSubmissionId,
        full_name: "Alex Example",
        email: "alex@example.test",
        position: "Frontend Developer",
        portfolio: "https://example.test/alex",
        message: "Synthetic application — no real applicant data",
      },
      [
        {
          fieldName: "attachments",
          filename: "alex_example_cv.pdf",
          contentType: "application/pdf",
          content: pdfBuffer,
        },
      ],
    );

    const postResponse = await fetch(`http://${config.host}:${config.port}/forms/job-application`, {
      method: "POST",
      headers: {
        "content-type": mp.contentType,
        origin: `http://${config.host}:${config.port}`,
      },
      body: new Uint8Array(mp.buffer),
    });

    if (postResponse.status !== 202) {
      const errText = await postResponse.text();
      throw new Error(`HTTP submission failed with status ${postResponse.status}: ${errText}`);
    }

    const receipt1 = (await postResponse.json()) as { submission_id: string; status: string };
    const submissionId = receipt1.submission_id;
    console.log(`✔ Initial POST accepted: 202 Accepted (submission_id: ${submissionId})`);

    // 6. Test Deduplication: repeat exact same POST with same clientSubmissionId
    const repeatResponse = await fetch(
      `http://${config.host}:${config.port}/forms/job-application`,
      {
        method: "POST",
        headers: {
          "content-type": mp.contentType,
          origin: `http://${config.host}:${config.port}`,
        },
        body: new Uint8Array(mp.buffer),
      },
    );

    if (repeatResponse.status !== 202) {
      throw new Error(`Repeat submission failed with status ${repeatResponse.status}`);
    }

    const receipt2 = (await repeatResponse.json()) as { submission_id: string; status: string };
    if (receipt2.submission_id !== submissionId) {
      throw new Error(
        `Dedup failure: expected ${submissionId}, received ${receipt2.submission_id}`,
      );
    }
    console.log(`✔ Repeated POST returned identical receipt (idempotent deduplication verified).`);

    // 7. Poll Mailpit API until message arrives
    console.log("Waiting for worker handoff to local Mailpit...");
    const deadline = Date.now() + 30000;
    let capturedRawMime: string | null = null;
    let capturedMessageId: string | null = null;

    while (Date.now() < deadline) {
      const mailpitRes = await fetch("http://127.0.0.1:8025/api/v1/messages");
      if (mailpitRes.ok) {
        const mailpitData = (await mailpitRes.json()) as {
          messages: Array<{ ID: string; Subject: string }>;
        };
        const match = mailpitData.messages.find((m) => m.Subject.includes(submissionId));
        if (match) {
          capturedMessageId = match.ID;
          const rawRes = await fetch(`http://127.0.0.1:8025/api/v1/message/${match.ID}/raw`);
          if (rawRes.ok) {
            capturedRawMime = await rawRes.text();
            break;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!capturedRawMime) {
      throw new Error(
        `Timed out waiting for notification email in Mailpit for submission ${submissionId}`,
      );
    }
    console.log(`✔ Notification captured in Mailpit (message ID: ${capturedMessageId})`);

    // 8. Parse captured MIME and verify attachment checksum
    const parsedMime = await simpleParser(capturedRawMime);
    if (parsedMime.attachments.length !== 1) {
      throw new Error(`Expected 1 attachment in MIME, got ${parsedMime.attachments.length}`);
    }

    const mailpitAttachmentSha256 = createHash("sha256")
      .update(parsedMime.attachments[0].content)
      .digest("hex");

    // 9. Export attachment via Operator CLI to temporary file
    const attRow = (
      await pool.query("SELECT id FROM attachments WHERE submission_id = $1", [submissionId])
    ).rows[0];

    const exportPath = join(tempDir, "demo_cli_export.pdf");
    const cliExitCode = await runCli(["attachments", "export", attRow.id, "--out", exportPath], {
      config,
      pool,
      storage,
    });

    if (cliExitCode !== 0) {
      throw new Error(`CLI export failed with exit code ${cliExitCode}`);
    }

    const exportedContent = readFileSync(exportPath);
    const cliExportedSha256 = createHash("sha256").update(exportedContent).digest("hex");

    // 10. Compare all three checksums
    const allMatch =
      originalSha256 === mailpitAttachmentSha256 && originalSha256 === cliExportedSha256;

    if (!allMatch) {
      throw new Error(
        `Checksum mismatch!\nOriginal: ${originalSha256}\nMailpit:  ${mailpitAttachmentSha256}\nExported: ${cliExportedSha256}`,
      );
    }

    // 11. Verify DB notification state is 'submitted'
    const notifRow = (
      await pool.query(
        "SELECT state, smtp_receipt, message_id FROM notifications WHERE submission_id = $1",
        [submissionId],
      )
    ).rows[0];

    if (notifRow.state !== "submitted") {
      throw new Error(`Expected notification state 'submitted', found '${notifRow.state}'`);
    }

    const demoSummary = {
      status: "success",
      demo_mode: true,
      submission_id: submissionId,
      client_submission_id: clientSubmissionId,
      message_id: notifRow.message_id,
      notification_state: notifRow.state,
      checksums: {
        original_pdf_sha256: originalSha256,
        mailpit_captured_sha256: mailpitAttachmentSha256,
        cli_exported_sha256: cliExportedSha256,
        all_match: true,
      },
    };

    console.log("\n--- DEMO VERIFICATION SUMMARY ---");
    console.log(JSON.stringify(demoSummary, null, 2));
    console.log("---------------------------------\n");
    console.log("✔ All assertions passed successfully!");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    await worker.stop();
    await app.close();
    await pool.end();
  }
}

runDemo().catch((err) => {
  console.error("FATAL DEMO VERIFICATION ERROR:", err);
  process.exit(1);
});
