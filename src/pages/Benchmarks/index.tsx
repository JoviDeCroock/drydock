import report from "../../features/public-content/incident-benchmark-v1.json";
import { Badge, severityTone } from "../../components/Badge";
import { LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { PageShell } from "../../components/PageShell";
import { MonoDetail, SectionLabel } from "../../components/Typography";
import {
  ContentArticleEvidence,
  ContentArticleHero,
  ContentArticleLinks,
  ContentArticleSections,
} from "../../features/public-content/ContentArticle";
import { incidentBenchmarkSeo, PageSeo } from "../../lib/seo";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

const REPOSITORY_URL = "https://github.com/JoviDeCroock/drydock";
const REPORT_PATH = "/benchmarks/shai-hulud-nx/v1.json";
const INCIDENTS = [
  { id: "shai-hulud", title: "Shai-Hulud" },
  { id: "nx", title: "Nx" },
] as const;

type BenchmarkCase = (typeof report.cases)[number];

function caseOutcome(testCase: BenchmarkCase) {
  if (testCase.verdict === "malicious") {
    return testCase.caught
      ? { short: "Caught", detail: "Caught: high release risk and required rule evidence" }
      : {
          short: "Missed",
          detail: "Missed: release risk or required rule evidence is below the benchmark threshold",
        };
  }
  return testCase.falsePositive
    ? { short: "False positive", detail: "False positive: release risk reaches medium or above" }
    : { short: "Control passes", detail: "Control passes: release risk remains below medium" };
}

function caseAnchor(testCase: BenchmarkCase) {
  return `case-${testCase.id}`;
}

/* Artifact risk is whole-package context the benchmark does not score, so it
   stays plain text; only release risk, the measured value, gets a severity
   Badge. A red HIGH on a passing control otherwise reads as a failure. */
function ArtifactRisk({ risk }: { risk: string }) {
  return <span class="font-mono text-[12px] uppercase text-ink-muted">{risk}</span>;
}

function CaseSummary() {
  return (
    <Card as="section" padding="none" class="flex flex-col">
      <div class="px-5 py-4">
        <SectionLabel as="h2" aside={`${report.cases.length} cases`}>
          Cases at a glance
        </SectionLabel>
      </div>
      {/* Four columns squeeze case titles into one-word stacks on a phone, so
          narrow screens get the same facts as one stacked entry per case. */}
      <ul class="m-0 flex list-none flex-col p-0 sm:hidden">
        {report.cases.map((testCase) => (
          <li key={testCase.id} class="flex flex-col gap-1.5 border-t border-border px-5 py-3">
            <a href={`#${caseAnchor(testCase)}`} class="text-[14px] text-ink">
              {testCase.title}
            </a>
            <span class="font-mono text-[11px] text-ink-subtle">
              {testCase.verdict === "malicious" ? "Malicious model" : "Benign control"} ·{" "}
              <span class="text-ink">{caseOutcome(testCase).short}</span>
            </span>
            <span class="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-subtle">
              <span>release risk</span>
              <Badge tone={severityTone(testCase.releaseRisk)}>{testCase.releaseRisk}</Badge>
              <span aria-hidden>·</span>
              <span>artifact risk</span>
              <ArtifactRisk risk={testCase.artifactRisk} />
            </span>
          </li>
        ))}
      </ul>
      <div class="hidden overflow-x-auto sm:block">
        <table class="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              <th scope="col" class="px-5 pb-2 font-normal">
                Case
              </th>
              <th scope="col" class="px-3 pb-2 font-normal whitespace-nowrap">
                Release risk
              </th>
              <th scope="col" class="px-3 pb-2 font-normal whitespace-nowrap">
                Artifact risk
              </th>
              <th scope="col" class="px-5 pb-2 font-normal">
                Outcome
              </th>
            </tr>
          </thead>
          <tbody>
            {report.cases.map((testCase) => (
              <tr key={testCase.id} class="border-t border-border align-top">
                <th scope="row" class="px-5 py-3 font-normal">
                  <a href={`#${caseAnchor(testCase)}`} class="text-ink">
                    {testCase.title}
                  </a>
                  <span class="block font-mono text-[11px] text-ink-subtle">
                    {testCase.verdict === "malicious" ? "Malicious model" : "Benign control"}
                  </span>
                </th>
                <td class="px-3 py-3">
                  <Badge tone={severityTone(testCase.releaseRisk)}>{testCase.releaseRisk}</Badge>
                </td>
                <td class="px-3 py-3">
                  <ArtifactRisk risk={testCase.artifactRisk} />
                </td>
                <td class="px-5 py-3 text-ink">{caseOutcome(testCase).short}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function CaseEvidence({ testCase }: { testCase: BenchmarkCase }) {
  const result = caseOutcome(testCase).detail;
  const findingCount = testCase.findings.length;

  return (
    <div id={caseAnchor(testCase)} class="scroll-mt-6">
      <Card as="article" padding="none" class="flex flex-col">
        <div class="px-5 py-4 flex flex-col gap-3">
          <MonoDetail
            parts={[testCase.verdict === "malicious" ? "Malicious model" : "Benign control"]}
          />
          <h3 class="m-0 text-base font-medium tracking-[-0.005em]">{testCase.title}</h3>
          <p class="m-0 max-w-[680px] text-[13px] text-ink-muted leading-[1.55]">
            {testCase.provenance}
          </p>
          <p class="m-0 text-[13px] text-ink-muted">{result}</p>
          <dl class="m-0 flex flex-wrap gap-x-6 gap-y-3 text-[13px]">
            <div class="flex items-center gap-2">
              <dt class="text-ink-muted">Release risk</dt>
              <dd class="m-0">
                <Badge tone={severityTone(testCase.releaseRisk)}>{testCase.releaseRisk}</Badge>
              </dd>
            </div>
            <div class="flex items-center gap-2">
              <dt class="text-ink-muted">Artifact risk</dt>
              <dd class="m-0">
                <ArtifactRisk risk={testCase.artifactRisk} />
              </dd>
            </div>
          </dl>
        </div>
        <div class="px-5 py-4 flex flex-col gap-3">
          <SectionLabel
            as="p"
            aside={`${findingCount} ${findingCount === 1 ? "finding" : "findings"}`}
          >
            Rule evidence
          </SectionLabel>
          {testCase.requiredRuleIds.length ? (
            <p class="m-0 max-w-[680px] text-[13px] text-ink-muted leading-[1.55]">
              Required on the release change:{" "}
              {testCase.requiredRuleIds.map((ruleId, index) => (
                <span key={ruleId}>
                  {index ? ", " : ""}
                  <code class="text-[12px] break-all">{ruleId}</code>
                </span>
              ))}
              .
            </p>
          ) : null}
          {testCase.findings.length ? (
            <ul class="m-0 p-0 list-none flex flex-col gap-4">
              {testCase.findings.map((finding, index) => (
                <li
                  key={`${finding.ruleId}-${finding.filePath}-${index}`}
                  class="flex flex-col gap-2"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
                    <code class="text-[12px] break-all">{finding.ruleId}</code>
                  </div>
                  <p class="m-0 font-mono text-[11px] text-ink-subtle break-all">
                    {finding.filePath ?? "Package metadata"} ·{" "}
                    {finding.releaseDelta ? "release change" : "package context"}
                  </p>
                  <p class="m-0 max-w-[680px] text-[13px] text-ink-muted leading-[1.55]">
                    {finding.message}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p class="m-0 text-[13px] text-ink-muted">No deterministic findings.</p>
          )}
        </div>
        <div class="border-t border-border px-5 py-4 flex flex-col gap-2">
          <a href={`${REPOSITORY_URL}/blob/main/${testCase.fixturePath}`} class="text-[13px]">
            Inspect the fixture →
          </a>
          <p class="m-0 font-mono text-[11px] text-ink-subtle break-all">
            Fixture SHA-256: {testCase.fixtureSha256}
          </p>
        </div>
      </Card>
    </div>
  );
}

export default function IncidentBenchmarkPage() {
  const authed = useAuthedSession();
  const { malicious, benign } = report.summary;
  const citation = `Drydock's sanitized Shai-Hulud and Nx behavior-reconstruction benchmark v${report.suiteVersion}, using deterministic rules ${report.rulesVersion}, caught ${malicious.caught} of ${malicious.total} malicious models at high release risk or above with required credential-access and process-execution evidence; ${benign.falsePositives} of ${benign.total} benign controls also reached medium release risk or above, counted as false positives (${report.evaluatedOn}; corpus SHA-256 ${report.corpusSha256}).`;

  return (
    <PageShell
      width="doc"
      class="gap-12"
      headerActions={<MarketingHeaderActions authed={authed} />}
    >
      <PageSeo metadata={incidentBenchmarkSeo} />
      <ContentArticleHero
        heading="Shai-Hulud and Nx: a reproducible detection benchmark."
        lead={`Inspect ${malicious.total} sanitized behavior reconstructions and ${benign.total} benign controls, with the release risk and exact rule evidence for each. These models represent documented attack techniques; they are not the original compromised tarballs.`}
        details={[
          `Suite ${report.suiteVersion}`,
          `Rules ${report.rulesVersion}`,
          report.evaluatedOn,
        ]}
        actions={
          <>
            <LinkButton href="#results">Read the results</LinkButton>
            <LinkButton
              href={REPORT_PATH}
              download="drydock-shai-hulud-nx-v1.json"
              variant="secondary"
            >
              Download JSON
            </LinkButton>
            <LinkButton href="#citation" variant="ghost">
              Cite this benchmark
            </LinkButton>
          </>
        }
      />
      <ContentArticleEvidence
        label="Measured results"
        rows={[
          {
            label: "Malicious models",
            value: `${malicious.caught}/${malicious.total} caught at high release risk or above with required rule evidence; ${malicious.missed} missed`,
          },
          {
            label: "Benign controls",
            value: `${benign.falsePositives}/${benign.total} false positives at medium release risk or above`,
          },
          { label: "Reviewer", value: "Deterministic rules only; no AI review" },
        ]}
      />
      <CaseSummary />
      <ContentArticleSections
        sections={[
          {
            label: "Method",
            heading: "Compare release changes with the production detector.",
            body: report.methodology,
          },
          {
            label: "Reading the results",
            heading: "Release risk separates changes from existing package context.",
            body: "A malicious model counts as caught when its release risk reaches high and the required credential-access and process-execution rules match the release change. The models retain existing install hooks in their baselines. Parsed command comparison keeps unchanged hooks as package context. Payload changes and newly install-reachable code still contribute to release risk. A benign control counts as a false positive when its release risk reaches medium. Artifact risk describes the whole package, including unchanged capabilities. Higher risk asks a human to review the release; it does not classify the package as malicious or prove an actual workflow rejection.",
          },
        ]}
      />
      <section id="results" class="scroll-mt-6 flex flex-col gap-10">
        <SectionLabel as="h2">Case results</SectionLabel>
        {INCIDENTS.map((incident) => (
          <section key={incident.id} class="flex flex-col gap-5">
            <h2 class="m-0 text-2xl font-semibold tracking-[-0.015em]">{incident.title}</h2>
            {report.cases
              .filter((testCase) => testCase.incident === incident.id)
              .map((testCase) => (
                <CaseEvidence key={testCase.id} testCase={testCase} />
              ))}
            <div class="flex flex-col gap-2">
              <p class="m-0 text-[13px] text-ink-muted">Primary incident sources:</p>
              {report.sources
                .filter((source) => source.id.startsWith(incident.id))
                .map((source) => (
                  <p key={source.id} class="m-0 max-w-[680px] text-[13px] leading-[1.55]">
                    <a href={source.url}>{source.title}</a>
                    <span class="text-ink-subtle"> · {source.publishedOn}</span>
                  </p>
                ))}
            </div>
          </section>
        ))}
      </section>
      <section class="flex flex-col gap-4">
        <SectionLabel as="h2">Limits of this result</SectionLabel>
        <ul class="m-0 pl-5 max-w-[680px] flex flex-col gap-3 text-[14px] text-ink-muted leading-[1.65] list-disc marker:text-ink-subtle">
          {report.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </section>
      <section class="flex flex-col gap-4">
        <SectionLabel as="h2">Reproduce the result</SectionLabel>
        <p class="m-0 max-w-[680px] text-[14px] text-ink-muted leading-[1.65]">
          Run the benchmark from the Drydock repository. The JSON report records the fixture hashes
          and detector revision; package payloads are inspected as data and never executed.
        </p>
        <Card as="div" padding="compact">
          <code class="block text-[13px] break-all">pnpm run benchmark:incidents</code>
        </Card>
        <p class="m-0 max-w-[680px] text-[13px] leading-[1.55]">
          <a href={`${REPOSITORY_URL}/tree/${report.engineRevision}/server/lib/review`}>
            Inspect the pinned detection engine
          </a>
          {" · "}
          <a href={REPORT_PATH} download="drydock-shai-hulud-nx-v1.json">
            Download the versioned JSON report
          </a>
          {" · "}
          <a
            href="/benchmarks/shai-hulud-nx/v1-rules-1.47.0.json"
            download="drydock-shai-hulud-nx-v1-rules-1.47.0.json"
          >
            Earlier rules 1.47.0 results
          </a>
        </p>
      </section>
      <section id="citation" class="scroll-mt-6 flex flex-col gap-4">
        <SectionLabel as="h2">Cite this benchmark</SectionLabel>
        <p class="m-0 max-w-[680px] text-[14px] text-ink-muted leading-[1.65]">
          This sentence describes the measured models and controls. Link it to this section so
          readers can inspect the evidence and limitations.
        </p>
        <Card as="div" padding="compact">
          <blockquote class="m-0 max-w-[680px] text-[14px] leading-[1.65] break-words">
            {citation}
          </blockquote>
        </Card>
        <a href="/benchmarks/shai-hulud-nx#citation" class="font-mono text-[12px] break-all">
          drydock.org/benchmarks/shai-hulud-nx#citation
        </a>
      </section>
      <ContentArticleLinks
        label="Inspect your own release"
        links={[
          {
            href: "/diff",
            title: "Diff a package",
            description: "Compare published package versions without installing them.",
          },
          {
            href: "/docs",
            title: "Review before publication",
            description: "Set up artifact review for your next release.",
          },
        ]}
      />
    </PageShell>
  );
}
