import { writeFile } from "node:fs/promises";

const bindingGyp = `{
  "targets": [
    {
      "target_name": "drydock_implicit_node_gyp_probe",
      "sources": []
    }
  ]
}
`;

await writeFile(new URL("../binding.gyp", import.meta.url), bindingGyp);
