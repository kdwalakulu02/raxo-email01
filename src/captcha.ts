import { AppError } from "./errors.js";

export interface CaptchaVerifyOptions {
  secret?: string;
  demoMode?: boolean;
  timeoutMs?: number;
  allowedHostnames?: string[];
  verifyEndpoint?: string;
}

export async function verifyCaptcha(
  token: string | null | undefined,
  remoteIp: string,
  options: CaptchaVerifyOptions,
): Promise<boolean> {
  // If demoMode is enabled and no token is supplied, bypass is permitted for loopback demo
  if (options.demoMode) {
    if (!token) return true;
    if (token === "demo_valid_token" || token === "test_token") {
      return true;
    }
  }

  // In production or when token is required
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return false;
  }

  const secret = options.secret;
  if (!secret) {
    if (options.demoMode) return true;
    throw new AppError("service_unavailable", 503, "CAPTCHA verification is not configured");
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const endpoint =
    options.verifyEndpoint ?? "https://challenges.cloudflare.com/turnstile/v0/siteverify";

  try {
    const formData = new URLSearchParams();
    formData.append("secret", secret);
    formData.append("response", token.trim());
    if (remoteIp) {
      formData.append("remoteip", remoteIp);
    }

    const res = await fetch(endpoint, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    if (!res.ok) {
      return false;
    }

    let body: any;
    try {
      body = await res.json();
    } catch {
      return false;
    }

    if (!body || typeof body !== "object") {
      return false;
    }

    // Require success === true
    if (body.success !== true) {
      return false;
    }

    // Require action === 'submit_form'
    if (body.action !== "submit_form") {
      return false;
    }

    // Require exact normalized hostname membership in allowedHostnames
    if (options.allowedHostnames && options.allowedHostnames.length > 0) {
      if (!body.hostname || typeof body.hostname !== "string") {
        return false;
      }
      const responseHostname = body.hostname.trim().toLowerCase();
      const normalizedAllowed = options.allowedHostnames.map((h) => h.trim().toLowerCase());
      if (!normalizedAllowed.includes(responseHostname)) {
        return false;
      }
    }

    return true;
  } catch (err) {
    // Fail closed on network error or timeout
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
