// Generates the identical fixture set used against both implementations (results/fixtures).
// The EICAR string is the standard harmless antivirus test string.
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export function pdf(streamText) {
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

export function makeFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const w = (n, b) => writeFileSync(join(dir, n), b);
  w("normal.pdf", pdf("BT /F1 12 Tf 72 712 Td (Raxo comparison clean document) Tj ET"));
  w("eicar.pdf", pdf(EICAR));
  w("eicar.txt", EICAR);
  // Archive fixtures built with python's stdlib so both stacks receive byte-identical files.
  execFileSync("python3", [
    "-c",
    `
import zipfile, tarfile, gzip, io, sys
d=sys.argv[1]; e=open(d+"/eicar.txt","rb").read()
for name,comp in (("eicar-stored.zip",zipfile.ZIP_STORED),("eicar-deflated.zip",zipfile.ZIP_DEFLATED)):
    with zipfile.ZipFile(d+"/"+name,"w",comp) as z: z.writestr("eicar.com",e)
with tarfile.open(d+"/eicar.tar.gz","w:gz") as t:
    ti=tarfile.TarInfo("eicar.com"); ti.size=len(e); t.addfile(ti,io.BytesIO(e))
with tarfile.open(d+"/eicar.tar","w") as t:
    ti=tarfile.TarInfo("eicar.com"); ti.size=len(e); t.addfile(ti,io.BytesIO(e))
open(d+"/eicar.gz","wb").write(gzip.compress(e))
# nested: a stored zip inside a stored zip
inner=open(d+"/eicar-stored.zip","rb").read()
with zipfile.ZipFile(d+"/nested.zip","w",zipfile.ZIP_STORED) as z: z.writestr("inner.zip",inner)
# clean archive
with zipfile.ZipFile(d+"/clean.zip","w",zipfile.ZIP_DEFLATED) as z: z.writestr("hello.txt","hello clean world\\n"*50)
`,
    dir,
  ]);
  w("polyglot-stored-zip.pdf", Buffer.concat([Buffer.from("%PDF-1.4\n"), execFileSync("cat", [join(dir, "eicar-stored.zip")])]));
  w("polyglot-deflated-zip.pdf", Buffer.concat([Buffer.from("%PDF-1.4\n"), execFileSync("cat", [join(dir, "eicar-deflated.zip")])]));
  w("note.txt", "plain text attachment\n");
  w("bad.exe", Buffer.from("MZ\x90\x00 not really an exe"));
  w("over-10mb.pdf", pdf("A".repeat(10 * 1024 * 1024 + 4096)));
  w("large-5mb.pdf", pdf(randomBytes(2.5 * 1024 * 1024).toString("hex")));
  w("bench-100k.pdf", pdf(randomBytes(50 * 1024).toString("hex")));
}
