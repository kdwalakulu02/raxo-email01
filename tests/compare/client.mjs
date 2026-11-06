// Runs inside a throwaway node container that shares the API container's network namespace,
// so both implementations are reached identically on http://127.0.0.1:3000 (same client IP,
// same rate-limit bucket semantics, no docker-proxy in the measurement path).
// Usage: node client.mjs '<job json>'
//   job: { path, method?, fields?, files?: [{field,file,filename,type}], count?, concurrency?,
//          headers?, raw?: {body, contentType}, uniqueId?: bool }
// "{i}" in field values is replaced by the request index; uniqueId adds a random _submission_id.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const job = JSON.parse(process.argv[2]);
const base = job.base ?? "http://127.0.0.1:3000";
const count = job.count ?? 1;
const concurrency = job.concurrency ?? 1;
const cache = new Map();
const load = (f) => cache.get(f) ?? (cache.set(f, readFileSync(f)), cache.get(f));

async function one(i) {
  const headers = { accept: "application/json", ...(job.headers ?? {}) };
  let body;
  if (job.raw) {
    body = job.raw.body;
    headers["content-type"] = job.raw.contentType;
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(job.fields ?? {})) form.append(k, String(v).replaceAll("{i}", String(i)));
    if (job.uniqueId) form.append("_submission_id", randomUUID());
    for (const f of job.files ?? []) {
      form.append(f.field ?? "attachments", new Blob([load(f.file)], { type: f.type ?? "application/octet-stream" }), f.filename);
    }
    body = form;
  }
  const t0 = performance.now();
  try {
    const method = job.method ?? "POST";
    const res = await fetch(base + job.path, { method, body: method === "GET" || method === "HEAD" ? undefined : body, headers, redirect: "manual" });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.slice(0, 200);
    }
    return { i, status: res.status, ms: +(performance.now() - t0).toFixed(1), body: parsed };
  } catch (e) {
    return { i, status: 0, ms: +(performance.now() - t0).toFixed(1), body: String(e.cause?.code ?? e.message) };
  }
}

const out = new Array(count);
let next = 0;
const t0 = performance.now();
await Promise.all(
  Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      const i = next++;
      out[i] = await one(i);
    }
  }),
);
console.log(JSON.stringify({ wall_ms: +(performance.now() - t0).toFixed(1), results: out }));
