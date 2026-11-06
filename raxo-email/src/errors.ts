export type AppErrorCode =
  | "invalid_form_data"
  | "unsupported_type"
  | "file_too_large"
  | "invalid_pdf"
  | "captcha_failed"
  | "rate_limited"
  | "idempotency_conflict"
  | "service_unavailable"
  | "not_found"
  | "forbidden"
  | "bad_request"
  | "expired_submission_id"
  | "scanner_unavailable"
  | "mime_too_large";

export class AppError extends Error {
  public readonly code: AppErrorCode;
  public readonly httpStatus: number;
  public readonly safeMessage: string;

  constructor(code: AppErrorCode, httpStatus: number, safeMessage: string) {
    super(safeMessage);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.safeMessage = safeMessage;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    request_id?: string;
  };
}

export function formatErrorResponse(
  err: unknown,
  requestId?: string,
): { status: number; body: ErrorResponseBody } {
  if (err instanceof AppError) {
    return {
      status: err.httpStatus,
      body: {
        error: {
          code: err.code,
          message: err.safeMessage,
          ...(requestId ? { request_id: requestId } : {}),
        },
      },
    };
  }

  // Handle Fastify and @fastify/multipart built-in error codes
  if (typeof err === "object" && err !== null) {
    const errorObj = err as { code?: string; statusCode?: number; message?: string };

    if (
      errorObj.code === "FST_FILES_LIMIT" ||
      errorObj.code === "FST_REQ_FILE_TOO_LARGE" ||
      errorObj.statusCode === 413
    ) {
      return {
        status: 413,
        body: {
          error: {
            code: "file_too_large",
            message: "File or multipart upload exceeded allowed size limits.",
            ...(requestId ? { request_id: requestId } : {}),
          },
        },
      };
    }

    if (
      errorObj.code === "FST_FIELDS_LIMIT" ||
      errorObj.code === "FST_PARTS_LIMIT" ||
      errorObj.statusCode === 422
    ) {
      return {
        status: 422,
        body: {
          error: {
            code: "invalid_form_data",
            message: "Multipart form fields exceeded allowed limits.",
            ...(requestId ? { request_id: requestId } : {}),
          },
        },
      };
    }

    if (errorObj.statusCode === 415) {
      return {
        status: 415,
        body: {
          error: {
            code: "unsupported_type",
            message: "Unsupported media type.",
            ...(requestId ? { request_id: requestId } : {}),
          },
        },
      };
    }

    if (errorObj.statusCode === 400) {
      return {
        status: 400,
        body: {
          error: {
            code: "bad_request",
            message: "Invalid request syntax.",
            ...(requestId ? { request_id: requestId } : {}),
          },
        },
      };
    }
  }

  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "An internal server error occurred.",
        ...(requestId ? { request_id: requestId } : {}),
      },
    },
  };
}
