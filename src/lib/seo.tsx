import { toStatic, useHead, useLink, type MetaOptions } from "hoofd/preact";

const SITE_NAME = "Drydock";
const SITE_URL = "https://drydock.org";
const OG_IMAGE_URL = `${SITE_URL}/og-image.png`;
const OG_IMAGE_ALT = "Drydock — pre-publish package review for npm and PyPI maintainers";

export interface PageSeoMetadata {
  title: string;
  description: string;
  path: "/" | "/docs" | "/privacy";
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
  title: "Drydock: pre-publish package review",
  description:
    "Drydock lets npm and PyPI maintainers review the exact package artifact before a staged publish or gated release goes live.",
  path: "/",
};

export const docsPageSeo: PageSeoMetadata = {
  title: "Drydock docs: staged publishing and workflow gates",
  description:
    "Set up npm staged publishing or GitHub workflow gates so Drydock can review release artifacts before publication.",
  path: "/docs",
};

export const privacyPageSeo: PageSeoMetadata = {
  title: "Drydock privacy policy",
  description:
    "How Drydock collects, uses, retains, and protects your account, organization, and release data.",
  path: "/privacy",
};

export function getPageSeoMetadata(pathname: string): PageSeoMetadata | undefined {
  const canonicalPathname =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  if (canonicalPathname === "/") return homePageSeo;
  if (canonicalPathname === "/docs") return docsPageSeo;
  if (canonicalPathname === "/privacy") return privacyPageSeo;
  return undefined;
}

export function PageSeo({ metadata }: { metadata: PageSeoMetadata }) {
  const canonicalUrl = metadata.path === "/" ? `${SITE_URL}/` : `${SITE_URL}${metadata.path}`;

  useHead({
    title: metadata.title,
    metas: [
      { name: "description", content: metadata.description },
      { name: "robots", content: "index,follow" },
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:type", content: "website" },
      { property: "og:title", content: metadata.title },
      { property: "og:description", content: metadata.description },
      { property: "og:url", content: canonicalUrl },
      { property: "og:image", content: OG_IMAGE_URL },
      { property: "og:image:alt", content: OG_IMAGE_ALT },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "800" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: metadata.title },
      { name: "twitter:description", content: metadata.description },
      { name: "twitter:image", content: OG_IMAGE_URL },
      { name: "twitter:image:alt", content: OG_IMAGE_ALT },
    ] satisfies MetaOptions[],
  });
  useLink({ rel: "canonical", href: canonicalUrl });

  return null;
}

// Schema.org JSON-LD describing the product and site. Search engines read
// `application/ld+json` data blocks from anywhere in the document; rendering it
// in the prerendered landing markup keeps it crawlable without client JS. The
// `type="application/ld+json"` script is a data block, not executable script,
// so the document CSP `script-src` does not apply to it.
const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      logo: OG_IMAGE_URL,
      description: homePageSeo.description,
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
    {
      "@type": "SoftwareApplication",
      name: SITE_NAME,
      applicationCategory: "SecurityApplication",
      operatingSystem: "Web",
      url: `${SITE_URL}/`,
      description: homePageSeo.description,
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
  ],
};

export function StructuredData() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
    />
  );
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
