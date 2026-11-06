// Node.js vs Rust behaviour comparison driver.
//   node tests/compare/run.mjs <node|rust> [A B C ...]
// Both stacks run on identical staging configuration (same forms file, same pinned Sentinel
// artifacts, plain-SMTP Mailpit sink, loopback API + DEMO_MODE). Requests go through
// tests/compare/client.mjs inside the API container's network namespace. Everything is staging-only.
// Raw results are written to results/compare-<impl>-<test>.json (git-ignored).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixtures } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const fx = join(root, "results", "fixtures");
mkdirSync(fx, { recursive: true });
makeFixtures(fx);

const env = Object.fromEntries(
  readFileSync(join(root, ".env.staging"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const IMPLS = {
  node: {
    api: "raxo_combo_api", worker: "raxo_combo_worker", pg: "raxo_combo_postgres", sentinel: "raxo_combo_sentinel",
    mailpit: "raxo_combo_mailpit", mailPort: 18025, clamav: "raxo_combo_clamav",
    cli: ["node", "/app/dist/src/cli.js"], workerCmd: ["node", "/app/dist/src/worker.js"],
    sentinelProbe: "raxo_combo_worker",
  },
  rust: {
    api: "raxo_rust_api", worker: "raxo_rust_worker", pg: "raxo_rust_postgres", sentinel: "raxo_rust_sentinel",
    mailpit: "raxo_rust_mailpit", mailPort: 18026, clamav: null,
    cli: ["raxo-cli"], workerCmd: ["raxo-worker"],
    sentinelProbe: "raxo_rust_sentinel",
  },
};
const impl = process.argv[2];
const I = IMPLS[impl];
if (!I) throw new Error("usage: run.mjs <node|rust> [tests...]");
const only = process.argv.slice(3);
const want = (k) => only.length === 0 || only.includes(k);

const NODE_IMG = "node:22.23.3-bookworm-slim";
const FORM = "/forms/staging-contact";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 << 20, ...opts });
const docker = (...a) => sh("docker", a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const log = (...a) => console.error(`[${impl}]`, ...a);

const psql = (sql) =>
  docker("exec", I.pg, "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-At", "-c", sql).trim();
const psqlJson = (sql) => JSON.parse(psql(`select coalesce(json_agg(t),'[]') from (${sql}) t`));
const clearRate = () => psql("truncate rate_buckets");

const mpBase = `http://127.0.0.1:${I.mailPort}/api/v1`;
async function mp(path, init) {
  const res = await fetch(mpBase + path, init);
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    return JSON.parse(buf.toString());
  } catch {
    return buf;
  }
}
const clearMail = () => mp("/messages", { method: "DELETE" });

async function mails() {
  const list = (await mp("/messages?limit=500")).messages ?? [];
  const out = [];
  for (const m of list) {
    const d = await mp(`/message/${m.ID}`);
    const atts = [];
    for (const a of d.Attachments ?? []) {
      const bytes = await mp(`/message/${m.ID}/part/${a.PartID}`);
      atts.push({ filename: a.FileName, contentType: a.ContentType, size: a.Size, sha256: Buffer.isBuffer(bytes) ? sha(bytes) : null });
    }
    const raw = await mp(`/message/${m.ID}/raw`);
    out.push({
      id: m.ID, subject: d.Subject, messageId: d.MessageID, attachments: atts,
      text: d.Text ?? "", hasHtml: !!d.HTML, html: d.HTML ?? "",
      rawTopContentType: (Buffer.isBuffer(raw) ? raw.toString() : "").match(/^Content-Type:[^\n]*/im)?.[0]?.trim() ?? null,
      rawHeaders: (Buffer.isBuffer(raw) ? raw.toString() : "").split(/\r?\n\r?\n/)[0].split(/\r?\n/).filter((l) => /^(X-|Message-ID|Subject|Reply-To)/i.test(l)),
    });
  }
  return out;
}

function client(job, { api = I.api } = {}) {
  const out = docker(
    "run", "--rm", "--network", `container:${api}`,
    "-v", `${here}:/w:ro`, "-v", `${fx}:/fx:ro`,
    NODE_IMG, "node", "/w/client.mjs", JSON.stringify(job),
  );
  return JSON.parse(out);
}
const baseFields = (n = "") => ({ full_name: "Compare Tester", email: "tester@raxo-combo.test", message: `compare ${n}` });
const fileSpec = (name, type = "application/pdf", filename = name) => ({ file: `/fx/${name}`, filename, type });
const fixSha = (name) => sha(readFileSync(join(fx, name)));
const TERMINAL = ["submitted", "blocked", "failed", "unknown"];

async function settle(ids, timeoutMs = 120000) {
  const t0 = Date.now();
  const list = ids.map((i) => `'${i}'`).join(",");
  let rows = [];
  while (Date.now() - t0 < timeoutMs) {
    rows = psqlJson(`select submission_id, state, last_error_code, prepare_failures,
      round(extract(epoch from (updated_at-created_at))*1000) as proc_ms from notifications where submission_id in (${list})`);
    if (rows.length === ids.length && rows.every((r) => TERMINAL.includes(r.state))) break;
    await sleep(500);
  }
  return { rows, settle_ms: Date.now() - t0 };
}

function dbView(ids) {
  const list = ids.map((i) => `'${i}'`).join(",");
  return {
    attachments: psqlJson(`select submission_id, original_name as filename, scan_state, to_jsonb(a)->>'delivery_disposition' as disposition,
      to_jsonb(a)->>'withheld_category' as withheld_category, left(sha256,12) as sha12, size_bytes from attachments a where submission_id in (${list}) order by original_name`),
    scans: psqlJson(`select s.scanner, s.shadow, s.verdict, s.detection, s.error, s.duration_ms, a.original_name as filename
      from scan_results s join attachments a on a.id=s.attachment_id where a.submission_id in (${list}) order by a.original_name, s.created_at, s.scanner`),
    attempts: psqlJson(`select n.submission_id, sa.attempt_number, sa.outcome, sa.error_code from send_attempts sa join notifications n on n.id=sa.notification_id where n.submission_id in (${list}) order by sa.attempt_number`),
  };
}

const slim = (m) => ({
  subject: m.subject, attachments: m.attachments.map((a) => ({ filename: a.filename, ct: a.contentType, size: a.size, sha256: a.sha256 })),
  has_security_notice: /SECURITY NOTICE/i.test(m.text), notice_html: /security notice/i.test(m.html),
  top_content_type: m.rawTopContentType, headers: m.rawHeaders, text_head: m.text.slice(0, 900),
});

async function scenario(label, files, { fields = baseFields(label), settleMs = 120000, keepMail = false } = {}) {
  clearRate();
  await clearMail();
  const r = client({ path: FORM, fields, files, uniqueId: false });
  const first = r.results[0];
  const res = { label, http_status: first.status, http_body: first.body, latency_ms: first.ms };
  const id = first.body?.submission_id;
  if (first.status === 202 && id) {
    const s = await settle([id], settleMs);
    await sleep(1500);
    res.notification = s.rows[0];
    res.settle_ms = s.settle_ms;
    Object.assign(res, dbView([id]));
    res.delivered = (await mails()).map(slim);
  }
  log(label, "→", first.status, res.notification?.state ?? "-", `delivered=${res.delivered?.length ?? 0}`);
  return res;
}

async function sentinelReady(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const o = docker("exec", I.sentinelProbe, "sh", "-c",
        "echo ok > /tmp/health.txt; /opt/raxosentinel/bin/raxosentinel client --socket /run/raxosentinel/scan.sock --json-envelope /tmp/health.txt");
      if (JSON.parse(o).status === "CLEAN") return true;
    } catch { /* not ready */ }
    await sleep(1000);
  }
  return false;
}
const save = (key, data) => {
  writeFileSync(join(root, "results", `compare-${impl}-${key}.json`), JSON.stringify(data, null, 1));
};

// ------------------------------------------------------------------ tests
const R = {};

if (want("A")) {
  R.A = [await scenario("A normal submission, no attachment", [])];
  save("A", R.A);
}

if (want("B")) {
  R.B = [await scenario("B clean PDF", [fileSpec("normal.pdf")])];
  R.B[0].expected_sha256 = fixSha("normal.pdf");
  save("B", R.B);
}

if (want("C")) {
  R.C = [
    await scenario("C EICAR in PDF body", [fileSpec("eicar.pdf")]),
    await scenario("C EICAR plain text file", [fileSpec("eicar.txt", "text/plain")]),
  ];
  save("C", R.C);
}

if (want("D")) {
  R.D = [];
  const cases = [
    ["eicar-stored.zip", "application/zip"], ["eicar-deflated.zip", "application/zip"],
    ["eicar.tar.gz", "application/gzip"], ["eicar.tar", "application/x-tar"], ["eicar.gz", "application/gzip"],
    ["nested.zip", "application/zip"], ["polyglot-stored-zip.pdf", "application/pdf"],
    ["polyglot-deflated-zip.pdf", "application/pdf"], ["clean.zip", "application/zip"],
  ];
  for (const [n, t] of cases) R.D.push(await scenario(`D ${n}`, [fileSpec(n, t)]));
  save("D", R.D);
}

if (want("E")) {
  R.E = [];
  if (!I.clamav) {
    R.E.push({ label: "E ClamAV unavailable", not_applicable: "Rust build has no ClamAV (RaxoSentinel-only by decision)" });
  } else {
    docker("stop", I.clamav);
    const r = await scenario("E ClamAV down, clean PDF", [fileSpec("normal.pdf")], { settleMs: 45000 });
    r.after_restart = null;
    docker("start", I.clamav);
    const t0 = Date.now();
    const id = r.http_body?.submission_id;
    // The worker backs off 60 s between scanner-unavailable retries; wait for recovery.
    while (id && Date.now() - t0 < 360000) {
      const st = psql(`select state from notifications where submission_id='${id}'`);
      if (TERMINAL.includes(st)) break;
      await sleep(3000);
    }
    if (id) {
      r.after_restart = { notification: psqlJson(`select state,last_error_code,prepare_failures from notifications where submission_id='${id}'`)[0], delivered: (await mails()).map(slim), recovery_ms: Date.now() - t0, ...dbView([id]) };
    }
    R.E.push(r);
  }
  save("E", R.E);
}

if (want("F")) {
  R.F = [];
  docker("stop", I.sentinel);
  try {
    R.F.push(await scenario("F Sentinel stopped, clean PDF", [fileSpec("normal.pdf")], { settleMs: 60000 }));
    R.F.push(await scenario("F Sentinel stopped, EICAR PDF", [fileSpec("eicar.pdf")], { settleMs: 60000 }));
  } finally {
    docker("start", I.sentinel);
    R.F_restored = await sentinelReady();
  }
  R.F.push(await scenario("F after Sentinel restored, EICAR PDF", [fileSpec("eicar.pdf")]));
  save("F", R.F);
}

if (want("G")) {
  R.G = [];
  docker("pause", I.sentinel);
  try {
    R.G.push(await scenario("G Sentinel hung (paused), clean PDF", [fileSpec("normal.pdf")], { settleMs: 150000 }));
  } finally {
    docker("unpause", I.sentinel);
  }
  R.G.push(await scenario("G after unpause, clean PDF", [fileSpec("normal.pdf")]));
  save("G", R.G);
}

if (want("H") || want("I")) {
  R.HI = {};
  docker("stop", I.mailpit);
  clearRate();
  const r = client({ path: FORM, fields: baseFields("smtp-down"), files: [fileSpec("normal.pdf")] }).results[0];
  const id = r.body?.submission_id;
  R.HI.http = { status: r.status };
  await sleep(20000);
  R.HI.while_down = { notification: psqlJson(`select state,last_error_code,prepare_failures from notifications where submission_id='${id}'`)[0], ...dbView([id]) };
  log("H while SMTP down:", JSON.stringify(R.HI.while_down.notification));
  docker("start", I.mailpit);
  await sleep(3000);
  await clearMail();
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < 300000) {
    st = psql(`select state from notifications where submission_id='${id}'`);
    if (TERMINAL.includes(st)) break;
    await sleep(2000);
  }
  await sleep(1500);
  R.HI.recovered = { state: st, recovery_ms: Date.now() - t0, delivered: (await mails()).map(slim), ...dbView([id]) };
  log("I recovered:", st, `delivered=${R.HI.recovered.delivered.length}`);
  save("HI", R.HI);
}

if (want("J")) {
  R.J = {};
  clearRate();
  await clearMail();
  const sid = randomUUID();
  const body = { path: FORM, fields: { ...baseFields("dup"), _submission_id: sid }, files: [fileSpec("normal.pdf")] };
  const reps = [];
  for (let k = 0; k < 3; k++) reps.push(client(body).results[0]);
  const diff = client({ ...body, fields: { ...body.fields, message: "different payload" } }).results[0];
  R.J.same_payload = reps.map((r) => ({ status: r.status, id: r.body?.submission_id, code: r.body?.error?.code }));
  R.J.conflicting_payload = { status: diff.status, code: diff.body?.error?.code };
  await settle([sid]);
  await sleep(1500);
  R.J.submissions_rows = Number(psql(`select count(*) from submissions where id='${R.J.same_payload[0].id}'`));
  R.J.messages_delivered = (await mails()).length;
  // Two competing workers: start a second worker process inside the worker container.
  const n = 12;
  await clearMail();
  docker("exec", "-d", I.worker, ...I.workerCmd);
  await sleep(2000);
  const ids = [];
  for (let b = 0; b < 3; b++) {
    clearRate();
    const r = client({ path: FORM, fields: baseFields("two-workers {i}"), files: [fileSpec("normal.pdf")], count: n / 3, concurrency: 1, uniqueId: true });
    ids.push(...r.results.filter((x) => x.status === 202).map((x) => x.body.submission_id));
  }
  const s = await settle(ids, 180000);
  await sleep(3000);
  const ms = await mails();
  R.J.two_workers = {
    accepted: ids.length, states: Object.fromEntries(s.rows.reduce((m, r) => m.set(r.state, (m.get(r.state) ?? 0) + 1), new Map())),
    messages: ms.length, unique_message_ids: new Set(ms.map((m) => m.messageId)).size,
    max_attempts_per_notification: Math.max(...psqlJson(`select count(*) c from send_attempts sa join notifications n on n.id=sa.notification_id where n.submission_id in (${ids.map((i) => `'${i}'`).join(",")}) group by n.id`).map((r) => r.c)),
  };
  docker("restart", I.worker); // drop the extra worker process
  log("J", JSON.stringify(R.J));
  save("J", R.J);
}

if (want("K")) {
  R.K = {};
  await clearMail();
  clearRate();
  const total = 40;
  const accepted = [];
  const statuses = {};
  const t0 = Date.now();
  // Bursts of 4 parallel uploads; the per-IP limit (5/min) is reset between bursts, staging only.
  for (let b = 0; b < total / 4; b++) {
    clearRate();
    const r = client({ path: FORM, fields: baseFields("conc {i}"), files: [fileSpec(b % 2 ? "normal.pdf" : "eicar.pdf")], count: 4, concurrency: 4, uniqueId: true });
    for (const x of r.results) {
      statuses[x.status] = (statuses[x.status] ?? 0) + 1;
      if (x.status === 202) accepted.push(x.body.submission_id);
    }
  }
  R.K.submit_wall_ms = Date.now() - t0;
  R.K.http_statuses = statuses;
  const s = await settle(accepted, 300000);
  await sleep(3000);
  const ms = await mails();
  R.K.accepted = accepted.length;
  R.K.final_states = s.rows.reduce((m, r) => ((m[r.state] = (m[r.state] ?? 0) + 1), m), {});
  R.K.messages = ms.length;
  R.K.unique_message_ids = new Set(ms.map((m) => m.messageId)).size;
  R.K.messages_with_attachment = ms.filter((m) => m.attachments.length > 0).length;
  R.K.eicar_leaks = ms.filter((m) => m.attachments.some((a) => a.sha256 === fixSha("eicar.pdf"))).length;
  R.K.drain_ms = s.settle_ms;
  log("K", JSON.stringify(R.K));
  save("K", R.K);
}

if (want("L")) {
  R.L = {};
  await clearMail();
  clearRate();
  const before = client({ path: FORM, fields: baseFields("pre-restart {i}"), files: [fileSpec("normal.pdf")], count: 3, uniqueId: true }).results;
  const during = [];
  // fire requests while postgres restarts
  const restart = new Promise((res) => {
    const p = sh("docker", ["restart", I.pg]);
    res(p);
  });
  const burst = client({ path: FORM, fields: baseFields("during-restart {i}"), files: [fileSpec("normal.pdf")], count: 4, concurrency: 1, uniqueId: true });
  during.push(...burst.results);
  await restart;
  let ready = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    try {
      psql("select 1");
      const h = client({ path: "/health/ready", method: "GET" }).results[0];
      if (h.status === 200) { ready = true; break; }
    } catch { /* still recovering */ }
    await sleep(1000);
  }
  R.L.api_ready_after_ms = ready ? Date.now() - t0 : null;
  clearRate();
  const after = client({ path: FORM, fields: baseFields("post-restart {i}"), files: [fileSpec("normal.pdf")], count: 3, uniqueId: true }).results;
  const all = [...before, ...during, ...after];
  const accepted = all.filter((x) => x.status === 202).map((x) => x.body.submission_id);
  R.L.http_before = before.map((x) => x.status);
  R.L.http_during = during.map((x) => `${x.status}${x.body?.error?.code ? ":" + x.body.error.code : ""}`);
  R.L.http_after = after.map((x) => x.status);
  const s = await settle(accepted, 240000);
  await sleep(3000);
  const ms = await mails();
  R.L.accepted = accepted.length;
  R.L.final_states = s.rows.reduce((m, r) => ((m[r.state] = (m[r.state] ?? 0) + 1), m), {});
  R.L.messages = ms.length;
  R.L.unique_message_ids = new Set(ms.map((m) => m.messageId)).size;
  R.L.api_container_restarts = Number(docker("inspect", I.api, "--format", "{{.RestartCount}}"));
  R.L.worker_still_running = docker("inspect", I.worker, "--format", "{{.State.Running}}").trim();
  log("L", JSON.stringify(R.L));
  save("L", R.L);
}

if (want("M")) {
  R.M = {};
  await clearMail();
  clearRate();
  docker("stop", I.worker);
  const r = client({ path: FORM, fields: baseFields("integrity"), files: [fileSpec("normal.pdf")] }).results[0];
  const id = r.body?.submission_id;
  const key = psql(`select storage_key from attachments where submission_id='${id}'`);
  // Flip one byte of the staged attachment while no worker is running.
  const files = docker("exec", I.api, "sh", "-c", `find /app/storage -type f -name '*' | grep -F '${key.split("/").pop()}' || true`).trim().split("\n").filter(Boolean);
  R.M.staged_files_found = files.length;
  if (files.length) docker("exec", I.api, "sh", "-c", `printf 'X' >> '${files[0]}'`);
  docker("start", I.worker);
  const s = await settle([id], 90000);
  await sleep(1500);
  R.M = { ...R.M, http_status: r.status, notification: s.rows[0], ...dbView([id]), delivered: (await mails()).map(slim) };
  log("M", JSON.stringify(R.M.notification), `delivered=${R.M.delivered.length}`);
  save("M", R.M);
}

if (want("N")) {
  R.N = [];
  const cases = [
    ["missing required field", { path: FORM, fields: { email: "t@x.test" } }],
    ["invalid email", { path: FORM, fields: { ...baseFields(), email: "not-an-email" } }],
    ["field too long", { path: FORM, fields: { ...baseFields(), message: "x".repeat(4001) } }],
    ["unknown form", { path: "/forms/does-not-exist", fields: baseFields() }],
    ["unknown extra field", { path: FORM, fields: { ...baseFields(), surprise: "1" } }],
    ["GET on form route", { path: FORM, method: "GET" }],
    ["JSON body", { path: FORM, raw: { body: JSON.stringify(baseFields()), contentType: "application/json" } }],
    ["urlencoded body", { path: FORM, raw: { body: "full_name=A&email=a%40x.test&message=hi", contentType: "application/x-www-form-urlencoded" } }],
    ["empty body", { path: FORM, raw: { body: "", contentType: "multipart/form-data; boundary=x" } }],
    ["bad _submission_id", { path: FORM, fields: { ...baseFields(), _submission_id: "not-a-uuid" } }],
    ["disallowed type (.exe)", { path: FORM, fields: baseFields(), files: [fileSpec("bad.exe", "application/x-msdownload")] }],
    ["type/extension mismatch", { path: FORM, fields: baseFields(), files: [fileSpec("bad.exe", "application/pdf", "evil.pdf")] }],
    ["oversized attachment (>10 MiB)", { path: FORM, fields: baseFields(), files: [fileSpec("over-10mb.pdf")] }],
    ["6 attachments (max 5)", { path: FORM, fields: baseFields(), files: Array.from({ length: 6 }, () => fileSpec("normal.pdf")) }],
    ["5 attachments", { path: FORM, fields: baseFields(), files: Array.from({ length: 5 }, () => fileSpec("normal.pdf")) }],
    ["path traversal filename", { path: FORM, fields: baseFields(), files: [fileSpec("normal.pdf", "application/pdf", "../../etc/passwd.pdf")] }],
    ["honeypot filled", { path: FORM, fields: { ...baseFields(), _gotcha: "bot" } }],
    ["unknown route", { path: "/nope", method: "GET" }],
    ["health live", { path: "/health/live", method: "GET" }],
    ["health ready", { path: "/health/ready", method: "GET" }],
  ];
  for (const [name, job] of cases) {
    clearRate();
    const r = client(job).results[0];
    R.N.push({ name, status: r.status, code: r.body?.error?.code ?? (typeof r.body === "object" ? r.body?.status : String(r.body).slice(0, 40)) });
    log("N", name, "→", R.N.at(-1).status, R.N.at(-1).code);
  }
  // 15 MiB aggregate is rejected before buffering
  clearRate();
  const big = client({ path: FORM, fields: baseFields(), files: [fileSpec("over-10mb.pdf"), fileSpec("large-5mb.pdf")] }).results[0];
  R.N.push({ name: "aggregate >11 MiB", status: big.status, code: big.body?.error?.code });
  // per-IP rate limit
  clearRate();
  const rl = client({ path: FORM, fields: baseFields("rl {i}"), count: 7, uniqueId: true }).results.map((x) => x.status);
  R.N.push({ name: "rate limit: 7 rapid submissions", statuses: rl });
  save("N", R.N);
}

if (want("O")) {
  R.O = {};
  R.O.migrations = psql("select string_agg(version, ',' order by version) from schema_migrations").split(",");
  R.O.schema = psql(`select string_agg(table_name||'.'||column_name||':'||data_type, ',' order by table_name, column_name) from information_schema.columns where table_schema='public'`).split(",");
  R.O.row_counts = psqlJson("select (select count(*) from submissions) submissions, (select count(*) from attachments) attachments, (select count(*) from notifications) notifications, (select count(*) from scan_results) scan_results, (select count(*) from send_attempts) send_attempts")[0];
  // Retention: run far in the future and show what is purged.
  const future = new Date(Date.now() + 120 * 86400e3).toISOString();
  const run = (...a) => { try { return docker("exec", I.api, ...I.cli, ...a).trim(); } catch (e) { return `EXIT ${e.status}: ${(e.stdout ?? "") + (e.stderr ?? "")}`.trim(); } };
  R.O.retention_now = run("retention", "run");
  R.O.counts_after_now = psqlJson("select (select count(*) from submissions) submissions, (select count(*) from attachments) attachments, (select count(*) from notifications) notifications, (select count(*) from scan_results) scan_results")[0];
  R.O.retention_future = run("retention", "run", "--now", future);
  R.O.counts_after_future = psqlJson("select (select count(*) from submissions) submissions, (select count(*) from attachments) attachments, (select count(*) from notifications) notifications, (select count(*) from scan_results) scan_results, (select count(*) from submissions where deleted_at is not null) tombstoned")[0];
  R.O.storage_files_left = Number(docker("exec", I.api, "sh", "-c", "find /app/storage -type f | wc -l").trim());
  R.O.retention_bad_arg = run("retention", "run", "--now", "garbage");
  log("O", JSON.stringify({ mig: R.O.migrations, now: R.O.retention_now, future: R.O.retention_future, after: R.O.counts_after_future }));
  save("O", R.O);
}

log("done", only.join("") || "all");
