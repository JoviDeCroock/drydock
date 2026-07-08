import { Container } from "@cloudflare/containers";

// Durable Object that manages the detonation container instance. The `Container`
// base forwards `fetch()` to the container's HTTP server (prototypes/detonation
// src/server.mjs) on `defaultPort`.
//
// This is the ONE place a package's code executes, and it executes inside the
// container — never in this Durable Object's isolate and never in the request
// Worker. The container is credential-free and network-restricted; see
// docs/detonation.md.
export class DetonationContainer extends Container<Cloudflare.Env> {
  // The detonation service listens here (Dockerfile EXPOSE 8080 / PORT=8080).
  defaultPort = 8080;
  // A detonation is a short burst; let an idle instance sleep quickly so we are
  // not paying for a warm container between reviews.
  sleepAfter = "5m";
}
