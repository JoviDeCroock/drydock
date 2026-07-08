// A normal, well-behaved postinstall: it writes a build artifact into the
// package's own directory and does nothing else. No network, no credential
// access, no out-of-workdir writes. The detonation harness should report this
// as clean.

const fs = require("node:fs");
const path = require("node:path");

const outDir = path.join(__dirname, "build");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "output.txt"), "built ok\n");
