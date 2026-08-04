# Incident content playbook

What to publish when a public supply-chain compromise breaks, and — more importantly — what not to.

The reach window for this content is roughly 24–48 hours. That is not enough time to decide policy under pressure, so the decisions are made here in advance: the hard rules below, the templates in [`../scripts/incident-post.mjs`](../scripts/incident-post.mjs), and a link check that runs before anything goes out.

## Hard rules

These are not style preferences. Breaking one of them costs more trust than any single post can earn.

1. **Confirmed public incidents only.** A named package, a disclosed compromise, a public advisory or maintainer statement. Never a live maintainer's release on suspicion, and never "this looks sketchy" about someone's package. The first viral moment must not be a maintainer being publicly accused by a tool that reviews maintainers' work.
2. **Describe the diff, not the intent.** The diff proves that bytes changed. It does not prove who changed them or why. Write "the release added X"; do not write "the attacker deliberately Y". Attribution belongs to the people running the actual investigation.
3. **Name the package, never a person.** A compromised maintainer is the victim of the incident, not its cause. No usernames, no "they should have used 2FA".
4. **Verify the link resolves first.** npm unpublishes malicious versions, often within hours. `scripts/incident-post.mjs` refuses to print a post when either version is gone. A post whose link 404s reads as opportunistic and cannot be quietly fixed after sharing.
5. **Never claim we found it first** unless we did, with a scan timestamp to back it. "Here is the diff" is the claim. "We caught this" is a different claim and usually a false one.
6. **No payload amplification.** Link the diff; do not paste the deobfuscated payload, the exfil endpoint, or anything that shortens the path to reuse. The diff view is enough to make the point.
7. **No AI output in incident content.** The public diff runs deterministic rules only, on purpose — determinism _is_ the message. Quoting a model's opinion about a live incident undercuts that and invites an argument about the model instead of the bytes.
8. **Correct in public, do not delete.** The correction template exists because the moment you need it is the moment you are least able to write it well.

## The loop

| When     | Do                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| T+0      | Confirm it is real: advisory, maintainer statement, or registry action. Nothing goes out on a rumor.                       |
| T+10     | Open the diff on drydock.org. Read it yourself. If the change is not legible in the diff, this is not our story — skip it. |
| T+15     | Run `pnpm incident:post` to verify both versions resolve and fill the copy.                                                |
| T+20     | Screenshot the diff hunk that shows the change. The image is the ad; the link is the proof.                                |
| T+30     | Post to Bluesky and X — `breaking` then `whatToDo` in one thread.                                                          |
| T+24–48h | LinkedIn `analysis` post: what changed, why it was reviewable, what provenance does and does not answer.                   |
| T+1 week | Check the channel counters. Which channel actually sent people to the diff?                                                |

The order matters. Bluesky and X are where the incident thread is alive on day one; LinkedIn rewards the considered write-up two days later, when the news cycle has moved and the analysis is the only thing left worth reading.

## Using the script

```bash
pnpm incident:post \
  --package chalk --from 5.6.0 --to 5.6.1 \
  --vector "a postinstall script that posts environment variables to a remote host" \
  --consequence "Anything the build host could reach should be treated as exposed."
```

It checks the registry, prints the diff URL, and emits per-channel copy with a character count against each channel's limit. Add `--ecosystem pypi` for PyPI, `--template provenance` when the compromised release passed provenance or 2FA, and `--template correction --claim … --correction …` when we get something wrong.

If a version has been pulled, the script exits without printing and lists the surviving versions, so the post can be rebuilt around a pair that still resolves — usually the last clean version against the maintainer's remediation release.

## Templates and when they apply

| Template      | Channel    | Use when                                                                                                                                                 |
| ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `breaking`    | Bluesky, X | First post. States what the release added and links the diff.                                                                                            |
| `whatToDo`    | Bluesky, X | Second post in the thread. What a reader with this package in a lockfile should do now.                                                                  |
| `provenance`  | any        | The compromised release had valid provenance, a signed pipeline, or 2FA. The strongest argument we have: provenance attests the pipeline, not the bytes. |
| `analysis`    | LinkedIn   | T+24–48h long form. Analysis first, product mentioned once at the end.                                                                                   |
| `unpublished` | any        | The registry already pulled the malicious version. Talk about the gap, link a pair that still resolves.                                                  |
| `correction`  | any        | We got something wrong.                                                                                                                                  |

## What makes a good incident post

The differentiator is the artifact, not the take. Every other account posting about a compromise is summarizing an advisory; the diff is a thing only we can show, so the post should be mostly diff and barely commentary.

Concretely:

- Lead with the change, not with the product. "`chalk` 5.6.1 added a postinstall script that is not in 5.6.0" is the story. "Drydock detected…" is not.
- One screenshot of the actual hunk. Not a dashboard, not a findings list — the lines that changed.
- Say what a reader should do. A post that only alarms is noise; a post that ends in "pin back to X and rotate Y" is useful.
- Mention "no account required" once so readers know the public diff opens immediately.

## Frequency

The incident engine is reactive and cannot be scheduled — real compromises are the only input, and manufacturing urgency between them is exactly how this becomes noise. Two or three genuine incidents a quarter is a healthy rate for this channel. If a month passes with nothing, that is the correct output.

## Measuring it

The `marketing_page.viewed` Analytics Engine event answers whether a post worked: views on the `diff` surface, grouped by `source`, on the day of the post and the day after. Filter `source != 'bot'` — crawler fetches scale with how many platforms a link was posted to, not with interest. The `bot` count is still worth a glance as confirmation the unfurl actually happened on each platform.
