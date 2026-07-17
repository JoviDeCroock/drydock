import { parseDiffSpec } from "../../src/lib/package-diff-path";
import { packageDiffSeo, SITE_URL } from "../../src/lib/seo-metadata";

export function isPackageDiffDetailPath(pathname: string): boolean {
  return parseDiffSpec(pathname) !== null;
}

export function rewritePackageDiffMetadata(response: Response, pathname: string): Response {
  const spec = parseDiffSpec(pathname);
  if (!spec || !response.headers.get("content-type")?.includes("text/html")) return response;

  const metadata = packageDiffSeo(spec.packageName, spec.fromVersion, spec.toVersion);
  const canonicalUrl = `${SITE_URL}${metadata.path}`;

  return new HTMLRewriter()
    .on("title", contentHandler(metadata.title))
    .on('meta[name="description"]', attributeHandler("content", metadata.description))
    .on('meta[property="og:title"]', attributeHandler("content", metadata.title))
    .on('meta[property="og:description"]', attributeHandler("content", metadata.description))
    .on('meta[property="og:url"]', attributeHandler("content", canonicalUrl))
    .on('meta[name="twitter:title"]', attributeHandler("content", metadata.title))
    .on('meta[name="twitter:description"]', attributeHandler("content", metadata.description))
    .on('link[rel="canonical"]', attributeHandler("href", canonicalUrl))
    .transform(response);
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
