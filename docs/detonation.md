# Detonation (dynamic analysis)

Detonation runs a completed scan's package through its install lifecycle in an
isolated environment and reports what it _does_ at runtime — process spawns,
network egress, out-of-workdir writes, and access to planted credential canaries.
It complements static detection: rules catch what's visible in the bytes,
detonation catches what only manifests at runtime.

It is **advisory and default-off**, gated per organization by the Cloudflare
Flagship `detonation` flag — the same posture as the AI reviewer. Detonation
findings are their own list; they never downgrade or gate deterministic findings.

## Trust boundary

The Worker **never executes package code**. The Workers isolate cannot spawn
processes, and executing package code in the trusted control plane is a core
non-negotiable. Detonation therefore runs in a **separate Cloudflare Container**
(the sacrificial environment), reached from the Worker as a `Fetcher` binding
(`DETONATION`) via its Durable Object stub:

```text
Worker (control plane)                         Cloudflare Container (sacrificial)
  POST /api/v1/scans/:id/detonate
    ├─ flag + owner/admin + rate-limit
    ├─ load the scan's reviewed file bytes   ── package bytes only, no creds ──▶  run lifecycle scripts
    │                                                                             observe + record behavior
    ├─ validate drydock.detonation.v1 report ◀──────── behavior report ─────────  return report
    └─ return advisory findings
```

Boundary invariants:

- **Package bytes only cross into the container** — never npm/registry
  credentials, tokens, or org identifiers. Detonation runs credential-free, so a
  hostile package cannot reach a protected resource through it.
- **The container's output is untrusted input.** The Worker re-validates the
  report against the `drydock.detonation.v1` schema before using any of it; a
  malformed report is a `502`, never trusted.
- **Container isolation is the real containment**: no network, read-only rootfs,
  dropped capabilities, non-root, resource limits (see the run flags below and
  `prototypes/detonation`). The prototype's `local` mode is a demo of the
  instrumentation, not a boundary.

## API

`POST /api/v1/scans/:id/detonate` — owner/admin, flag-gated, rate-limited
(10/hour/org). Returns:

```json
{ "detonation": { "verdict": "critical", "advisory": true, "findings": [ ... ] } }
```

Responses: `403` (flag off or insufficient role), `503` (flag on but no runtime
provisioned), `409` (scan not complete), `422` (no manifest text to detonate),
`502` (container unavailable or returned an unusable report).

## Deployment

The container image is `prototypes/detonation` (its `Dockerfile` serves the
harness over HTTP at `/detonate`). Provision it as a Cloudflare Container fronted
by a Durable Object, and expose that DO to the Worker as the `DETONATION` binding.
Add to `wrangler.jsonc`:

```jsonc
{
  "containers": [
    {
      "class_name": "DetonationContainer",
      "image": "./prototypes/detonation/Dockerfile",
      "instances": 3,
      "name": "drydock-detonation",
    },
  ],
  "durable_objects": {
    "bindings": [{ "class_name": "DetonationContainer", "name": "DETONATION" }],
  },
}
```

The Worker exports a thin `DetonationContainer` Durable Object (extending the
`@cloudflare/containers` `Container` base) that forwards `fetch` to the container
on port 8080; `server/lib/detonation.ts` calls it through the `Fetcher` interface.
Enable the `detonation` Flagship flag for the organizations that should have it.

Without the binding the feature is inert: `isDetonationEnabled` short-circuits and
the route returns `503`, so shipping this code is safe before the container is
provisioned.

## Status

The Worker-side orchestration, report validation, advisory mapping, route, flag
gate, and the containerized service are implemented and tested
(`test/workers/detonation-route.test.ts`, `prototypes/detonation/test`). The
detonation engine itself is the prototype in `prototypes/detonation` (see its
README for the roadmap: real dependency install inside the container, micro-VM
isolation, syscall-level capture, more ecosystems).
