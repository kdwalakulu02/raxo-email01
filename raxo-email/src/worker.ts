import type { Pool, PoolClient } from "pg";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createStorage, type StorageAdapter } from "./storage.js";
import type { SmtpConfig } from "./smtp.js";
import {
  claimDueNotification,
  processNotification,
  recoverExpiredLeases,
  renewLease,
} from "./queue.js";
import { runRetention } from "./retention.js";
import { initSnapshotDir, loadSentinelConfig, type SentinelConfig } from "./dual-scan.js";

export const WORKER_ADVISORY_LOCK_ID = 726901;

export interface WorkerOptions {
  pool: Pool;
  storage: StorageAdapter;
  smtpConfig: SmtpConfig;
  scannerHost: string;
  scannerPort: number;
  maxMimeBytes?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  leaseDurationSeconds?: number;
  outboundEnabled?: boolean;
  sentinel?: SentinelConfig;
}

export class Worker {
  public pool: Pool;
  public storage: StorageAdapter;
  public smtpConfig: SmtpConfig;
  public scannerHost: string;
  public scannerPort: number;
  public maxMimeBytes?: number;
  public pollIntervalMs: number;
  public heartbeatIntervalMs: number;
  public leaseDurationSeconds: number;
  public outboundEnabled: boolean;
  public sentinel?: SentinelConfig;

  private lockClient: PoolClient | null = null;
  private isRunning = false;
  private isProcessing = false;
  private hasAdvisoryLock = false;
  private currentLeaseValid = true;
  private isRecoveringLeases = false;

  private pollTimeout: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private retentionInterval: NodeJS.Timeout | null = null;
  private recoveryInterval: NodeJS.Timeout | null = null;
  private activeLeaseRenewalInterval: NodeJS.Timeout | null = null;

  constructor(options: WorkerOptions) {
    this.pool = options.pool;
    this.storage = options.storage;
    this.smtpConfig = options.smtpConfig;
    this.scannerHost = options.scannerHost;
    this.scannerPort = options.scannerPort;
    this.maxMimeBytes = options.maxMimeBytes;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20000;
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? 120;
    this.outboundEnabled = options.outboundEnabled ?? true;
    this.sentinel = options.sentinel;
    this.hasAdvisoryLock = false;
  }

  async acquireLock(): Promise<boolean> {
    this.hasAdvisoryLock = false;
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      return false;
    }

    try {
      const res = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) as acquired;",
        [WORKER_ADVISORY_LOCK_ID],
      );
      if (!res.rows[0]?.acquired) {
        client.release();
        return false;
      }
    } catch {
      client.release();
      return false;
    }

    this.lockClient = client;
    this.hasAdvisoryLock = true;

    // F08: Handle dedicated advisory-lock client error/end events
    const onLockLost = () => {
      if (this.hasAdvisoryLock) {
        console.error("Worker advisory lock client disconnected; ownership lost.");
        this.hasAdvisoryLock = false;
      }
    };
    client.on("error", onLockLost);
    client.on("end", onLockLost);

    return true;
  }

  async releaseLock(): Promise<void> {
    this.hasAdvisoryLock = false;
    if (this.lockClient) {
      this.lockClient.removeAllListeners("error");
      this.lockClient.removeAllListeners("end");
      try {
        await this.lockClient.query("SELECT pg_advisory_unlock($1);", [WORKER_ADVISORY_LOCK_ID]);
      } catch {
        // ignore error during unlock
      } finally {
        this.lockClient.release(true);
        this.lockClient = null;
      }
    }
  }

  async updateHeartbeat(): Promise<void> {
    if (!this.hasAdvisoryLock) return;
    await this.pool.query(
      `INSERT INTO schema_meta (key, value, updated_at)
       VALUES ('worker_heartbeat', jsonb_build_object('last_seen', $1::text), now())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = now()`,
      [new Date().toISOString()],
    );
  }

  async recoverLeases(): Promise<{
    recoveredPreparing: number;
    expiredSubmitting: number;
  }> {
    if (this.isRecoveringLeases) {
      return { recoveredPreparing: 0, expiredSubmitting: 0 };
    }
    this.isRecoveringLeases = true;
    try {
      return await recoverExpiredLeases(this.pool);
    } finally {
      this.isRecoveringLeases = false;
    }
  }

  async processOne(): Promise<boolean> {
    // F06 & F08: Check outboundEnabled and advisory lock ownership before claiming
    if (!this.outboundEnabled || !this.hasAdvisoryLock) {
      return false;
    }

    const claimed = await claimDueNotification(this.pool, this.leaseDurationSeconds);
    if (!claimed) {
      return false;
    }

    const { notification, leaseToken } = claimed;
    this.currentLeaseValid = true;

    // Start lease renewal timer (normal 20-second cadence inside 120-second lease)
    const renewalIntervalMs = 20000;
    this.activeLeaseRenewalInterval = setInterval(() => {
      renewLease(this.pool, notification.id, leaseToken, this.leaseDurationSeconds)
        .then((ok) => {
          if (!ok) {
            this.currentLeaseValid = false;
            console.error("Failed to renew lease: lease expired or lost");
          }
        })
        .catch((err) => {
          this.currentLeaseValid = false;
          console.error("Failed to renew lease:", err);
        });
    }, renewalIntervalMs);

    try {
      this.isProcessing = true;
      const result = await processNotification(notification, leaseToken, {
        pool: this.pool,
        storage: this.storage,
        smtpConfig: this.smtpConfig,
        scannerHost: this.scannerHost,
        scannerPort: this.scannerPort,
        maxMimeBytes: this.maxMimeBytes,
        outboundEnabled: this.outboundEnabled,
        sentinel: this.sentinel,
        isOwnershipValid: () => this.hasAdvisoryLock && this.currentLeaseValid,
      });
      if (result.status === "aborted") {
        return false;
      }
      return true;
    } catch (err) {
      console.error("Worker error during notification processing:", err);
      // F08: An unexpected preparation exception must not leave work stuck until restart
      try {
        await this.pool.query(
          `UPDATE notifications
           SET state = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND lease_token = $2 AND state = 'preparing'`,
          [notification.id, leaseToken],
        );
      } catch {
        // ignore rollback error
      }
      return false;
    } finally {
      this.isProcessing = false;
      if (this.activeLeaseRenewalInterval) {
        clearInterval(this.activeLeaseRenewalInterval);
        this.activeLeaseRenewalInterval = null;
      }
    }
  }

  async start(): Promise<void> {
    const acquired = await this.acquireLock();
    if (!acquired) {
      throw new Error(
        `Worker could not acquire advisory lock ${WORKER_ADVISORY_LOCK_ID}. Another worker is already running.`,
      );
    }

    this.isRunning = true;

    // Crash recovery at startup
    const recovery = await this.recoverLeases();
    if (recovery.recoveredPreparing > 0 || recovery.expiredSubmitting > 0) {
      console.log(
        `Worker crash recovery: recovered ${recovery.recoveredPreparing} preparing, marked ${recovery.expiredSubmitting} submitting as unknown.`,
      );
    }

    // Periodic recovery running every 30s as well as startup recovery (F08)
    this.recoveryInterval = setInterval(async () => {
      if (!this.isRunning || !this.hasAdvisoryLock) return;
      try {
        await this.recoverLeases();
      } catch (err) {
        console.error("Periodic lease recovery failed:", err);
      }
    }, 30000);

    // Initial heartbeat and periodic heartbeat
    await this.updateHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.updateHeartbeat().catch((err) => console.error("Worker heartbeat failed:", err));
    }, this.heartbeatIntervalMs);

    // Retention sweep at startup and hourly
    try {
      await runRetention(this.pool, this.storage);
    } catch (err) {
      console.error("Worker startup retention sweep failed:", err);
    }
    this.retentionInterval = setInterval(() => {
      runRetention(this.pool, this.storage).catch((err) =>
        console.error("Hourly retention sweep failed:", err),
      );
    }, 3600000);

    // Polling loop
    const runLoop = async () => {
      if (!this.isRunning) return;
      try {
        const didProcess = await this.processOne();
        if (didProcess) {
          // Immediately check for more work
          setImmediate(runLoop);
          return;
        }
      } catch (err) {
        console.error("Worker error during notification processing:", err);
      }

      if (this.isRunning) {
        this.pollTimeout = setTimeout(runLoop, this.pollIntervalMs);
      }
    };

    runLoop();
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
      this.recoveryInterval = null;
    }

    if (this.retentionInterval) {
      clearInterval(this.retentionInterval);
      this.retentionInterval = null;
    }

    if (this.activeLeaseRenewalInterval) {
      clearInterval(this.activeLeaseRenewalInterval);
      this.activeLeaseRenewalInterval = null;
    }

    // Wait if an item is currently processing
    while (this.isProcessing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await this.releaseLock();
  }
}

async function main() {
  const config = await loadConfig();
  const pool = createPool(config.databaseUrl);
  const storage = createStorage(config.storageDir);
  const sentinel = loadSentinelConfig(process.env, config.storageDir);
  if (sentinel) initSnapshotDir(sentinel);

  const worker = new Worker({
    pool,
    storage,
    smtpConfig: {
      host: config.smtpHost,
      port: config.smtpPort,
      tlsMode: config.smtpTlsMode,
      username: config.smtpUsername,
      password: config.smtpPassword,
    },
    scannerHost: config.clamdHost,
    scannerPort: config.clamdPort,
    maxMimeBytes: config.smtpMaxMessageBytes,
    outboundEnabled: config.outboundEnabled,
    sentinel,
  });

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`Received ${signal}. Shutting down worker gracefully...`);
    try {
      await worker.stop();
      await pool.end();
      console.log("Worker shutdown complete.");
      process.exit(0);
    } catch (err) {
      console.error("Error during worker shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await worker.start();
    console.log(
      `Raxo Email Forms Core worker started with advisory lock ${WORKER_ADVISORY_LOCK_ID}.`,
    );
  } catch (err) {
    console.error("Failed to start worker:", err);
    await pool.end();
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("worker.ts") || process.argv[1]?.endsWith("worker.js")) {
  main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
