import nodemailer from "nodemailer";
import type { SmtpTlsMode, SubmitResult } from "./types.js";

export interface SmtpEnvelope {
  from: string;
  to: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  tlsMode: SmtpTlsMode;
  username?: string;
  password?: string;
  socketTimeoutMs?: number;
}

export function classifySmtpError(err: unknown): SubmitResult {
  if (typeof err !== "object" || err === null) {
    return { kind: "unknown", code: "unrecognized_error" };
  }

  const error = err as {
    code?: string;
    responseCode?: number;
    response?: string;
    command?: string;
    message?: string;
    timeoutType?: string;
    syscall?: string;
    originalCode?: string;
  };

  const responseCode = error.responseCode;
  const command = error.command ? String(error.command).toUpperCase() : "";
  const code = (error.code ? String(error.code) : "").toUpperCase();
  const timeoutType = error.timeoutType ? String(error.timeoutType).toUpperCase() : "";

  // 1. Explicit SMTP 5xx permanent refusal -> failed
  if (responseCode && responseCode >= 500 && responseCode < 600) {
    return { kind: "failed", code: `smtp_${responseCode}` };
  }

  // 2. Explicit SMTP 4xx temporary refusal -> safe_retry
  if (responseCode && responseCode >= 400 && responseCode < 500) {
    return { kind: "safe_retry", code: `smtp_${responseCode}` };
  }

  // 3. Known permanent client / TLS / Auth errors -> failed
  if (
    code === "EAUTH" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID"
  ) {
    return { kind: "failed", code: code.toLowerCase() };
  }

  // 4. Positive structured evidence of pre-submission timeout or connection failure -> safe_retry
  // Standard TCP pre-connection failures where no connection was ever established:
  // - ECONNREFUSED: Server port is not open (RST packet)
  // - ENOTFOUND / EDNS: DNS hostname could not be resolved
  // - EHOSTUNREACH / ENETUNREACH: Routing failure
  // - ESOCKET during connect syscall: Initial socket connection refused
  //
  // For timeouts (code === 'ETIMEDOUT'):
  // Nodemailer's _onTimeout() defaults command="CONN" even for SOCKET_TIMEOUT, which can occur during or after DATA!
  // Therefore, command="CONN" alone is NOT reliable evidence that sending never started.
  // Only structured pre-submission timeoutType values ('CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT')
  // prove that timeout occurred before message submission began.
  // Any timeout with timeoutType='SOCKET_TIMEOUT', missing timeoutType, or unrecognized stage MUST remain unknown.
  const isPreSubmissionTimeout =
    code === "ETIMEDOUT" &&
    (timeoutType === "CONNECT_TIMEOUT" ||
      timeoutType === "GREETING_TIMEOUT" ||
      timeoutType === "UPGRADE_TIMEOUT");

  const isPreConnectionNetworkFailure =
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EDNS" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    (code === "ESOCKET" &&
      command === "CONN" &&
      (error as { syscall?: string }).syscall === "connect") ||
    Boolean((error as { originalCode?: string }).originalCode === "ECONNREFUSED");

  if (isPreSubmissionTimeout || isPreConnectionNetworkFailure) {
    const errCode =
      (error as { originalCode?: string }).originalCode?.toLowerCase() ||
      code.toLowerCase() ||
      "connection_failed";
    return { kind: "safe_retry", code: errCode };
  }

  // 5. Post-DATA, in-flight, or ambiguous timeouts/disconnects -> unknown
  // ECONNECTION (Connection closed unexpectedly), ECONNRESET, EPIPE,
  // ETIMEDOUT with SOCKET_TIMEOUT or unproven timeout stage, command DATA, command END,
  // or any unrecognized error.
  // Remote MTA acceptance cannot be proven, so it must NEVER be automatically retried.
  return { kind: "unknown", code: code.toLowerCase() || "unrecognized_error" };
}

export async function submitRaw(
  raw: Buffer,
  envelope: SmtpEnvelope,
  config: SmtpConfig,
): Promise<SubmitResult> {
  const isSecure = config.tlsMode === "implicit" || config.port === 465;
  const isRequireTls = config.tlsMode === "starttls_required";
  const isIgnoreTls = config.tlsMode === "plain_local";

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: isSecure,
    requireTLS: isRequireTls,
    ignoreTLS: isIgnoreTls,
    pool: false, // Disallow connection pooling for v0.1 bounded retry integrity
    auth:
      config.username && config.password
        ? { user: config.username, pass: config.password }
        : undefined,
    logger: false,
    debug: false,
    connectionTimeout: config.socketTimeoutMs ?? 30000,
    socketTimeout: config.socketTimeoutMs ?? 30000,
    greetingTimeout: config.socketTimeoutMs ?? 30000,
  });

  try {
    const info = await transport.sendMail({
      envelope: {
        from: envelope.from,
        to: [envelope.to],
      },
      raw,
    });

    const accepted = (info.accepted || []).map((a: string | { address: string }) =>
      typeof a === "string" ? a : a.address,
    );

    if (accepted.some((a) => a.toLowerCase() === envelope.to.toLowerCase())) {
      return {
        kind: "submitted",
        receipt: {
          response: typeof info.response === "string" ? info.response.substring(0, 500) : "250 OK",
          accepted,
        },
      };
    }

    return {
      kind: "failed",
      code: "recipient_not_accepted",
    };
  } catch (err: unknown) {
    return classifySmtpError(err);
  } finally {
    try {
      transport.close();
    } catch {
      // ignore
    }
  }
}

export async function sendSystemMessage(
  recipient: string,
  subject: string,
  text: string,
  html: string,
  config: SmtpConfig,
  fromAddress: string,
): Promise<SubmitResult> {
  const isSecure = config.tlsMode === "implicit" || config.port === 465;
  const isRequireTls = config.tlsMode === "starttls_required";
  const isIgnoreTls = config.tlsMode === "plain_local";

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: isSecure,
    requireTLS: isRequireTls,
    ignoreTLS: isIgnoreTls,
    pool: false,
    auth:
      config.username && config.password
        ? { user: config.username, pass: config.password }
        : undefined,
    logger: false,
    debug: false,
    connectionTimeout: config.socketTimeoutMs ?? 30000,
    socketTimeout: config.socketTimeoutMs ?? 30000,
    greetingTimeout: config.socketTimeoutMs ?? 30000,
  });

  try {
    const info = await transport.sendMail({
      from: fromAddress,
      to: recipient,
      subject,
      text,
      html,
    });

    const accepted = (info.accepted || []).map((a: string | { address: string }) =>
      typeof a === "string" ? a : a.address,
    );

    if (accepted.some((a) => a.toLowerCase() === recipient.toLowerCase())) {
      return {
        kind: "submitted",
        receipt: {
          response: typeof info.response === "string" ? info.response.substring(0, 500) : "250 OK",
          accepted,
        },
      };
    }

    return {
      kind: "failed",
      code: "recipient_not_accepted",
    };
  } catch (err: unknown) {
    return classifySmtpError(err);
  } finally {
    try {
      transport.close();
    } catch {
      // ignore
    }
  }
}
