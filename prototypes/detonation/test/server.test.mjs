import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { c as createTar } from "tar";
import { createDetonationServer } from "../src/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function fixtureArchive(name, entries) {
  const dir = path.join(HERE, "..", "fixtures", name);
  const stream = createTar(
    { cwd: dir, gzip: true, portable: true, prefix: "package/" },
    entries || ["package.json", ...lifecycleFiles(dir)],
  );
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function lifecycleFiles(dir) {
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  return Object.values(manifest.scripts || {})
    .map((script) => /node\s+([\w.-]+\.js)/.exec(script)?.[1])
    .filter(Boolean);
}

let server;
let base;
before(async () => {
  server = createDetonationServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function postDetonate(archive) {
  const res = await fetch(`${base}/detonate`, {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: archive,
  });
  return { status: res.status, body: await res.json() };
}

test("GET /health returns ok", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /detonate runs the suspicious fixture and returns a critical report", async () => {
  const { status, body } = await postDetonate(await fixtureArchive("benign-suspicious"));
  assert.equal(status, 200);
  assert.equal(body.schema, "drydock.detonation.v1");
  assert.equal(body.verdict, "critical");
  const rules = new Set(body.findings.map((f) => f.ruleId));
  assert.ok(rules.has("detonation.credential-exfil"));
});

test("POST /detonate reports the clean fixture as clean", async () => {
  const { status, body } = await postDetonate(await fixtureArchive("clean"));
  assert.equal(status, 200);
  assert.equal(body.verdict, "clean");
});

test("rejects an archive without package.json", async () => {
  const { status } = await postDetonate(await fixtureArchive("clean", ["build.js"]));
  assert.equal(status, 500);
});

test("rejects a malformed package archive", async () => {
  const { status } = await postDetonate(Buffer.from("not a tarball"));
  assert.equal(status, 500);
});
