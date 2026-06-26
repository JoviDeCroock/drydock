const VERIFY_EMAIL_CALLBACK_PATH = "/verify-email";

export function normalizedVerificationCallbackURL(value: string, origin: string): string {
  try {
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin) return VERIFY_EMAIL_CALLBACK_PATH;
    if (parsed.pathname !== VERIFY_EMAIL_CALLBACK_PATH) return VERIFY_EMAIL_CALLBACK_PATH;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return VERIFY_EMAIL_CALLBACK_PATH;
  }
}

export function verificationCallbackRequest(request: Request): Request {
  if (request.method !== "GET") return request;

  const url = new URL(request.url);
  if (url.pathname !== "/api/auth/verify-email") return request;

  const callbackURL = url.searchParams.get("callbackURL");
  if (!callbackURL) return request;

  const normalized = normalizedVerificationCallbackURL(callbackURL, url.origin);
  if (normalized === callbackURL) return request;

  url.searchParams.set("callbackURL", normalized);
  return new Request(url, request);
}
