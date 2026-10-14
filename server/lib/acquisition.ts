import type { Context } from "hono";
import { getCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { recordProductEvent } from "./analytics";
import { describeOperationalError, emitOperationalEvent } from "./platform/observability";
import {
  LANDING_EXPERIMENT,
  classifyAcquisitionChannel,
  type AcquisitionChannel,
  type LandingVariant,
} from "../../src/lib/landing-experiment";
import type { Bindings, Variables } from "../types";

type AcquisitionContext = Context<{ Bindings: Bindings; Variables: Variables }>;
const COOKIE = "drydock_landing";
const DAY_MS = 86_400_000;
const COHORT_DAYS = 30;

export interface Acquisition {
  experiment: typeof LANDING_EXPERIMENT;
  variant: LandingVariant;
  channel: AcquisitionChannel;
  expiresDay: number;
  diffRead: boolean;
}

export async function landingExperimentEnabled(env: Bindings): Promise<boolean> {
  if (!env.FLAGS || !env.BETTER_AUTH_SECRET || !env.PRODUCT_ANALYTICS) return false;
  try {
    return await env.FLAGS.getBooleanValue("landing-hero-experiment", false);
  } catch (err) {
    emitOperationalEvent("warn", "acquisition.flag_unavailable", {
      error: describeOperationalError(err),
    });
    return false;
  }
}

export async function readAcquisition(c: AcquisitionContext): Promise<Acquisition | null> {
  if (!c.env.BETTER_AUTH_SECRET) return null;
  const raw = getCookie(c, COOKIE);
  if (!raw || raw.length > 512) return null;
  try {
    const value = await getSignedCookie(c, cookieSecret(c.env), COOKIE);
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const item = parsed as Record<string, unknown>;
    const today = Math.floor(Date.now() / DAY_MS);
    if (
      item.experiment !== LANDING_EXPERIMENT ||
      (item.variant !== "control" && item.variant !== "challenger") ||
      !["direct", "search", "github", "other"].includes(String(item.channel)) ||
      typeof item.expiresDay !== "number" ||
      !Number.isInteger(item.expiresDay) ||
      item.expiresDay <= today ||
      item.expiresDay > today + COHORT_DAYS ||
      typeof item.diffRead !== "boolean"
    )
      return null;
    return {
      experiment: LANDING_EXPERIMENT,
      variant: item.variant,
      channel: item.channel as AcquisitionChannel,
      expiresDay: item.expiresDay,
      diffRead: item.diffRead,
    };
  } catch {
    return null;
  }
}

function cookieSecret(env: Bindings): string {
  return `${env.BETTER_AUTH_SECRET}:landing-acquisition-v1`;
}

async function writeAcquisition(c: AcquisitionContext, acquisition: Acquisition): Promise<void> {
  await setSignedCookie(c, COOKIE, JSON.stringify(acquisition), cookieSecret(c.env), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: Math.max(0, Math.floor((acquisition.expiresDay * DAY_MS - Date.now()) / 1000)),
  });
}

function hasSignInCookie(c: AcquisitionContext): boolean {
  return Boolean(getCookie(c, "spr.session_token") || getCookie(c, "__Secure-spr.session_token"));
}

export async function assignLandingExperiment(
  c: AcquisitionContext,
  channel?: AcquisitionChannel,
): Promise<Acquisition | null> {
  if (
    hasSignInCookie(c) ||
    c.req.method !== "GET" ||
    /prefetch/i.test(c.req.header("sec-purpose") ?? c.req.header("purpose") ?? "") ||
    /bot|crawler|spider/i.test(c.req.header("user-agent") ?? "") ||
    !(await landingExperimentEnabled(c.env))
  )
    return null;
  const existing = await readAcquisition(c);
  if (existing) return existing;
  const acquisition: Acquisition = {
    experiment: LANDING_EXPERIMENT,
    variant: crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0 ? "control" : "challenger",
    channel:
      channel ?? classifyAcquisitionChannel(c.req.header("referer"), new URL(c.req.url).hostname),
    expiresDay: Math.floor(Date.now() / DAY_MS) + COHORT_DAYS,
    diffRead: false,
  };
  await writeAcquisition(c, acquisition);
  recordAcquisitionMilestone(c.env, acquisition, "assigned");
  return acquisition;
}

export function recordAcquisitionMilestone(
  env: Pick<Bindings, "PRODUCT_ANALYTICS"> | undefined,
  acquisition: Pick<Acquisition, "experiment" | "variant" | "channel">,
  milestone: "assigned" | "diff_read" | "signed_up",
): void {
  recordProductEvent(env, {
    name: "acquisition.milestone",
    experiment: acquisition.experiment,
    variant: acquisition.variant,
    channel: acquisition.channel,
    milestone,
  });
}

export async function recordAcquiredDiffRead(c: AcquisitionContext): Promise<boolean> {
  try {
    const acquisition = await readAcquisition(c);
    if (!acquisition || acquisition.diffRead || !(await landingExperimentEnabled(c.env)))
      return false;
    await writeAcquisition(c, { ...acquisition, diffRead: true });
    c.header("Cache-Control", "private, no-store");
    recordAcquisitionMilestone(c.env, acquisition, "diff_read");
    return true;
  } catch (err) {
    emitOperationalEvent("warn", "acquisition.diff_unavailable", {
      error: describeOperationalError(err),
    });
    return false;
  }
}
