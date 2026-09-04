import { dependencyDeclarationKey } from "../../server/lib/review/dependency-evidence";
import type { DependencySection } from "../../server/lib/review/serialize";

export interface DependencyEvidenceCoordinate {
  name: string;
  section: DependencySection;
  declaredSpec: string;
}

export function dependencyEvidenceDomId(coordinate: DependencyEvidenceCoordinate): string {
  return `dep-evidence-${encodeURIComponent(
    dependencyDeclarationKey(coordinate.name, coordinate.section, coordinate.declaredSpec),
  )}`;
}
