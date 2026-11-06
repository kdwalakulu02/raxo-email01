# 02 — Exact file tree, stack and commands

## One package, no monorepo

Use Node 24 LTS, TypeScript, npm, Fastify, @fastify/multipart, pg, Nodemailer, Zod and file-type. Use Node's built-in node:test runner and assert module. Use tsx for development and Prettier for formatting. No test framework, ORM, frontend framework, dependency injection framework or CLI framework.

Node 24.22.1 is the reviewed security LTS release at document creation. At G00 use that or a later patched 24.x version, record its exact value in .nvmrc and package engines. Do not use a prerelease.

G00 resolves current compatible patched stable dependency versions, saves exact versions and commits package-lock.json. Do not copy outdated major pins from an earlier pack. In particular, @fastify/multipart versions below 10.1.1 have a documented aborted-upload issue; never select them.

Bootstrap dependency commands:

```bash
npm install --save-exact fastify @fastify/multipart pg nodemailer zod file-type
npm install --save-dev --save-exact typescript tsx prettier @types/node @types/pg @types/nodemailer mailparser @types/mailparser
npm ls
npm audit
```

Confirm Fastify/plugin compatibility with a tiny route registration test before implementing uploads. A security or compatibility failure is a G00 blocker; do not suppress it or independently upgrade half the stack. Exact chosen versions go in docs/DEPENDENCY_VERSIONS.md.

## Exact target files

Keep the existing Markdown. Generate only this source/config set unless a test needs a narrowly justified fixture:

```text
package.json
package-lock.json
tsconfig.json
.nvmrc
.gitignore
.dockerignore
.prettierignore
.prettierrc.json
.env.example
Dockerfile
compose.dev.yml
config/forms.example.json
config/dev-init.sql
examples/job-application.html
examples/contact.html
examples/README.md
migrations/001_initial.sql
src/config.ts
src/errors.ts
src/types.ts
src/db.ts
src/migrate.ts
src/repository.ts
src/rate-limit.ts
src/storage.ts
src/scanner.ts
src/multipart.ts
src/captcha.ts
src/accept.ts
src/http.ts
src/server.ts
src/mime.ts
src/smtp.ts
src/queue.ts
src/worker.ts
src/cli.ts
src/retention.ts
scripts/demo.ts
scripts/release-check.ts
test/helpers.ts
test/unit.config.test.ts
test/unit.input.test.ts
test/unit.smtp-outcomes.test.ts
test/integration.accept.test.ts
test/integration.worker.test.ts
test/integration.cli.test.ts
test/integration.retention.test.ts
test/integration.clamav.test.ts
.github/workflows/ci.yml
docs/DEPENDENCY_VERSIONS.md
docs/IMPLEMENTED_QUICKSTART.md
docs/DEMO_RESULTS.md
BUILD_STATUS.md
CHANGELOG.md
THIRD_PARTY_NOTICES.md
```

Do not create a second src subproject or generated private package. SQLite and S3 are not substitutions for these contracts.

## Module responsibilities and function signatures

| File          | Export / job                                                               |
| ------------- | -------------------------------------------------------------------------- |
| config.ts     | loadConfig(env, formsPath): Promise<AppConfig>; parse/validate once        |
| errors.ts     | AppError(code,httpStatus,safeMessage); error response mapping              |
| types.ts      | FormConfig, Submission, Attachment, Notification, ScanResult, SubmitResult |
| db.ts         | createPool(url); withTransaction(pool, fn)                                 |
| migrate.ts    | apply migrations under DB advisory lock, checksummed history               |
| repository.ts | parameterized SQL only; insert/get/list/tombstone plus claim/update        |
| rate-limit.ts | consumeRateLimit(formId, ipHash, now); shared SQL buckets                  |
| storage.ts    | stage(stream), read(key), delete(key), persistMime(buffer), orphanSweep    |
| scanner.ts    | scanStoredPdf(key): Promise<ScanResult>; clamd adapter                     |
| multipart.ts  | parseSubmission(request, form): Promise<ParsedInput>                       |
| captcha.ts    | verifyCaptcha(token, remoteIp): Promise<boolean>                           |
| accept.ts     | acceptSubmission(parsed, form, dependencies): Promise<Receipt>             |
| http.ts       | buildApp(dependencies): FastifyInstance; no listen side effect             |
| server.ts     | load config, create deps, listen; graceful shutdown                        |
| mime.ts       | buildNotification(snapshot, attachments): Promise<Buffer>                  |
| smtp.ts       | submitRaw(raw, envelope): Promise<SubmitResult>; no DB writes              |
| queue.ts      | claim/heartbeat/processOne; no HTTP dependency                             |
| worker.ts     | single-worker advisory lock, poll loop and shutdown                        |
| cli.ts        | parse fixed commands, call repository/storage; no mail bypass              |
| retention.ts  | tombstone/delete/reclaim; no SMTP calls                                    |

Dependencies are passed as ordinary typed objects. No global network connection on import. Test imports must not start a server or worker.

## Compile layout

package.json has type=module. tsconfig uses target ES2022, module/moduleResolution NodeNext, strict=true, rootDir=".", outDir="dist", esModuleInterop=true. Include src, scripts and test. Use .js import suffixes in TypeScript relative imports so compiled ESM runs.

## Required scripts

Implement these exact npm scripts:

| Script           | Command / behavior                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build            | tsc -p tsconfig.json                                                                                                                                                                          |
| typecheck        | tsc -p tsconfig.json --noEmit                                                                                                                                                                 |
| format:check     | prettier --check with quoted globs: src/**/\*.ts, scripts/**/_.ts, test/\**/_.ts, config/_.json, examples/_.{html,md}, _.md, docs/_.md; do not ask Prettier to parse SQL without a SQL plugin |
| dev              | node --env-file=.env --import tsx --watch src/server.ts                                                                                                                                       |
| dev:worker       | node --env-file=.env --import tsx --watch src/worker.ts                                                                                                                                       |
| db:migrate       | node --env-file=.env --import tsx src/migrate.ts                                                                                                                                              |
| cli              | node --env-file=.env --import tsx src/cli.ts                                                                                                                                                  |
| services:up      | docker compose -f compose.dev.yml up -d --wait                                                                                                                                                |
| services:down    | docker compose -f compose.dev.yml down; NEVER -v                                                                                                                                              |
| test:unit        | build, then node --env-file=.env --test dist/test/unit.*.test.js                                                                                                                              |
| test:integration | build, then node --env-file=.env --test --test-concurrency=1 dist/test/integration.*.test.js                                                                                                  |
| check            | format:check, typecheck, test:unit, test:integration, build in sequence                                                                                                                       |
| demo:verify      | node --env-file=.env --import tsx scripts/demo.ts                                                                                                                                             |
| check:release    | node --env-file=.env --import tsx scripts/release-check.ts                                                                                                                                    |

Unit/integration files sit directly in test/ so the listed patterns resolve. Missing fixtures/services must fail clearly. Do not make check skip integration tests when DB is absent.

## Local ports and dependencies

PostgreSQL: host 127.0.0.1:55432 -> container 5432.
Mailpit UI: 127.0.0.1:8025. SMTP: 127.0.0.1:1025.
ClamAV: 127.0.0.1:3310; private Docker network only for container users.
API: 127.0.0.1:3000.

compose.dev.yml includes PostgreSQL, Mailpit and ClamAV plus named persistence volumes and health checks. Resolve maintained stable images in G00 and pin their exact digests in the compose file. Record a maximum ClamAV readiness wait of 180 seconds with diagnostics; signature download can take time. Do not bypass scanning if readiness fails.

config/dev-init.sql contains CREATE DATABASE raxo_email_test OWNER raxo_demo; mount it read-only as the PostgreSQL first-start initialization script. Set POSTGRES_DB=raxo_email_demo in development Compose. On an existing volume, check for the test DB and report a clear setup instruction if absent; never delete a volume to recreate it.

Choose development DB passwords that are visibly synthetic and loopback-only. They are not acceptable production credentials. CI creates a fresh isolated DB; tests refuse a database name lacking _test. DB_TEST_URL is separate from DATABASE_URL.

## Environment example

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
DATABASE_URL=postgres://raxo_demo:local_demo_only@127.0.0.1:55432/raxo_email_demo
DB_TEST_URL=postgres://raxo_demo:local_demo_only@127.0.0.1:55432/raxo_email_test
FORMS_CONFIG_PATH=config/forms.json
STORAGE_DIR=./data
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_TLS_MODE=plain_local
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_MAX_MESSAGE_BYTES=20971520
MESSAGE_ID_DOMAIN=notifications.example.test
CLAMD_HOST=127.0.0.1
CLAMD_PORT=3310
CAPTCHA_SECRET=
DEMO_MODE=true
IP_HASH_SECRET=
OUTBOUND_ENABLED=true
TRUSTED_PROXY_CIDRS=
```

Copy .env.example to ignored .env. All local entry points use explicit Node --env-file=.env; having a file alone does not load it. Generate IP_HASH_SECRET using the exact quickstart command in doc07. Empty TRUSTED_PROXY_CIDRS means no forwarding-header trust; otherwise validate its explicit CIDR list. Do not ship one production secret value. CI creates an isolated .env from the example and supplies the same required values before tests.

Production rejects DEMO_MODE, plain_local, empty IP hash secret, non-private storage and missing CAPTCHA. Generic SMTP production uses implicit TLS or starttls_required with normal certificate validation.

## Git ignores before runtime

Ignore .env and variants except .env.example, config/forms.json, data/, exports/, dist/, node_modules/, coverage/, logs/, dumps, backups, keys/certs and generated archives. .dockerignore must exclude all of those plus git history and unrelated folders.

No credentials may be copied into an image during build. Never bake config/forms.json into the image.
