import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import {
  REPORT_VIEW_CLOCK_SKEW_MS,
  reportOpenedBeforePublication,
  type ReportViewVerdictInput,
} from "../server/db/scan-views";
import { OPENED_BEFORE_PUBLICATION_SQL, SNAPSHOT_QUERIES } from "../scripts/ops-snapshot.mjs";

const PUBLISHED = Date.UTC(2026, 9, 1, 12, 0, 0);
const OBSERVED = PUBLISHED + 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function verdict(overrides: Partial<ReportViewVerdictInput>) {
  return reportOpenedBeforePublication({
    source: "manual",
    status: "complete",
    reportViewCount: 0,
    ...overrides,
  });
}

describe("reportOpenedBeforePublication", () => {
  test("orders the first view against npm's own publication time", () => {
    expect(
      verdict({
        registryPublishedAt: PUBLISHED,
        reportFirstViewedAt: PUBLISHED - MINUTE,
        reportViewCount: 2,
      }),
    ).toBe("opened");
    expect(
      verdict({
        registryPublishedAt: PUBLISHED,
        reportFirstViewedAt: PUBLISHED + MINUTE,
        reportViewCount: 1,
      }),
    ).toBe("not_opened");
    expect(verdict({ registryPublishedAt: PUBLISHED })).toBe("not_opened");
  });

  test("a view inside the clock-skew margin of publication is unknown", () => {
    for (const offset of [-REPORT_VIEW_CLOCK_SKEW_MS, -1, 0, 1, REPORT_VIEW_CLOCK_SKEW_MS]) {
      expect(
        verdict({
          registryPublishedAt: PUBLISHED,
          reportFirstViewedAt: PUBLISHED + offset,
          reportViewCount: 1,
        }),
      ).toBe("unknown");
    }
  });

  test("a version status bounds publication from above, so an earlier view is unknown", () => {
    const published = { registryVersionStatus: "published", registryVersionStatusAt: OBSERVED };
    expect(verdict({ ...published, reportFirstViewedAt: OBSERVED - MINUTE })).toBe("unknown");
    expect(verdict({ ...published, reportFirstViewedAt: OBSERVED + MINUTE })).toBe("not_opened");
    expect(verdict(published)).toBe("not_opened");
    expect(
      verdict({
        registryVersionStatus: "deleted",
        registryVersionStatusAt: OBSERVED,
        reportFirstViewedAt: OBSERVED + MINUTE,
      }),
    ).toBe("not_opened");
  });

  test("a review counted only since view tracking began can prove opened, never not opened", () => {
    expect(
      verdict({
        registryPublishedAt: PUBLISHED,
        reportFirstViewedAt: PUBLISHED - MINUTE,
        reportViewCount: null,
      }),
    ).toBe("opened");
    expect(verdict({ registryPublishedAt: PUBLISHED, reportViewCount: null })).toBe("unknown");
    expect(
      verdict({
        registryPublishedAt: PUBLISHED,
        reportFirstViewedAt: PUBLISHED + MINUTE,
        reportViewCount: null,
      }),
    ).toBe("unknown");
    expect(
      verdict({
        registryVersionStatus: "published",
        registryVersionStatusAt: OBSERVED,
        reportViewCount: null,
      }),
    ).toBe("unknown");
  });

  test("does not answer without evidence of publication", () => {
    // A stage that left npm's stage list, was blocked, or is still staged has
    // no publication to compare against.
    expect(verdict({ reportFirstViewedAt: PUBLISHED })).toBeNull();
    for (const status of ["staged", "validating", "blocked"]) {
      expect(
        verdict({ registryVersionStatus: status, registryVersionStatusAt: OBSERVED }),
      ).toBeNull();
    }
  });

  test("applies only to completed, live staged reviews", () => {
    const evidence = { registryPublishedAt: PUBLISHED, reportFirstViewedAt: PUBLISHED - MINUTE };
    expect(verdict({ ...evidence, source: "workflow_gate" })).toBeNull();
    expect(verdict({ ...evidence, source: "published" })).toBeNull();
    expect(verdict({ ...evidence, status: "failed" })).toBeNull();
    expect(verdict({ ...evidence, registryStatusSupersededAt: OBSERVED })).toBeNull();
    expect(verdict({ ...evidence, source: "auto_discovery" })).toBe("opened");
  });
});

describe("ops snapshot opened-before-publication query", () => {
  const query = SNAPSHOT_QUERIES.find(
    (candidate) => candidate.name === "published_staged_reviews_opened_before_publication",
  );

  function cases(): ReportViewVerdictInput[] {
    const rows: ReportViewVerdictInput[] = [];
    const views = [
      null,
      PUBLISHED - MINUTE,
      PUBLISHED - REPORT_VIEW_CLOCK_SKEW_MS,
      PUBLISHED + 1,
      PUBLISHED + MINUTE,
      OBSERVED - MINUTE,
      OBSERVED + REPORT_VIEW_CLOCK_SKEW_MS + 1,
    ];
    for (const source of ["manual", "auto_discovery", "workflow_gate"])
      for (const status of ["complete", "failed"])
        for (const registryStatusSupersededAt of [null, OBSERVED])
          for (const registryPublishedAt of [null, PUBLISHED])
            for (const registryVersionStatus of [null, "staged", "blocked", "published", "deleted"])
              for (const reportFirstViewedAt of views)
                for (const reportViewCount of [null, 0, 3])
                  rows.push({
                    source,
                    status,
                    registryStatusSupersededAt,
                    registryPublishedAt,
                    registryVersionStatus,
                    registryVersionStatusAt: registryVersionStatus ? OBSERVED : null,
                    reportFirstViewedAt,
                    reportViewCount,
                  });
    return rows;
  }

  test("agrees with reportOpenedBeforePublication on every row", () => {
    expect(query).toBeDefined();
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE scans (
      id TEXT PRIMARY KEY, source TEXT, status TEXT, decision TEXT, completed_at INTEGER,
      registry_status_superseded_at INTEGER, registry_published_at INTEGER,
      registry_version_status TEXT, registry_version_status_at INTEGER,
      report_first_viewed_at INTEGER, report_view_count INTEGER)`);
    const insert = db.prepare("INSERT INTO scans VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)");
    const rows = cases();
    rows.forEach((row, index) =>
      insert.run(
        String(index),
        row.source,
        row.status,
        PUBLISHED - 2 * MINUTE,
        (row.registryStatusSupersededAt as number | null) ?? null,
        (row.registryPublishedAt as number | null) ?? null,
        row.registryVersionStatus ?? null,
        (row.registryVersionStatusAt as number | null) ?? null,
        (row.reportFirstViewedAt as number | null) ?? null,
        row.reportViewCount ?? null,
      ),
    );

    // The snapshot query's own filter and CASE, per row rather than grouped.
    const where = query!.sql.slice(
      query!.sql.indexOf(" WHERE ") + 7,
      query!.sql.indexOf(" GROUP BY "),
    );
    const fromSql = new Map(
      (
        db
          .prepare(
            `SELECT id, ${OPENED_BEFORE_PUBLICATION_SQL} AS verdict FROM scans WHERE ${where}`,
          )
          .all() as Array<{ id: string; verdict: string }>
      ).map((row) => [row.id, row.verdict]),
    );
    rows.forEach((row, index) => {
      expect([index, fromSql.get(String(index)) ?? null]).toEqual([
        index,
        reportOpenedBeforePublication(row),
      ]);
    });

    const grouped = db.prepare(query!.sql).all() as Array<Record<string, unknown>>;
    expect(grouped.length).toBeGreaterThan(0);
    for (const row of grouped) expect(Object.keys(row).sort()).toEqual([...query!.columns].sort());
  });
});
