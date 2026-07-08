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
(the sacrificial environment). The Worker reaches it through the `DETONATION`
Durable Object namespace, resolved to a container stub it `fetch`es:

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

The wiring is in the repo and ready; the container is **not provisioned in the
deployed `wrangler.jsonc`** because that requires Cloudflare Containers enabled
on the account (a Docker image build in the deploy pipeline), which the
production Workers build does not currently support. The Worker therefore
deploys cleanly and the feature stays inert (route `503`) until it is provisioned.

Present in the repo already:

- **Container image** — `prototypes/detonation` (its `Dockerfile` serves the
  harness over HTTP at `/detonate` on port 8080).
- **Durable Object class** — `DetonationContainer`
  (`server/detonation-container.ts`, extending the `@cloudflare/containers`
  `Container` base), forwarding `fetch` to port 8080.
- **Worker orchestration** — `server/lib/detonation-binding.ts` resolves a
  container stub via `getContainer`; `server/lib/detonation.ts` validates and
  maps the report; the route in `server/routes/scans.ts`.

To provision it (requires Cloudflare Containers on the account + Docker in the
deploy pipeline):

1. Re-add the `DetonationContainer` export in `server/index.ts`.
2. Add this block to `wrangler.jsonc` (note: DO bindings use `name`, and the
   instance type is `standard-1`):

   ```jsonc
   {
     "containers": [
       {
         "name": "drydock-detonation",
         "class_name": "DetonationContainer",
         "image": "./prototypes/detonation/Dockerfile",
         "image_build_context": "./prototypes/detonation",
         "max_instances": 3,
         "instance_type": "standard-1",
       },
     ],
     "durable_objects": {
       "bindings": [{ "name": "DETONATION", "class_name": "DetonationContainer" }],
     },
     "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DetonationContainer"] }],
   }
   ```

3. `wrangler deploy` (builds + pushes the image), then enable the `detonation`
   Flagship flag for the organizations that should have it.

## Status

The Worker-side orchestration, report validation, advisory mapping, route, flag
gate, the Durable Object class + container-binding code, and the containerized
service are implemented and tested (`test/workers/detonation-route.test.ts`,
`prototypes/detonation/test`). The only step gated on the environment is
provisioning the container in the deploy config (above). The detonation engine
itself is the prototype in `prototypes/detonation` (see its README for the
roadmap: real dependency install inside the container, micro-VM isolation,
syscall-level capture, more ecosystems).
