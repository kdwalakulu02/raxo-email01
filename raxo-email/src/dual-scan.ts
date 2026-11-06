import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { scanStream, type ScannerOptions } from "./scanner.js";
import type { ScanResult } from "./types.js";

export type ScannerName = "clamav" | "raxosentinel";
export type ScanVerdict = "CLEAN" | "DETECTED" | "ERROR" | "UNSCANNED" | "BUSY" | "TIMEOUT";

export interface ScanRecord {
  scanner: ScannerName;
  shadow: boolean;
  verdict: ScanVerdict;
  detection: string | null;
  engineVersion: string | null;
  databaseGeneration: string | null;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
  error: string | null;
}

export interface SentinelConfig {
  enabled: boolean;
  socketPath: string;
  binaryPath: string;
  snapshotDir: string;
  timeoutMs: number;
}

const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 4096;
const SENTINEL_VERDICTS = new Set(["CLEAN", "DETECTED", "UNSCANNED", "ERROR", "BUSY"]);

export function loadSentinelConfig(
  env: Record<string, string | undefined>,
  storageDir: string,
): SentinelConfig | undefined {
  if (env.SENTINEL_SHADOW_ENABLED !== "true") return undefined;
  const socketPath = env.SENTINEL_SOCKET;
  if (!socketPath) throw new Error("SENTINEL_SHADOW_ENABLED=true requires SENTINEL_SOCKET");
  const timeoutMs = parseInt(env.SENTINEL_TIMEOUT_MS ?? "15000", 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error("SENTINEL_TIMEOUT_MS must be between 1000 and 60000");
  }
  return {
    enabled: true,
    socketPath,
    binaryPath: env.SENTINEL_BIN ?? "/opt/raxosentinel/bin/raxosentinel",
    snapshotDir: join(storageDir, "scan-snapshots"),
    timeoutMs,
  };
}

export function initSnapshotDir(cfg: SentinelConfig): void {
  // Discard anything a crashed worker left behind; snapshots are never reused.
  rmSync(cfg.snapshotDir, { recursive: true, force: true });
  mkdirSync(cfg.snapshotDir, { recursive: true, mode: 0o700 });
}

function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function* chunks(buf: Buffer, size = 65536): Generator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

function collectDetections(report: unknown, out: string[]): void {
  if (!report || typeof report !== "object") return;
  const r = report as { threats?: Array<{ name?: string }>; sub_targets?: unknown[] };
  for (const t of r.threats ?? []) if (t?.name) out.push(t.name);
  for (const s of r.sub_targets ?? []) collectDetections(s, out);
}

/** ClamAV scan of the verified in-memory attachment bytes. Existing clamd protocol and timeouts apply. */
export async function scanClamAvBytes(
  content: Buffer,
  sha256: string,
  options: ScannerOptions,
): Promise<{ result: ScanResult; record: ScanRecord }> {
  const start = performance.now();
  const result = await scanStream(Readable.from(chunks(content)), options);
  const durationMs = Math.round(performance.now() - start);
  const base = {
    scanner: "clamav" as const,
    shadow: false,
    sha256,
    sizeBytes: content.length,
    durationMs,
    databaseGeneration: null,
  };
  let record: ScanRecord;
  if (result.kind === "clean") {
    record = { ...base, verdict: "CLEAN", detection: null, engineVersion: result.version, error: null };
  } else if (result.kind === "blocked") {
    record = { ...base, verdict: "DETECTED", detection: result.reason, engineVersion: null, error: null };
  } else {
    const timedOut = /timed out|timeout/i.test(result.reason);
    record = {
      ...base,
      verdict: timedOut ? "TIMEOUT" : "ERROR",
      detection: null,
      engineVersion: null,
      error: result.reason.slice(0, 500),
    };
  }
  return { result, record };
}

function runClient(
  cfg: SentinelConfig,
  file: string,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; spawnError: string | null }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | null = null;
    const child = spawn(
      cfg.binaryPath,
      ["client", "--socket", cfg.socketPath, "--json-envelope", file],
      { stdio: ["ignore", "pipe", "pipe"], shell: false, env: {} },
    );
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += d.toString("utf8").slice(0, MAX_STDOUT_BYTES - stdout.length);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += d.toString("utf8").slice(0, MAX_STDERR_BYTES - stderr.length);
    });
    child.on("error", (e) => {
      spawnError = e.message;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, cfg.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, spawnError });
    });
  });
}

/**
 * Shadow scan through the RaxoSentinel Unix-socket coordinator. Never throws: every failure is
 * returned as an ERROR/TIMEOUT record so it cannot influence the ClamAV delivery policy.
 */
export async function scanSentinelShadow(
  content: Buffer,
  sha256: string,
  attachmentId: string,
  cfg: SentinelConfig,
): Promise<ScanRecord> {
  const start = performance.now();
  const record = (p: Partial<ScanRecord> & { verdict: ScanVerdict }): ScanRecord => ({
    scanner: "raxosentinel",
    shadow: true,
    detection: null,
    engineVersion: null,
    databaseGeneration: null,
    sha256,
    sizeBytes: content.length,
    durationMs: Math.round(performance.now() - start),
    error: null,
    ...p,
  });

  const dir = join(cfg.snapshotDir, randomUUID());
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${attachmentId}.pdf`);
    const fd = openSync(file, "wx", 0o400);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(file, 0o400);
    if (sha256Of(readFileSync(file)) !== sha256) {
      return record({ verdict: "ERROR", error: "snapshot_sha256_mismatch_before_scan" });
    }

    const run = await runClient(cfg, file);

    if (sha256Of(readFileSync(file)) !== sha256) {
      return record({ verdict: "ERROR", error: "snapshot_sha256_mismatch_after_scan" });
    }
    if (run.timedOut) {
      return record({ verdict: "TIMEOUT", error: `sentinel client exceeded ${cfg.timeoutMs}ms` });
    }
    if (run.spawnError) {
      return record({ verdict: "ERROR", error: `sentinel_spawn_failed: ${run.spawnError}`.slice(0, 500) });
    }

    let envelope: {
      status?: string;
      report?: { engine_version?: string; target?: { sha256?: string } } | null;
      error?: string | null;
      database_generation?: string | null;
    } | null = null;
    try {
      envelope = JSON.parse(run.stdout);
    } catch {
      envelope = null;
    }
    if (!envelope || !envelope.status || !SENTINEL_VERDICTS.has(envelope.status)) {
      const detail = run.stderr.trim() || `exit code ${run.code}`;
      return record({ verdict: "ERROR", error: `sentinel_unavailable: ${detail}`.slice(0, 500) });
    }

    const generation = envelope.database_generation ?? null;
    const reportedSha = envelope.report?.target?.sha256;
    if (reportedSha && reportedSha.toLowerCase() !== sha256) {
      return record({
        verdict: "ERROR",
        databaseGeneration: generation,
        error: "sentinel_scanned_sha256_mismatch",
      });
    }

    const names: string[] = [];
    collectDetections(envelope.report, names);
    return record({
      verdict: envelope.status as ScanVerdict,
      detection: names.length ? names.join(", ").slice(0, 500) : null,
      engineVersion: envelope.report?.engine_version ?? null,
      databaseGeneration: generation,
      error: envelope.error ? String(envelope.error).slice(0, 500) : null,
    });
  } catch (err) {
    return record({
      verdict: "ERROR",
      error: `sentinel_internal: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
    });
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

export async function recordScanResults(
  pool: Pool,
  attachmentId: string,
  notificationId: string,
  records: ScanRecord[],
): Promise<void> {
  for (const r of records) {
    await pool.query(
      `INSERT INTO scan_results (
         id, attachment_id, notification_id, scanner, shadow, verdict, detection, engine_version,
         database_generation, sha256, size_bytes, duration_ms, error, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())`,
      [
        randomUUID(),
        attachmentId,
        notificationId,
        r.scanner,
        r.shadow,
        r.verdict,
        r.detection,
        r.engineVersion,
        r.databaseGeneration,
        r.sha256,
        r.sizeBytes,
        r.durationMs,
        r.error,
      ],
    );
  }
}

/**
 * Scans the same SHA-256-verified bytes with ClamAV and (when configured) RaxoSentinel in parallel,
 * records both results, and returns only the ClamAV result for the existing delivery policy.
 */
export async function dualScan(
  pool: Pool,
  attachmentId: string,
  notificationId: string,
  content: Buffer,
  sha256: string,
  clam: ScannerOptions,
  sentinel: SentinelConfig | undefined,
): Promise<ScanResult> {
  const start = performance.now();
  const [clamOut, sentinelRecord] = await Promise.all([
    scanClamAvBytes(content, sha256, clam),
    sentinel?.enabled
      ? scanSentinelShadow(content, sha256, attachmentId, sentinel)
      : Promise.resolve(null),
  ]);
  const records = sentinelRecord ? [clamOut.record, sentinelRecord] : [clamOut.record];
  try {
    await recordScanResults(pool, attachmentId, notificationId, records);
  } catch (err) {
    console.error("Failed to record scan results (delivery policy unaffected):", err);
  }
  console.log(
    JSON.stringify({
      event: "dual_scan",
      attachment_id: attachmentId,
      clamav: { verdict: clamOut.record.verdict, ms: clamOut.record.durationMs },
      raxosentinel: sentinelRecord
        ? {
            verdict: sentinelRecord.verdict,
            ms: sentinelRecord.durationMs,
            generation: sentinelRecord.databaseGeneration,
          }
        : null,
      combined_ms: Math.round(performance.now() - start),
    }),
  );
  return clamOut.result;
}
