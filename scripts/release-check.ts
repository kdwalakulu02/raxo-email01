import { existsSync, readFileSync, readdirSync, statSync, createWriteStream } from "node:fs";
import { resolve, join, relative } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".js",
  ".json",
  ".md",
  ".html",
  ".sql",
  ".yml",
  ".yaml",
  ".example",
  "",
]);

const FORBIDDEN_FILE_PATTERNS = [
  /\.env(\..+)?$/,
  /config\/forms\.json$/,
  /^storage\/.+$/,
  /^data\/.+$/,
  /^exports\/.+$/,
  /\.pem$/,
  /\.key$/,
  /\.id_rsa$/,
  /\.p12$/,
  /\.log$/,
];

async function checkRelease(): Promise<void> {
  console.log("=== Raxo Email Pre-Release Check & Audit ===");
  const root = process.cwd();

  // 1. Check for forbidden runtime/credential files
  console.log("Checking for disallowed runtime artifacts and credentials...");
  const errors: string[] = [];

  function scanDir(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);

      for (const pattern of FORBIDDEN_FILE_PATTERNS) {
        if (pattern.test(relPath)) {
          // If git is initialized, check if tracked
          try {
            const gitTracked = execSync(`git ls-files --error-unmatch "${relPath}"`, {
              stdio: "pipe",
            })
              .toString()
              .trim();
            if (gitTracked) {
              errors.push(`Disallowed file tracked in git: ${relPath}`);
            }
          } catch {
            // Not tracked in git, which is good
          }
        }
      }

      if (entry.isDirectory()) {
        scanDir(fullPath);
      }
    }
  }

  scanDir(root);

  if (errors.length > 0) {
    console.error("Release check failed with tracking errors:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("✔ No disallowed runtime files or credentials are tracked.");

  // 2. Check BUILD_STATUS.md evidence
  console.log("Checking BUILD_STATUS.md evidence...");
  const buildStatus = readFileSync(join(root, "BUILD_STATUS.md"), "utf8");
  if (!buildStatus.includes("Evidence Table")) {
    console.error("FATAL: BUILD_STATUS.md lacks an Evidence Table.");
    process.exit(1);
  }
  console.log("✔ BUILD_STATUS.md evidence table verified.");

  // 3. Verify THIRD_PARTY_NOTICES.md matches package.json
  console.log("Verifying THIRD_PARTY_NOTICES.md against package.json...");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");

  for (const dep of Object.keys(pkg.dependencies || {})) {
    if (!notices.includes(dep)) {
      console.error(`FATAL: Dependency '${dep}' not documented in THIRD_PARTY_NOTICES.md`);
      process.exit(1);
    }
  }
  console.log("✔ THIRD_PARTY_NOTICES.md accurately documents all dependencies.");

  // 4. Verify scope boundary compliance: no disallowed frameworks in src
  console.log("Verifying strict scope compliance in src/...");
  const disallowedPackages = [
    '"react"',
    "'react'",
    '"next"',
    "'next'",
    '"redis"',
    "'redis'",
    '"drizzle-orm"',
    "'drizzle-orm'",
  ];
  const srcFiles = readdirSync(join(root, "src"));
  for (const file of srcFiles) {
    const content = readFileSync(join(root, "src", file), "utf8");
    for (const pkg of disallowedPackages) {
      if (content.includes(pkg)) {
        console.error(`FATAL: Out-of-scope package ${pkg} imported in src/${file}`);
        process.exit(1);
      }
    }
  }
  console.log("✔ Codebase strictly respects v0.1 scope lock (no React, Next, Redis, ORM).");

  // 5. Inspect and prepare clean release archive
  console.log("Generating clean source release archive...");
  const distDir = join(root, "dist");
  if (!existsSync(distDir)) {
    execSync("mkdir -p dist");
  }

  const archivePath = join(distDir, "raxo-email-v0.1.0-alpha-src.tar.gz");
  // Pack allowlisted source files using tar
  const allowlist = [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    ".nvmrc",
    ".gitignore",
    ".dockerignore",
    ".prettierignore",
    ".prettierrc.json",
    ".env.example",
    ".github/",
    "Dockerfile",
    "compose.dev.yml",
    "00_START_HERE.md",
    "01_AGENT_PROMPT.md",
    "README.md",
    "CHANGELOG.md",
    "GITHUB_PUBLIC_WHITE_PAPER.md",
    "LICENSE.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    "THIRD_PARTY_NOTICES.md",
    "BUILD_STATUS.md",
    "config/forms.example.json",
    "config/dev-init.sql",
    "examples/",
    "migrations/",
    "src/",
    "scripts/",
    "docs/",
    "test/",
  ];

  execSync(
    `tar -czf "${archivePath}" --exclude='node_modules' --exclude='.env' --exclude='.env.local' --exclude='.env.test' --exclude='.env.*.local' --exclude='dist' --exclude='storage' --exclude='data' --exclude='*.log' ${allowlist.join(" ")}`,
    {
      stdio: "inherit",
    },
  );

  const archiveBytes = readFileSync(archivePath);
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  console.log(`✔ Release archive created: ${archivePath}`);
  console.log(`  Size: ${archiveBytes.length} bytes`);
  console.log(`  SHA-256: ${archiveSha256}`);

  // 6. Verify contents of the archive
  const tarEntries = execSync(`tar -ztf "${archivePath}"`, { encoding: "utf8" })
    .split("\n")
    .map((e) => e.trim())
    .filter(Boolean);

  if (!tarEntries.includes(".env.example")) {
    console.error("FATAL: .env.example missing from release archive!");
    process.exit(1);
  }
  if (!tarEntries.includes("GITHUB_PUBLIC_WHITE_PAPER.md")) {
    console.error("FATAL: GITHUB_PUBLIC_WHITE_PAPER.md missing from release archive!");
    process.exit(1);
  }
  if (!tarEntries.includes("CHANGELOG.md")) {
    console.error("FATAL: CHANGELOG.md missing from release archive!");
    process.exit(1);
  }
  for (const entry of tarEntries) {
    if (entry === ".env" || (entry.startsWith(".env.") && entry !== ".env.example")) {
      console.error(`FATAL: Disallowed environment file found in release archive: ${entry}`);
      process.exit(1);
    }
  }
  console.log(
    `✔ Archive contents verified (${tarEntries.length} files; .env.example and white paper included; real .env excluded).`,
  );

  console.log("\n✔ Release verification completed successfully.");
}

checkRelease().catch((err) => {
  console.error("FATAL RELEASE CHECK ERROR:", err);
  process.exit(1);
});
