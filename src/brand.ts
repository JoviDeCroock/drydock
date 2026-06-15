interface PublicBrandEnv {
  VITE_APP_NAME?: string;
  VITE_APP_TAGLINE?: string;
  VITE_BRAND_WORDMARK?: string;
  VITE_CONTACT_EMAIL?: string;
  VITE_SITE_URL?: string;
}

const brandEnv = import.meta.env as PublicBrandEnv;

// Vite injects these from wrangler.jsonc at build time; see vite.config.ts.
export const BRAND_NAME = brandEnv.VITE_APP_NAME ?? "drydock";

export const BRAND_WORDMARK = brandEnv.VITE_BRAND_WORDMARK ?? BRAND_NAME.toLowerCase();

export const CONTACT_EMAIL = brandEnv.VITE_CONTACT_EMAIL ?? "";

export const TAGLINE = brandEnv.VITE_APP_TAGLINE ?? "Pre-publish review for npm and PyPI";

export const SITE_URL = normalizeSiteUrl(brandEnv.VITE_SITE_URL ?? "https://drydock.org");

function normalizeSiteUrl(value: string): string {
  return value.replace(/\/+$/, "");
}
