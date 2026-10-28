import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import net from "node:net";
import pg from "pg";
const { Pool } = pg;
import type { FormConfig } from "../src/types.js";
import { runMigrations } from "../src/migrate.js";

export interface TestContext {
  pool: pg.Pool;
  schema: string;
  storageDir: string;
  forms: Map<string, FormConfig>;
  dbTestUrl: string;
  cleanup: () => Promise<void>;
}

export function makePdf(label = "Raxo Email synthetic CV fixture"): Buffer {
  const contentStream = `BT /F1 12 Tf 72 712 Td (${label.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const streamLength = Buffer.byteLength(contentStream, "utf8");

  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";

  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n";
  const obj4 = "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  const obj5 = `5 0 obj\n<< /Length ${streamLength} >>\nstream\n${contentStream}\nendstream\nendobj\n`;

  const part1 = header;
  const offset1 = Buffer.byteLength(part1, "utf8");
  const offset2 = offset1 + Buffer.byteLength(obj1, "utf8");
  const offset3 = offset2 + Buffer.byteLength(obj2, "utf8");
  const offset4 = offset3 + Buffer.byteLength(obj3, "utf8");
  const offset5 = offset4 + Buffer.byteLength(obj4, "utf8");
  const xrefOffset = offset5 + Buffer.byteLength(obj5, "utf8");

  const xref =
    [
      "xref",
      "0 6",
      "0000000000 65535 f ",
      `${offset1.toString().padStart(10, "0")} 00000 n `,
      `${offset2.toString().padStart(10, "0")} 00000 n `,
      `${offset3.toString().padStart(10, "0")} 00000 n `,
      `${offset4.toString().padStart(10, "0")} 00000 n `,
      `${offset5.toString().padStart(10, "0")} 00000 n `,
    ].join("\n") + "\n";

  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const fullPdf = part1 + obj1 + obj2 + obj3 + obj4 + obj5 + xref + trailer;
  return Buffer.from(fullPdf, "utf8");
}

export function makeEicarPdf(): Buffer {
  const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
  const streamLength = Buffer.byteLength(eicar, "utf8");

  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n";
  const obj4 = `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${eicar}\nendstream\nendobj\n`;

  const offset1 = Buffer.byteLength(header, "utf8");
  const offset2 = offset1 + Buffer.byteLength(obj1, "utf8");
  const offset3 = offset2 + Buffer.byteLength(obj2, "utf8");
  const offset4 = offset3 + Buffer.byteLength(obj3, "utf8");
  const xrefOffset = offset4 + Buffer.byteLength(obj4, "utf8");

  const xref =
    [
      "xref",
      "0 5",
      "0000000000 65535 f ",
      `${offset1.toString().padStart(10, "0")} 00000 n `,
      `${offset2.toString().padStart(10, "0")} 00000 n `,
      `${offset3.toString().padStart(10, "0")} 00000 n `,
      `${offset4.toString().padStart(10, "0")} 00000 n `,
    ].join("\n") + "\n";

  const trailer = `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(header + obj1 + obj2 + obj3 + obj4 + xref + trailer, "utf8");
}

export function makeMultipart(
  fields: Record<string, string | null | undefined>,
  files: Array<{ fieldName: string; filename: string; contentType: string; content: Buffer }> = [],
  boundary = "----RaxoBoundary" + randomBytes(8).toString("hex"),
): { boundary: string; contentType: string; buffer: Buffer } {
  const chunks: Buffer[] = [];

  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined || val === null) continue;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`,
        "utf8",
      ),
    );
  }

  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
    );
    chunks.push(file.content);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

  return {
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`,
    buffer: Buffer.concat(chunks),
  };
}

export async function createTestContext(): Promise<TestContext> {
  const dbTestUrl =
    process.env.DB_TEST_URL ||
    "postgres://raxo_demo:local_demo_only@127.0.0.1:55432/raxo_email_test";
  const urlObj = new URL(dbTestUrl);
  if (!urlObj.pathname.includes("_test")) {
    throw new Error(`Refusing to run tests on database without _test in name: ${urlObj.pathname}`);
  }

  const schema = `test_${randomBytes(8).toString("hex")}`;
  if (!schema.startsWith("test_")) {
    throw new Error(`Invalid test schema name: ${schema}`);
  }

  const rootPool = new Pool({ connectionString: dbTestUrl, max: 2 });
  await rootPool.query(`CREATE SCHEMA ${schema};`);

  const scopedPool = new Pool({
    connectionString: dbTestUrl,
    options: `-c search_path=${schema},public`,
    max: 10,
  });

  // Run migrations into the scoped schema
  await runMigrations(scopedPool);

  const storageDir = mkdtempSync(join(tmpdir(), "raxo_test_storage_"));
  mkdirSync(join(storageDir, "quarantine"), { recursive: true });
  mkdirSync(join(storageDir, "clean"), { recursive: true });
  mkdirSync(join(storageDir, "mime"), { recursive: true });
  mkdirSync(join(storageDir, "tmp"), { recursive: true });

  const forms = new Map<string, FormConfig>();
  forms.set("job-application", {
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
  });
  forms.set("contact", {
    id: "contact",
    enabled: true,
    from: "notifications@example.test",
    recipient: "owner@example.test",
    subject_prefix: "Contact enquiry",
    reply_to_field: "email",
    success_url: null,
    allowed_origins: ["http://127.0.0.1:3000"],
    fields: [
      { name: "full_name", type: "text", required: true, max_length: 120 },
      { name: "email", type: "email", required: true, max_length: 254 },
      { name: "message", type: "text", required: true, max_length: 4000 },
    ],
  });

  const cleanup = async () => {
    try {
      // Terminate any advisory lock holder so unreleased worker lock clients are released
      await rootPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = 726901;`,
      );
    } catch {
      // ignore
    }

    try {
      await Promise.race([
        scopedPool.end(),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    } catch {
      // ignore
    }

    try {
      if (schema.startsWith("test_")) {
        await rootPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
      }
    } finally {
      await rootPool.end().catch(() => {});
    }

    try {
      rmSync(storageDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return {
    pool: scopedPool,
    schema,
    storageDir,
    forms,
    dbTestUrl,
    cleanup,
  };
}

export function startSmtpPeer(options: {
  greeting?: string;
  onMail?: (from: string, to: string, data: string) => { code: number; message: string };
  dropAfterData?: boolean;
  holdAfterData?: boolean;
}): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.write(options.greeting ?? "220 test-smtp.local ESMTP Mock\r\n");
      let inData = false;
      let dataBuffer = "";

      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (inData) {
          dataBuffer += text;
          if (dataBuffer.includes("\r\n.\r\n")) {
            if (options.dropAfterData) {
              socket.destroy();
              return;
            }
            if (options.holdAfterData) {
              // Withhold 250 reply and keep connection open so client socket timeout fires
              inData = false;
              return;
            }
            const res = options.onMail
              ? options.onMail("", "", dataBuffer)
              : { code: 250, message: "OK: queued" };
            socket.write(`${res.code} ${res.message}\r\n`);
            inData = false;
            dataBuffer = "";
          }
          return;
        }

        const lines = text.split("\r\n");
        for (const line of lines) {
          if (!line) continue;
          const upper = line.toUpperCase();
          if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
            socket.write("250-test-smtp.local Hello\r\n250 8BITMIME\r\n");
          } else if (upper.startsWith("MAIL FROM:")) {
            socket.write("250 2.1.0 Sender OK\r\n");
          } else if (upper.startsWith("RCPT TO:")) {
            socket.write("250 2.1.5 Recipient OK\r\n");
          } else if (upper.startsWith("DATA")) {
            inData = true;
            socket.write("354 Start mail input; end with <CRLF>.<CRLF>\r\n");
          } else if (upper.startsWith("QUIT")) {
            socket.write("221 2.0.0 Bye\r\n");
            socket.end();
          } else if (upper.startsWith("RSET")) {
            socket.write("250 2.0.0 OK\r\n");
          } else {
            socket.write("500 5.5.1 Command unrecognized\r\n");
          }
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolvePromise({
        port: addr.port,
        close: () =>
          new Promise((res) => {
            for (const s of sockets) {
              try {
                s.destroy();
              } catch {
                // ignore
              }
            }
            server.close(() => res());
          }),
      });
    });

    server.on("error", reject);
  });
}

export function startClamdPeer(options: {
  versionResponse?: string;
  streamResponse?: "OK" | "FOUND" | "ERROR" | "TIMEOUT" | "CLOSE";
}): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.includes("PING")) {
          socket.write("PONG\n");
        } else if (text.includes("VERSION")) {
          socket.write(options.versionResponse ?? "ClamAV 1.4.1/28000/Fri Oct 24 12:00:00 2026\n");
        } else if (text.includes("INSTREAM")) {
          if (options.streamResponse === "TIMEOUT") {
            // don't reply, wait for client timeout
            return;
          }
          if (options.streamResponse === "CLOSE") {
            socket.destroy();
            return;
          }
          if (options.streamResponse === "FOUND") {
            socket.write("stream: Eicar-Signature FOUND\n");
          } else if (options.streamResponse === "ERROR") {
            socket.write("stream: Scan error ERROR\n");
          } else {
            socket.write("stream: OK\n");
          }
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolvePromise({
        port: addr.port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });

    server.on("error", reject);
  });
}
