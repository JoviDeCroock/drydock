import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import net from "node:net";
import { buildDockerArgs, detonateLocal, fixtureDir } from "../src/harness.mjs";
import { buildBehaviors, verdictFor } from "../src/report.mjs";

// Guard the whole suite: if any egress reaches a non-loopback address during a
// detonation, the containment promise is broken. We stub net.connect at the
// test level to assert nothing external is ever dialed.
let externalConnects = [];
const realConnect = net.Socket.prototype.connect;
before(() => {
  net.Socket.prototype.connect = function guarded(...args) {
    const opts = args[0];
    const host = opts && typeof opts === "object" ? opts.host : args[1];
    if (host && !["127.0.0.1", "localhost", "::1"].includes(String(host))) {
      externalConnects.push(String(host));
    }
    return realConnect.apply(this, args);
  };
});
after(() => {
  net.Socket.prototype.connect = realConnect;
});

test("detonating the benign-suspicious fixture surfaces the attack behaviors", async () => {
  externalConnects = [];
  const report = await detonateLocal({ packageDir: fixtureDir("benign-suspicious") });

  assert.equal(report.schema, "drydock.detonation.v1");
  assert.equal(report.package.name, "benign-suspicious");
  assert.equal(report.verdict, "critical");

  const rules = new Set(report.behaviors.map((b) => b.ruleId));
  assert.ok(rules.has("detonation.credential-access"), "reads the ~/.npmrc canary");
  assert.ok(rules.has("detonation.credential-exfil"), "exfiltrates the canary token");
  assert.ok(rules.has("detonation.fs-persistence"), "writes a home-dir persistence file");
  assert.ok(rules.has("detonation.suspicious-spawn"), "shells out to curl");

  // The exfil finding is the highest-signal one: it proves the canary was both
  // read and sent off-host (caught by the loopback sink and/or the curl shim).
  const exfil = report.findings.find((f) => f.ruleId === "detonation.credential-exfil");
  assert.ok(exfil, "credential exfiltration finding present");
  assert.equal(exfil.severity, "critical");

  // Containment: the harness never let the payload reach a real host.
  assert.deepEqual(externalConnects, [], "no external network egress escaped the harness");
});

test("detonating the clean fixture reports no suspicious behavior", async () => {
  externalConnects = [];
  const report = await detonateLocal({ packageDir: fixtureDir("clean") });

  assert.equal(report.package.name, "clean-package");
  assert.equal(report.verdict, "clean");
  const suspicious = report.behaviors.filter((b) => b.severity !== "info" && b.severity !== "low");
  assert.deepEqual(
    suspicious,
    [],
    `clean package must not raise medium+ behaviors, got: ${JSON.stringify(suspicious)}`,
  );
  assert.deepEqual(externalConnects, []);
});

test("buildBehaviors dedupes repeats and ranks by severity", () => {
  const behaviors = buildBehaviors([
    { type: "process.spawn", command: "/bin/env", args: [] },
    { type: "process.spawn", command: "/bin/env", args: [] },
    { type: "credential.read", path: "/home/x/.npmrc" },
    { type: "fs.write.outside", path: "/home/x/.evil" },
  ]);
  assert.equal(behaviors[0].severity, "high", "credential.read outranks the spawn/write");
  const spawn = behaviors.find((b) => b.ruleId === "detonation.process-spawn");
  assert.equal(spawn.count, 2, "identical spawns collapse into one behavior with a count");
});

test("verdictFor escalates to the worst behavior severity", () => {
  assert.equal(verdictFor([]), "clean");
  assert.equal(verdictFor([{ severity: "low" }]), "low");
  assert.equal(verdictFor([{ severity: "low" }, { severity: "critical" }]), "critical");
});

test("buildDockerArgs pins the hardened isolation flags", () => {
  const args = buildDockerArgs({ packageDir: "/tmp/pkg", outDir: "/tmp/out" });
  const joined = args.join(" ");
  assert.match(joined, /--network none/);
  assert.match(joined, /--read-only/);
  assert.match(joined, /--cap-drop ALL/);
  assert.match(joined, /--security-opt no-new-privileges/);
  assert.match(joined, /--user 1000:1000/);
  assert.match(joined, /:\/pkg:ro/, "package is mounted read-only");
});
