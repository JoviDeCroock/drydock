import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

export interface WorkspaceSession {
  userId: string;
  email?: string;
  name?: string;
}

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
