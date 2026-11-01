import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import multipart from "@fastify/multipart";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import type { Pool } from "pg";
import type { AppConfig, FormConfig } from "./types.js";
import type { StorageAdapter } from "./storage.js";
import { AppError, formatErrorResponse } from "./errors.js";
import { parseSubmission, type ParsedInput } from "./multipart.js";
import { verifyCaptcha } from "./captcha.js";
import { acceptSubmission } from "./accept.js";
import {
  computeIpHash,
  consumeRateLimit,
  consumeRegistrationRateLimit,
  consumeRecipientRegistrationRateLimit,
  consumeGlobalRateLimit,
  consumeDeactivationRateLimit,
} from "./rate-limit.js";
import { Repository } from "./repository.js";
import { checkScannerVersion } from "./scanner.js";
import {
  createDynamicForm,
  getDynamicFormByPublicId,
  verifyDynamicForm,
  deactivateDynamicForm,
  resendDynamicFormVerification,
  generateHtmlSnippet,
} from "./forms.js";
import { sendSystemMessage } from "./smtp.js";
import {
  renderGeneratorPage,
  renderVerificationPage,
  renderReceiptPage,
  renderTestPage,
} from "./views.js";

const MAX_AGGREGATE_MULTIPART_BYTES = 11534336; // 11 MiB aggregate limit

export interface HttpDependencies {
  config: AppConfig;
  pool: Pool;
  storage: StorageAdapter;
}

function getBaseUrl(request: FastifyRequest, config: AppConfig): string {
  const host = request.headers.host || `${config.host}:${config.port}`;
  const proto = (request.headers["x-forwarded-proto"] as string) || "http";
  return `${proto}://${host}`;
}

export function validateNextUrl(
  nextUrl: string | unknown,
  originHeader?: string,
  refererHeader?: string,
  allowedOrigins?: string[],
): string | null {
  if (typeof nextUrl !== "string") return null;
  const trimmed = nextUrl.trim();
  if (!trimmed) return null;

  // Disallow protocol-relative and backslash URLs
  if (trimmed.startsWith("//") || trimmed.startsWith("\\\\") || trimmed.startsWith("/\\")) {
    return null;
  }

  // Safe relative paths: starts with single slash
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  // Absolute URLs: must parse as valid http: or https:
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  // If explicit allowed_origins are set on the form, match against them
  if (allowedOrigins && allowedOrigins.length > 0) {
    const isAllowed = allowedOrigins.some((ao) => {
      try {
        const aoUrl = new URL(ao);
        return parsed.origin === aoUrl.origin;
      } catch {
        return false;
      }
    });
    return isAllowed ? parsed.href : null;
  }

  // For dynamic forms, validate host against Origin or Referer if present
  const sourceUrl = originHeader || refererHeader;
  if (sourceUrl) {
    try {
      const parsedSource = new URL(sourceUrl);
      if (
        parsed.hostname === parsedSource.hostname ||
        parsed.hostname.endsWith(`.${parsedSource.hostname}`)
      ) {
        return parsed.href;
      }
      return null; // Hostname mismatch -> open redirect blocked!
    } catch {
      return null;
    }
  }

  // If neither Origin nor Referer is present (e.g. direct programmatic test call),
  // allow the valid http/https URL
  return parsed.href;
}

function sanitizeSubject(raw: unknown): string {
  if (typeof raw !== "string") return "New Form Submission";
  const clean = raw.replace(/[\r\n]/g, " ").trim();
  return clean.substring(0, 150) || "New Form Submission";
}

export function buildApp(deps: HttpDependencies): FastifyInstance {
  const { config, pool, storage } = deps;
  const repo = new Repository(pool);

  let inFlightUploads = 0;
  const MAX_IN_FLIGHT = 2;

  const app = Fastify({
    logger: false,
    bodyLimit: MAX_AGGREGATE_MULTIPART_BYTES,
  });

  // Register multipart plugin with strict limits
  app.register(multipart, {
    limits: {
      fileSize: 10485760, // 10 MB per file
      files: 5, // max 5 files
      fields: 50, // max 50 fields
      fieldSize: 65536, // max 64 KB text field
    },
  });

  // Support standard HTML forms: application/x-www-form-urlencoded
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 1048576 },
    (_req, body: string, done) => {
      try {
        const params = new URLSearchParams(body);
        const fields: Record<string, string> = {};
        for (const [key, value] of params.entries()) {
          fields[key] = value;
        }
        done(null, fields);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Hook: PreParsing byte-counter stream to strictly enforce aggregate multipart limit for all requests
  app.addHook("preParsing", async (request, reply, payload) => {
    const contentType = request.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      return payload;
    }

    const contentLength = request.headers["content-length"];
    if (contentLength && parseInt(contentLength, 10) > MAX_AGGREGATE_MULTIPART_BYTES) {
      throw new AppError(
        "file_too_large",
        413,
        `Request body exceeds multipart aggregate limit of ${MAX_AGGREGATE_MULTIPART_BYTES} bytes`,
      );
    }

    let bytesReceived = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesReceived += chunk.length;
        if (bytesReceived > MAX_AGGREGATE_MULTIPART_BYTES) {
          callback(
            new AppError(
              "file_too_large",
              413,
              `Multipart request aggregate limit of ${MAX_AGGREGATE_MULTIPART_BYTES} bytes exceeded`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });

    payload.pipe(counter);
    return counter;
  });

  // Liveness probe
  app.get("/health/live", async (_req, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  // Readiness probe
  app.get("/health/ready", async (_req, reply) => {
    try {
      // 1. Check DB
      await pool.query("SELECT 1;");

      // 2. Check storage write
      const probeKey = randomUUID();
      const probePath = storage.resolveSafePath(probeKey, "tmp");
      const { writeFileSync, unlinkSync } = await import("node:fs");
      writeFileSync(probePath, "probe", { mode: 0o600 });
      unlinkSync(probePath);

      // 3. Check scanner readiness and signature freshness
      await checkScannerVersion({ host: config.clamdHost, port: config.clamdPort });

      // 4. Check worker heartbeat <= 60s
      const heartbeat = await repo.getWorkerHeartbeat();
      if (!heartbeat || !heartbeat.last_seen) {
        return reply.status(503).send({ status: "not_ready", reason: "no worker heartbeat" });
      }
      const ageMs = Date.now() - new Date(heartbeat.last_seen).getTime();
      if (ageMs > 60000) {
        return reply.status(503).send({
          status: "not_ready",
          reason: `stale worker heartbeat (${Math.round(ageMs / 1000)}s ago)`,
        });
      }

      return reply.status(200).send({ status: "ready" });
    } catch (err: unknown) {
      return reply.status(503).send({
        status: "not_ready",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Minimal Form ID Generator (UI)
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const baseUrl = getBaseUrl(request, config);
    const html = renderGeneratorPage(baseUrl);
    return reply.status(200).type("text/html").send(html);
  });

  // Minimal Operator Test Form (GET /test)
  app.get("/test", async (request: FastifyRequest, reply: FastifyReply) => {
    const baseUrl = getBaseUrl(request, config);
    const siteKey = process.env.CAPTCHA_SITEKEY?.trim() || "0x4AAAAAAAxxxxxxxxxxxxxx";
    const html = renderTestPage(baseUrl, "vps-delivery-test", siteKey);
    return reply.status(200).type("text/html").send(html);
  });

  // Dynamic Form Registration API
  app.post("/api/forms", async (request, reply) => {
    const ip = request.ip || "127.0.0.1";
    const ipHash = computeIpHash(config.ipHashSecret, new Date().toISOString(), ip);
    await consumeRegistrationRateLimit(pool, ipHash);

    const body = (request.body || {}) as Record<string, unknown>;
    const email = body.email as string;
    if (email) {
      await consumeRecipientRegistrationRateLimit(pool, email);
    }
    const { form, formId, verificationToken, managementToken } = await createDynamicForm(
      pool,
      email,
    );

    const baseUrl = getBaseUrl(request, config);
    const activationUrl = `${baseUrl}/verify?token=${verificationToken}`;

    const emailSubject = `Activate your Raxo Email form (${formId.substring(0, 8)}...)`;
    const emailText = `Hello,\n\nYou requested a new Raxo Email form endpoint.\n\nForm ID: ${formId}\nAction URL: ${baseUrl}/f/${formId}\n\nTo activate submission delivery, click the link below:\n${activationUrl}\n\nThis activation link expires in 24 hours. Submissions sent while pending are held safely in your queue.\n\nManagement Key: ${managementToken}\n(Use this key if you ever want to deactivate this form without an account)\n`;
    const emailHtml = `<p>Hello,</p><p>You requested a new Raxo Email form endpoint.</p><p><strong>Form ID:</strong> <code>${formId}</code><br><strong>Action URL:</strong> <code>${baseUrl}/f/${formId}</code></p><p><a href="${activationUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:white;text-decoration:none;border-radius:5px;font-weight:bold;">Activate Form</a></p><p>Or copy this activation link:<br><a href="${activationUrl}">${activationUrl}</a></p><p><small>This activation link expires in 24 hours. Submissions sent before activation are held safely and delivered upon verification.<br>Management Key: <code>${managementToken}</code></small></p>`;

    try {
      await sendSystemMessage(
        form.recipient_email,
        emailSubject,
        emailText,
        emailHtml,
        {
          host: config.smtpHost,
          port: config.smtpPort,
          tlsMode: config.smtpTlsMode,
          username: config.smtpUsername,
          password: config.smtpPassword,
        },
        `notifications@${config.messageIdDomain}`,
      );
    } catch (smtpErr) {
      console.warn("Notice: could not dispatch system email directly:", smtpErr);
    }

    const acceptHeader = request.headers.accept || "";
    if (!acceptHeader.includes("application/json") && acceptHeader.includes("text/html")) {
      const html = renderGeneratorPage(baseUrl, { formId, email: form.recipient_email });
      return reply.status(200).type("text/html").send(html);
    }

    return reply.status(201).send({
      status: "pending_verification",
      form_id: formId,
      action_url: `${baseUrl}/f/${formId}`,
      html_snippet: generateHtmlSnippet(baseUrl, formId),
      management_token: managementToken,
      message: "Form created successfully. An activation link has been sent to your email address.",
    });
  });

  // Email Ownership Verification Endpoint (GET)
  app.get<{ Querystring: { token?: string } }>("/verify", async (request, reply) => {
    const token = request.query.token;
    if (!token) {
      const html = renderVerificationPage({
        success: false,
        message: "Missing verification token in query parameters.",
      });
      return reply.status(400).type("text/html").send(html);
    }

    // Prefetch detection: Antivirus scanners, Outlook SafeLinks, browser prefetch
    const isPrefetch =
      request.headers["purpose"] === "prefetch" ||
      request.headers["sec-purpose"] === "prefetch" ||
      request.headers["x-purpose"] === "preview" ||
      request.headers["x-moz"] === "prefetch";

    if (isPrefetch) {
      // Safe, non-mutating response for prefetchers - do NOT burn token or activate
      const html = renderVerificationPage({
        success: false,
        isPrefetch: true,
        token: token.trim(),
        message:
          "Link prefetch detected. To verify your email and activate your form, please click the confirmation button below.",
      });
      reply.header("X-Robots-Tag", "noindex, nofollow");
      return reply.status(200).type("text/html").send(html);
    }

    try {
      const res = await verifyDynamicForm(pool, token);
      const html = renderVerificationPage({
        success: true,
        message:
          "Your email ownership has been verified! Your form is now active and ready to deliver submissions.",
        promotedCount: res.promotedNotifications,
      });
      return reply.status(200).type("text/html").send(html);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Verification failed";
      const status = err instanceof AppError ? err.httpStatus : 400;
      const html = renderVerificationPage({
        success: false,
        message: msg,
      });
      return reply.status(status).type("text/html").send(html);
    }
  });

  // Explicit POST /verify endpoint for prefetch-safe confirmation and API clients
  app.post<{ Body: { token?: string }; Querystring: { token?: string } }>(
    "/verify",
    async (request, reply) => {
      const body = (request.body as { token?: string } | undefined) ?? {};
      const token = body.token || request.query.token;
      if (!token) {
        const html = renderVerificationPage({
          success: false,
          message: "Missing verification token.",
        });
        return reply.status(400).type("text/html").send(html);
      }

      try {
        const res = await verifyDynamicForm(pool, token);
        const acceptsJson = (request.headers.accept || "").includes("application/json");
        if (acceptsJson) {
          return reply.status(200).send({
            status: "verified",
            form_id: res.form.public_id,
            promoted_notifications: res.promotedNotifications,
          });
        }
        const html = renderVerificationPage({
          success: true,
          message:
            "Your email ownership has been verified! Your form is now active and ready to deliver submissions.",
          promotedCount: res.promotedNotifications,
        });
        return reply.status(200).type("text/html").send(html);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Verification failed";
        const status = err instanceof AppError ? err.httpStatus : 400;
        const acceptsJson = (request.headers.accept || "").includes("application/json");
        if (acceptsJson) {
          return reply
            .status(status)
            .send({ error: { code: "verification_failed", message: msg } });
        }
        const html = renderVerificationPage({
          success: false,
          message: msg,
        });
        return reply.status(status).type("text/html").send(html);
      }
    },
  );

  // Resend Verification Email Endpoint
  app.post<{ Params: { formId: string } }>("/api/forms/:formId/resend", async (request, reply) => {
    const formId = request.params.formId;
    const { form, verificationToken } = await resendDynamicFormVerification(pool, formId);

    const baseUrl = getBaseUrl(request, config);
    const activationUrl = `${baseUrl}/verify?token=${verificationToken}`;

    const emailSubject = `Activate your Raxo Email form (${formId.substring(0, 8)}...)`;
    const emailText = `Hello,\n\nHere is your new activation link for Form ID ${formId}:\n${activationUrl}\n\nThis activation link expires in 24 hours.\n`;
    const emailHtml = `<p>Hello,</p><p>Here is your new activation link for Form ID <code>${formId}</code>:</p><p><a href="${activationUrl}">Activate Form</a></p>`;

    await sendSystemMessage(
      form.recipient_email,
      emailSubject,
      emailText,
      emailHtml,
      {
        host: config.smtpHost,
        port: config.smtpPort,
        tlsMode: config.smtpTlsMode,
        username: config.smtpUsername,
        password: config.smtpPassword,
      },
      `notifications@${config.messageIdDomain}`,
    );

    return reply.status(200).send({
      status: "ok",
      message: "A new activation email has been sent.",
    });
  });

  // Deactivation Handlers
  const handleDeactivate = async (
    request: FastifyRequest<{ Params: { formId: string } }>,
    reply: FastifyReply,
  ) => {
    const formId = request.params.formId;
    await consumeDeactivationRateLimit(pool, formId);
    const body = (request.body || {}) as Record<string, unknown>;
    const managementToken =
      (body.management_token as string) || (request.headers["x-management-token"] as string);

    await deactivateDynamicForm(pool, formId, managementToken);

    const acceptHeader = request.headers.accept || "";
    if (acceptHeader.includes("text/html") && !acceptHeader.includes("application/json")) {
      const html = renderVerificationPage({
        success: true,
        message: `Form ${formId} has been successfully deactivated. No further submissions will be accepted.`,
      });
      return reply.status(200).type("text/html").send(html);
    }

    return reply.status(200).send({
      status: "deactivated",
      form_id: formId,
      message: "Form has been successfully deactivated.",
    });
  };

  app.post<{ Params: { formId: string } }>("/f/:formId/deactivate", handleDeactivate);
  app.post<{ Params: { formId: string } }>("/api/forms/:formId/deactivate", handleDeactivate);

  // FormSubmit-style Public Submission Route: POST /f/:formId
  app.post<{ Params: { formId: string } }>("/f/:formId", async (request, reply) => {
    const isMultipart = Boolean(request.headers["content-type"]?.includes("multipart/form-data"));
    if (isMultipart && request.raw && typeof request.raw.pause === "function") {
      request.raw.pause();
    }

    if (inFlightUploads >= MAX_IN_FLIGHT) {
      if (isMultipart && request.raw && typeof request.raw.resume === "function") {
        request.raw.resume();
      }
      throw new AppError(
        "service_unavailable",
        503,
        "In-flight upload capacity full, please try again shortly",
      );
    }

    inFlightUploads++;
    try {
      const formId = request.params.formId;

      // 1. Lookup dynamic form or static form
      let formConfig: FormConfig;
      let initialState: "queued" | "held_unverified" = "queued";

      const dynamicForm = await getDynamicFormByPublicId(pool, formId);
      if (dynamicForm) {
        if (dynamicForm.status === "deactivated") {
          throw new AppError("forbidden", 403, "This form has been deactivated");
        }
        if (dynamicForm.status === "pending_verification") {
          initialState = "held_unverified";
        }
        formConfig = {
          id: dynamicForm.public_id,
          enabled: true,
          from: `notifications@${config.messageIdDomain}`,
          recipient: dynamicForm.recipient_email,
          subject_prefix: "New Form Submission",
          reply_to_field: null,
          success_url: null,
          allowed_origins: [],
          fields: [],
        };
      } else {
        const staticForm = config.forms.get(formId);
        if (!staticForm) {
          throw new AppError("not_found", 404, `Form not found: ${formId}`);
        }
        if (!staticForm.enabled) {
          throw new AppError("forbidden", 403, `Form is disabled: ${formId}`);
        }
        formConfig = { ...staticForm };
      }

      // 2. Global and IP rate limit check
      await consumeGlobalRateLimit(pool, new Date());
      const ip = request.ip || "127.0.0.1";
      const ipHash = computeIpHash(config.ipHashSecret, new Date().toISOString(), ip);
      await consumeRateLimit(pool, formConfig.id, ipHash);

      // 3. Process body
      const contentType = request.headers["content-type"] || "";
      let parsed: ParsedInput;

      if (contentType.includes("multipart/form-data")) {
        if (request.raw && typeof request.raw.resume === "function") {
          request.raw.resume();
        }
        parsed = await parseSubmission(request, formConfig, storage);
      } else {
        const rawFields = (request.body || {}) as Record<string, string>;
        const fields: Record<string, string | null> = {};
        const keys = Object.keys(rawFields);
        if (keys.length > 50) {
          throw new AppError("bad_request", 400, "Too many form fields (maximum 50)");
        }
        for (const k of keys) {
          const val = rawFields[k];
          if (typeof val === "string" && Buffer.byteLength(val, "utf8") > 65536) {
            throw new AppError("bad_request", 400, `Field "${k}" exceeds 64 KB limit`);
          }
          fields[k] = typeof val === "string" ? val : String(val);
        }

        const isHoneypot = Boolean(
          (fields._honey && fields._honey.trim().length > 0) ||
          (fields._gotcha && fields._gotcha.trim().length > 0) ||
          (fields.website && fields.website.trim().length > 0),
        );

        parsed = {
          submissionId: randomUUID(),
          clientSubmissionId: (fields._submission_id as string) || null,
          fields,
          attachments: [],
          captchaToken: null,
          isHoneypot,
        };
      }

      // Honeypot short-circuit
      if (parsed.isHoneypot) {
        if (parsed.fields._next) {
          const validated = validateNextUrl(
            parsed.fields._next,
            request.headers.origin,
            request.headers.referer,
            formConfig.allowed_origins,
          );
          if (validated) {
            return reply.status(303).redirect(validated);
          }
        }
        return reply.status(202).send({ submission_id: null, status: "received" });
      }

      // Dynamic subject, reply-to, success_url
      if (parsed.fields._subject) {
        formConfig.subject_prefix = sanitizeSubject(parsed.fields._subject);
      }
      if (parsed.fields._replyto) {
        formConfig.reply_to_field = "_replyto";
      } else if (parsed.fields.email) {
        formConfig.reply_to_field = "email";
      }
      if (parsed.fields._next) {
        const validated = validateNextUrl(
          parsed.fields._next,
          request.headers.origin,
          request.headers.referer,
          formConfig.allowed_origins,
        );
        if (validated) {
          formConfig.success_url = validated;
        }
      }

      // Populate formConfig.fields if empty so buildNotification outputs all fields
      if (formConfig.fields.length === 0) {
        formConfig.fields = Object.keys(parsed.fields)
          .filter((k) => !k.startsWith("_"))
          .map((k) => ({
            name: k,
            type: "text" as const,
            required: false,
            max_length: 5000,
          }));
      }

      // 4. Accept submission
      const receipt = await acceptSubmission(parsed, formConfig, {
        pool,
        storage,
        messageIdDomain: config.messageIdDomain,
        initialNotificationState: initialState,
      });

      // 5. Send response
      if (formConfig.success_url) {
        return reply.status(303).redirect(formConfig.success_url);
      }

      const acceptHeader = request.headers.accept || "";
      const prefersJson =
        acceptHeader.includes("application/json") || !acceptHeader.includes("text/html");

      if (prefersJson) {
        return reply.status(202).send(receipt);
      }

      const html = renderReceiptPage(receipt.submission_id, initialState === "held_unverified");
      return reply.status(202).type("text/html").send(html);
    } finally {
      inFlightUploads--;
    }
  });

  // Existing static form submission route: POST /forms/:form_id (Preserved for backwards compatibility)
  app.post<{ Params: { form_id: string } }>("/forms/:form_id", async (request, reply) => {
    // Check in-flight upload semaphore
    if (inFlightUploads >= MAX_IN_FLIGHT) {
      throw new AppError(
        "service_unavailable",
        503,
        "In-flight upload capacity full, please try again shortly",
      );
    }

    inFlightUploads++;
    try {
      // 1. Content-type check
      const contentType = request.headers["content-type"] || "";
      if (!contentType.includes("multipart/form-data")) {
        throw new AppError("unsupported_type", 415, "Only multipart/form-data is accepted");
      }

      // 2. Form configuration lookup
      const formId = request.params.form_id;
      const form = config.forms.get(formId);
      if (!form) {
        throw new AppError("not_found", 404, `Form not found: ${formId}`);
      }
      if (!form.enabled) {
        throw new AppError("forbidden", 403, `Form is disabled: ${formId}`);
      }

      // 3. Origin check
      const origin = request.headers.origin;
      if (config.nodeEnv === "production") {
        if (!origin) {
          throw new AppError("forbidden", 403, "Missing Origin header in production");
        }
        if (!form.allowed_origins.includes(origin)) {
          throw new AppError("forbidden", 403, `Origin ${origin} is not allowed`);
        }
      } else if (origin && !form.allowed_origins.includes(origin)) {
        throw new AppError("forbidden", 403, `Origin ${origin} is not allowed`);
      }

      // 4. Rate limit check (pause raw stream to avoid data loss during async DB call)
      const ip = request.ip || "127.0.0.1";
      const ipHash = computeIpHash(config.ipHashSecret, new Date().toISOString(), ip);
      request.raw.pause();
      try {
        await consumeRateLimit(pool, form.id, ipHash);
      } finally {
        request.raw.resume();
      }

      // 5. Parse multipart body and stage files
      const parsed = await parseSubmission(request, form, storage);

      // 6. Verify CAPTCHA (unless honeypot)
      if (!parsed.isHoneypot) {
        const allowedHostnames = form.allowed_origins.map((o) => {
          try {
            return new URL(o).hostname.toLowerCase();
          } catch {
            return o.toLowerCase();
          }
        });

        const captchaValid = await verifyCaptcha(parsed.captchaToken, ip, {
          secret: config.captchaSecret,
          demoMode: config.demoMode,
          allowedHostnames,
        });

        if (!captchaValid) {
          // Clean staged files on CAPTCHA failure
          for (const att of parsed.attachments) {
            storage.delete(att.storageKey);
          }
          throw new AppError("captcha_failed", 422, "CAPTCHA verification failed");
        }
      }

      // 7. Accept submission into database
      const receipt = await acceptSubmission(parsed, form, {
        pool,
        storage,
        messageIdDomain: config.messageIdDomain,
      });

      // 8. Return response
      const acceptHeader = request.headers.accept || "";
      const prefersJson =
        acceptHeader.includes("application/json") || !acceptHeader.includes("text/html");

      if (prefersJson) {
        return reply.status(202).send(receipt);
      }

      // HTML response
      if (form.success_url) {
        return reply.status(303).redirect(form.success_url);
      }

      const escapedId = receipt.submission_id
        ? receipt.submission_id.replace(/[&<>"']/g, "")
        : "received";

      const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Submission Received</title></head>
<body>
  <h1>Submission Received</h1>
  <p>Status: received</p>
  <p>Submission ID: <code>${escapedId}</code></p>
</body>
</html>`;

      return reply.status(202).type("text/html").send(html);
    } finally {
      inFlightUploads--;
    }
  });

  // Loopback demo routes: served ONLY in DEMO_MODE
  app.get("/demo/job-application", async (_req, reply) => {
    if (!config.demoMode) {
      return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
    }
    const filePath = resolve(process.cwd(), "examples/job-application.html");
    if (!existsSync(filePath)) {
      return reply
        .status(404)
        .send({ error: { code: "not_found", message: "Demo file not found" } });
    }
    const html = readFileSync(filePath, "utf8");
    return reply.status(200).type("text/html").send(html);
  });

  app.get("/demo/contact", async (_req, reply) => {
    if (!config.demoMode) {
      return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
    }
    const filePath = resolve(process.cwd(), "examples/contact.html");
    if (!existsSync(filePath)) {
      return reply
        .status(404)
        .send({ error: { code: "not_found", message: "Demo file not found" } });
    }
    const html = readFileSync(filePath, "utf8");
    return reply.status(200).type("text/html").send(html);
  });

  // Disallowed and nonexistent routes
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: "not_found",
        message: "Route not found",
        request_id: randomUUID(),
      },
    });
  });

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    const requestId = randomUUID();
    const formatted = formatErrorResponse(error, requestId);

    const accept = request.headers.accept || "";
    if (accept.includes("text/html") && !accept.includes("application/json")) {
      const escapedMsg = formatted.body.error.message.replace(/[&<>"']/g, "");
      const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Error</title></head>
<body>
  <h1>Error</h1>
  <p>${escapedMsg}</p>
</body>
</html>`;
      return reply.status(formatted.status).type("text/html").send(html);
    }

    return reply.status(formatted.status).send(formatted.body);
  });

  return app;
}
