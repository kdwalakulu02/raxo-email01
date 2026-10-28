import nodemailer, { type SendMailOptions } from "nodemailer";
import type { FormConfig } from "./types.js";
import { AppError } from "./errors.js";

export interface NotificationAttachment {
  filename: string;
  content: Buffer;
}

export interface NotificationPayload {
  submissionId: string;
  createdAt: Date;
  fields: Record<string, string | null>;
  messageId: string;
}

export async function buildNotification(
  snapshot: FormConfig,
  payload: NotificationPayload,
  attachments: NotificationAttachment[] = [],
  maxBytes = 20971520, // 20 MiB default limit
): Promise<Buffer> {
  // Use Nodemailer with streamTransport and buffer=true to safely compose MIME
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  // Plain text body with explicit field labels and escaped values
  const lines: string[] = [
    `Raxo Email Submission Notification`,
    `----------------------------------------`,
    `Receipt ID:     ${payload.submissionId}`,
    `Received (UTC): ${new Date(payload.createdAt).toISOString()}`,
    `Form ID:        ${snapshot.id}`,
    ``,
    `Submission Fields:`,
  ];

  for (const field of snapshot.fields) {
    const val = payload.fields[field.name];
    const displayVal = val !== null && val !== undefined ? val : "(none)";
    lines.push(`  ${field.name}: ${displayVal}`);
  }

  lines.push(``);
  lines.push(`----------------------------------------`);
  lines.push(`Retained attachments: ${attachments.length}`);
  for (const att of attachments) {
    lines.push(`  - ${att.filename} (${att.content.length} bytes)`);
  }

  const plainTextBody = lines.join("\r\n");

  // Determine Reply-To if configured and present
  let replyTo: string | undefined = undefined;
  if (snapshot.reply_to_field) {
    const replyVal = payload.fields[snapshot.reply_to_field];
    if (replyVal && replyVal.trim().length > 0) {
      replyTo = replyVal.trim();
    }
  }

  const mailOptions: SendMailOptions = {
    from: snapshot.from,
    to: snapshot.recipient,
    ...(replyTo ? { replyTo } : {}),
    subject: `${snapshot.subject_prefix} — ${payload.submissionId}`,
    messageId: payload.messageId,
    text: plainTextBody,
    attachments: attachments.map((att) => ({
      filename: att.filename,
      content: att.content,
      contentType: "application/pdf",
    })),
  };

  const info = await transport.sendMail(mailOptions);
  const mimeBuffer = info.message as Buffer;

  if (mimeBuffer.length > maxBytes) {
    throw new AppError(
      "mime_too_large",
      413,
      `Final notification MIME size (${mimeBuffer.length} bytes) exceeds maximum limit (${maxBytes} bytes)`,
    );
  }

  return mimeBuffer;
}
