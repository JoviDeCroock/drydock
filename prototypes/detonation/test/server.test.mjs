import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createDetonationServer } from "../src/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fixtureFiles(name) {
  const dir = path.join(HERE, "..", "fixtures", name);
  const files = { "package.json": readFileSync(path.join(dir, "package.json"), "utf8") };
  const manifest = JSON.parse(files["package.json"]);
  // Pull the lifecycle script file(s) referenced by the manifest.
  for (const script of Object.values(manifest.scripts || {})) {
    const match = /node\s+([\w.-]+\.js)/.exec(script);
    if (match) files[match[1]] = readFileSync(path.join(dir, match[1]), "utf8");
  }
  return files;
}

let server;
let base;
before(async () => {
  server = createDetonationServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function postDetonate(body) {
  const res = await fetch(`${base}/detonate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("GET /health returns ok", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /detonate runs the suspicious fixture and returns a critical report", async () => {
  const { status, body } = await postDetonate({
    package: { name: "benign-suspicious", files: fixtureFiles("benign-suspicious") },
  });
  assert.equal(status, 200);
  assert.equal(body.schema, "drydock.detonation.v1");
  assert.equal(body.verdict, "critical");
  const rules = new Set(body.findings.map((f) => f.ruleId));
  assert.ok(rules.has("detonation.credential-exfil"));
});

test("POST /detonate reports the clean fixture as clean", async () => {
  const { status, body } = await postDetonate({
    package: { name: "clean", files: fixtureFiles("clean") },
  });
  assert.equal(status, 200);
  assert.equal(body.verdict, "clean");
});

test("rejects a body without package.json", async () => {
  const { status } = await postDetonate({ package: { files: { "index.js": "1" } } });
  assert.equal(status, 400);
});

test("path-traversal entries in the file map are dropped, not written", async () => {
  // The escaping entry must be ignored; package.json still present so it runs.
  const { status, body } = await postDetonate({
    package: {
      files: {
        "package.json": JSON.stringify({ name: "trav", version: "1.0.0" }),
        "../escape.js": "require('fs').writeFileSync('/tmp/DETONATION_ESCAPE','x')",
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.verdict, "clean");
  assert.equal(
    readFileSyncSafe("/tmp/DETONATION_ESCAPE"),
    null,
    "traversal file must not have been written outside the input dir",
  );
});

function readFileSyncSafe(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
