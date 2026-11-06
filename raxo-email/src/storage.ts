import {
  openSync,
  closeSync,
  fsyncSync,
  writeSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  createReadStream,
  createWriteStream,
  readdirSync,
  statSync,
  readFileSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { AppError } from "./errors.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StagedFile {
  key: string;
  sizeBytes: number;
  sha256: string;
  filePath: string;
}

export interface StorageAdapter {
  storageDir: string;
  stage(stream: Readable, maxBytes?: number): Promise<StagedFile>;
  read(key: string, area?: "quarantine" | "clean" | "mime"): Buffer;
  getStream(key: string, area?: "quarantine" | "clean" | "mime"): Readable;
  moveToClean(key: string): void;
  delete(key: string, area?: "quarantine" | "clean" | "mime"): void;
  persistMime(buffer: Buffer): { key: string; sha256: string };
  orphanSweep(maxAgeMs?: number): string[];
  sweepTmp(maxAgeMs?: number, referenceDate?: Date): string[];
  resolveSafePath(key: string, area: "quarantine" | "clean" | "mime" | "tmp"): string;
  exists(key: string, area?: "quarantine" | "clean" | "mime"): boolean;
}

export function createStorage(storageDir: string): StorageAdapter {
  const root = resolve(process.cwd(), storageDir);

  // Initialize private directories with mode 0700
  mkdirSync(join(root, "quarantine"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "clean"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "mime"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "tmp"), { recursive: true, mode: 0o700 });

  function validateKey(key: string): void {
    if (!key || typeof key !== "string" || !UUID_REGEX.test(key)) {
      throw new AppError("bad_request", 400, "Invalid storage key format");
    }
  }

  function resolveSafePath(key: string, area: "quarantine" | "clean" | "mime" | "tmp"): string {
    validateKey(key);
    const targetDir = join(root, area);
    const targetPath = join(targetDir, key);

    // Verify safe path resolution within root
    const resolved = resolve(targetPath);
    if (!resolved.startsWith(targetDir) || basename(resolved) !== key) {
      throw new AppError("bad_request", 400, "Path traversal attempt detected");
    }

    return resolved;
  }

  async function stage(stream: Readable, maxBytes = 10485760): Promise<StagedFile> {
    const key = randomUUID();
    const tmpPath = resolveSafePath(key, "tmp");
    const quarantinePath = resolveSafePath(key, "quarantine");

    let bytesCount = 0;
    const hash = createHash("sha256");

    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesCount += chunk.length;
        if (bytesCount > maxBytes) {
          callback(
            new AppError(
              "file_too_large",
              413,
              `Attachment exceeds maximum size of ${maxBytes} bytes`,
            ),
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    const fd = openSync(tmpPath, "wx", 0o600);
    const outStream = createWriteStream("", { fd, autoClose: false });

    try {
      await pipeline(stream, counter, outStream);
      fsyncSync(fd);
      closeSync(fd);

      // Atomically move into quarantine
      renameSync(tmpPath, quarantinePath);

      // fsync parent quarantine directory
      const dirFd = openSync(join(root, "quarantine"), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }

      return {
        key,
        sizeBytes: bytesCount,
        sha256: hash.digest("hex"),
        filePath: quarantinePath,
      };
    } catch (err) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      throw err;
    }
  }

  function read(key: string, area?: "quarantine" | "clean" | "mime"): Buffer {
    const areas: Array<"clean" | "quarantine" | "mime"> = area ? [area] : ["clean", "quarantine"];
    for (const a of areas) {
      const p = resolveSafePath(key, a);
      if (existsSync(p)) {
        return readFileSync(p);
      }
    }
    throw new AppError("not_found", 404, `File not found for key: ${key}`);
  }

  function getStream(key: string, area?: "quarantine" | "clean" | "mime"): Readable {
    const areas: Array<"clean" | "quarantine" | "mime"> = area ? [area] : ["clean", "quarantine"];
    for (const a of areas) {
      const p = resolveSafePath(key, a);
      if (existsSync(p)) {
        return createReadStream(p);
      }
    }
    throw new AppError("not_found", 404, `File not found for key: ${key}`);
  }

  function moveToClean(key: string): void {
    const quarantinePath = resolveSafePath(key, "quarantine");
    const cleanPath = resolveSafePath(key, "clean");

    if (!existsSync(quarantinePath)) {
      if (existsSync(cleanPath)) return; // already in clean
      throw new AppError("not_found", 404, `Quarantine file not found for key: ${key}`);
    }

    renameSync(quarantinePath, cleanPath);
  }

  function deleteFile(key: string, area?: "quarantine" | "clean" | "mime"): void {
    const areas: Array<"clean" | "quarantine" | "mime" | "tmp"> = area
      ? [area]
      : ["clean", "quarantine", "mime", "tmp"];

    for (const a of areas) {
      const p = resolveSafePath(key, a);
      try {
        unlinkSync(p);
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === "ENOENT") {
          // Idempotent absence in this area
          continue;
        }
        // Propagate other filesystem failures (EACCES, EIO, EPERM, etc.) and AppError
        throw err;
      }
    }
  }

  function persistMime(buffer: Buffer): { key: string; sha256: string } {
    const key = randomUUID();
    const mimePath = resolveSafePath(key, "mime");
    const sha256 = createHash("sha256").update(buffer).digest("hex");

    const fd = openSync(mimePath, "wx", 0o600);
    try {
      writeSync(fd, buffer);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    return { key, sha256 };
  }

  /**
   * Sweeps temporary staging files (tmp/ only) that are older than maxAgeMs relative to referenceDate.
   * Explicitly scoped to tmp/ only. Live quarantine files are NOT swept here because they require
   * committed database reference checks.
   */
  function sweepTmp(maxAgeMs = 24 * 60 * 60 * 1000, referenceDate = new Date()): string[] {
    const swept: string[] = [];
    const now = referenceDate.getTime();
    const dir = join(root, "tmp");
    if (!existsSync(dir)) return swept;

    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (!UUID_REGEX.test(entry)) continue;
      const p = join(dir, entry);
      try {
        const stats = statSync(p);
        if (now - stats.mtimeMs > maxAgeMs) {
          unlinkSync(p);
          swept.push(entry);
        }
      } catch {
        // ignore errors on individual tmp entry
      }
    }

    return swept;
  }

  function orphanSweep(maxAgeMs = 24 * 60 * 60 * 1000): string[] {
    // Deprecated alias for backwards compatibility: strictly sweeps tmp/ staging files only
    return sweepTmp(maxAgeMs);
  }

  function exists(key: string, area?: "quarantine" | "clean" | "mime"): boolean {
    const areas: Array<"clean" | "quarantine" | "mime"> = area
      ? [area]
      : ["clean", "quarantine", "mime"];

    for (const a of areas) {
      try {
        const p = resolveSafePath(key, a);
        if (existsSync(p)) return true;
      } catch {
        // ignore format errors or non-existent
      }
    }
    return false;
  }

  return {
    storageDir: root,
    stage,
    read,
    getStream,
    moveToClean,
    delete: deleteFile,
    persistMime,
    orphanSweep,
    sweepTmp,
    resolveSafePath,
    exists,
  };
}
