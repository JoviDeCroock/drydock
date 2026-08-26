import { readFileSync } from "node:fs";

const GRADES = ["clear", "notable", "needs-review"];
const CAPABILITIES = [
  "network",
  "process",
  "credentials",
  "dynamicEval",
  "native",
  "installScripts",
  "bin",
];
const POLICY_KEYS = new Set([
  "$schema",
  "minReleaseAgeHours",
  "maxGrade",
  "denyCapabilityEscalation",
  "requireListedReview",
  "onUnavailable",
]);

function stringArray(value, key) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

export function validatePolicy(input, source = "drydock.policy.json") {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  for (const key of Object.keys(input)) {
    if (!POLICY_KEYS.has(key))
      throw new Error(`${source} has unknown property ${JSON.stringify(key)}`);
  }

  const minReleaseAgeHours = input.minReleaseAgeHours ?? 0;
  if (!Number.isFinite(minReleaseAgeHours) || minReleaseAgeHours < 0) {
    throw new Error("minReleaseAgeHours must be a non-negative number");
  }
  const maxGrade = input.maxGrade ?? "needs-review";
  if (!GRADES.includes(maxGrade)) throw new Error(`maxGrade must be one of ${GRADES.join(", ")}`);

  const denyCapabilityEscalation = stringArray(
    input.denyCapabilityEscalation ?? [],
    "denyCapabilityEscalation",
  );
  for (const capability of denyCapabilityEscalation) {
    if (!CAPABILITIES.includes(capability)) {
      throw new Error(`unknown capability ${JSON.stringify(capability)}`);
    }
  }
  const requireListedReview = stringArray(input.requireListedReview ?? [], "requireListedReview");
  const onUnavailable = input.onUnavailable ?? "fail";
  if (onUnavailable !== "warn" && onUnavailable !== "fail") {
    throw new Error('onUnavailable must be "warn" or "fail"');
  }

  return {
    minReleaseAgeHours,
    maxGrade,
    denyCapabilityEscalation,
    requireListedReview,
    onUnavailable,
  };
}

export function loadPolicy(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validatePolicy(parsed, filePath);
}

function globMatches(pattern, packageName) {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(packageName);
}

export function requiresListedReview(policy, packageName) {
  return policy.requireListedReview.some((pattern) => globMatches(pattern, packageName));
}

export function evaluateVerdict(
  pair,
  verdict,
  policy,
  { now = Date.now(), listedReview, listedReviewUnavailable = false } = {},
) {
  const violations = [];
  const unavailable = [];

  if (GRADES.indexOf(verdict.grade) > GRADES.indexOf(policy.maxGrade)) {
    violations.push(`grade ${verdict.grade} exceeds ${policy.maxGrade}`);
  }

  if (policy.minReleaseAgeHours > 0) {
    const publishedAt = Date.parse(verdict.to.publishedAt ?? "");
    if (!Number.isFinite(publishedAt)) {
      unavailable.push("release publication time is unavailable");
    } else {
      const ageHours = (now - publishedAt) / 3_600_000;
      if (ageHours < policy.minReleaseAgeHours) {
        violations.push(
          `release age ${Math.max(0, ageHours).toFixed(1)}h is below ${policy.minReleaseAgeHours}h`,
        );
      }
    }
  }

  const denied = verdict.capabilities.escalations.filter((capability) =>
    policy.denyCapabilityEscalation.includes(capability),
  );
  if (denied.length > 0) violations.push(`denied capability escalation: ${denied.join(", ")}`);
  if (policy.denyCapabilityEscalation.length > 0 && verdict.capabilities.confident !== true) {
    unavailable.push("capability delta has incomplete coverage");
  }

  if (requiresListedReview(policy, pair.name)) {
    if (listedReview === undefined) {
      if (!listedReviewUnavailable) unavailable.push("listed-review status is unavailable");
    } else if (listedReview.listed !== true) {
      violations.push("a listed maintainer review is required");
    }
  }

  return { violations, unavailable };
}
