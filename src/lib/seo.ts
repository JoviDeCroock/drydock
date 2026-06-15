import { toStatic, useHead, useLink, type MetaOptions } from "hoofd/preact";
import { BRAND_NAME, SITE_URL } from "../brand";

export interface PageSeoMetadata {
  title: string;
  description: string;
  path: "/" | "/docs";
}

export interface PrerenderHeadElement {
  type: string;
  props: Record<string, string>;
  children?: string;
}

export interface PrerenderHead {
  title?: string;
  elements?: Set<PrerenderHeadElement>;
}

export const homePageSeo: PageSeoMetadata = {
  title: `${BRAND_NAME}: pre-publish package review`,
  description: `${BRAND_NAME} lets npm and PyPI maintainers review the exact package artifact before a staged publish or gated release goes live.`,
  path: "/",
};

export const docsPageSeo: PageSeoMetadata = {
  title: `${BRAND_NAME} docs: staged publishing and workflow gates`,
  description: `Set up npm staged publishing or GitHub workflow gates so ${BRAND_NAME} can review release artifacts before publication.`,
  path: "/docs",
};

export function getPageSeoMetadata(pathname: string): PageSeoMetadata | undefined {
  const canonicalPathname =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  if (canonicalPathname === "/") return homePageSeo;
  if (canonicalPathname === "/docs") return docsPageSeo;
  return undefined;
}

export function PageSeo({ metadata }: { metadata: PageSeoMetadata }) {
  const canonicalUrl = metadata.path === "/" ? `${SITE_URL}/` : `${SITE_URL}${metadata.path}`;

  useHead({
    title: metadata.title,
    metas: [
      { name: "description", content: metadata.description },
      { name: "robots", content: "index,follow" },
      { property: "og:site_name", content: BRAND_NAME },
      { property: "og:type", content: "website" },
      { property: "og:title", content: metadata.title },
      { property: "og:description", content: metadata.description },
      { property: "og:url", content: canonicalUrl },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: metadata.title },
      { name: "twitter:description", content: metadata.description },
    ] satisfies MetaOptions[],
  });
  useLink({ rel: "canonical", href: canonicalUrl });

  return null;
}

export function extractPrerenderHead(): PrerenderHead | undefined {
  const staticHead = toStatic();
  const elements = new Set<PrerenderHeadElement>();

  for (const meta of staticHead.metas) {
    elements.add(createPrerenderHeadElement("meta", meta));
  }
  for (const link of staticHead.links as object[]) {
    elements.add(createPrerenderHeadElement("link", link));
  }

  if (!staticHead.title && elements.size === 0) return undefined;
  return {
    ...(staticHead.title ? { title: staticHead.title } : {}),
    ...(elements.size ? { elements } : {}),
  };
}

function createPrerenderHeadElement(type: string, attributes: object): PrerenderHeadElement {
  const props: Record<string, string> = {};

  for (const [key, value] of Object.entries(attributes) as [string, unknown][]) {
    if (value == null) continue;
    props[key] = String(value);
  }

  return { type, props };
}
