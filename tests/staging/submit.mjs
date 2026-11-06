// Runs INSIDE the staging api container: node submit.mjs FILE FILENAME MIME
// Submits one multipart form to the loopback-only API and prints {status, body}.
import { readFileSync } from "node:fs";

const [file, filename, mime] = process.argv.slice(2);
const form = new FormData();
form.append("full_name", "Staging Tester");
form.append("email", "tester@raxo-combo.test");
form.append("message", `e2e ${filename}`);
form.append("attachments", new Blob([readFileSync(file)], { type: mime }), filename);
const res = await fetch("http://127.0.0.1:3000/forms/staging-contact", {
  method: "POST",
  body: form,
  headers: { accept: "application/json" },
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text.slice(0, 300);
}
console.log(JSON.stringify({ status: res.status, body }));
