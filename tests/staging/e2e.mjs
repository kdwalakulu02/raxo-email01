// Host-side end-to-end runner for the isolated staging stack (project raxo_combo).
// Usage: node tests/staging/e2e.mjs   (stack from deploy/staging must be running)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const outDir = join(root, "results");
const fixDir = join(outDir, "fixtures");
mkdirSync(fixDir, { recursive: true });
const env = Object.fromEntries(
  readFileSync(join(root, "deploy/staging/.env.staging"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
const docker = (...a) => sh("docker", a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");

function psql(sql) {
  return docker(
    "exec", "raxo_combo_postgres", "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-At", "-c", sql,
  ).trim();
}
const mailpit = async (path, init) => {
  const text = await (await fetch(`http://127.0.0.1:18025/api/v1${path}`, init)).text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// ---------- fixtures ----------
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
function pdf(streamText) {
  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const objs = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamText)} >>\nstream\n${streamText}\nendstream\nendobj\n`,
  ];
  let off = Buffer.byteLength(header);
  const offs = objs.map((o) => {
    const v = off;
    off += Buffer.byteLength(o);
    return v;
  });
  const xref =
    "xref\n0 5\n0000000000 65535 f \n" + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(
    header + objs.join("") + xref + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${off}\n%%EOF\n`,
    "latin1",
  );
}
const normalPdf = pdf("BT /F1 12 Tf 72 712 Td (Raxo combo staging clean document) Tj ET");
const eicarPdf = pdf(EICAR);
writeFileSync(join(fixDir, "eicar.txt"), EICAR);
sh("python3", [
  "-c",
  `
import zipfile
e=open("${join(fixDir, "eicar.txt")}","rb").read()
for name,comp in (("eicar-stored.zip",zipfile.ZIP_STORED),("eicar-deflated.zip",zipfile.ZIP_DEFLATED)):
    with zipfile.ZipFile("${fixDir}/"+name,"w",comp) as z: z.writestr("eicar.com",e)
`,
]);
const zipStored = readFileSync(join(fixDir, "eicar-stored.zip"));
const zipDeflated = readFileSync(join(fixDir, "eicar-deflated.zip"));
const fixtures = {
  "normal.pdf": [normalPdf, "application/pdf"],
  "eicar.pdf": [eicarPdf, "application/pdf"],
  "eicar-stored.zip": [zipStored, "application/zip"],
  "polyglot-stored-zip.pdf": [Buffer.concat([Buffer.from("%PDF-1.4\n"), zipStored]), "application/pdf"],
  "polyglot-deflated-zip.pdf": [Buffer.concat([Buffer.from("%PDF-1.4\n"), zipDeflated]), "application/pdf"],
};
for (const mb of [1, 5, 9]) {
  fixtures[`large-${mb}mb.pdf`] = [pdf(randomBytes((mb * 1024 * 1024) / 2 - 2048).toString("hex")), "application/pdf"];
}
for (const [n, [b]] of Object.entries(fixtures)) writeFileSync(join(fixDir, n), b);

// ---------- submission helper ----------
let lastSubmitAt = 0;
async function submit(name) {
  // API limit is 5 submissions/minute/IP
  const wait = lastSubmitAt + 13000 - Date.now();
  if (wait > 0) await sleep(wait);
  const [buf, mime] = fixtures[name];
  docker("cp", join(fixDir, name), `raxo_combo_api:/tmp/${name}`);
  docker("cp", join(here, "submit.mjs"), "raxo_combo_api:/tmp/submit.mjs");
  const t0 = Date.now();
  const out = JSON.parse(docker("exec", "raxo_combo_api", "node", "/tmp/submit.mjs", `/tmp/${name}`, name, mime));
  lastSubmitAt = Date.now();
  return { name, sha256: sha(buf), http: out, t0 };
}

async function settle(sub, timeoutMs = 120000) {
  const id = sub.http.body?.submission_id;
  if (!id) return { notification: null };
  const t0 = Date.now();
  let n;
  while (Date.now() - t0 < timeoutMs) {
    n = psql(`select state||'|'||coalesce(last_error_code,'')||'|'||prepare_failures||'|'||message_id||'|'||round(extract(epoch from (updated_at-created_at))*1000) from notifications where submission_id='${id}'`);
    const state = n.split("|")[0];
    if (["submitted", "blocked", "failed", "unknown"].includes(state)) break;
    await sleep(500);
  }
  const [state, err, failures, messageId, procMs] = n.split("|");
  const scans = JSON.parse(
    psql(`select coalesce(json_agg(row_to_json(t) order by t.created_at, t.scanner),'[]') from (select scanner,shadow,verdict,detection,engine_version,database_generation,left(sha256,16) as sha16,sha256=(select sha256 from attachments where id=attachment_id) as sha_matches_attachment,size_bytes,duration_ms,error,created_at from scan_results where attachment_id in (select id from attachments where submission_id='${id}')) t`),
  );
  const att = psql(`select scan_state||'|'||sha256 from attachments where submission_id='${id}'`).split("|");
  await sleep(1000);
  const msgs = (await mailpit("/messages")).messages ?? [];
  const delivered = msgs.filter((m) => m.Snippet !== undefined && m.Subject?.includes("STAGING")).length;
  const withAtt = msgs.filter((m) => (m.Attachments ?? 0) > 0).length;
  return {
    submission_id: id,
    notification: { state, last_error_code: err, prepare_failures: Number(failures), message_id: messageId, queue_to_final_ms: Number(procMs) },
    attachment: { scan_state: att[0], sha256_db: att[1], sha256_expected: sub.sha256 },
    scans,
    mailpit: { messages: msgs.length, staging_messages: delivered, with_attachment: withAtt },
    settle_ms: Date.now() - t0,
  };
}

async function clearMail() {
  await mailpit("/messages", { method: "DELETE" });
}

async function runCase(label, name) {
  await clearMail();
  const sub = await submit(name);
  const res = await settle(sub);
  const r = { label, file: name, http_status: sub.http.status, http_body: sub.http.body, ...res };
  console.log(JSON.stringify(r, null, 1));
  return r;
}

async function sentinelReady(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const o = docker(
        "exec", "raxo_combo_worker", "sh", "-c",
        "echo ok > /tmp/health.txt; /opt/raxosentinel/bin/raxosentinel client --socket /run/raxosentinel/scan.sock --json-envelope /tmp/health.txt",
      );
      const j = JSON.parse(o);
      if (j.status === "CLEAN") return j.database_generation;
    } catch {
      /* not ready */
    }
    await sleep(1000);
  }
  return null;
}

const results = {};
const only = process.argv[2];
const want = (k) => !only || only === k;

if (want("A")) results.A = await runCase("TEST A normal PDF", "normal.pdf");
if (want("B")) results.B = await runCase("TEST B EICAR PDF", "eicar.pdf");

if (want("C")) {
  docker("stop", "raxo_combo_sentinel");
  results.C_clean = await runCase("TEST C (sentinel stopped) normal PDF", "normal.pdf");
  results.C_eicar = await runCase("TEST C (sentinel stopped) EICAR PDF", "eicar.pdf");
  docker("start", "raxo_combo_sentinel");
  results.C_restore_generation = await sentinelReady();
}

if (want("C2")) {
  // Hung coordinator: processes frozen, socket still present -> bounded timeout must trip.
  docker("pause", "raxo_combo_sentinel");
  try {
    results.C2_hung_clean = await runCase("TEST C2 (sentinel paused/hung) normal PDF", "normal.pdf");
  } finally {
    docker("unpause", "raxo_combo_sentinel");
  }
}

if (want("D")) {
  const gen = await sentinelReady();
  console.log("sentinel ready, generation:", gen);
  results.D_clean = await runCase("TEST D normal PDF after restore", "normal.pdf");
  results.D_eicar = await runCase("TEST D EICAR PDF after restore", "eicar.pdf");
}

if (want("D2")) {
  // Hard kill leaves a stale socket; coordinator must come back on restart.
  docker("kill", "raxo_combo_sentinel");
  results.D2_down = await runCase("TEST D2 (sentinel killed) normal PDF", "normal.pdf");
  docker("start", "raxo_combo_sentinel");
  results.D2_generation = await sentinelReady();
  results.D2_up = await runCase("TEST D2 normal PDF after hard-kill restart", "normal.pdf");
}

if (want("E")) {
  results.E_zip_http = await runCase("TEST E1 pure ZIP via form (expect existing PDF-only policy rejection)", "eicar-stored.zip");
  results.E_polyglot_stored = await runCase("TEST E2 PDF-header + stored ZIP(EICAR)", "polyglot-stored-zip.pdf");
  results.E_polyglot_deflated = await runCase("TEST E3 PDF-header + deflated ZIP(EICAR)", "polyglot-deflated-zip.pdf");
}

if (want("P")) {
  for (const n of ["normal.pdf", "large-1mb.pdf", "large-5mb.pdf", "large-9mb.pdf"]) {
    results[`P_${n}`] = await runCase(`PERF e2e ${n}`, n);
  }
}

writeFileSync(join(outDir, `e2e-${only ?? "all"}.json`), JSON.stringify(results, null, 1));
console.log("done");
