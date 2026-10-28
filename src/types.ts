export type FormFieldType = "text" | "email" | "url";

export interface FormField {
  name: string;
  type: FormFieldType;
  required: boolean;
  max_length: number;
}

export interface FormConfig {
  id: string;
  enabled: boolean;
  from: string;
  recipient: string;
  subject_prefix: string;
  reply_to_field: string | null;
  success_url: string | null;
  allowed_origins: string[];
  fields: FormField[];
}

export type SmtpTlsMode = "plain_local" | "implicit" | "starttls_required";

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  databaseUrl: string;
  dbTestUrl: string;
  formsConfigPath: string;
  storageDir: string;
  smtpHost: string;
  smtpPort: number;
  smtpTlsMode: SmtpTlsMode;
  smtpUsername?: string;
  smtpPassword?: string;
  smtpMaxMessageBytes: number;
  messageIdDomain: string;
  clamdHost: string;
  clamdPort: number;
  captchaSecret?: string;
  demoMode: boolean;
  ipHashSecret: string;
  outboundEnabled: boolean;
  trustedProxyCidrs: string[];
  forms: Map<string, FormConfig>;
}

export interface Submission {
  id: string;
  form_id: string;
  client_submission_id: string | null;
  fingerprint: string;
  fields: Record<string, string | null> | null;
  config_snapshot: FormConfig | null;
  created_at: Date;
  deleted_at: Date | null;
  cleanup_done: boolean;
}

export type AttachmentScanState = "pending" | "clean" | "blocked" | "error" | "deleted";

export interface Attachment {
  id: string;
  submission_id: string;
  storage_key: string;
  original_name: string;
  size_bytes: number;
  sha256: string;
  scan_state: AttachmentScanState;
  scan_version: string | null;
  scanned_at: Date | null;
  created_at: Date;
}

export type NotificationState =
  | "queued"
  | "preparing"
  | "retry_wait"
  | "submitting"
  | "submitted"
  | "unknown"
  | "blocked"
  | "failed"
  | "cancelled"
  | "held_unverified";

export type DynamicFormStatus = "pending_verification" | "active" | "deactivated";

export interface RegisteredForm {
  id: string;
  public_id: string;
  recipient_email: string;
  status: DynamicFormStatus;
  verification_token_hash: string | null;
  verification_expires_at: Date | null;
  management_token_hash: string;
  resend_count: number;
  last_verification_sent_at: Date;
  created_at: Date;
  verified_at: Date | null;
  deactivated_at: Date | null;
}

export interface Notification {
  id: string;
  submission_id: string;
  message_id: string;
  state: NotificationState;
  attempt_count: number;
  prepare_failures: number;
  next_attempt_at: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  mime_key: string | null;
  mime_sha256: string | null;
  last_error_code: string | null;
  smtp_receipt: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export type ScanResult =
  | { kind: "clean"; version: string }
  | { kind: "blocked"; reason: string }
  | { kind: "error"; reason: string };

export type SubmitResult =
  | { kind: "submitted"; receipt: { response: string; accepted: string[] } }
  | { kind: "safe_retry"; code: string }
  | { kind: "failed"; code: string }
  | { kind: "unknown"; code: string };

export interface Receipt {
  submission_id: string | null;
  status: "received";
}

export interface WorkerHeartbeat {
  last_seen: string;
}
