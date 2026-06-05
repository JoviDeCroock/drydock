import { SECRET_PATTERNS } from "./review-rules";
import type { FileRecord, Finding } from "./review";

export function redactText(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

export function redactFileRecords(files: FileRecord[]): FileRecord[] {
  // Drop scanText: it is the full pre-truncation body used only for scanning and
  // must never reach persistence, the report digest, or the AI reviewer.
  return files.map(({ scanText: _scanText, ...file }) => ({
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
