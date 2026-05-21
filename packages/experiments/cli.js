#!/usr/bin/env node
import { listExperiments, packageName } from "./index.js";

const rows = listExperiments()
  .map((experiment) => `- ${experiment.name}: ${experiment.enabled ? "on" : "off"}`)
  .join("\n");

console.log(packageName);
console.log(rows);
