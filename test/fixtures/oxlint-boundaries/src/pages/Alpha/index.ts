// Five violations: static import, bare page-directory import, re-export,
// star re-export, and a literal dynamic import — all reaching into Beta/.
import { thing } from "../Beta/thing";
import { beta } from "../Beta";
export { thing2 } from "../Beta/thing";
export * from "../Beta/lazy";
export const loadLazy = () => import("../Beta/lazy");

// Allowed: same-page, pages-root shared file, and a shared feature.
import { local } from "./local";
import { sharedRoot } from "../SharedRoot";
import { shared } from "../../features/shared";

export const alpha = [thing, beta, local, sharedRoot, shared].join(",");
