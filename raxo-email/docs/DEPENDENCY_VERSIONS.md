# Pinned Dependency and Container Versions

Recorded at G00 scaffold gate.

## Runtimes & Package Manager

- **Node.js**: v22.23.3 (system execution, Docker runner, and .nvmrc target; engine >=22.0.0)
- **pnpm**: 12.6.0 (pnpm-lock.yaml locked)

## Production Dependencies

| Package              | Version | Purpose & Security Review                                            |
| -------------------- | ------- | -------------------------------------------------------------------- |
| `fastify`            | 5.12.7  | Core HTTP engine                                                     |
| `@fastify/multipart` | 10.1.6  | Streaming multipart parsing (safe: > 10.1.1 per GHSA-vmph-573x-85f6) |
| `pg`                 | 8.23.1  | PostgreSQL driver (parameterized queries, transaction pooling)       |
| `nodemailer`         | 10.2.1  | SMTP submission and MIME generation                                  |
| `zod`                | 4.6.7   | Configuration and schema validation                                  |
| `file-type`          | 22.2.0  | Buffer magic byte verification for PDF detection                     |

## Development Dependencies

| Package             | Version | Purpose                                          |
| ------------------- | ------- | ------------------------------------------------ |
| `typescript`        | 7.0.2   | Strict TypeScript compiler                       |
| `tsx`               | 4.23.15 | TypeScript execution for dev, migration, and CLI |
| `prettier`          | 3.9.10  | Code formatting                                  |
| `@types/node`       | 26.6.5  | Node.js standard library typings                 |
| `@types/pg`         | 8.23.1  | PostgreSQL driver typings                        |
| `@types/nodemailer` | 8.0.2   | Nodemailer typings                               |
| `mailparser`        | 3.12.4  | MIME parser for integration test assertions      |
| `@types/mailparser` | 3.9.0   | Typings for mailparser                           |

## Container Images & Digests

| Service    | Image                     | Pinned Digest                                                             |
| ---------- | ------------------------- | ------------------------------------------------------------------------- |
| PostgreSQL | `postgres:17-alpine`      | `sha256:3d317ea5cf83d5cf599a38f3e5e4ef3be1acb3d5b7a151b6dbf08c3755cf9427` |
| Mailpit    | `axllent/mailpit:v1.22.4` | `sha256:d15ceb8c4c379a515a8c2738b81373574cbe15951804fca92cb53da634e447b9` |
| ClamAV     | `clamav/clamav:1.4.1`     | `sha256:d713c23067eb7a8dfef527376a74ad49b9cb12fb10d3224765d1d6a8f6bb0d8a` |

## Audit Summary

`pnpm audit` reviewed: 0 vulnerabilities found.
Fastify and `@fastify/multipart` plugin registration and injection probe verified successfully.
