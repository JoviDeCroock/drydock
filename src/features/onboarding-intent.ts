import type { DiffEcosystem } from "../lib/package-diff-path";

/**
 * The npm package an anonymous reader was looking at on `/diff` when they
 * clicked through to sign up.
 *
 * The npm public diff is the top of this funnel: someone arrives with a package
 * they care about, reads the diff, and then lands on an empty dashboard that
 * knows nothing about them. PyPI and atpm have different private-review paths,
 * so they must not be carried into instructions built around `npm stage
 * publish`.
 *
 * Client-side only, and deliberately so: it is a UI breadcrumb, not a claim
 * about the account. It is written before signup — by an anonymous visitor with
 * no organization — so there is nothing to scope it to server-side, and nothing
 * in it is worth trusting beyond "prefill this field".
 *
 * Shared by two pages (`src/pages/Diff` writes, `src/pages/Dashboard` reads),
 * which is why it lives here rather than with either of them.
 */
export interface OnboardingIntent {
  ecosystem: Extract<DiffEcosystem, "npm">;
  /** Canonical name, as it appears in a `/diff` URL. */
  packageName: string;
  /** Optional readable spelling when a caller has one, else null. */
  displayName: string | null;
  /** When it was recorded, for expiry. */
  at: number;
}

const STORAGE_KEY = "drydock:onboarding-intent";

// A breadcrumb from a browsing session, not a saved preference: a dashboard
// personalized around a package someone glanced at a month ago is noise, and
// worse, it looks like Drydock believes something about their account that it
// does not.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Bounds a hand-edited storage value. npm caps names at 214 characters.
const MAX_NAME_LENGTH = 256;

function isUsableName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}

/**
 * Read the stored intent, or null when there is none, it is unusable, or it has
 * aged out. Anything unusable is dropped on the way out: the value is
 * user-writable, so the only safe reading of a shape we do not recognize is
 * that there is no intent.
 */
export function readOnboardingIntent(): OnboardingIntent | null {
  if (typeof localStorage === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const parsed = parseIntent(raw);
  if (!parsed) {
    clearOnboardingIntent();
    return null;
  }
  return parsed;
}

function parseIntent(raw: string): OnboardingIntent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ecosystem !== "npm") return null;
  if (!isUsableName(record.packageName)) return null;
  const at = record.at;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (Date.now() - at > MAX_AGE_MS) return null;
  return {
    ecosystem: record.ecosystem,
    packageName: record.packageName,
    displayName: isUsableName(record.displayName) ? record.displayName : null,
    at,
  };
}

/** Record the package a reader was on when they left for signup. */
export function rememberOnboardingIntent(intent: {
  ecosystem: Extract<DiffEcosystem, "npm">;
  packageName: string;
  displayName?: string | null;
}): void {
  if (typeof localStorage === "undefined") return;
  if (!isUsableName(intent.packageName)) return;
  const stored: OnboardingIntent = {
    ecosystem: intent.ecosystem,
    packageName: intent.packageName,
    displayName: isUsableName(intent.displayName) ? intent.displayName : null,
    at: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage may be blocked or full. The signup flow must not depend on a
    // personalization hint, so a failed write is simply no intent.
  }
}

/** Drop the intent once it has been consumed or dismissed. */
export function clearOnboardingIntent(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Same as above: nothing downstream depends on the removal succeeding.
  }
}
