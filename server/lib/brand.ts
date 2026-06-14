const FALLBACK_APP_NAME = "drydock";

export function appDisplayName(env: Pick<Cloudflare.Env, "APP_NAME" | "EMAIL_FROM_NAME">): string {
  return (
    sanitizedDisplayName(env.APP_NAME) ??
    sanitizedDisplayName(env.EMAIL_FROM_NAME) ??
    FALLBACK_APP_NAME
  );
}

export function emailSignature(env: Pick<Cloudflare.Env, "APP_NAME" | "EMAIL_FROM_NAME">): string {
  return `-- ${appDisplayName(env)}`;
}

function sanitizedDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\r\n]/g, "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 80);
}
