function markdown(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", " ");
}

function status(result) {
  const messages = [
    ...result.violations.map((message) => `fail: ${message}`),
    ...result.warnings.map((message) => `warn: ${message}`),
  ];
  return messages.length > 0 ? messages.join("; ") : "pass";
}

export function renderReport(results, metadata = {}) {
  const heading = "## Drydock verify";
  if (results.length === 0) {
    return `${heading}\n\nNo changed dependency version pairs found.\n`;
  }
  const lines = [
    heading,
    "",
    "| Package | Change | Grade | Capability escalations | Listed review | Result | Diff |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const verdict = result.verdict;
    const listed = result.listedReview
      ? result.listedReview.listed
        ? "listed"
        : "not listed"
      : "—";
    const diff = verdict?.diffUrl ? `[review](${verdict.diffUrl})` : "—";
    lines.push(
      `| ${markdown(result.pair.name)} | ${markdown(`${result.pair.from} → ${result.pair.to}`)} | ${markdown(verdict?.grade ?? "unavailable")} | ${markdown(verdict?.capabilities.escalations.join(", ") || "none")} | ${markdown(listed)} | ${markdown(status(result))} | ${diff} |`,
    );
  }
  if (metadata.baseRevision) lines.push("", `Compared with \`${metadata.baseRevision}\`.`);
  return `${lines.join("\n")}\n`;
}
