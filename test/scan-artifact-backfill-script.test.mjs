import { describe, expect, test } from "vitest";
import { parseBackfillArgs, runBackfill } from "../scripts/backfill-scan-artifacts.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureStream() {
  let output = "";
  return {
    write(chunk) {
      output += chunk;
    },
    output() {
      return output;
    },
  };
}

describe("scan artifact backfill script", () => {
  test("drains one organization by cursor", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      const body = JSON.parse(init.body);
      if (body.cursor === null) {
        return jsonResponse({
          scanned: 2,
          backfilled: 2,
          alreadyBacked: 0,
          digestMismatch: 0,
          failed: 0,
          nextCursor: "scan_2",
        });
      }
      return jsonResponse({
        scanned: 1,
        backfilled: 0,
        alreadyBacked: 1,
        digestMismatch: 0,
        failed: 0,
        nextCursor: null,
      });
    };
    const stdout = captureStream();
    const options = parseBackfillArgs(
      [
        "--base-url",
        "https://drydock.example.test/",
        "--cookie",
        "better-auth.session_token=secret",
        "--organization-id",
        "org_123",
        "--limit",
        "25",
      ],
      {},
    );

    await expect(runBackfill(options, { fetch, stdout })).resolves.toMatchObject({
      scanned: 3,
      backfilled: 2,
      alreadyBacked: 1,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://drydock.example.test/api/v1/scans/artifacts/backfill");
    expect(calls[0].init.headers.get("x-organization-id")).toBe("org_123");
    expect(JSON.parse(calls[0].init.body)).toEqual({ limit: 25, cursor: null });
    expect(JSON.parse(calls[1].init.body)).toEqual({ limit: 25, cursor: "scan_2" });
    expect(stdout.output()).toContain("nextCursor=done");
  });

  test("filters all-organization runs to owner and admin memberships", async () => {
    const organizationHeaders = [];
    const fetch = async (url, init) => {
      if (url.endsWith("/api/v1/organizations")) {
        return jsonResponse({
          organizations: [
            { id: "org_owner", name: "Owner Org", role: "owner" },
            { id: "org_member", name: "Member Org", role: "member" },
            { id: "org_admin", name: "Admin Org", role: "admin" },
          ],
        });
      }
      organizationHeaders.push(init.headers.get("x-organization-id"));
      return jsonResponse({
        scanned: 1,
        backfilled: 1,
        alreadyBacked: 0,
        digestMismatch: 0,
        failed: 0,
        nextCursor: null,
      });
    };
    const stdout = captureStream();
    const options = parseBackfillArgs(
      [
        "--base-url=https://drydock.example.test",
        "--cookie=better-auth.session_token=secret",
        "--all-organizations",
      ],
      {},
    );

    await expect(runBackfill(options, { fetch, stdout })).resolves.toMatchObject({
      scanned: 2,
      backfilled: 2,
    });

    expect(organizationHeaders).toEqual(["org_owner", "org_admin"]);
    expect(stdout.output()).toContain("skipped 1 organization(s) without admin access");
  });

  test("rejects ambiguous all-organization resume cursors", () => {
    expect(() =>
      parseBackfillArgs(
        [
          "--base-url=https://drydock.example.test",
          "--cookie=better-auth.session_token=secret",
          "--all-organizations",
          "--cursor=scan_123",
        ],
        {},
      ),
    ).toThrow("--cursor is only supported for a single organization run");
  });
});
