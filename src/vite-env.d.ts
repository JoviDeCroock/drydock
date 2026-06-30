/// <reference types="vite/client" />

interface ImportMetaEnv {
  // PostHog project API key (write-only, safe to ship in the client bundle).
  // When unset, product analytics is disabled entirely — forks and self-hosted
  // deployments stay analytics-free unless they opt in at build time.
  readonly VITE_PUBLIC_POSTHOG_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
