// Pure manifest reading for the detonation harness. The manifest is the
// package's own claim, so it only ever adds a caveat to a clean run; omitting
// these fields cannot make a run look stronger than "load only".

const BROWSER_FIELDS = ["browser", "unpkg", "jsdelivr"];
const MAX_EXPORT_NODES = 1000;
const MAX_EXPORT_DEPTH = 8;

/**
 * Whether the package ships a browser build: a `browser`, `unpkg`, or
 * `jsdelivr` field, or a `browser` condition anywhere in `exports`. Its
 * browser code paths never run in the Node sandbox.
 *
 * @param {Record<string, unknown> | null} manifest
 * @returns {boolean}
 */
export function isBrowserTargeted(manifest) {
  if (manifest === null) return false;
  if (BROWSER_FIELDS.some((field) => manifest[field] !== undefined && manifest[field] !== false)) {
    return true;
  }
  const budget = { nodes: MAX_EXPORT_NODES };
  return hasBrowserCondition(manifest.exports, 0, budget);
}

/** @param {unknown} value @param {number} depth @param {{ nodes: number }} budget @returns {boolean} */
function hasBrowserCondition(value, depth, budget) {
  if (depth > MAX_EXPORT_DEPTH || budget.nodes <= 0 || !value || typeof value !== "object") {
    return false;
  }
  budget.nodes -= 1;
  if (Array.isArray(value))
    return value.some((item) => hasBrowserCondition(item, depth + 1, budget));
  return Object.entries(value).some(
    ([key, item]) => key === "browser" || hasBrowserCondition(item, depth + 1, budget),
  );
}
