import { SECRET_PATTERNS } from "./rules";
import type { FileRecord, Finding } from "./";

export function redactText(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

export function redactFileRecords(files: FileRecord[]): FileRecord[] {
  return files.map((file) => ({
    ...file,
    textSample: file.textSample ? redactText(file.textSample) : file.textSample,
  }));
}

export function redactFindings(findings: Finding[]): Finding[] {
  return findings.map((finding) => ({
    ...finding,
    evidence: redactText(finding.evidence),
    reason: redactText(finding.reason),
  }));
}

export function redactJson<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactJson(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        redactJson(nested),
      ]),
    ) as T;
  }
  return value;
}
