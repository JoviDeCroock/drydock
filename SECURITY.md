# Security policy

Drydock reviews untrusted package artifacts, so its own security posture matters
as much as the findings it produces. The non-negotiable boundaries — package
bytes are untrusted evidence, deterministic findings are authoritative, and
`NpmStageGateway` is the only credentialed egress — are documented in
[`docs/security-model.md`](docs/security-model.md). If you find a way to cross
one of those boundaries, we want to hear about it.

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for security
reports.** Disclose privately so we can fix the issue before it is public:

- Preferred: [GitHub private vulnerability reporting](https://github.com/JoviDeCroock/drydock/security/advisories/new)
  (Security → Report a vulnerability).
- Email: **drydock@drydock.org** with the subject line `Drydock security report`.

Include enough detail to reproduce:

- A description of the issue and the impact you believe it has.
- Step-by-step reproduction (a minimal package fixture or `curl` sequence is ideal).
- Affected component (sandbox, npm credential forwarding, auth/session, workflow
  gate webhook, AI reviewer, etc.) and commit/branch if known.

Please give us a reasonable window to remediate before any public disclosure.

## What to expect

- Acknowledgement of your report within **3 business days**.
- An initial assessment (severity, affected versions, planned fix) within **7
  business days**.
- Credit in the fix's release notes if you'd like it — let us know how you wish
  to be attributed.

## Scope

In scope:

- This repository's code (the Worker, the Dynamic Worker sandbox, auth, the
  GitHub/Slack integrations, and persistence).
- Anything that lets untrusted package contents read credentials, reach
  uncredentialed egress, escalate privileges, or downgrade deterministic
  findings.

Out of scope:

- Vulnerabilities in upstream dependencies with no Drydock-specific exploit path
  (report those upstream; we still appreciate a heads-up).
- Findings that require a self-hoster to misconfigure their own deployment (for
  example, committing real secrets to a fork, or pointing a binding at an
  attacker-controlled resource). See [`docs/self-hosting.md`](docs/self-hosting.md)
  for the intended configuration.

## Supported versions

Drydock is deployed continuously from `main`; security fixes land there. There
is no long-term support branch — please test against the latest `main` before
reporting.
