import type { Finding } from "../types";
import { firstMatchingLine } from "../../platform/text-utils";
import { FINDING_SECRET_PATTERNS, HIGH_CONFIDENCE_SECRET_PATTERNS } from "./patterns";
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

const DEMOTED_SEVERITY: Partial<Record<Finding["severity"], Finding["severity"]>> = {
  critical: "high",
  high: "medium",
  medium: "low",
};

// Demote a finding that lives in an unreachable test file by one severity step
// and mark it test-scoped so the risk roll-up can keep it out of the capability
// co-occurrence escalation. Findings are demoted, never dropped — malware does
// hide in test directories. Obfuscated matches keep full severity: hiding an
// identifier inside a test file is still a malice signal.
export function testScope(testScoped: boolean, obfuscated: boolean, finding: Finding): Finding {
  if (!testScoped || obfuscated) return finding;
  return {
    ...finding,
    severity: DEMOTED_SEVERITY[finding.severity] ?? finding.severity,
    evidence: `test-scoped ${finding.evidence}`,
    testScoped: true,
  };
}

// Demote a finding in a minified bundle or data file that nothing provably
// loads, the way `testScope` demotes one in an unreachable test file: lower,
// and out of capability co-occurrence. The file is scanned either way; the
// load-call scan cannot follow a path assembled at runtime, so this grades
// rather than drops. A minified bundle is code and drops one step; a data
// format (`.txt`, `.css`, ...) drops two, since docs such as `llms.txt` quote
// API calls as text. Obfuscated matches and test-scoped findings keep theirs.
export function loadScope(finding: Finding, steps: 1 | 2): Finding {
  if (finding.testScoped || finding.obfuscated) return finding;
  let severity = DEMOTED_SEVERITY[finding.severity] ?? finding.severity;
  if (steps === 2) severity = DEMOTED_SEVERITY[severity] ?? severity;
  return {
    ...finding,
    severity,
    evidence: `not provably loaded; ${finding.evidence}`,
    loadUnproven: true,
  };
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
  return options.highConfidenceOnly ? HIGH_CONFIDENCE_SECRET_PATTERNS : FINDING_SECRET_PATTERNS;
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
