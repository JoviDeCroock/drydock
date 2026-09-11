import { describe, expect, test } from "vitest";
import { decideOutOfBandCandidate } from "../server/lib/ecosystems/npm/out-of-band-watch";

describe("decideOutOfBandCandidate", () => {
  test("a confirmed published version alarms with confirmation", () => {
    expect(decideOutOfBandCandidate({ ok: true, status: "published" })).toBe("alarm-confirmed");
  });

  test("blocked and deleted versions are accounted without an alarm", () => {
    expect(decideOutOfBandCandidate({ ok: true, status: "blocked" })).toBe("ignore");
    expect(decideOutOfBandCandidate({ ok: true, status: "deleted" })).toBe("ignore");
  });

  test("staged and validating versions defer to the next sweep", () => {
    expect(decideOutOfBandCandidate({ ok: true, status: "staged" })).toBe("defer");
    expect(decideOutOfBandCandidate({ ok: true, status: "validating" })).toBe("defer");
  });

  test("a failed lookup does not silence the alarm — packument presence is the evidence", () => {
    for (const reason of ["not_found", "unauthorized", "rate_limited", "unavailable"]) {
      expect(decideOutOfBandCandidate({ ok: false, reason, httpStatus: null })).toBe(
        "alarm-unconfirmed",
      );
    }
  });

  test("malformed coordinates can never alarm", () => {
    expect(decideOutOfBandCandidate({ ok: false, reason: "rejected", httpStatus: 400 })).toBe(
      "ignore",
    );
    expect(
      decideOutOfBandCandidate({ ok: false, reason: "incomplete_input", httpStatus: null }),
    ).toBe("ignore");
  });
});
