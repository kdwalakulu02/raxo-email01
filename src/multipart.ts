import { fileTypeFromBuffer } from "file-type";
import { randomUUID } from "node:crypto";
import { Readable, PassThrough } from "node:stream";
import type { FastifyRequest } from "fastify";
import "@fastify/multipart";
import type { FormConfig, FormField } from "./types.js";
import type { StorageAdapter, StagedFile } from "./storage.js";
import { AppError } from "./errors.js";

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export interface StagedAttachment {
  id: string;
  storageKey: string;
  originalName: string;
  sizeBytes: number;
  sha256: string;
}

export interface ParsedInput {
  submissionId: string;
  clientSubmissionId: string | null;
  fields: Record<string, string | null>;
  isHoneypot: boolean;
  captchaToken: string | null;
  attachments: StagedAttachment[];
}

export function normalizeText(raw: string, maxCodePoints = 4000, maxBytes = 65536): string | null {
  if (typeof raw !== "string") return null;

  // Unicode NFC normalization
  let normalized = raw.normalize("NFC").trim();

  // Convert CRLF to LF
  normalized = normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (normalized.length === 0) {
    return null;
  }

  // Code points check
  const codePoints = Array.from(normalized).length;
  if (codePoints > maxCodePoints) {
    throw new AppError(
      "invalid_form_data",
      422,
      `Text value exceeds maximum allowed ${maxCodePoints} code points`,
    );
  }

  // Byte length check
  const byteLength = Buffer.byteLength(normalized, "utf8");
  if (byteLength > maxBytes) {
    throw new AppError(
      "invalid_form_data",
      422,
      `Text UTF-8 bytes exceed maximum allowed ${maxBytes} bytes`,
    );
  }

  return normalized;
}

export function sanitizeFilename(raw: string): string {
  if (!raw || typeof raw !== "string") {
    return "attachment.pdf";
  }

  // Remove directory separators and path traversal
  let base = raw.replace(/[/\\]/g, "_").replace(/\.\.+/g, "_");

  // Remove control characters and CRLF
  base = base.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();

  if (!base.toLowerCase().endsWith(".pdf")) {
    base += ".pdf";
  } else {
    base = base.substring(0, base.length - 4) + ".pdf";
  }

  if (base.length > 120) {
    const ext = ".pdf";
    base = base.substring(0, 120 - ext.length) + ext;
  }

  return base || "attachment.pdf";
}

export function normalizeEmail(raw: string): string {
  if (!raw || typeof raw !== "string") {
    throw new AppError("invalid_form_data", 422, "Email is required");
  }

  if (/[\r\n<>]/.test(raw)) {
    throw new AppError("invalid_form_data", 422, "Header injection characters detected in email");
  }

  const trimmed = raw.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    throw new AppError("invalid_form_data", 422, "Invalid email address");
  }

  const localPart = trimmed.substring(0, atIndex);
  const domainPart = trimmed.substring(atIndex + 1).toLowerCase();
  const combined = `${localPart}@${domainPart}`;

  if (!EMAIL_REGEX.test(combined)) {
    throw new AppError("invalid_form_data", 422, "Invalid email format");
  }

  return combined;
}

export function normalizeUrl(raw: string, maxLength = 500): string {
  const normalized = normalizeText(raw, maxLength);
  if (!normalized) return "";

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AppError("invalid_form_data", 422, "URL must use http or https scheme");
    }
    return parsed.toString();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("invalid_form_data", 422, "Invalid URL format");
  }
}

export async function detectPdfBuffer(buffer: Buffer): Promise<boolean> {
  if (buffer.length < 5) return false;
  // Check magic bytes %PDF-
  if (buffer.subarray(0, 5).toString("utf8") !== "%PDF-") {
    return false;
  }
  const ft = await fileTypeFromBuffer(buffer);
  if (ft && ft.mime !== "application/pdf") {
    return false;
  }
  return true;
}

export async function parseSubmission(
  request: FastifyRequest,
  form: FormConfig,
  storage: StorageAdapter,
): Promise<ParsedInput> {
  const parts = request.parts();
  const rawFields: Record<string, string> = {};
  const stagedAttachments: StagedAttachment[] = [];
  const stagedKeysToCleanup: string[] = [];
  let activeCheckStream: PassThrough | null = null;
  let activeStagePromise: Promise<StagedFile> | null = null;

  let clientSubmissionId: string | null = null;
  let captchaToken: string | null = null;
  let isHoneypot = false;
  let partCount = 0;
  let totalRawFileBytes = 0;

  const MAX_PARTS = 30;
  const MAX_FILES = 5;
  const MAX_FILE_BYTES = 10485760;
  const MAX_COMBINED_FILES = 10485760;

  const allowedFieldNames = new Set(form.fields.map((f) => f.name));
  const seenFieldNames = new Set<string>();

  try {
    for await (const part of parts) {
      partCount++;
      if (partCount > MAX_PARTS) {
        throw new AppError("invalid_form_data", 422, "Exceeded maximum allowed 30 multipart parts");
      }

      if (part.type === "file") {
        if (allowedFieldNames.size > 0 && part.fieldname !== "attachments") {
          throw new AppError(
            "invalid_form_data",
            422,
            `Unexpected file field name: ${part.fieldname}`,
          );
        }

        if (stagedAttachments.length >= MAX_FILES) {
          throw new AppError("file_too_large", 413, `Exceeded maximum ${MAX_FILES} attachments`);
        }

        const sanitizedName = sanitizeFilename(part.filename || "attachment.pdf");
        if (part.mimetype !== "application/pdf") {
          throw new AppError("invalid_pdf", 422, "Only application/pdf MIME type is allowed");
        }

        // Buffer initial chunk for magic bytes check
        const chunks: Buffer[] = [];
        let headerChecked = false;

        const checkStream = new PassThrough();
        activeCheckStream = checkStream;

        let stageError: Error | null = null;
        let drainPendingReject: ((err: Error) => void) | null = null;

        // F03: Attach error and close listeners immediately so checkStream NEVER causes unhandled 'error' events
        checkStream.on("error", (err) => {
          if (!stageError) stageError = err;
          if (drainPendingReject) {
            drainPendingReject(err);
            drainPendingReject = null;
          }
        });
        checkStream.on("close", () => {
          if (drainPendingReject) {
            drainPendingReject(stageError || new Error("Stream closed prematurely"));
            drainPendingReject = null;
          }
        });

        const stagePromise = storage.stage(checkStream, MAX_FILE_BYTES).catch((err) => {
          const errorObj = err instanceof Error ? err : new Error(String(err));
          if (!stageError) stageError = errorObj;
          if (!checkStream.destroyed) {
            checkStream.destroy(errorObj);
          }
          if (drainPendingReject) {
            drainPendingReject(errorObj);
            drainPendingReject = null;
          }
          throw errorObj;
        });
        activeStagePromise = stagePromise;

        try {
          for await (const chunk of part.file) {
            if (stageError) {
              throw stageError;
            }

            // Check client abort / stream errors
            if (
              (request.raw.destroyed && !request.raw.readableEnded) ||
              request.raw.errored ||
              part.file.truncated
            ) {
              throw new AppError("bad_request", 400, "Client aborted upload request");
            }

            const buf = chunk as Buffer;
            totalRawFileBytes += buf.length;
            if (totalRawFileBytes > MAX_COMBINED_FILES) {
              throw new AppError("file_too_large", 413, "Combined file bytes exceed 10MB limit");
            }

            if (!headerChecked) {
              chunks.push(buf);
              const combined = Buffer.concat(chunks);
              if (combined.length >= 5) {
                if (combined.subarray(0, 5).toString("utf8") !== "%PDF-") {
                  throw new AppError(
                    "invalid_pdf",
                    422,
                    "File content is not a valid PDF (%PDF- header missing)",
                  );
                }
                headerChecked = true;
              }
            }

            if (stageError) {
              throw stageError;
            }

            // Respect backpressure, but settle immediately on drain, error, close, or stage failure
            if (!checkStream.write(buf)) {
              if (stageError) {
                throw stageError;
              }
              await new Promise<void>((resolve, reject) => {
                if (stageError) return reject(stageError);
                if (checkStream.destroyed)
                  return reject(stageError || new Error("Stream destroyed"));

                const onDrain = () => {
                  cleanup();
                  resolve();
                };
                const onError = (err: any) => {
                  cleanup();
                  reject(err);
                };
                const onClose = () => {
                  cleanup();
                  reject(stageError || new Error("Stream closed"));
                };
                function cleanup() {
                  drainPendingReject = null;
                  checkStream.off("drain", onDrain);
                  checkStream.off("error", onError);
                  checkStream.off("close", onClose);
                }
                drainPendingReject = (err) => {
                  cleanup();
                  reject(err);
                };
                checkStream.once("drain", onDrain);
                checkStream.once("error", onError);
                checkStream.once("close", onClose);
              });
            }
          }

          if (stageError) {
            throw stageError;
          }

          if (!headerChecked) {
            throw new AppError("invalid_pdf", 422, "Empty or truncated PDF file");
          }

          checkStream.end();
          const staged = await stagePromise;
          stagedKeysToCleanup.push(staged.key);

          stagedAttachments.push({
            id: randomUUID(),
            storageKey: staged.key,
            originalName: sanitizedName,
            sizeBytes: staged.sizeBytes,
            sha256: staged.sha256,
          });
        } catch (fileErr) {
          // If checkStream is still active, destroy it safely (error listener is already attached)
          if (!checkStream.destroyed) {
            checkStream.destroy(fileErr instanceof Error ? fileErr : new Error(String(fileErr)));
          }

          // Resume part.file to drain remaining incoming payload so parser slot is released
          try {
            part.file.resume();
          } catch {
            // ignore
          }

          // Wait for stagePromise to settle completely before throwing
          try {
            const staged = await stagePromise;
            stagedKeysToCleanup.push(staged.key);
          } catch {
            // stage() pipeline failed and unlinked tmpPath
          }

          if (fileErr instanceof AppError) {
            throw fileErr;
          }
          const errCode = (fileErr as any)?.code;
          if (errCode === "ENOSPC" || errCode === "EACCES" || errCode === "EIO") {
            throw new AppError(
              "service_unavailable",
              503,
              `Storage unavailable during upload: ${(fileErr as Error).message}`,
            );
          }
          throw fileErr;
        } finally {
          activeCheckStream = null;
          activeStagePromise = null;
        }
      } else {
        // Field part
        const fieldName = part.fieldname;
        const value = (part.value as string) || "";

        if (fieldName === "_submission_id") {
          if (seenFieldNames.has(fieldName)) {
            throw new AppError("invalid_form_data", 422, "Duplicate _submission_id field");
          }
          seenFieldNames.add(fieldName);
          const trimmed = value.trim();
          if (trimmed) {
            if (!UUID_V4_REGEX.test(trimmed)) {
              throw new AppError(
                "invalid_form_data",
                422,
                "Invalid _submission_id: must be a valid UUID v4",
              );
            }
            clientSubmissionId = trimmed;
          }
        } else if (fieldName === "_captcha_token" || fieldName === "cf-turnstile-response") {
          if (seenFieldNames.has("_captcha_token") || seenFieldNames.has("cf-turnstile-response")) {
            throw new AppError("invalid_form_data", 422, `Duplicate ${fieldName} field`);
          }
          seenFieldNames.add(fieldName);
          captchaToken = value.trim() || null;
        } else if (fieldName === "_honey") {
          if (seenFieldNames.has(fieldName)) {
            throw new AppError("invalid_form_data", 422, "Duplicate _honey field");
          }
          seenFieldNames.add(fieldName);
          if (value.trim().length > 0) {
            isHoneypot = true;
          }
        } else {
          // Normal form field
          if (allowedFieldNames.size > 0 && !allowedFieldNames.has(fieldName)) {
            throw new AppError(
              "invalid_form_data",
              422,
              `Unknown or disallowed field: ${fieldName}`,
            );
          }
          if (seenFieldNames.has(fieldName)) {
            throw new AppError("invalid_form_data", 422, `Duplicate field name: ${fieldName}`);
          }
          seenFieldNames.add(fieldName);
          rawFields[fieldName] = value;
        }
      }
    }

    // If honeypot triggered, clean newly staged files immediately
    if (isHoneypot) {
      for (const k of stagedKeysToCleanup) {
        storage.delete(k);
      }
      return {
        submissionId: randomUUID(),
        clientSubmissionId,
        fields: {},
        isHoneypot: true,
        captchaToken,
        attachments: [],
      };
    }

    // Validate form fields according to schema (or dynamically for schema-less forms)
    const normalizedFields: Record<string, string | null> = {};
    if (form.fields.length > 0) {
      for (const field of form.fields) {
        const rawVal = rawFields[field.name];
        if (field.required && (rawVal === undefined || rawVal.trim().length === 0)) {
          throw new AppError("invalid_form_data", 422, `Required field missing: ${field.name}`);
        }

        if (rawVal === undefined || rawVal.trim().length === 0) {
          normalizedFields[field.name] = null;
          continue;
        }

        if (field.type === "email") {
          normalizedFields[field.name] = normalizeEmail(rawVal);
        } else if (field.type === "url") {
          normalizedFields[field.name] = normalizeUrl(rawVal, field.max_length);
        } else {
          normalizedFields[field.name] = normalizeText(rawVal, field.max_length);
        }
      }
    } else {
      for (const [k, v] of Object.entries(rawFields)) {
        normalizedFields[k] = normalizeText(v, 4000);
      }
    }

    return {
      submissionId: randomUUID(),
      clientSubmissionId,
      fields: normalizedFields,
      isHoneypot: false,
      captchaToken,
      attachments: stagedAttachments,
    };
  } catch (err) {
    if (activeCheckStream && !activeCheckStream.destroyed) {
      activeCheckStream.destroy(err instanceof Error ? err : new Error(String(err)));
    }
    if (activeStagePromise) {
      try {
        const staged = await activeStagePromise;
        stagedKeysToCleanup.push(staged.key);
      } catch {
        // stage() unlinked tmpPath
      }
      activeStagePromise = null;
    }
    // Cleanup any staged files on rejection
    for (const k of stagedKeysToCleanup) {
      try {
        storage.delete(k);
      } catch {
        // ignore
      }
    }
    const errCode = (err as any)?.code;
    if (
      !(err instanceof AppError) &&
      (errCode === "ENOSPC" || errCode === "EACCES" || errCode === "EIO")
    ) {
      throw new AppError(
        "service_unavailable",
        503,
        `Storage failure during upload: ${(err as Error).message}`,
      );
    }
    throw err;
  }
}
