import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Plant fake credentials in a throwaway HOME. Each carries a unique token, so
// if that token later shows up in an egress body or a subprocess argument we
// know the package both *read* the credential and *exfiltrated* it — the two
// halves of a credential-theft attack, tied together by the token.
export async function plantCanaries(homeDir) {
  const tokens = {
    npm: `drydock-canary-npm-${randomUUID()}`,
    aws: `drydock-canary-aws-${randomUUID()}`,
    ssh: `drydock-canary-ssh-${randomUUID()}`,
    env: `drydock-canary-env-${randomUUID()}`,
  };

  const files = [
    {
      relPath: ".npmrc",
      content: `//registry.npmjs.org/:_authToken=${tokens.npm}\n`,
    },
    {
      relPath: path.join(".aws", "credentials"),
      content: `[default]\naws_access_key_id=AKIA_DRYDOCK\naws_secret_access_key=${tokens.aws}\n`,
    },
    {
      relPath: path.join(".ssh", "id_rsa"),
      content: `-----BEGIN OPENSSH PRIVATE KEY-----\n${tokens.ssh}\n-----END OPENSSH PRIVATE KEY-----\n`,
    },
    {
      relPath: ".env",
      content: `API_SECRET=${tokens.env}\n`,
    },
  ];

  const paths = [];
  for (const file of files) {
    const absolute = path.join(homeDir, file.relPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, { mode: 0o600 });
    paths.push(absolute);
  }

  return { tokens: Object.values(tokens), paths };
}
