# Product analytics

Drydock records product analytics through PostHog Cloud's EU ingestion endpoint:

```text
https://eu.i.posthog.com
```

Enable tracking by setting `VITE_POSTHOG_KEY` in the build environment. The key is a public PostHog project key that is bundled into the client; do not use a personal or secret API key.

The client disables autocapture and session recording. Only explicit, product-level events are sent:

- SPA page views.
- Authentication milestones.
- Dashboard and settings workspace load events.
- Organization switching and creation.
- npm connection save, validation, and removal.
- Staged publish discovery start, completion, and failure.
- Scan comparison selection and publish/block decisions.
- Workflow gate decisions.

Event properties intentionally avoid package contents, tokens, email addresses, names, and raw errors.
