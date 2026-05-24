import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node ./scripts/with-implicit-node-gyp.mjs <npm-command> [...args]");
  process.exit(1);
}

const bindingGypUrl = new URL("../binding.gyp", import.meta.url);
const bindingGyp = `{
  "targets": [
    {
      "target_name": "drydock_implicit_node_gyp_probe",
      "sources": []
    }
  ]
}
`;

await writeFile(bindingGypUrl, bindingGyp);
try {
  const code = await run(process.platform === "win32" ? "npm.cmd" : "npm", args);
  process.exitCode = code;
} finally {
  await rm(bindingGypUrl, { force: true });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
