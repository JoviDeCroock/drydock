import type { Context } from "hono";
import { assignLandingExperiment } from "./acquisition";
import { landingHeroCopy } from "../../src/lib/landing-experiment";
import { homePageSeo } from "../../src/lib/seo-metadata";
import { describeOperationalError, emitOperationalEvent } from "./platform/observability";
import type { Bindings, Variables } from "../types";

export async function rewriteLandingExperiment(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  response: Response,
): Promise<Response> {
  if (
    c.req.path !== "/" ||
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("text/html")
  )
    return response;
  try {
    const acquisition = await assignLandingExperiment(c);
    if (!acquisition) return response;
    const copy = landingHeroCopy[acquisition.variant];
    const title =
      acquisition.variant === "control"
        ? homePageSeo.title
        : `Drydock Package Review: ${copy.title.replace(/\.$/, "")}`;
    const description =
      acquisition.variant === "control" ? homePageSeo.description : copy.description;
    const rewriter = new HTMLRewriter()
      .on("#app", {
        element: (element) => {
          element.setAttribute("data-landing-variant", acquisition.variant);
        },
      })
      .on("#landing-hero-title", {
        element: (element) => {
          element.setInnerContent(copy.title);
        },
      })
      .on("#landing-hero-description", {
        element: (element) => {
          element.setInnerContent(copy.description);
        },
      })
      .on("#landing-diff-action", {
        element: (element) => {
          element.setInnerContent(copy.action);
        },
      })
      .on("title", {
        element: (element) => {
          element.setInnerContent(title);
        },
      });
    for (const selector of [
      'meta[name="description"]',
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
    ])
      rewriter.on(selector, {
        element: (element) => {
          element.setAttribute("content", description);
        },
      });
    for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]'])
      rewriter.on(selector, {
        element: (element) => {
          element.setAttribute("content", title);
        },
      });
    const transformed = rewriter.transform(response);
    const headers = new Headers(transformed.headers);
    headers.set("Cache-Control", "private, no-store");
    return c.newResponse(transformed.body, { status: 200, headers });
  } catch (err) {
    emitOperationalEvent("warn", "acquisition.page_unavailable", {
      error: describeOperationalError(err),
    });
    return response;
  }
}
