# Staged publish sandbox prototype

Cloudflare Worker prototype for reviewing an npm staged publish before approval.

## What this proves

- The public Worker accepts a `stageId` and spins up a fresh Dynamic Worker for the risky package-download/parsing step.
- The Dynamic Worker fetches the staged tarball through a locked-down gateway; it never receives the npm token.
- Direct sandbox egress is intercepted. Only `https://registry.npmjs.org/-/stage/<stage-id>/tarball` is allowed.
- The sandbox gunzips/parses the tarball, returns bounded file metadata and text samples, and the parent Worker runs deterministic checks plus Workers AI JSON-mode review.
- Package files are treated as hostile evidence. The AI prompt explicitly ignores file-contained instructions and the output is schema constrained.

## Important constraint

Cloudflare Workers/Dynamic Workers cannot spawn a shell or run the literal `npm stage download` CLI command. This prototype uses the same staged-tarball download boundary from inside the Dynamic Worker via `fetch()`, behind an egress gateway that injects npm auth outside the sandbox.

If we need to test the literal CLI command, that belongs in a separate container/VM runner. For Cloudflare, this fetch-based shape is safer and closer to the runtime we can actually deploy.

## API

```sh
curl -X POST https://<worker>/scan \
  -H 'content-type: application/json' \
  -d '{"stageId":"<stage-id>"}'
```

Response includes:

- `fileCount`
- bounded file metadata from the sandbox
- deterministic `ruleFindings`
- Workers AI `aiFindings`
- safety posture metadata

## Deploy notes

1. Use Node `22.14.0+` locally for Wrangler parity with npm staged publishing tooling.
2. Install dependencies:

   ```sh
   npm install
   ```

3. Configure npm auth token as a Worker secret. The token is only used by the gateway, never passed into the Dynamic Worker:

   ```sh
   npm exec wrangler secret put NPM_TOKEN
   ```

4. Deploy:

   ```sh
   npm run deploy
   ```

## Threat model

Defended:

- Malicious package content trying to prompt-inject the AI reviewer.
- Package parser trying direct Internet egress from the sandbox.
- NPM token exposure to sandbox code.
- Huge packages overwhelming AI context; samples are bounded.

Not defended in this spike:

- Literal `npm stage download` CLI execution inside Workers; Workers cannot spawn CLI processes.
- Perfect malware detection. This is triage, not a proof of safety.
- Deep binary analysis. Large/binary files are flagged for manual review.
- Full npm CLI auth edge cases around staged publish permissions.

## Verdict: PARTIAL

### What worked

- The Cloudflare architecture is viable if we treat staged download as a registry tarball fetch inside a Dynamic Worker.
- Dynamic Worker egress control is the right trust boundary: block default egress and route only the npm staged tarball request through a parent-owned gateway.
- Prompt-injection resistance is mostly an application discipline: deterministic findings first, hostile-file framing, bounded JSON input, schema output, and no AI authority to approve.

### What didn't

- The literal npm CLI command cannot run in a Worker runtime.

### Recommendation for the real build

- Build the Cloudflare service around the fetch-equivalent staged tarball endpoint.
- Add R2 storage for tarball + scan artifacts, Queue-based async scans, and a signed review URL for maintainers.
- Keep final `npm stage approve <stage-id>` out of automation; it should remain a maintainer 2FA step.
