import { isRecord } from "./shape";
import { createDb } from "../../db/store";
import type { Env } from "../../bindings";
export { createDb as reexported } from "../../db/store";
export * from "../../db/store";
const lazy = () => import("../../db/store");

export function leaky(env: Env): boolean {
  void createDb();
  void lazy;
  return isRecord(env);
}
