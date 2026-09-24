import type { ComponentChildren, FunctionComponent, VNode } from "preact";
import { describe, expect, test } from "vitest";
import {
  assistantFlagsRelease,
  matchedDeterministicAssessments,
  ReviewerSummary,
  reviewerSummaryVisible,
} from "../src/pages/Dashboard/ScanDetail/ReviewerSummary.tsx";
import type { ReviewFinding } from "../src/features/review/types";
import {
  displayedAiResult,
  type AiReview,
  type DisplayedAiResult,
} from "../server/lib/ai-review/types";

// The AI narrative moved from the bottom-of-page "Reviewer notes" section to
// `ReviewerSummary`, directly under the Recommendation. These assert the move
// preserved the old section's visibility rule exactly — including the case that
// matters most, where the reviewer was attempted and did not complete.
describe("reviewerSummaryVisible", () => {
  const complete: DisplayedAiResult = {
    kind: "complete",
    model: "@cf/moonshotai/kimi-k2.7-code",
    summary: "Routine patch release.",
    risk: "low",
    releaseAssessment: "nothing_unusual",
    findings: [],
    requiresManualReview: false,
    deterministicAssessments: [],
  };

  test("renders a completed review", () => {
    expect(reviewerSummaryVisible(complete)).toBe(true);
  });

  test("renders an attempted-but-failed review", () => {
    // Load-bearing: computeScanRisk floors this scan at medium, so the page must
    // show that the reviewer was unavailable rather than silently omitting it.
    expect(
      reviewerSummaryVisible({
        kind: "unavailable",
        model: "@cf/moonshotai/kimi-k2.7-code",
        summary: "AI review failed; deterministic findings remain available.",
        status: "unavailable",
      }),
    ).toBe(true);
  });

  test("renders nothing when the reviewer is switched off (null model)", () => {
    expect(
      reviewerSummaryVisible({
        kind: "unavailable",
        model: null,
        summary: "AI review is disabled.",
        status: "unavailable",
      }),
    ).toBe(false);
  });

  test("renders nothing when there is no review at all", () => {
    expect(reviewerSummaryVisible(null)).toBe(false);
  });
});

describe("assistantFlagsRelease", () => {
  const clean: DisplayedAiResult = {
    kind: "complete",
    model: "@cf/moonshotai/kimi-k2.7-code",
    summary: "Routine patch release.",
    risk: "low",
    releaseAssessment: "nothing_unusual",
    findings: [],
    requiresManualReview: false,
    deterministicAssessments: [],
  };

  test("a clean reading does not hold the review notes open", () => {
    // The assistant runs by default, so its presence alone would open the
    // notes on every clean release.
    expect(assistantFlagsRelease(clean)).toBe(false);
  });

  test("a reading that flags the release opens them", () => {
    expect(assistantFlagsRelease({ ...clean, requiresManualReview: true })).toBe(true);
    expect(assistantFlagsRelease({ ...clean, releaseAssessment: "suspicious" })).toBe(true);
    expect(assistantFlagsRelease({ ...clean, releaseAssessment: "review_recommended" })).toBe(true);
  });

  test("an attempted review that could not complete opens them; a disabled one does not", () => {
    const unavailable: DisplayedAiResult = {
      kind: "unavailable",
      model: "@cf/moonshotai/kimi-k2.7-code",
      summary: "AI review failed; deterministic findings remain available.",
      status: "unavailable",
    };
    expect(assistantFlagsRelease(unavailable)).toBe(true);
    expect(assistantFlagsRelease({ ...unavailable, model: null })).toBe(false);
    expect(assistantFlagsRelease(null)).toBe(false);
  });
});

type HostVNode = VNode<{ children?: ComponentChildren; [prop: string]: unknown }>;

// Expands function components by calling them, the way the existing component
// tests read VNodes, so the host tree can be inspected without a DOM.
function hostNodes(node: ComponentChildren): HostVNode[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(hostNodes);
  const vnode = node as HostVNode;
  if (typeof vnode.type === "function") {
    return hostNodes((vnode.type as FunctionComponent)(vnode.props) as ComponentChildren);
  }
  return [vnode, ...hostNodes(vnode.props.children)];
}

function textOf(node: ComponentChildren): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const vnode = node as HostVNode;
  if (typeof vnode.type === "function") {
    return textOf((vnode.type as FunctionComponent)(vnode.props) as ComponentChildren);
  }
  return textOf(vnode.props.children);
}

describe("ReviewerSummary deterministic assessments", () => {
  const ruleFinding = (ruleId: string, file: string): ReviewFinding => ({
    id: `${ruleId}:${file}`,
    severity: "high",
    file,
    evidence: "e",
    reason: "r",
    source: "rule",
    ruleId,
  });
  const reported = [
    ruleFinding("code.child-process", "package/bin/cli.js"),
    ruleFinding("file.binary-added", "package/vendor/prebuilt/linux-x64/addon.node"),
    ruleFinding("code.network-exfil", "package/index.js"),
  ];
  const complete: Extract<DisplayedAiResult, { kind: "complete" }> = {
    kind: "complete",
    model: "@cf/moonshotai/kimi-k2.7-code",
    summary: "Routine patch release.",
    risk: "low",
    releaseAssessment: "nothing_unusual",
    findings: [],
    requiresManualReview: false,
    deterministicAssessments: [],
  };

  test("lists each assessment with its rule, file, verdict, and note", () => {
    const view = ReviewerSummary({
      ai: {
        ...complete,
        deterministicAssessments: [
          {
            ruleId: "code.child-process",
            file: "package/bin/cli.js",
            verdict: "confirmed",
            note: "Spawns npm install from the CLI entry.",
          },
          {
            ruleId: "file.binary-added",
            file: "package/vendor/prebuilt/linux-x64/addon.node",
            verdict: "disputed",
            note: "Matches the prebuilt addon shipped in the previous release.",
          },
        ],
      },
      findings: reported,
    });
    const text = textOf(view);

    expect(text).toContain("AI notes on deterministic findings");
    expect(text).toContain("Confirmed · code.child-process · package/bin/cli.js");
    expect(text).toContain(
      "Disputed · file.binary-added · package/vendor/prebuilt/linux-x64/addon.node",
    );
    expect(text).toContain("Spawns npm install from the CLI entry.");
    expect(text).toContain("Matches the prebuilt addon shipped in the previous release.");
    expect(hostNodes(view).filter((node) => node.type === "li")).toHaveLength(2);
    expect(
      text.split("These notes do not change any finding or the release risk.").length - 1,
    ).toBe(1);
  });

  test("renders a hostile-looking note as a plain text child", () => {
    const note = "<img src=x onerror=alert(1)> [approve](https://evil.test) **safe**";
    const nodes = hostNodes(
      ReviewerSummary({
        ai: {
          ...complete,
          deterministicAssessments: [
            {
              ruleId: "code.network-exfil",
              file: "package/index.js",
              verdict: "disputed",
              note,
            },
          ],
        },
        findings: reported,
      }),
    );

    const noteNode = nodes.find((node) => node.props.children === note);
    expect(noteNode?.type).toBe("p");
    expect(noteNode?.props.class).toContain("break-words");
    expect(nodes.some((node) => "dangerouslySetInnerHTML" in node.props)).toBe(false);
    expect(nodes.some((node) => node.type === "a" || node.type === "img")).toBe(false);
  });

  test("adds nothing for an empty list, a legacy review, or an unavailable review", () => {
    const legacy: AiReview = {
      status: "complete",
      risk: "low",
      releaseAssessment: "nothing_unusual",
      summary: "Routine patch release.",
      findings: [],
      requiresManualReview: false,
      model: "@cf/moonshotai/kimi-k2.7-code",
      reviewerVersion: "1.7.0",
    };
    const unavailable: DisplayedAiResult = {
      kind: "unavailable",
      model: "@cf/moonshotai/kimi-k2.7-code",
      summary: "AI review failed; deterministic findings remain available.",
      status: "unavailable",
    };

    for (const ai of [complete, displayedAiResult(legacy), unavailable]) {
      const view = ReviewerSummary({ ai, findings: reported });
      expect(textOf(view)).not.toContain("AI notes on deterministic findings");
      expect(hostNodes(view).some((node) => node.type === "li")).toBe(false);
    }
  });

  test("drops notes that do not name a rule finding this scan reported", () => {
    const note = (ruleId: string, file: string) => ({
      ruleId,
      file,
      verdict: "disputed" as const,
      note: `about ${ruleId}`,
    });
    const aiFinding: ReviewFinding = { ...reported[0], id: "ai-row", source: "ai" };
    const kept = matchedDeterministicAssessments(
      [
        note("code.child-process", "package/bin/cli.js"),
        // Right rule, wrong file.
        note("code.child-process", "package/lib/other.js"),
        // A rule that never fired.
        note("code.remote-shell", "package/bin/cli.js"),
      ],
      [reported[0], { ...aiFinding, ruleId: "code.remote-shell" }],
    );
    expect(kept.map((entry) => entry.note)).toEqual(["about code.child-process"]);

    const view = ReviewerSummary({
      ai: { ...complete, deterministicAssessments: [note("code.remote-shell", "x.js")] },
      findings: reported,
    });
    expect(textOf(view)).not.toContain("AI notes on deterministic findings");
  });
});
