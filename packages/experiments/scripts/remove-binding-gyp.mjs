import { rm } from "node:fs/promises";

await rm(new URL("../binding.gyp", import.meta.url), { force: true });
