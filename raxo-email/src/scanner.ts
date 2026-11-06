import net from "node:net";
import type { Readable } from "node:stream";
import type { ScanResult } from "./types.js";
import type { StorageAdapter } from "./storage.js";
import { AppError } from "./errors.js";

export interface ScannerOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

export function parseClamAvSignatureDate(versionStr: string): Date | null {
  // ClamAV output: ClamAV 1.4.1/28000/Fri Oct 24 12:00:00 2026
  const parts = versionStr.trim().split("/");
  if (parts.length < 3) return null;
  const dateStr = parts[2];
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

export async function checkScannerVersion(
  options: ScannerOptions,
): Promise<{ version: string; signatureDate: Date }> {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host: options.host, port: options.port });
    const timeoutMs = options.timeoutMs ?? 10000;
    socket.setTimeout(timeoutMs);

    let data = "";

    socket.on("connect", () => {
      socket.write("zVERSION\0");
    });

    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\n") || data.includes("\0")) {
        socket.end();
      }
    });

    socket.on("timeout", () => {
      socket.destroy(new AppError("scanner_unavailable", 503, "ClamAV VERSION timeout"));
    });

    socket.on("error", (err) => {
      reject(new AppError("scanner_unavailable", 503, `ClamAV connection error: ${err.message}`));
    });

    socket.on("close", () => {
      const trimmed = data.trim();
      const sigDate = parseClamAvSignatureDate(trimmed);
      if (!sigDate) {
        reject(
          new AppError(
            "scanner_unavailable",
            503,
            `Could not parse ClamAV signature date from: ${trimmed}`,
          ),
        );
        return;
      }

      const ageMs = Date.now() - sigDate.getTime();
      const maxAgeMs = 48 * 60 * 60 * 1000;
      // Allow clock skew of up to 1 hour into future, but reject if > 48h in past
      if (ageMs > maxAgeMs) {
        reject(
          new AppError(
            "scanner_unavailable",
            503,
            `ClamAV signatures are older than 48 hours: ${sigDate.toISOString()}`,
          ),
        );
        return;
      }

      const cleanVersion = trimmed.replace(/\0+$/, "");
      resolvePromise({ version: cleanVersion, signatureDate: sigDate });
    });
  });
}

export async function scanStream(stream: Readable, options: ScannerOptions): Promise<ScanResult> {
  let versionInfo: { version: string; signatureDate: Date };
  try {
    versionInfo = await checkScannerVersion(options);
  } catch (err) {
    return {
      kind: "error",
      reason: err instanceof Error ? err.message : "Scanner version check failed",
    };
  }

  return new Promise<ScanResult>((resolvePromise) => {
    const socket = net.createConnection({ host: options.host, port: options.port });
    const timeoutMs = options.timeoutMs ?? 30000;
    socket.setTimeout(timeoutMs);

    let responseData = "";
    let completed = false;

    const finish = (result: ScanResult) => {
      if (completed) return;
      completed = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolvePromise(result);
    };

    socket.on("connect", async () => {
      try {
        socket.write("zINSTREAM\0");

        for await (const chunk of stream) {
          if (completed) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const lengthBuf = Buffer.alloc(4);
          lengthBuf.writeUInt32BE(buf.length, 0);
          socket.write(lengthBuf);
          socket.write(buf);
        }

        if (completed) return;
        const zeroBuf = Buffer.alloc(4, 0);
        socket.write(zeroBuf);
      } catch (err) {
        finish({
          kind: "error",
          reason: `Stream read error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    socket.on("data", (chunk) => {
      responseData += chunk.toString("utf8");
      if (responseData.includes("\n") || responseData.includes("\0")) {
        const line = responseData.replace(/[\0\r\n]+$/, "").trim();
        if (line.endsWith("OK")) {
          finish({ kind: "clean", version: versionInfo.version });
        } else if (line.includes("FOUND")) {
          finish({ kind: "blocked", reason: line });
        } else {
          finish({ kind: "error", reason: line || "Unexpected scanner response" });
        }
      }
    });

    socket.on("timeout", () => {
      finish({ kind: "error", reason: "ClamAV scan timed out (30s deadline exceeded)" });
    });

    socket.on("error", (err) => {
      finish({ kind: "error", reason: `ClamAV socket error: ${err.message}` });
    });

    socket.on("close", () => {
      if (!completed) {
        finish({ kind: "error", reason: "ClamAV socket closed unexpectedly without a verdict" });
      }
    });
  });
}

export async function scanStoredPdf(
  key: string,
  storage: StorageAdapter,
  options: ScannerOptions,
): Promise<ScanResult> {
  const stream = storage.getStream(key);
  return scanStream(stream, options);
}
