import { describe, expect, test } from "vitest";
import {
  registryStatusBadge,
  registryStatusVariant,
} from "../src/pages/Dashboard/ScanDetail/RegistryStatusNotice";

describe("registry status variant", () => {
  test("npm blocking a version is its own signal, whatever we decided", () => {
    expect(registryStatusVariant({ registryVersionStatus: "blocked" })).toBe("blocked");
    expect(registryStatusVariant({ registryVersionStatus: "blocked", decision: "publish" })).toBe(
      "blocked",
    );
  });

  test("staged is silent until we have approved it", () => {
    // The normal resting state of a release under review. Announcing it on the
    // page reached from the staged list is noise.
    expect(registryStatusVariant({ registryVersionStatus: "staged" })).toBe(null);
    expect(registryStatusVariant({ registryVersionStatus: "staged", decision: "no_publish" })).toBe(
      null,
    );
    expect(registryStatusVariant({ registryVersionStatus: "staged", decision: "publish" })).toBe(
      "awaiting_approval",
    );
  });

  test("an unresolved lookup says nothing at all", () => {
    // npm answers 404 for an unknown version and an unauthorized one alike, so
    // a missing status must never render as reassurance or alarm.
    expect(registryStatusVariant({})).toBe(null);
    expect(registryStatusVariant({ registryVersionStatus: null })).toBe(null);
    expect(registryStatusVariant({ registryVersionStatus: null, decision: "publish" })).toBe(null);
    expect(registryStatusVariant({ registryVersionStatus: "" })).toBe(null);
  });

  test("a status npm has not documented is not guessed at", () => {
    expect(registryStatusVariant({ registryVersionStatus: "quarantined" })).toBe(null);
  });

  test("maps the remaining lifecycle states", () => {
    expect(registryStatusVariant({ registryVersionStatus: "validating" })).toBe("validating");
    expect(registryStatusVariant({ registryVersionStatus: "published" })).toBe("published");
    expect(registryStatusVariant({ registryVersionStatus: "deleted" })).toBe("withdrawn");
  });
});

describe("registry status badge", () => {
  test("names npm in every label, so it is never read as our verdict", () => {
    for (const status of ["blocked", "validating", "published", "deleted"]) {
      const badge = registryStatusBadge({ registryVersionStatus: status });
      expect(badge?.label).toMatch(/^npm /);
    }
    expect(
      registryStatusBadge({ registryVersionStatus: "staged", decision: "publish" })?.label,
    ).toMatch(/^npm /);
  });

  test("blocked is the only critical tone", () => {
    expect(registryStatusBadge({ registryVersionStatus: "blocked" })?.tone).toBe("critical");
    expect(registryStatusBadge({ registryVersionStatus: "published" })?.tone).toBe("ok");
    expect(registryStatusBadge({})).toBe(null);
  });
});
