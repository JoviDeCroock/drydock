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
  // A lockfile added in this change has no previous side to compare, so its
  // dependencies are unverified rather than clean. Saying nothing would let the
  // most permissive reading — "nothing to check" — stand for the whole file.
  const added = (metadata.addedLockfiles ?? []).map(
    (entry) => `- \`${entry.path}\`: ${entry.unavailableReason}`,
  );
  if (results.length === 0) {
    const empty = [heading, "", "No changed dependency version pairs found."];
    if (added.length > 0) empty.push("", "Not verified:", ...added);
    return `${empty.join("\n")}\n`;
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
    // An empty escalation list over partially inspected bytes is a lower bound,
    // not a clean bill. The endpoint goes to some trouble to make that
    // unreadable as "no escalation"; printing "none" here would undo it.
    const escalations = verdict
      ? verdict.capabilities.escalations.length > 0
        ? verdict.capabilities.escalations.join(", ")
        : verdict.capabilities.confident === true
          ? "none"
          : "none seen (partial coverage)"
      : "—";
    lines.push(
      `| ${markdown(result.pair.name)} | ${markdown(`${result.pair.from} → ${result.pair.to}`)} | ${markdown(verdict?.grade ?? "unavailable")} | ${markdown(escalations)} | ${markdown(listed)} | ${markdown(status(result))} | ${diff} |`,
    );
  }
  if (added.length > 0) lines.push("", "Not verified:", ...added);
  if (metadata.baseRevision) lines.push("", `Compared with \`${metadata.baseRevision}\`.`);
  return `${lines.join("\n")}\n`;
}
