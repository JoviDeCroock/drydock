import { parseDiffPackage, parseDiffSpec } from "../../../src/lib/package-diff-path";
import {
  OG_CARD_IMAGE_HEIGHT,
  OG_CARD_IMAGE_WIDTH,
  packageDiffOgImageAlt,
  packageDiffOgImageUrl,
  packageDiffSeo,
  SITE_URL,
} from "../../../src/lib/seo-metadata";

// Covers both the full spec (/diff/<name>/<from>/<to>) and the package-only
// form (/diff/<name>) that dependency "view diff" links open in a new tab —
// both must be served the /diff/ shell, not the homepage prerender.
export function isPackageDiffDetailPath(pathname: string): boolean {
  return parseDiffSpec(pathname) !== null || parseDiffPackage(pathname) !== null;
}

export function rewritePackageDiffMetadata(response: Response, pathname: string): Response {
  const spec = parseDiffSpec(pathname);
  if (!spec || !response.headers.get("content-type")?.includes("text/html")) return response;

  const metadata = packageDiffSeo(
    spec.packageName,
    spec.fromVersion,
    spec.toVersion,
    spec.ecosystem,
  );
  const canonicalUrl = `${SITE_URL}${metadata.path}`;
  const cardUrl = packageDiffOgImageUrl(
    spec.packageName,
    spec.fromVersion,
    spec.toVersion,
    spec.ecosystem,
  );
  const cardAlt = packageDiffOgImageAlt(spec.packageName, spec.fromVersion, spec.toVersion);

  return (
    new HTMLRewriter()
      .on("title", contentHandler(metadata.title))
      .on('meta[name="description"]', attributeHandler("content", metadata.description))
      .on('meta[property="og:title"]', attributeHandler("content", metadata.title))
      .on('meta[property="og:description"]', attributeHandler("content", metadata.description))
      .on('meta[property="og:url"]', attributeHandler("content", canonicalUrl))
      // The prerendered shell carries the site-wide card; swap in the per-diff one
      // along with its dimensions, or clients size the preview from stale values.
      .on('meta[property="og:image"]', attributeHandler("content", cardUrl))
      .on('meta[property="og:image:alt"]', attributeHandler("content", cardAlt))
      .on(
        'meta[property="og:image:width"]',
        attributeHandler("content", String(OG_CARD_IMAGE_WIDTH)),
      )
      .on(
        'meta[property="og:image:height"]',
        attributeHandler("content", String(OG_CARD_IMAGE_HEIGHT)),
      )
      .on('meta[name="twitter:title"]', attributeHandler("content", metadata.title))
      .on('meta[name="twitter:description"]', attributeHandler("content", metadata.description))
      .on('meta[name="twitter:image"]', attributeHandler("content", cardUrl))
      .on('meta[name="twitter:image:alt"]', attributeHandler("content", cardAlt))
      .on('link[rel="canonical"]', attributeHandler("href", canonicalUrl))
      .transform(response)
  );
}

function contentHandler(content: string): HTMLRewriterElementContentHandlers {
  return {
    element(element) {
      element.setInnerContent(content);
    },
  };
}

function attributeHandler(name: string, value: string): HTMLRewriterElementContentHandlers {
  return {
    element(element) {
      element.setAttribute(name, value);
    },
  };
}
