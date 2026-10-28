import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runProcessAsync(
  cmd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, {
      env: options.env ?? process.env,
      timeout: options.timeout,
    });
    let stdout = "";
    let stderr = "";
    cp.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    cp.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    cp.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe("U09: Service Readiness and Bounded Probing (F10)", () => {
  // 1. ClamAV socket probe tests against isolated ephemeral server fixtures
  test("U09: ClamAV socket probe succeeds against healthy service", async () => {
    const sockets = new Set<any>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", (d) => {
        if (d.toString().includes("PING")) {
          socket.write("PONG\0");
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const probeCode = `
        const net = require("net");
        const client = net.createConnection({ port: ${port}, host: "127.0.0.1" }, () => client.write("zPING\\0"));
        client.setTimeout(2000, () => { client.destroy(); process.exit(1); });
        client.on("data", (d) => {
          if (d.toString().includes("PONG")) {
            client.end();
            process.exit(0);
          }
          process.exit(1);
        });
        client.on("error", () => process.exit(1));
      `;

      const res = await runProcessAsync("node", ["-e", probeCode]);
      assert.equal(res.status, 0, "Probe must exit 0 when ClamAV replies with PONG");
    } finally {
      sockets.forEach((s) => s.destroy());
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("U09: ClamAV socket probe fails immediately on unreachable port", async () => {
    const probeCode = `
      const net = require("net");
      const client = net.createConnection({ port: 59999, host: "127.0.0.1" }, () => client.write("zPING\\0"));
      client.setTimeout(2000, () => { client.destroy(); process.exit(1); });
      client.on("data", (d) => {
        if (d.toString().includes("PONG")) {
          client.end();
          process.exit(0);
        }
        process.exit(1);
      });
      client.on("error", () => process.exit(1));
    `;

    const res = await runProcessAsync("node", ["-e", probeCode]);
    assert.notEqual(res.status, 0, "Probe must exit nonzero on unreachable port");
  });

  test("U09: ClamAV socket probe fails and bounds wait when socket hangs without replying", async () => {
    const sockets = new Set<any>();
    const server = createTcpServer((_socket) => {
      sockets.add(_socket);
      _socket.on("close", () => sockets.delete(_socket));
      // Do nothing, withhold reply
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const start = Date.now();
      const probeCode = `
        const net = require("net");
        const client = net.createConnection({ port: ${port}, host: "127.0.0.1" }, () => client.write("zPING\\0"));
        client.setTimeout(1000, () => { client.destroy(); process.exit(1); });
        client.on("data", (d) => {
          if (d.toString().includes("PONG")) {
            client.end();
            process.exit(0);
          }
          process.exit(1);
        });
        client.on("error", () => process.exit(1));
      `;

      const res = await runProcessAsync("node", ["-e", probeCode]);
      const duration = Date.now() - start;

      assert.notEqual(res.status, 0, "Probe must exit nonzero on timeout");
      assert.ok(
        duration >= 900 && duration <= 3000,
        `Duration ${duration}ms must be bounded around 1s`,
      );
    } finally {
      sockets.forEach((s) => s.destroy());
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // 2. Mailpit HTTP probe tests against isolated ephemeral server fixtures
  test("U09: Mailpit HTTP probe succeeds on HTTP 200 response", async () => {
    const sockets = new Set<any>();
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const resOk = await runProcessAsync("curl", [
        "-s",
        "-f",
        "--max-time",
        "2",
        `http://127.0.0.1:${port}/api/v1/info`,
      ]);
      assert.equal(resOk.status, 0, "curl -f must exit 0 on HTTP 200 from Mailpit");
    } finally {
      sockets.forEach((s) => s.destroy());
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("U09: Mailpit HTTP probe fails on HTTP 500 error or unreachable port", async () => {
    const sockets = new Set<any>();
    const server = createHttpServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "server error" }));
    });
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const res500 = await runProcessAsync("curl", [
        "-s",
        "-f",
        "--max-time",
        "2",
        `http://127.0.0.1:${port}/api/v1/info`,
      ]);
      assert.notEqual(res500.status, 0, "curl -f must exit nonzero on HTTP 500");

      const resUnreachable = await runProcessAsync("curl", [
        "-s",
        "-f",
        "--max-time",
        "2",
        "http://127.0.0.1:59999/api/v1/info",
      ]);
      assert.notEqual(resUnreachable.status, 0, "curl -f must exit nonzero when port is closed");
    } finally {
      sockets.forEach((s) => s.destroy());
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // 3. Controlled services.sh branch testing with mock command fixtures
  test("U09: services.sh up - successful Docker Compose branch", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "raxo_test_bin_"));
    try {
      const dockerScript = `#!/bin/sh
if [ "$1" = "info" ]; then exit 0; fi
if [ "$1" = "compose" ]; then exit 0; fi
exit 1
`;
      writeFileSync(join(binDir, "docker"), dockerScript);
      chmodSync(join(binDir, "docker"), 0o755);

      const res = await runProcessAsync("./scripts/services.sh", ["up"], {
        env: { ...process.env, TMPDIR: binDir, PATH: `${binDir}:${process.env.PATH}` },
      });

      assert.equal(res.status, 0, "Successful Docker branch must exit 0");
      assert.match(res.stdout, /Services are up and healthy/i);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("U09: services.sh up - failing Docker Compose branch returns nonzero", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "raxo_test_bin_"));
    try {
      const dockerScript = `#!/bin/sh
if [ "$1" = "info" ]; then exit 0; fi
if [ "$1" = "compose" ]; then exit 1; fi
exit 1
`;
      writeFileSync(join(binDir, "docker"), dockerScript);
      chmodSync(join(binDir, "docker"), 0o755);

      const res = await runProcessAsync("./scripts/services.sh", ["up"], {
        env: { ...process.env, TMPDIR: binDir, PATH: `${binDir}:${process.env.PATH}` },
      });

      assert.notEqual(res.status, 0, "Failing Docker branch must exit nonzero");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  function createMockBinDir(): string {
    const binDir = mkdtempSync(join(tmpdir(), "raxo_test_bin_"));
    writeFileSync(join(binDir, "sudo"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "sudo"), 0o755);
    writeFileSync(join(binDir, "service"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "service"), 0o755);
    writeFileSync(join(binDir, "mailpit"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "mailpit"), 0o755);
    writeFileSync(join(binDir, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "sleep"), 0o755);
    return binDir;
  }

  test("U09: services.sh up - host fallback reports PostgreSQL timeout", async () => {
    const binDir = createMockBinDir();
    try {
      // Docker fails
      writeFileSync(join(binDir, "docker"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(binDir, "docker"), 0o755);

      // pg_isready fails
      writeFileSync(join(binDir, "pg_isready"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(binDir, "pg_isready"), 0o755);

      const res = await runProcessAsync("./scripts/services.sh", ["up"], {
        env: { ...process.env, TMPDIR: binDir, PATH: `${binDir}:${process.env.PATH}` },
      });

      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /Timed out waiting for PostgreSQL dependency at 127\.0\.0\.1:55432/);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("U09: services.sh up - host fallback reports Mailpit timeout", async () => {
    const binDir = createMockBinDir();
    try {
      // Docker fails
      writeFileSync(join(binDir, "docker"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(binDir, "docker"), 0o755);

      // pg_isready succeeds
      writeFileSync(join(binDir, "pg_isready"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "pg_isready"), 0o755);

      // curl fails (Mailpit timeout)
      writeFileSync(join(binDir, "curl"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(binDir, "curl"), 0o755);

      const res = await runProcessAsync("./scripts/services.sh", ["up"], {
        env: { ...process.env, TMPDIR: binDir, PATH: `${binDir}:${process.env.PATH}` },
      });

      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /Timed out waiting for Mailpit dependency at 127\.0\.0\.1:8025/);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("U09: services.sh up - host fallback reports ClamAV timeout", async () => {
    const binDir = createMockBinDir();
    try {
      // Docker fails
      writeFileSync(join(binDir, "docker"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(binDir, "docker"), 0o755);

      // pg_isready succeeds
      writeFileSync(join(binDir, "pg_isready"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "pg_isready"), 0o755);

      // curl succeeds
      writeFileSync(join(binDir, "curl"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "curl"), 0o755);

      // node mock exits 1 immediately for ClamAV probe
      writeFileSync(join(binDir, "node"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(binDir, "node"), 0o755);

      const res = await runProcessAsync("./scripts/services.sh", ["up"], {
        env: { ...process.env, TMPDIR: binDir, PATH: `${binDir}:${process.env.PATH}` },
      });

      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /Timed out waiting for ClamAV dependency at 127\.0\.0\.1:3310/);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("U09: services.sh up - successful host fallback branch", async () => {
    const binDir = createMockBinDir();
    try {
      // Docker fails
      writeFileSync(join(binDir, "docker"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(binDir, "docker"), 0o755);

      // pg_isready succeeds
      writeFileSync(join(binDir, "pg_isready"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "pg_isready"), 0o755);

      // curl succeeds
      writeFileSync(join(binDir, "curl"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "curl"), 0o755);

      // node mock exits 0 for ClamAV probe
      writeFileSync(join(binDir, "node"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "node"), 0o755);

      const res = await runProcessAsync("./scripts/services.sh", ["up"], {
        env: { ...process.env, TMPDIR: binDir, PATH: `${binDir}:${process.env.PATH}` },
      });

      assert.equal(res.status, 0, "Successful host fallback must exit 0");
      assert.match(res.stdout, /Services are up and healthy/i);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("U09: services.sh down and usage validation", async () => {
    const binDir = createMockBinDir();
    try {
      // Docker down branch
      writeFileSync(
        join(binDir, "docker"),
        `#!/bin/sh
if [ "$1" = "info" ]; then exit 0; fi
if [ "$1" = "compose" ]; then exit 0; fi
exit 1
`,
      );
      chmodSync(join(binDir, "docker"), 0o755);

      const resDockerDown = await runProcessAsync("./scripts/services.sh", ["down"], {
        env: { ...process.env, TMPDIR: binDir, PATH: `${binDir}:${process.env.PATH}` },
      });
      assert.equal(resDockerDown.status, 0);

      // Host fallback down branch
      writeFileSync(join(binDir, "docker"), "#!/bin/sh\nexit 1\n");
      const resHostDown = await runProcessAsync("./scripts/services.sh", ["down"], {
        env: { ...process.env, TMPDIR: binDir, PATH: `${binDir}:${process.env.PATH}` },
      });
      assert.equal(resHostDown.status, 0);
      assert.match(resHostDown.stdout, /Services stopped/i);

      // Invalid action
      const resUsage = await runProcessAsync("./scripts/services.sh", ["invalid_command"], {
        env: { ...process.env, TMPDIR: binDir, PATH: `${binDir}:${process.env.PATH}` },
      });
      assert.equal(resUsage.status, 1);
      assert.match(resUsage.stdout, /Usage: .* \[up\|down\]/);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
