import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { verifyCaptcha } from "../src/captcha.js";

describe("U07: F04 — Context-Bound CAPTCHA Verification", () => {
  let mockServer: Server;
  let serverUrl: string;
  let nextResponse: { status?: number; body: any; delayMs?: number } = {
    status: 200,
    body: { success: true, action: "submit_form", hostname: "example.test" },
  };

  test("setup mock turnstile endpoint", async () => {
    mockServer = createServer((req, res) => {
      const delay = nextResponse.delayMs ?? 0;
      setTimeout(() => {
        const status = nextResponse.status ?? 200;
        res.writeHead(status, { "content-type": "application/json" });
        if (typeof nextResponse.body === "string") {
          res.end(nextResponse.body);
        } else {
          res.end(JSON.stringify(nextResponse.body));
        }
      }, delay);
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}/siteverify`;
        resolve();
      });
    });
  });

  test("Valid context: success=true, action=submit_form, matching hostname passes", async () => {
    nextResponse = {
      status: 200,
      body: { success: true, action: "submit_form", hostname: "example.test" },
    };

    const valid = await verifyCaptcha("test_token_123", "127.0.0.1", {
      secret: "turnstile_secret_key",
      allowedHostnames: ["example.test", "sub.example.test"],
      verifyEndpoint: serverUrl,
    });
    assert.equal(valid, true);
  });

  test("Wrong action returns false", async () => {
    nextResponse = {
      status: 200,
      body: { success: true, action: "login", hostname: "example.test" },
    };

    const valid = await verifyCaptcha("test_token_123", "127.0.0.1", {
      secret: "turnstile_secret_key",
      allowedHostnames: ["example.test"],
      verifyEndpoint: serverUrl,
    });
    assert.equal(valid, false);
  });

  test("Missing action returns false", async () => {
    nextResponse = {
      status: 200,
      body: { success: true, hostname: "example.test" },
    };

    const valid = await verifyCaptcha("test_token_123", "127.0.0.1", {
      secret: "turnstile_secret_key",
      allowedHostnames: ["example.test"],
      verifyEndpoint: serverUrl,
    });
    assert.equal(valid, false);
  });

  test("Wrong hostname returns false", async () => {
    nextResponse = {
      status: 200,
      body: { success: true, action: "submit_form", hostname: "attacker.test" },
    };

    const valid = await verifyCaptcha("test_token_123", "127.0.0.1", {
      secret: "turnstile_secret_key",
      allowedHostnames: ["example.test"],
      verifyEndpoint: serverUrl,
    });
    assert.equal(valid, false);
  });

  test("Misleading hostname suffix returns false (strict equality, no suffix matching)", async () => {
    nextResponse = {
      status: 200,
      body: { success: true, action: "submit_form", hostname: "notexample.test" },
    };

    const valid = await verifyCaptcha("test_token_123", "127.0.0.1", {
      secret: "turnstile_secret_key",
      allowedHostnames: ["example.test"],
      verifyEndpoint: serverUrl,
    });
    assert.equal(valid, false);
  });

  test("Missing hostname when allowedHostnames specified returns false", async () => {
    nextResponse = {
      status: 200,
      body: { success: true, action: "submit_form" },
    };

    const valid = await verifyCaptcha("test_token_123", "127.0.0.1", {
      secret: "turnstile_secret_key",
      allowedHostnames: ["example.test"],
      verifyEndpoint: serverUrl,
    });
    assert.equal(valid, false);
  });

  test("Malformed JSON response fails closed", async () => {
    nextResponse = {
      status: 200,
      body: "<html><body>Gateway Error</body></html>",
    };

    const valid = await verifyCaptcha("test_token_123", "127.0.0.1", {
      secret: "turnstile_secret_key",
      allowedHostnames: ["example.test"],
      verifyEndpoint: serverUrl,
    });
    assert.equal(valid, false);
  });

  test("Service error (non-2xx) fails closed", async () => {
    nextResponse = {
      status: 502,
      body: { error: "Bad Gateway" },
    };

    const valid = await verifyCaptcha("test_token_123", "127.0.0.1", {
      secret: "turnstile_secret_key",
      allowedHostnames: ["example.test"],
      verifyEndpoint: serverUrl,
    });
    assert.equal(valid, false);
  });

  test("Timeout fails closed within bounded duration", async () => {
    nextResponse = {
      status: 200,
      body: { success: true, action: "submit_form", hostname: "example.test" },
      delayMs: 150,
    };

    const valid = await verifyCaptcha("test_token_123", "127.0.0.1", {
      secret: "turnstile_secret_key",
      allowedHostnames: ["example.test"],
      timeoutMs: 30, // 30ms timeout
      verifyEndpoint: serverUrl,
    });
    assert.equal(valid, false);
  });

  test("cleanup mock turnstile endpoint", async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });
});
