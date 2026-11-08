/**
 * The rate-limit subject for a client address: an IPv4 address whole, an IPv6
 * address by its /64. One IPv6 subscriber is routinely delegated a /64 (often
 * more), so keying on the full address hands a single client 2^64 fresh
 * budgets. An IPv4-mapped IPv6 address is its IPv4 address.
 *
 * Anything that does not parse, including a missing address, is the shared
 * `UNKNOWN_CLIENT` bucket: a limiter keyed here never skips a request, and a
 * value that cannot be normalized cannot mint a budget of its own either.
 */
export const UNKNOWN_CLIENT = "unknown";

export function clientAddressBucket(address: string | null | undefined): string {
  const trimmed = address?.trim().toLowerCase() ?? "";
  if (!trimmed) return UNKNOWN_CLIENT;
  const v4 = parseIpv4(trimmed);
  if (v4) return v4.join(".");
  const v6 = parseIpv6(trimmed);
  if (!v6) return UNKNOWN_CLIENT;
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) {
    return [v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff].join(".");
  }
  return `${v6
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Eight 16-bit groups, or null. Zone identifiers are not accepted. */
function parseIpv6(text: string): number[] | null {
  if (!text.includes(":")) return null;
  let head = text;
  // A dotted IPv4 tail (`::ffff:192.0.2.1`) is rewritten as its two groups.
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (!v4) return null;
    const high = ((v4[0]! << 8) | v4[1]!).toString(16);
    const low = ((v4[2]! << 8) | v4[3]!).toString(16);
    head = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const left = groups(halves[0]!);
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = groups(halves[1]!);
  if (!right) return null;
  const present = left.length + right.length;
  if (present > 7) return null;
  return [...left, ...Array.from({ length: 8 - present }, () => 0), ...right];
}
