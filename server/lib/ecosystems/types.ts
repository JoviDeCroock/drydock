import type { AdapterBroker, PackageAdapter } from "./package-adapter";
import type { WorkflowGateAdapter } from "../workflow-gates/types";
import type { PublicDiffAdapter } from "../public-diff/types";
import type { PublishedPairAdapter } from "./published-pair";
import type { EcosystemId } from "./labels";

/** Every ecosystem Drydock knows about. Matches persisted `ecosystem` columns. */
export type { EcosystemId } from "./labels";

/**
 * One ecosystem, and which of Drydock's three release paths it supports.
 *
 * Before this existed the same three ecosystems were declared in three separate
 * places — a `PackageAdapter` for the scan pipeline, a `WorkflowGateAdapter` in
 * its own registry, and hand-rolled `ecosystem === "pypi"` branches in the
 * public-diff orchestrator — so "does VS Code support staged publishes?" could
 * only be answered by reading all three. Here the answer is the presence or
 * absence of a field, and adding an ecosystem means writing one directory.
 *
 * Capabilities are intentionally optional and independent:
 *
 *  - `staged` — the registry can hold a private release candidate that Drydock
 *    reviews before the maintainer approves it (npm `stage publish`). Absent for
 *    registries with no staging concept.
 *  - `gate` — a GitHub Actions publish job is held by an Environment
 *    deployment-protection rule while Drydock reviews the built artifacts.
 *  - `publicDiff` — two published versions can be diffed anonymously on `/diff`
 *    with no credentials and nothing persisted.
 *  - `published` — the authenticated pipeline reviews two published versions
 *    and persists the result, so an organization reaches a first review with no
 *    registry credential and nothing to wait for. Built on `publicDiff`, and
 *    declared separately because reviewing an ecosystem's public releases
 *    under an organization is a deliberate product decision, not a free
 *    consequence of `/diff` supporting it.
 */
export interface EcosystemModule {
  readonly id: EcosystemId;
  /** Human-facing name used in UI copy and report sections. */
  readonly label: string;
  readonly staged?: PackageAdapter<never, AdapterBroker>;
  readonly gate?: WorkflowGateAdapter;
  readonly publicDiff?: PublicDiffAdapter;
  readonly published?: PublishedPairAdapter;
}
