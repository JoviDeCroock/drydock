import { Hono } from "hono";
import { assignLandingExperiment } from "../lib/acquisition";
import { guardRateLimit } from "../lib/rate-limit";
import type { Bindings, Variables } from "../types";
import type { AcquisitionChannel } from "../../src/lib/landing-experiment";

export const landingExperimentRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

landingExperimentRoutes.get("/", async (c) => {
  c.header("Cache-Control", "private, no-store");
  if (c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "forbidden" }, 403);
  const limited = await guardRateLimit(
    c,
    {
      key: `landing-experiment:${c.req.header("cf-connecting-ip") ?? "unknown"}`,
      limit: 30,
      windowMs: 60_000,
    },
    "experiment rate limit exceeded",
  );
  if (limited) return limited;
  const suppliedChannel = c.req.header("x-drydock-acquisition-channel");
  const channel = ["direct", "search", "github", "other"].includes(suppliedChannel ?? "")
    ? (suppliedChannel as AcquisitionChannel)
    : undefined;
  const acquisition = await assignLandingExperiment(c, channel);
  return c.json({ variant: acquisition?.variant ?? "control" });
});
