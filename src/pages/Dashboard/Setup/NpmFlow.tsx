import { useComputed, useModel, useSignal } from "@preact/signals";
import type { NpmConnectionModel } from "../../../models/npm-connection";
import type { StagedPublishesModel } from "../../../models/staged-publishes";
import { Alert, Badge, Button, Field, Input, Muted, CodeBlock } from "../../../components";
import { Checklist, StepCard } from "./StepCard";
import { npmStagedPublishWorkflow, npmTrustCommand, setupDefaults } from "./workflow-templates";

type Npm = ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
type StagedPublishes = ReturnType<typeof useModel<typeof StagedPublishesModel.prototype>>;

export function NpmFlow({ npm, stagedPublishes }: { npm: Npm; stagedPublishes: StagedPublishes }) {
  const packageName = useSignal("");
  const repositoryFullName = useSignal("");
  const workflowFilename = useSignal(setupDefaults.npmWorkflowFilename);

  const owner = useComputed(() => repositoryFullName.value.split("/", 2)[0]?.trim() ?? "");
  const repo = useComputed(() => repositoryFullName.value.split("/", 2)[1]?.trim() ?? "");

  const workflowYaml = useComputed(() =>
    npmStagedPublishWorkflow({
      packageName: packageName.value,
      environment: setupDefaults.npmEnvironment,
    }),
  );
  const trustCommand = useComputed(() =>
    npmTrustCommand({
      owner: owner.value,
      repo: repo.value,
      packageName: packageName.value,
      workflowFilename: workflowFilename.value,
      environment: setupDefaults.npmEnvironment,
    }),
  );

  const connected = npm.connection.value !== null;
  const validated = npm.validated.value;
  const discovery = stagedPublishes.lastResult.value;
  const discovered = discovery !== null && (discovery.found > 0 || discovery.created > 0);

  return (
    <div class="flex flex-col gap-4">
      <StepCard
        index="01"
        title="Connect npm for staged-publish discovery"
        status={validated ? "done" : "todo"}
        summary="Drydock lists your staged publishes with a read-only npm token. It never publishes, and the token never reaches the sandbox."
      >
        <NpmConnectStep npm={npm} connected={connected} validated={validated} />
      </StepCard>

      <StepCard
        index="02"
        title="Add the staged-publish workflow"
        status="manual"
        summary="A tag-triggered GitHub Actions workflow that stages the selected package tarball(s) through npm trusted publishing (OIDC). No NPM_TOKEN — only the gated stage job can mint the OIDC token."
      >
        <Field label="Published package name(s)" for="npmFlowPackage">
          <Input
            id="npmFlowPackage"
            type="text"
            value={packageName.value}
            placeholder="@scope/pkg or @scope/a, @scope/b"
            onInput={(e) => (packageName.value = (e.target as HTMLInputElement).value)}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        <CodeBlock
          label={`.github/workflows/${workflowFilename.value}`}
          code={workflowYaml.value}
        />
        <Muted class="text-[12px] leading-[1.55] m-0">
          Commit this to{" "}
          <code class="font-mono text-ink-subtle">.github/workflows/{workflowFilename.value}</code>.
          Pushing a <code class="font-mono text-ink-subtle">v*</code> tag builds the tarball with no
          credentials, then the <code class="font-mono text-ink-subtle">stage</code> job (gated by
          the <code class="font-mono text-ink-subtle">{setupDefaults.npmEnvironment}</code>{" "}
          environment) stages it. In monorepos, enter multiple package names separated by commas;
          the workflow stages only the tarballs whose package identities match that list. For
          supply-chain hardening, pin each action to a commit SHA.
        </Muted>
      </StepCard>

      <StepCard
        index="03"
        title="Configure npm package trust as stage-only"
        status="manual"
        summary="On npm, trust this repo + workflow for staged publishing only, and lock each package down so OIDC can stage but can never bypass review to publish."
      >
        <Field label="Repository (owner/repo)" for="npmFlowRepo">
          <Input
            id="npmFlowRepo"
            type="text"
            value={repositoryFullName.value}
            placeholder="owner/repo"
            onInput={(e) => (repositoryFullName.value = (e.target as HTMLInputElement).value)}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        <CodeBlock label="npm trust (stage-only)" code={trustCommand.value} />
        <Checklist
          items={[
            <>
              Each trusted publisher is <strong>stage-only</strong> —{" "}
              <code class="font-mono text-ink-subtle">--allow-stage-publish</code> with{" "}
              <code class="font-mono text-ink-subtle">--no-allow-publish</code> — so OIDC can stage
              but never publish directly.
            </>,
            <>
              Require <strong>2FA</strong> for the public publish so a maintainer approves the
              release after Drydock's review.
            </>,
            <>
              Disallow long-lived tokens for publishing — staged publishing through trusted
              publishing replaces <code class="font-mono text-ink-subtle">NPM_TOKEN</code> entirely.
            </>,
            <>
              The workflow filename and environment here must match the workflow from step 02 (
              <code class="font-mono text-ink-subtle">{workflowFilename.value}</code> /{" "}
              <code class="font-mono text-ink-subtle">{setupDefaults.npmEnvironment}</code>).
            </>,
          ]}
        />
        <Muted class="text-[12px] leading-[1.55] m-0">
          GitHub YAML alone does not enable trusted publishing — run the commands above (npm{" "}
          <code class="font-mono text-ink-subtle">≥ 11.15.0</code>) before the workflow first fires.
        </Muted>
      </StepCard>

      <StepCard
        index="04"
        title="Verify a staged publish is discoverable"
        status={discovered ? "done" : "todo"}
        summary="Push a v* tag to stage a release, then have Drydock check npm. A discovered staged publish confirms the token reaches the staging endpoints."
      >
        <VerifyStep stagedPublishes={stagedPublishes} ready={validated} />
      </StepCard>
    </div>
  );
}

function NpmConnectStep({
  npm,
  connected,
  validated,
}: {
  npm: Npm;
  connected: boolean;
  validated: boolean;
}) {
  const status = npm.status.value;
  const busy = npm.busy.value;
  const token = npm.token.value;
  const error = npm.error.value;
  const connection = npm.connection.value;

  const onSave = async (event: Event) => {
    event.preventDefault();
    await npm.save();
  };

  return (
    <>
      <div class="flex items-center gap-2">
        {validated ? (
          <Badge tone="ok">connected · validated</Badge>
        ) : connected ? (
          <Badge tone="info">connected · {connection?.validationStatus ?? "unvalidated"}</Badge>
        ) : (
          <Badge tone="neutral">not connected</Badge>
        )}
      </div>

      <Checklist
        items={[
          "Granular access token, read-only.",
          "Scoped to only the packages you stage.",
          "Short expiry with a rotation plan.",
        ]}
      />

      <form
        class="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end"
        onSubmit={onSave}
      >
        <Field label={connected ? "Rotate npm token" : "npm token"} for="npmFlowToken">
          <Input
            id="npmFlowToken"
            type="password"
            value={token}
            placeholder={connected ? "Paste a new token to rotate" : "npm_..."}
            onInput={(e) => (npm.token.value = (e.target as HTMLInputElement).value)}
            disabled={busy}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        <Button type="submit" disabled={busy || !token.trim()} class="shrink-0">
          {status === "saving"
            ? "Saving…"
            : status === "validating"
              ? "Checking…"
              : connected
                ? "Rotate"
                : "Connect"}
        </Button>
      </form>

      {connected ? (
        <div class="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => void npm.validate()} disabled={busy}>
            {status === "validating" ? "Checking…" : "Re-check access"}
          </Button>
          <Muted class="text-[12px] m-0">
            Saving runs the npm auth check automatically. We don't keep the release archive.
          </Muted>
        </div>
      ) : (
        <Muted class="text-[12px] m-0">
          Create one in{" "}
          <a
            class="underline"
            href="https://docs.npmjs.com/creating-and-viewing-access-tokens/"
            target="_blank"
            rel="noreferrer"
          >
            npm access token settings
          </a>
          .
        </Muted>
      )}

      {error ? <Alert tone="critical">{error}</Alert> : null}
    </>
  );
}

function VerifyStep({
  stagedPublishes,
  ready,
}: {
  stagedPublishes: StagedPublishes;
  ready: boolean;
}) {
  const refreshing = stagedPublishes.refreshing.value;
  const error = stagedPublishes.error.value;
  const result = stagedPublishes.lastResult.value;

  return (
    <>
      <div class="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void stagedPublishes.discover()}
          disabled={refreshing || !ready}
        >
          {refreshing ? "Checking…" : "Check npm"}
        </Button>
        {!ready ? (
          <Muted class="text-[12px] m-0">Connect and validate npm in step 01 first.</Muted>
        ) : null}
      </div>

      {error ? <Alert tone="critical">{error}</Alert> : null}

      {result && !error ? (
        result.found > 0 || result.created > 0 ? (
          <Alert tone="ok">
            Found {result.found} staged publish{result.found === 1 ? "" : "es"}
            {result.created > 0
              ? ` · started ${result.created} review${result.created === 1 ? "" : "s"}`
              : ""}
            . They'll show up on your dashboard.
          </Alert>
        ) : (
          <Muted class="text-[13px] m-0">
            No open staged publishes yet. Push a <code class="font-mono text-ink-subtle">v*</code>{" "}
            tag to run the workflow, then check again.
          </Muted>
        )
      ) : null}
    </>
  );
}
