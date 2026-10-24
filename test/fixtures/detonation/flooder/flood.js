// SIMULATED trace flooder for the Drydock detonation sandbox: thousands of
// harmless scratch files meant to push a later credential read out of the
// harness's event budget. It only writes under /tmp.
const fs = require("node:fs");

for (let index = 0; index < 3000; index += 1) {
  fs.writeFileSync(`/tmp/drydock-flood-${index}`, "x");
}
