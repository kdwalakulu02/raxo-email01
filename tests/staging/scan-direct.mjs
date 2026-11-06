// Runs INSIDE the staging worker container (uses the integrated scanner code, no DB, no delivery):
//   node scan-direct.mjs ITERATIONS FILE...
// Prints one JSON line per scan with both scanners' verdicts and durations, then a summary.
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { scanClamAvBytes, scanSentinelShadow, loadSentinelConfig } from "/app/dist/src/dual-scan.js";

const iterations = Number(process.argv[2]);
const files = process.argv.slice(3);
const cfg = loadSentinelConfig(process.env, "/app/storage");
const clam = { host: process.env.CLAMD_HOST, port: Number(process.env.CLAMD_PORT) };

const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
const summary = {};
for (const f of files) {
  const orig = readFileSync(f);
  const c = [];
  const s = [];
  const both = [];
  let last;
  for (let i = 0; i < iterations; i++) {
    // Unique bytes per iteration so clamd's result cache cannot hide real scan cost.
    const buf = Buffer.concat([orig, Buffer.from("\n%" + randomBytes(8).toString("hex") + "\n")]);
    const sha = createHash("sha256").update(buf).digest("hex");
    const t0 = performance.now();
    const [cr, sr] = await Promise.all([
      scanClamAvBytes(buf, sha, clam),
      scanSentinelShadow(buf, sha, "00000000-0000-0000-0000-000000000000", cfg),
    ]);
    both.push(performance.now() - t0);
    c.push(cr.record.durationMs);
    s.push(sr.durationMs);
    last = { cr, sr };
  }
  const row = {
    file: basename(f),
    bytes: orig.length,
    clamav: { verdict: last.cr.record.verdict, detection: last.cr.record.detection, error: last.cr.record.error },
    raxosentinel: {
      verdict: last.sr.verdict,
      detection: last.sr.detection,
      generation: last.sr.databaseGeneration,
      error: last.sr.error,
    },
    iterations,
    clamav_ms: { p50: pct(c, 50), max: Math.max(...c) },
    sentinel_ms: { p50: pct(s, 50), max: Math.max(...s) },
    combined_parallel_ms: { p50: Math.round(pct(both, 50)), max: Math.round(Math.max(...both)) },
  };
  summary[basename(f)] = row;
  console.log(JSON.stringify(row));
}
