import { isRecord } from "../platform/shape";
import { createDb } from "../../db/store";

export function job(): boolean {
  return isRecord(createDb());
}
