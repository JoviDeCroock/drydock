# Security Policy

Drydock handles untrusted package artifacts and sensitive release credentials.
Please report suspected vulnerabilities privately.

## Supported versions

This repository currently tracks security fixes on the default branch. If release
branches or tagged versions are introduced, this policy should be updated with
the supported range.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow for this repository if it is
enabled. If it is not enabled yet, contact the maintainers through a private
project channel and include `SECURITY` in the subject.

Please include:

- affected commit, branch, or deployed instance if known;
- steps to reproduce;
- expected and observed behavior;
- impact and likely attacker capabilities;
- any logs or screenshots with secrets removed.

Do not include live tokens, private package contents, user data, or exploit
payloads that could harm third parties. Use synthetic examples when possible.

## Scope

High-priority issues include:

- npm, GitHub, Slack, Better Auth, or Cloudflare credential exposure;
- sandbox escape or unintended outbound network access from package parsing;
- cross-organization scan, report, artifact, or decision access;
- package-provided active content rendered in the browser;
- deterministic findings or gate decisions that can be bypassed by malformed
  archives or untrusted metadata;
- logs, errors, notifications, exports, or AI inputs leaking secrets or raw
  package evidence.

Out of scope unless they show a concrete project vulnerability:

- denial-of-service reports that require unrealistic resource access;
- findings only affecting a local developer's intentionally insecure setup;
- dependency advisories with no reachable project impact;
- social engineering against maintainers or users.

## Disclosure

Maintainers will acknowledge reports when received, investigate privately, and
coordinate a fix and disclosure timeline based on severity. Please do not publish
details until maintainers have had a reasonable chance to ship a fix.
