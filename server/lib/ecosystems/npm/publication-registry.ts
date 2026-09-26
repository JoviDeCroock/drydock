import {
  allowInsecureLocalRegistry,
  isLoopbackHostname,
  registryProtocolAllowed,
} from "./connection";

export function npmPublicationRegistry(env: Cloudflare.Env): string {
  if (allowInsecureLocalRegistry(env)) {
    try {
      const local = new URL(env.NPM_REGISTRY);
      if (
        isLoopbackHostname(local.hostname) &&
        registryProtocolAllowed(local, { allowInsecureLocalhost: true }) &&
        !local.username &&
        !local.password &&
        !local.search &&
        !local.hash &&
        local.pathname === "/"
      )
        return local.origin;
    } catch {}
  }
  return "https://registry.npmjs.org";
}
