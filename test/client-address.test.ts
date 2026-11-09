import { describe, expect, test } from "vitest";
import { clientAddressBucket, UNKNOWN_CLIENT } from "../server/lib/platform/client-address";
import { clientRateLimitKey } from "../server/lib/rate-limit";

function requestWith(headers: Record<string, string>) {
  return { req: { header: (name: string) => headers[name] } };
}

describe("clientAddressBucket", () => {
  test("keeps an IPv4 address whole", () => {
    expect(clientAddressBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddressBucket(" 203.0.113.007 ")).toBe("203.0.113.7");
  });

  test("groups IPv6 by /64 whatever the spelling", () => {
    const full = clientAddressBucket("2001:0db8:0000:0042:0000:8a2e:0370:7334");
    expect(full).toBe("2001:db8:0:42::/64");
    for (const spelling of [
      "2001:db8:0:42::1",
      "2001:DB8:0:42:ffff:ffff:ffff:ffff",
      "2001:db8::42:1:2:3:4",
      "2001:db8:0:42:1:2:192.0.2.1",
    ]) {
      expect(clientAddressBucket(spelling), spelling).toBe(full);
    }
    expect(clientAddressBucket("2001:db8:0:43::1")).not.toBe(full);
    expect(clientAddressBucket("::1")).toBe("0:0:0:0::/64");
    expect(clientAddressBucket("::")).toBe("0:0:0:0::/64");
    expect(clientAddressBucket("fe80::")).toBe("fe80:0:0:0::/64");
  });

  test("reads an IPv4-mapped IPv6 address as its IPv4 address", () => {
    expect(clientAddressBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddressBucket("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(clientAddressBucket("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  test("reads a 6to4 address as the IPv4 host whose /48 it is", () => {
    expect(clientAddressBucket("2002:cb00:7107::1")).toBe("203.0.113.7");
    expect(clientAddressBucket("2002:cb00:7107:ffff::9")).toBe("203.0.113.7");
  });

  test("puts a missing or malformed address in the shared bucket", () => {
    for (const value of [
      undefined,
      null,
      "",
      "  ",
      "unknown",
      "203.0.113.256",
      "203.0.113",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      "1:2:3:4:5:6:7::8",
      "12345::1",
      "fe80::1%eth0",
      "::ffff:203.0.113.999",
      "2001:db8:0:42::/64",
      "203.0.113.7, 198.51.100.1",
    ]) {
      expect(clientAddressBucket(value), String(value)).toBe(UNKNOWN_CLIENT);
    }
  });
});

describe("clientRateLimitKey", () => {
  test("reads only the edge-set address, never x-forwarded-for", () => {
    expect(clientRateLimitKey(requestWith({ "cf-connecting-ip": "2001:db8:0:42::9" }))).toBe(
      "2001:db8:0:42::/64",
    );
    expect(clientRateLimitKey(requestWith({ "x-forwarded-for": "198.51.100.1" }))).toBe(
      UNKNOWN_CLIENT,
    );
  });
});
