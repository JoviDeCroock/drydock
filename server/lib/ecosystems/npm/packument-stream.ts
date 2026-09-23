/**
 * Streaming extraction of the few packument fields the publication monitor
 * reads: top-level `name`, `dist-tags` and `time`, and each version's `name`,
 * `version`, `dist.tarball` and `dist.shasum`.
 *
 * The packument is a hostile registry document, and only npm's full document
 * carries per-version publish times, so a mature package's packument can be
 * tens of megabytes. This consumes it chunk by chunk with an explicit stack
 * (never recursion on input depth), keeps only the captured fields, and holds
 * at most one bounded captured string at a time, so memory stays flat however
 * large the document is. The result equals `JSON.parse` followed by the same
 * projection, duplicate keys included (the last one wins).
 */

export class PackumentStreamError extends Error {
  constructor(readonly code: "invalid" | "too_complex") {
    super(`packument_${code}`);
  }
}

export interface PackumentVersion {
  name: string | null;
  version: string | null;
  tarball: string | null;
  shasum: string | null;
}

export interface PackumentExtract {
  name: string | null;
  versions: Map<string, PackumentVersion | null>;
  versionsIsObject: boolean;
  time: Map<string, string>;
  distTags: Map<string, string>;
  distTagsTruncated: boolean;
  versionLimitExceeded: boolean;
}

// Container frames: what the keys of an open object mean.
const ROOT = 0;
const VERSIONS = 1;
const ENTRY = 2;
const DIST = 3;
const TIME = 4;
const TAGS = 5;
const SKIP_OBJECT = 6;
const ARRAY = 7;

// Value slots: what the next value means.
const SLOT_SKIP = 0;
const SLOT_ROOT = 1;
const SLOT_NAME = 2;
const SLOT_VERSIONS = 3;
const SLOT_TIME = 4;
const SLOT_TAGS = 5;
const SLOT_VERSION = 6;
const SLOT_ENTRY_NAME = 7;
const SLOT_ENTRY_VERSION = 8;
const SLOT_ENTRY_DIST = 9;
const SLOT_TARBALL = 10;
const SLOT_SHASUM = 11;
const SLOT_TIME_VALUE = 12;
const SLOT_TAG_VALUE = 13;

// Parser states.
const S_VALUE = 0;
const S_OBJECT_FIRST = 1;
const S_OBJECT_KEY = 2;
const S_COLON = 3;
const S_OBJECT_NEXT = 4;
const S_ARRAY_FIRST = 5;
const S_ARRAY_NEXT = 6;
const S_STRING = 7;
const S_NUMBER = 8;
const S_KEYWORD = 9;
const S_DONE = 10;

// String modes. A `MATCH` key only has to equal one of a few short names, so
// an overlong one is simply not a match; a `CAPTURE` string is data we keep.
const SKIP = 0;
const CAPTURE = 1;
const MATCH = 2;

// JSON number grammar states. `nextNumberState` answers -1 when the byte ends
// the number (it is reprocessed as what follows) and null when it is invalid.
const N_MINUS = 0;
const N_ZERO = 1;
const N_INT = 2;
const N_DOT = 3;
const N_FRACTION = 4;
const N_E = 5;
const N_E_SIGN = 6;
const N_EXPONENT = 7;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const KEYWORDS: Record<number, Uint8Array> = {
  0x74: new TextEncoder().encode("true"),
  0x66: new TextEncoder().encode("false"),
  0x6e: new TextEncoder().encode("null"),
};

const ROOT_KEYS: Record<string, number> = {
  name: SLOT_NAME,
  versions: SLOT_VERSIONS,
  time: SLOT_TIME,
  "dist-tags": SLOT_TAGS,
};
const ENTRY_KEYS: Record<string, number> = {
  name: SLOT_ENTRY_NAME,
  version: SLOT_ENTRY_VERSION,
  dist: SLOT_ENTRY_DIST,
};
const DIST_KEYS: Record<string, number> = { tarball: SLOT_TARBALL, shasum: SLOT_SHASUM };
const STRING_SLOTS: ReadonlySet<number> = new Set([
  SLOT_NAME,
  SLOT_ENTRY_NAME,
  SLOT_ENTRY_VERSION,
  SLOT_TARBALL,
  SLOT_SHASUM,
  SLOT_TIME_VALUE,
  SLOT_TAG_VALUE,
]);

const isWhitespace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

function nextNumberState(state: number, c: number): number | null {
  const digit = isDigit(c);
  const exponent = c === 0x65 || c === 0x45;
  switch (state) {
    case N_MINUS:
      return c === 0x30 ? N_ZERO : digit ? N_INT : null;
    case N_ZERO:
      return c === 0x2e ? N_DOT : exponent ? N_E : -1;
    case N_INT:
      return digit ? N_INT : c === 0x2e ? N_DOT : exponent ? N_E : -1;
    case N_DOT:
      return digit ? N_FRACTION : null;
    case N_FRACTION:
      return digit ? N_FRACTION : exponent ? N_E : -1;
    case N_E:
      return c === 0x2b || c === 0x2d ? N_E_SIGN : digit ? N_EXPONENT : null;
    case N_E_SIGN:
      return digit ? N_EXPONENT : null;
    default:
      return digit ? N_EXPONENT : -1;
  }
}

export function createPackumentExtractor(
  limits: {
    maxVersions?: number;
    maxDistTags?: number;
    maxDepth?: number;
    maxCapturedBytes?: number;
  } = {},
): { write(chunk: Uint8Array): void; end(): PackumentExtract } {
  const maxVersions = limits.maxVersions ?? 10_001;
  const maxDistTags = limits.maxDistTags ?? 1_000;
  const maxDepth = limits.maxDepth ?? 256;
  const maxCaptured = limits.maxCapturedBytes ?? 4_096;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const out: PackumentExtract = {
    name: null,
    versions: new Map(),
    versionsIsObject: false,
    time: new Map(),
    distTags: new Map(),
    distTagsTruncated: false,
    versionLimitExceeded: false,
  };
  const frames: number[] = [];
  let state = S_VALUE;
  let slot = SLOT_ROOT;
  let pendingKey = "";
  let entry: PackumentVersion | null = null;
  let failed: PackumentStreamError | null = null;

  let stringIsKey = false;
  let stringMode = SKIP;
  let escaped = false;
  const captured = new Uint8Array(maxCaptured);
  let capturedLength = 0;
  let overflow = false;
  let numberState = N_INT;
  let keyword: Uint8Array = KEYWORDS[0x74]!;
  let keywordAt = 0;

  const fail = (code: "invalid" | "too_complex"): never => {
    throw (failed = new PackumentStreamError(code));
  };

  function push(frame: number) {
    if (frames.length >= maxDepth) fail("too_complex");
    frames.push(frame);
  }

  function afterValue() {
    const top = frames[frames.length - 1];
    state = top === undefined ? S_DONE : top === ARRAY ? S_ARRAY_NEXT : S_OBJECT_NEXT;
  }

  function versionAllowed(): boolean {
    if (out.versions.has(pendingKey) || out.versions.size < maxVersions) return true;
    out.versionLimitExceeded = true;
    return false;
  }

  // The value in `slot` is not a string (and not an object, unless the slot
  // takes one and the caller handles that): a later non-string value erases
  // what an earlier duplicate key captured, exactly as `JSON.parse` would.
  function applyNonString() {
    switch (slot) {
      case SLOT_ROOT:
        fail("invalid");
        break;
      case SLOT_NAME:
        out.name = null;
        break;
      case SLOT_VERSIONS:
        out.versions = new Map();
        out.versionsIsObject = false;
        out.versionLimitExceeded = false;
        break;
      case SLOT_TIME:
        out.time = new Map();
        break;
      case SLOT_TAGS:
        out.distTags = new Map();
        out.distTagsTruncated = false;
        break;
      case SLOT_VERSION:
        if (versionAllowed()) out.versions.set(pendingKey, null);
        break;
      case SLOT_ENTRY_NAME:
        entry!.name = null;
        break;
      case SLOT_ENTRY_VERSION:
        entry!.version = null;
        break;
      case SLOT_ENTRY_DIST:
        entry!.tarball = null;
        entry!.shasum = null;
        break;
      case SLOT_TARBALL:
        entry!.tarball = null;
        break;
      case SLOT_SHASUM:
        entry!.shasum = null;
        break;
      case SLOT_TIME_VALUE:
        out.time.delete(pendingKey);
        break;
      case SLOT_TAG_VALUE:
        out.distTags.delete(pendingKey);
        break;
    }
  }

  function applyString(value: string) {
    switch (slot) {
      case SLOT_NAME:
        out.name = value;
        break;
      case SLOT_ENTRY_NAME:
        entry!.name = value;
        break;
      case SLOT_ENTRY_VERSION:
        entry!.version = value;
        break;
      case SLOT_TARBALL:
        entry!.tarball = value;
        break;
      case SLOT_SHASUM:
        entry!.shasum = value;
        break;
      case SLOT_TIME_VALUE:
        out.time.set(pendingKey, value);
        break;
      case SLOT_TAG_VALUE:
        if (out.distTags.has(pendingKey) || out.distTags.size < maxDistTags) {
          out.distTags.set(pendingKey, value);
        } else {
          out.distTagsTruncated = true;
        }
        break;
    }
  }

  function openObject() {
    switch (slot) {
      case SLOT_ROOT:
        return push(ROOT);
      case SLOT_VERSIONS:
        applyNonString();
        out.versionsIsObject = true;
        return push(VERSIONS);
      case SLOT_TIME:
        applyNonString();
        return push(TIME);
      case SLOT_TAGS:
        applyNonString();
        return push(TAGS);
      case SLOT_VERSION: {
        if (!versionAllowed()) return push(SKIP_OBJECT);
        entry = { name: null, version: null, tarball: null, shasum: null };
        out.versions.set(pendingKey, entry);
        return push(ENTRY);
      }
      case SLOT_ENTRY_DIST:
        applyNonString();
        return push(DIST);
      default:
        applyNonString();
        return push(SKIP_OBJECT);
    }
  }

  function startString(isKey: boolean, mode: number) {
    stringIsKey = isKey;
    stringMode = mode;
    escaped = false;
    capturedLength = 0;
    overflow = false;
    if (mode !== SKIP) captured[capturedLength++] = QUOTE;
    state = S_STRING;
  }

  function startValue(c: number) {
    if (c === 0x7b) {
      openObject();
      state = S_OBJECT_FIRST;
    } else if (c === 0x5b) {
      applyNonString();
      push(ARRAY);
      state = S_ARRAY_FIRST;
    } else if (c === QUOTE) {
      const keep = STRING_SLOTS.has(slot);
      if (!keep) applyNonString();
      startString(false, keep ? CAPTURE : SKIP);
    } else if (c === 0x2d || isDigit(c)) {
      applyNonString();
      numberState = c === 0x2d ? N_MINUS : c === 0x30 ? N_ZERO : N_INT;
      state = S_NUMBER;
    } else if (KEYWORDS[c]) {
      applyNonString();
      keyword = KEYWORDS[c]!;
      keywordAt = 1;
      state = S_KEYWORD;
    } else {
      fail("invalid");
    }
  }

  function startKey() {
    const top = frames[frames.length - 1];
    const mode =
      top === VERSIONS || top === TIME || top === TAGS
        ? CAPTURE
        : top === ROOT || top === ENTRY || top === DIST
          ? MATCH
          : SKIP;
    startString(true, mode);
  }

  function capture(chunk: Uint8Array, from: number, to: number) {
    if (stringMode === SKIP || overflow) return;
    if (capturedLength + (to - from) > maxCaptured) {
      if (stringMode === CAPTURE) fail("too_complex");
      overflow = true;
      return;
    }
    captured.set(chunk.subarray(from, to), capturedLength);
    capturedLength += to - from;
  }

  function decodeCaptured(): string {
    try {
      const value: unknown = JSON.parse(decoder.decode(captured.subarray(0, capturedLength)));
      if (typeof value === "string") return value;
    } catch {
      // Invalid UTF-8, a bad escape or a raw control character.
    }
    return fail("invalid");
  }

  function endString() {
    const text = stringMode === SKIP || overflow ? null : decodeCaptured();
    if (!stringIsKey) {
      if (text !== null) applyString(text);
      afterValue();
      return;
    }
    const top = frames[frames.length - 1];
    if (top === VERSIONS || top === TIME || top === TAGS) {
      pendingKey = text!;
      slot = top === VERSIONS ? SLOT_VERSION : top === TIME ? SLOT_TIME_VALUE : SLOT_TAG_VALUE;
    } else {
      const names = top === ROOT ? ROOT_KEYS : top === ENTRY ? ENTRY_KEYS : DIST_KEYS;
      slot = text !== null && Object.hasOwn(names, text) ? names[text]! : SLOT_SKIP;
    }
    state = S_COLON;
  }

  function closeContainer(isObject: boolean) {
    const top = frames.pop();
    if (top === undefined || (top === ARRAY) === isObject) fail("invalid");
    afterValue();
  }

  function write(chunk: Uint8Array) {
    if (failed) throw failed;
    // Cached next quote/backslash positions keep string scanning linear even
    // when a string holds many escapes.
    let quoteAt = -1;
    let backslashAt = -1;
    let i = 0;
    const length = chunk.length;
    while (i < length) {
      if (state === S_STRING) {
        const start = i;
        while (i < length) {
          if (escaped) {
            escaped = false;
            i++;
            continue;
          }
          if (quoteAt < i) {
            const found = chunk.indexOf(QUOTE, i);
            quoteAt = found === -1 ? length : found;
          }
          if (backslashAt < i) {
            const found = chunk.indexOf(BACKSLASH, i);
            backslashAt = found === -1 ? length : found;
          }
          if (backslashAt < quoteAt) {
            i = backslashAt + 1;
            escaped = true;
            continue;
          }
          i = quoteAt;
          break;
        }
        if (i >= length) {
          capture(chunk, start, length);
          break;
        }
        capture(chunk, start, i + 1);
        i++;
        endString();
        continue;
      }
      const c = chunk[i]!;
      if (state === S_NUMBER) {
        const next = nextNumberState(numberState, c);
        if (next === null) fail("invalid");
        if (next === -1) {
          afterValue();
          continue;
        }
        numberState = next!;
        i++;
        continue;
      }
      if (state === S_KEYWORD) {
        if (c !== keyword[keywordAt]) fail("invalid");
        i++;
        if (++keywordAt === keyword.length) afterValue();
        continue;
      }
      i++;
      if (isWhitespace(c)) continue;
      switch (state) {
        case S_VALUE:
          startValue(c);
          break;
        case S_ARRAY_FIRST:
          if (c === 0x5d) closeContainer(false);
          else {
            slot = SLOT_SKIP;
            startValue(c);
          }
          break;
        case S_ARRAY_NEXT:
          if (c === 0x5d) closeContainer(false);
          else if (c === 0x2c) {
            slot = SLOT_SKIP;
            state = S_VALUE;
          } else fail("invalid");
          break;
        case S_OBJECT_FIRST:
          if (c === 0x7d) closeContainer(true);
          else if (c === QUOTE) startKey();
          else fail("invalid");
          break;
        case S_OBJECT_KEY:
          if (c === QUOTE) startKey();
          else fail("invalid");
          break;
        case S_COLON:
          if (c === 0x3a) state = S_VALUE;
          else fail("invalid");
          break;
        case S_OBJECT_NEXT:
          if (c === 0x7d) closeContainer(true);
          else if (c === 0x2c) state = S_OBJECT_KEY;
          else fail("invalid");
          break;
        default:
          fail("invalid");
      }
    }
  }

  return {
    write(chunk) {
      try {
        write(chunk);
      } catch (err) {
        throw err instanceof PackumentStreamError
          ? err
          : (failed = new PackumentStreamError("invalid"));
      }
    },
    end() {
      if (failed) throw failed;
      if (state !== S_DONE) fail("invalid");
      return out;
    },
  };
}
