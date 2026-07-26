// Fills the incident-response post templates for a confirmed public
// supply-chain compromise, and — more importantly — checks the diff link
// actually resolves before anyone posts it.
//
// That check is the whole reason this is a script and not a snippet in a doc.
// npm unpublishes malicious versions, often within hours of disclosure, which is
// exactly the window this content targets. A post whose link 404s is worse than
// no post: it reads as opportunistic and it cannot be quietly fixed once it has
// been shared.
//
// Templates live here rather than in the playbook so there is one copy of the
// wording. docs/incident-content-playbook.md explains when and why to send them.

import { parseArgs } from "node:util";

export const CHANNELS = ["bluesky", "x", "linkedin"];

// Bluesky counts graphemes, X counts a weighted length that is close enough to
// code points for copy this short. Both are advisory: the script reports an
// overflow, it does not silently truncate someone's post.
const CHANNEL_LIMITS = { bluesky: 300, x: 280, linkedin: 3000 };

const REGISTRY = {
  npm: {
    metadataUrl: (pkg) =>
      `https://registry.npmjs.org/${encodeURIComponent(pkg).replace(/^%40/, "@")}`,
    listVersions: (body) => Object.keys(body?.versions ?? {}),
  },
  pypi: {
    metadataUrl: (pkg) => `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`,
    listVersions: (body) => Object.keys(body?.releases ?? {}),
  },
};

// Mirrors packageDiffPath() in src/lib/package-diff-path.ts. This file is plain
// ESM so it can run with bare `node`, and test/incident-post.test.mjs asserts
// the two stay in agreement rather than trusting the duplication.
export function diffUrl({
  ecosystem = "npm",
  packageName,
  fromVersion,
  toVersion,
  origin = "https://drydock.org",
}) {
  const encodedName = packageName
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/^%40/, "@"))
    .join("/");
  const prefix = ecosystem === "pypi" ? "/diff/pypi" : "/diff";
  const path = `${prefix}/${encodedName}/${encodeURIComponent(fromVersion)}/${encodeURIComponent(toVersion)}`;
  return `${origin}${path}`;
}

export async function fetchPublishedVersions({
  ecosystem = "npm",
  packageName,
  fetchImpl = fetch,
}) {
  const registry = REGISTRY[ecosystem];
  if (!registry) throw new Error(`unknown ecosystem: ${ecosystem}`);
  const response = await fetchImpl(registry.metadataUrl(packageName), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`registry metadata for ${packageName} returned ${response.status}`);
  }
  return registry.listVersions(await response.json());
}

// The compromised version is the one most likely to be gone. Suggest the
// surviving neighbours so the post can still show a real diff — usually the last
// clean version against whatever the maintainer shipped as the remediation.
export function checkVersionsSurvive({ published, fromVersion, toVersion }) {
  const available = new Set(published);
  const missing = [fromVersion, toVersion].filter((version) => !available.has(version));
  return {
    ok: missing.length === 0,
    missing,
    // Registry order is publish order for npm; keep it rather than sorting by
    // semver, so "the versions either side of the gap" stays meaningful for
    // prereleases and PEP 440 alike.
    nearest: published.slice(-6),
  };
}

function truthy(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function req(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (!truthy(value)) throw new Error(`missing required field: ${name}`);
  }
}

// Every template states only what the diff shows. Intent, attribution, and blast
// radius are claims the diff cannot support, so they are not in the wording —
// see the hard rules in docs/incident-content-playbook.md.
export const TEMPLATES = {
  // T+30min. The one that has to go out while the thread is still alive.
  breaking: ({ packageName, fromVersion, toVersion, vector, url }) => {
    req({ packageName, fromVersion, toVersion, vector, url });
    return [
      `${packageName} ${toVersion} added ${vector}. It is not in ${fromVersion}.`,
      ``,
      `Here is the diff. No login, no token, nothing installed:`,
      url,
    ].join("\n");
  },

  // T+30min, second post in the same thread. What a reader should do now.
  whatToDo: ({ packageName, safeVersion, url }) => {
    req({ packageName, safeVersion, url });
    return [
      `If you have ${packageName} in a lockfile, pin back to ${safeVersion} and rotate anything the build host could reach.`,
      ``,
      `The diff shows exactly which files changed, so you can check whether the version you shipped is affected: ${url}`,
    ].join("\n");
  },

  // For compromises that passed provenance, 2FA, or a signed pipeline. The
  // strongest argument we have, and the least intuitive one.
  provenance: ({ packageName, toVersion, attestation, url }) => {
    req({ packageName, toVersion, attestation, url });
    return [
      `${packageName} ${toVersion} had ${attestation}. The pipeline was authentic. The bytes were not.`,
      ``,
      `Provenance answers "did this come from the right pipeline". It does not answer "what is in it". Different questions.`,
      ``,
      url,
    ].join("\n");
  },

  // T+24-48h, long form. Analysis, not product pitch.
  analysis: ({ packageName, fromVersion, toVersion, vector, consequence, url }) => {
    req({ packageName, fromVersion, toVersion, vector, consequence, url });
    return [
      `${packageName} ${fromVersion} → ${toVersion}: what actually changed`,
      ``,
      `The compromised release added ${vector}. ${consequence}`,
      ``,
      `The part worth sitting with: this was reviewable. The change is visible in a file-by-file diff of the two published tarballs, and it took seconds to find once someone looked. Almost nobody looks, because until recently there was nowhere to look — package managers show you a version number and a changelog, not the bytes.`,
      ``,
      `Diff, if you want to read it yourself: ${url}`,
      ``,
      `Free, no account. It is the same review Drydock runs before a publish goes out, pointed at two versions that are already public.`,
    ].join("\n");
  },

  // When npm has already pulled the malicious version. Very common, and the
  // reason to check before posting rather than after.
  unpublished: ({ packageName, badVersion, fromVersion, toVersion, url }) => {
    req({ packageName, badVersion, fromVersion, toVersion, url });
    return [
      `${packageName} ${badVersion} has been unpublished, so the malicious bytes are no longer fetchable — which also means nobody can independently check what shipped.`,
      ``,
      `What is still readable is ${fromVersion} → ${toVersion}: ${url}`,
    ].join("\n");
  },

  // If we get something wrong. Pre-written on purpose: the moment you need this
  // is the moment you are least able to write it well.
  correction: ({ claim, correction, url }) => {
    req({ claim, correction, url });
    return [
      `Correction to my earlier post: I said ${claim}. That is wrong — ${correction}.`,
      ``,
      `The diff is public either way, so you do not have to take my word for it: ${url}`,
      ``,
      `Leaving the original up rather than deleting it.`,
    ].join("\n");
  },
};

export const CHANNEL_TEMPLATES = {
  bluesky: ["breaking", "whatToDo"],
  x: ["breaking", "whatToDo"],
  linkedin: ["analysis"],
};

export function renderPost(templateName, fields) {
  const template = TEMPLATES[templateName];
  if (!template) throw new Error(`unknown template: ${templateName}`);
  return template(fields);
}

export function measure(text, channel) {
  const length = [...text].length;
  const limit = CHANNEL_LIMITS[channel];
  return { length, limit, overflow: limit ? Math.max(0, length - limit) : 0 };
}

function usage() {
  return `Usage: node scripts/incident-post.mjs --package <name> --from <version> --to <version> [options]

Required:
  --package <name>        Package or project name
  --from <version>        Last known-clean version (the diff's left side)
  --to <version>          Compromised or remediation version (right side)

Content:
  --vector <text>         What the release added, in the diff's own terms
                          (e.g. "a postinstall script that posts env to a remote host")
  --consequence <text>    One sentence of impact, for the long-form post
  --attestation <text>    If it passed provenance/2FA, name it (e.g. "valid SLSA provenance")
  --safe-version <ver>    Version to pin back to (defaults to --from)
  --claim / --correction  Fill the correction template instead

Options:
  --ecosystem npm|pypi    Default npm
  --template <name>       ${Object.keys(TEMPLATES).join(", ")}
  --channel <name>        ${CHANNELS.join(", ")}, or all (default all)
  --origin <url>          Default https://drydock.org
  --no-verify             Skip the registry check (offline; not for real posts)
`;
}

export async function main(
  argv,
  { fetchImpl = fetch, log = console.log, warn = console.warn } = {},
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      package: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      vector: { type: "string" },
      consequence: { type: "string" },
      attestation: { type: "string" },
      "safe-version": { type: "string" },
      claim: { type: "string" },
      correction: { type: "string" },
      ecosystem: { type: "string", default: "npm" },
      template: { type: "string" },
      channel: { type: "string", default: "all" },
      origin: { type: "string", default: "https://drydock.org" },
      verify: { type: "boolean", default: true },
      help: { type: "boolean", default: false },
    },
    allowNegative: true,
  });

  if (values.help || !values.package || !values.from || !values.to) {
    log(usage());
    return values.help ? 0 : 1;
  }

  const spec = {
    ecosystem: values.ecosystem,
    packageName: values.package,
    fromVersion: values.from,
    toVersion: values.to,
    origin: values.origin,
  };
  const url = diffUrl(spec);

  let verified = false;
  if (values.verify) {
    try {
      const published = await fetchPublishedVersions({ ...spec, fetchImpl });
      const check = checkVersionsSurvive({
        published,
        fromVersion: values.from,
        toVersion: values.to,
      });
      if (check.ok) {
        verified = true;
      } else {
        warn(`
!! ${check.missing.join(" and ")} ${check.missing.length > 1 ? "are" : "is"} not published.

   The registry has probably pulled the compromised release. Do not post this
   link — it will 404 for everyone who clicks it.

   Most recent surviving versions: ${check.nearest.join(", ")}

   Pick a pair from those, or use --template unpublished to post about the gap.
`);
        return 2;
      }
    } catch (err) {
      warn(`!! could not verify versions against the registry: ${err.message}`);
      warn("   Check the link by hand before posting.\n");
    }
  }

  const fields = {
    ...spec,
    vector: values.vector,
    consequence: values.consequence,
    attestation: values.attestation,
    safeVersion: values["safe-version"] ?? values.from,
    badVersion: values.to,
    claim: values.claim,
    correction: values.correction,
    url,
  };

  log(`diff: ${url}${verified ? "  (both versions resolve)" : "  (UNVERIFIED)"}\n`);

  const channels = values.channel === "all" ? CHANNELS : [values.channel];
  for (const channel of channels) {
    if (!CHANNELS.includes(channel)) {
      warn(`unknown channel: ${channel}`);
      return 1;
    }
    const templateNames = values.template ? [values.template] : CHANNEL_TEMPLATES[channel];
    log(`── ${channel} ${"─".repeat(Math.max(0, 60 - channel.length))}`);
    for (const name of templateNames) {
      let text;
      try {
        text = renderPost(name, fields);
      } catch (err) {
        log(`  [${name}] skipped: ${err.message}`);
        continue;
      }
      const { length, limit, overflow } = measure(text, channel);
      log(`\n[${name}]  ${length}/${limit}${overflow ? `  OVER BY ${overflow}` : ""}\n`);
      log(text);
      log("");
    }
  }

  log(`Screenshot the diff before posting — the image is the ad, the link is the proof.`);
  return 0;
}

// Only run when invoked directly, so the pure helpers above stay importable.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
