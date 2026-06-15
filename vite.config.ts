import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { ADDITIONAL_PRERENDER_ROUTES } from "./src/lib/prerender-routes";

declare const process: {
  env: {
    CLOUDFLARE_VITE_PERSIST_STATE_PATH?: string;
    VITE_APP_NAME?: string;
    VITE_APP_TAGLINE?: string;
    VITE_BRAND_WORDMARK?: string;
    VITE_CONTACT_EMAIL?: string;
    VITE_SITE_URL?: string;
  };
};

interface WranglerConfig {
  vars?: Record<string, string>;
}

const wranglerVars = readWranglerVars();

const publicConfig = {
  appName: envOrVar("VITE_APP_NAME", "APP_NAME") ?? "drydock",
  tagline: envOrVar("VITE_APP_TAGLINE", "APP_TAGLINE") ?? "Pre-publish review for npm and PyPI",
  wordmark: envOrVar("VITE_BRAND_WORDMARK", "BRAND_WORDMARK"),
  contactEmail:
    envOrVar("VITE_CONTACT_EMAIL", "CONTACT_EMAIL") ?? wranglerVars.EMAIL_FROM_ADDRESS ?? "",
  siteUrl: normalizeSiteUrl(envOrVar("VITE_SITE_URL", "BETTER_AUTH_URL") ?? "https://drydock.org"),
};

export default defineConfig(({ mode }) => {
  const persistStatePath = process.env.CLOUDFLARE_VITE_PERSIST_STATE_PATH;

  return {
    server: {
      port: 5173,
      strictPort: true,
      watch: {
        ignored: ["**/.context/**"],
      },
    },
    define: {
      "import.meta.env.VITE_APP_NAME": JSON.stringify(publicConfig.appName),
      "import.meta.env.VITE_APP_TAGLINE": JSON.stringify(publicConfig.tagline),
      "import.meta.env.VITE_BRAND_WORDMARK": JSON.stringify(
        publicConfig.wordmark ?? publicConfig.appName.toLowerCase(),
      ),
      "import.meta.env.VITE_CONTACT_EMAIL": JSON.stringify(publicConfig.contactEmail),
      "import.meta.env.VITE_SITE_URL": JSON.stringify(publicConfig.siteUrl),
    },
    plugins: [
      publicHtmlConfigPlugin(),
      preact({
        prerender: {
          enabled: true,
          renderTarget: "#app",
          additionalPrerenderRoutes: Array.from(ADDITIONAL_PRERENDER_ROUTES),
          previewMiddlewareEnabled: true,
          previewMiddlewareFallback: "/404",
        },
      }),
      tailwindcss(),
      ...(mode === "test"
        ? []
        : [
            cloudflare({
              persistState: persistStatePath ? { path: persistStatePath } : true,
            }),
          ]),
    ],
  };
});

function envOrVar(envName: keyof typeof process.env, varName: string): string | undefined {
  return process.env[envName] || wranglerVars[varName];
}

function normalizeSiteUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function readWranglerVars(): Record<string, string> {
  try {
    const raw = readFileSync(new URL("wrangler.jsonc", import.meta.url), "utf8");
    const parsed = JSON.parse(stripJsonc(raw)) as WranglerConfig;
    return parsed.vars ?? {};
  } catch {
    return {};
  }
}

function stripJsonc(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += char;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function publicHtmlConfigPlugin() {
  const title = `${publicConfig.appName} - see exactly what your next publish ships`;
  const description = `${publicConfig.tagline}. ${publicConfig.appName} diffs each release candidate against the last published version and pins risk findings to the lines that introduced them. You approve, and ${publicConfig.appName} never holds your publish credential.`;
  return {
    name: "public-html-config",
    transformIndexHtml(html: string) {
      return html
        .replace(/<title>.*?<\/title>/s, `<title>${escapeHtml(title)}</title>`)
        .replace(
          /<meta\s+name="description"\s+content="[^"]*"\s*\/>/s,
          `<meta name="description" content="${escapeHtmlAttribute(description)}" />`,
        );
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
