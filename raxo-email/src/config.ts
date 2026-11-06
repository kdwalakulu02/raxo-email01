import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";
import type { AppConfig, FormConfig, FormField, SmtpTlsMode } from "./types.js";
import { AppError } from "./errors.js";

const RESERVED_FIELD_NAMES = new Set([
  "attachments",
  "_captcha_token",
  "_honey",
  "_submission_id",
  "_to",
  "_cc",
  "_from",
  "_next",
  "_subject",
  "_webhook",
]);

const formIdRegex = /^[a-z0-9][a-z0-9-]{0,39}$/;
const fieldNameRegex = /^[a-z0-9_]{1,40}$/;
const emailRegex =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const FormFieldSchema = z
  .object({
    name: z
      .string()
      .regex(fieldNameRegex, "Field name must be 1-40 alphanumeric/underscore chars")
      .refine((name) => !RESERVED_FIELD_NAMES.has(name) && !name.startsWith("_"), {
        message: "Field name is reserved",
      }),
    type: z.enum(["text", "email", "url"]),
    required: z.boolean(),
    max_length: z.number().int().min(1).max(4000),
  })
  .strict();

const FormConfigSchema = z
  .object({
    id: z.string().regex(formIdRegex, "Form ID must match ^[a-z0-9][a-z0-9-]{0,39}$"),
    enabled: z.boolean(),
    from: z
      .string()
      .refine((val) => !/[\r\n<>]/.test(val) && emailRegex.test(val), "Invalid sender email"),
    recipient: z
      .string()
      .refine((val) => !/[\r\n<>]/.test(val) && emailRegex.test(val), "Invalid recipient email"),
    subject_prefix: z
      .string()
      .min(1)
      .max(120)
      .refine((val) => !/[\r\n]/.test(val), "Subject prefix cannot contain CRLF"),
    reply_to_field: z.string().nullable(),
    success_url: z
      .string()
      .nullable()
      .refine((url) => {
        if (!url) return true;
        try {
          const u = new URL(url);
          return u.protocol === "http:" || u.protocol === "https:";
        } catch {
          return false;
        }
      }, "Invalid success_url"),
    allowed_origins: z.array(
      z.string().refine((origin) => {
        try {
          const u = new URL(origin);
          return u.protocol === "http:" || u.protocol === "https:";
        } catch {
          return false;
        }
      }, "Invalid allowed_origin"),
    ),
    fields: z.array(FormFieldSchema).max(20, "At most 20 configured fields per form"),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Check unique field names
    const fieldNames = new Set<string>();
    const emailFieldNames = new Set<string>();

    for (let i = 0; i < data.fields.length; i++) {
      const f = data.fields[i];
      if (fieldNames.has(f.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", i, "name"],
          message: `Duplicate field name: ${f.name}`,
        });
      }
      fieldNames.add(f.name);
      if (f.type === "email") {
        emailFieldNames.add(f.name);
      }
    }

    // Validate reply_to_field
    if (data.reply_to_field !== null) {
      if (!emailFieldNames.has(data.reply_to_field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reply_to_field"],
          message: `reply_to_field '${data.reply_to_field}' must reference an existing email field`,
        });
      }
    }
  });

const FormsFileSchema = z
  .object({
    version: z.literal(1),
    forms: z.array(FormConfigSchema).superRefine((forms, ctx) => {
      const ids = new Set<string>();
      for (let i = 0; i < forms.length; i++) {
        if (ids.has(forms[i].id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "id"],
            message: `Duplicate form id: ${forms[i].id}`,
          });
        }
        ids.add(forms[i].id);
      }
    }),
  })
  .strict();

export function parseFormsConfig(rawJson: string): Map<string, FormConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new AppError("bad_request", 400, "Invalid forms.json syntax");
  }

  const result = FormsFileSchema.safeParse(parsed);
  if (!result.success) {
    const msg = result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new AppError("invalid_form_data", 422, `Forms configuration invalid: ${msg}`);
  }

  const map = new Map<string, FormConfig>();
  for (const form of result.data.forms) {
    map.set(form.id, form as FormConfig);
  }
  return map;
}

export async function loadConfig(
  rawEnv: Record<string, string | undefined> = process.env,
  customFormsPath?: string,
): Promise<AppConfig> {
  const nodeEnv = rawEnv.NODE_ENV ?? "development";
  const isProd = nodeEnv === "production";

  const host = rawEnv.HOST ?? "127.0.0.1";
  const port = parseInt(rawEnv.PORT ?? "3000", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new AppError("bad_request", 500, `Invalid PORT: ${rawEnv.PORT}`);
  }

  const databaseUrl = rawEnv.DATABASE_URL;
  if (!databaseUrl) {
    throw new AppError("bad_request", 500, "DATABASE_URL is required");
  }

  const dbTestUrl = rawEnv.DB_TEST_URL ?? databaseUrl;

  const formsConfigPath = customFormsPath ?? rawEnv.FORMS_CONFIG_PATH ?? "config/forms.json";
  const resolvedFormsPath = resolve(process.cwd(), formsConfigPath);
  if (!existsSync(resolvedFormsPath)) {
    throw new AppError("bad_request", 500, `Forms config file not found: ${resolvedFormsPath}`);
  }
  const formsContent = readFileSync(resolvedFormsPath, "utf-8");
  const forms = parseFormsConfig(formsContent);

  const storageDir = resolve(process.cwd(), rawEnv.STORAGE_DIR ?? "./data");

  const smtpHost = rawEnv.SMTP_HOST ?? "127.0.0.1";
  const smtpPort = parseInt(rawEnv.SMTP_PORT ?? "1025", 10);
  const smtpTlsMode = (rawEnv.SMTP_TLS_MODE ?? "plain_local") as SmtpTlsMode;
  if (!["plain_local", "implicit", "starttls_required"].includes(smtpTlsMode)) {
    throw new AppError("bad_request", 500, `Invalid SMTP_TLS_MODE: ${smtpTlsMode}`);
  }

  const smtpUsername = rawEnv.SMTP_USERNAME?.trim() || undefined;
  const smtpPassword = rawEnv.SMTP_PASSWORD || undefined;
  const smtpMaxMessageBytes = parseInt(rawEnv.SMTP_MAX_MESSAGE_BYTES ?? "20971520", 10);
  const messageIdDomain = rawEnv.MESSAGE_ID_DOMAIN ?? "notifications.example.test";

  const clamdHost = rawEnv.CLAMD_HOST ?? "127.0.0.1";
  const clamdPort = parseInt(rawEnv.CLAMD_PORT ?? "3310", 10);

  const captchaSecret = rawEnv.CAPTCHA_SECRET?.trim() || undefined;
  const demoMode = rawEnv.DEMO_MODE === "true";
  const ipHashSecret = rawEnv.IP_HASH_SECRET ?? "";
  const outboundEnabled = rawEnv.OUTBOUND_ENABLED !== "false";
  const trustedProxyCidrs = rawEnv.TRUSTED_PROXY_CIDRS
    ? rawEnv.TRUSTED_PROXY_CIDRS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // DEMO_MODE safety check
  if (demoMode) {
    if (isProd) {
      throw new AppError("forbidden", 500, "DEMO_MODE=true is forbidden in production");
    }
    const isLoopbackHost = host === "127.0.0.1" || host === "::1";
    if (!isLoopbackHost) {
      throw new AppError(
        "forbidden",
        500,
        `DEMO_MODE=true requires loopback HOST (127.0.0.1 or ::1), got: ${host}`,
      );
    }
    const isLoopbackSmtp =
      smtpHost === "127.0.0.1" ||
      smtpHost === "::1" ||
      smtpHost === "localhost" ||
      smtpHost === "mailpit";
    if (!isLoopbackSmtp) {
      throw new AppError(
        "forbidden",
        500,
        `DEMO_MODE=true requires loopback SMTP host, got: ${smtpHost}`,
      );
    }
    if (smtpUsername || smtpPassword) {
      throw new AppError("forbidden", 500, "DEMO_MODE=true forbids SMTP credentials");
    }
  }

  // Production safety check
  if (isProd) {
    if (demoMode) {
      throw new AppError("forbidden", 500, "Production rejects DEMO_MODE");
    }
    if (smtpTlsMode === "plain_local") {
      throw new AppError("forbidden", 500, "Production rejects plain_local SMTP_TLS_MODE");
    }
    if (!ipHashSecret || ipHashSecret.trim().length === 0) {
      throw new AppError("forbidden", 500, "Production requires non-empty IP_HASH_SECRET");
    }
    if (!captchaSecret || captchaSecret.trim().length === 0) {
      throw new AppError("forbidden", 500, "Production requires CAPTCHA_SECRET");
    }
    for (const [formId, form] of forms.entries()) {
      if (form.success_url) {
        const u = new URL(form.success_url);
        if (u.protocol !== "https:") {
          throw new AppError(
            "forbidden",
            500,
            `Production requires HTTPS success_url in form ${formId}`,
          );
        }
      }
      for (const origin of form.allowed_origins) {
        if (origin === "*") {
          throw new AppError(
            "forbidden",
            500,
            `Production forbids wildcard origin in form ${formId}`,
          );
        }
        const u = new URL(origin);
        if (u.protocol !== "https:") {
          throw new AppError(
            "forbidden",
            500,
            `Production requires HTTPS allowed_origins in form ${formId}`,
          );
        }
      }
    }
  }

  return {
    nodeEnv,
    host,
    port,
    databaseUrl,
    dbTestUrl,
    formsConfigPath,
    storageDir,
    smtpHost,
    smtpPort,
    smtpTlsMode,
    smtpUsername,
    smtpPassword,
    smtpMaxMessageBytes,
    messageIdDomain,
    clamdHost,
    clamdPort,
    captchaSecret,
    demoMode,
    ipHashSecret,
    outboundEnabled,
    trustedProxyCidrs,
    forms,
  };
}
