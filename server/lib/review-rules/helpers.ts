import type { Finding } from "../review";
import { firstMatchingLine } from "../text-utils";
import { HIGH_CONFIDENCE_SECRET_PATTERNS, SECRET_PATTERNS } from "./patterns";
import { DETERMINISTIC_RULE_IDS, type DeterministicRuleKey } from "./rule-ids";

// Family modules tag findings with a rule ID only; the deterministic ruleset
// version is stamped uniformly by the index composer so the version stays a
// single concern.
export function tag(
  rule: DeterministicRuleKey,
  finding: Omit<Finding, "ruleId" | "ruleVersion">,
): Finding {
  return { ...finding, ruleId: DETERMINISTIC_RULE_IDS[rule] };
}

interface SecretTextOptions {
  highConfidenceOnly?: boolean;
}

export function containsSecretLikeText(text: string, options: SecretTextOptions = {}): boolean {
  return secretPatternsFor(options).some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function firstSecretLine(
  text: string | undefined | null,
  options: SecretTextOptions = {},
): number | undefined {
  if (!text) return undefined;
  return firstMatchingLine(
    text,
    secretPatternsFor(options).map(([pattern]) => pattern),
  );
}

function secretPatternsFor(options: SecretTextOptions): Array<[RegExp, string]> {
  return options.highConfidenceOnly ? HIGH_CONFIDENCE_SECRET_PATTERNS : SECRET_PATTERNS;
}

export function firstJsonPropertyLine(
  text: string | undefined | null,
  key: string,
  value?: string,
): number | undefined {
  if (!text) return undefined;
  const escapedKey = escapeRegExp(key);
  const keyPattern = new RegExp(`["']${escapedKey}["']\\s*:`);
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (keyPattern.test(lines[index])) return index + 1;
  }
  if (value) {
    const escapedValue = escapeRegExp(value);
    const valuePattern = new RegExp(escapedValue);
    for (let index = 0; index < lines.length; index += 1) {
      if (valuePattern.test(lines[index])) return index + 1;
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
