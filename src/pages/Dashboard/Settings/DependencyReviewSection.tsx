import type { ComponentChildren } from "preact";
import { DependencyReviewsModel } from "../../../models/dependency-review";
import {
  DEPENDENCY_REVIEWS_PATH,
  POLICY_SWITCHES,
  RELEASE_RISK_THRESHOLDS,
} from "../../../features/dependency-review/wording";
import type { RiskLevel } from "../../../../server/lib/review/types";
import { Alert } from "../../../components/Alert";
import { Button, LinkButton } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody, SettingsCardHeader } from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { LoadingLine, MonoLabel, Muted } from "../../../components/Typography";
import { SETTINGS_SECTION, settingsTabHref } from "./settings-links";

export function DependencyReviewSection({
  model,
  defaultOpen = false,
}: {
  model: InstanceType<typeof DependencyReviewsModel>;
  defaultOpen?: boolean;
}) {
  const loaded = model.loaded.value;
  const saved = model.saved.value;
  const loadError = model.error.value;

  return (
    <CollapsibleCard
      title="Dependency review"
      defaultOpen={defaultOpen}
      aside={saved ? <MonoLabel>{saved.enabled ? "on" : "off"}</MonoLabel> : null}
    >
      <SettingsCardBody>
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div class="flex flex-col gap-2 max-w-[600px]">
            <Muted class="text-[13px] m-0">
              Drydock reviews Dependabot and Renovate pull requests and posts a{" "}
              <span class="font-medium text-ink">Drydock dependency review</span> check. Clean
              version bumps pass; a bump that adds a capability is held until someone with write
              access to the repository approves it on the check. An approval covers that exact
              version change in that repository, including after a rebase.
            </Muted>
            <Muted class="text-[12px] m-0">
              The GitHub App needs Checks (write), Pull requests (read), and Contents (read)
              permissions and the Pull request and Check run events.
            </Muted>
          </div>
          <LinkButton
            href={DEPENDENCY_REVIEWS_PATH}
            variant="secondary"
            class="shrink-0 self-start"
          >
            Recent reviews
          </LinkButton>
        </div>

        {!loaded ? (
          <LoadingLine size="inline">loading dependency review settings</LoadingLine>
        ) : null}
        {loadError ? <Alert tone="critical">{loadError}</Alert> : null}
        {loaded && saved && !model.githubAppInstalled.value ? (
          <Alert tone="warn">
            Dependency review runs through the GitHub App. Install it in the{" "}
            <a
              class="underline text-accent"
              href={settingsTabHref("integrations", SETTINGS_SECTION.githubApp)}
            >
              GitHub App section
            </a>{" "}
            first.
          </Alert>
        ) : null}
      </SettingsCardBody>

      {saved ? <DependencyReviewForm model={model} /> : null}
    </CollapsibleCard>
  );
}

function DependencyReviewForm({ model }: { model: InstanceType<typeof DependencyReviewsModel> }) {
  const canManage = model.canManage.value;
  const saving = model.saving.value;
  const disabled = !canManage || saving;
  const enabled = model.draftEnabled.value;
  const policy = model.draftPolicy.value;
  const dirty = model.dirty.value;
  const saveError = model.saveError.value;

  const onSubmit = (event: Event) => {
    event.preventDefault();
    if (canManage && dirty) void model.save();
  };

  return (
    <form onSubmit={onSubmit}>
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Checkbox
          checked={enabled}
          disabled={disabled}
          onChange={(value) => model.setEnabled(value)}
        >
          <span class="text-ink">Review dependency update pull requests</span>
        </Checkbox>
      </SettingsCardBody>

      <SettingsCardHeader title="Hold an update that" />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <div role="group" aria-label="Hold an update that" class="flex flex-col gap-3">
          {POLICY_SWITCHES.map((entry) => (
            <Checkbox
              key={entry.key}
              checked={policy[entry.key]}
              disabled={disabled}
              onChange={(value) => model.setPolicy(entry.key, value)}
            >
              <span class="text-ink">{entry.label}</span>
              {entry.hint ? (
                <span class="block text-[12px] text-ink-muted">{entry.hint}</span>
              ) : null}
            </Checkbox>
          ))}
        </div>
        <Field label="Or reaches release risk" for="dependencyReviewRisk" class="max-w-[260px]">
          <Select
            id="dependencyReviewRisk"
            value={policy.holdAtReleaseRisk ?? ""}
            disabled={disabled}
            onChange={(value) =>
              model.setPolicy("holdAtReleaseRisk", value ? (value as RiskLevel) : null)
            }
          >
            {RELEASE_RISK_THRESHOLDS.map((option) => (
              <option key={option.value ?? "off"} value={option.value ?? ""}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </SettingsCardBody>

      <SettingsCardHeader title="Self-hosted Renovate" />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Field label="Extra bot logins" for="dependencyReviewBots">
          <Input
            id="dependencyReviewBots"
            mono
            value={model.draftBotLogins.value}
            placeholder="my-renovate[bot]"
            spellcheck={false}
            autocomplete="off"
            disabled={disabled}
            onInput={(e) => model.setBotLogins((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Muted class="text-[12px] m-0">
          dependabot[bot] and renovate[bot] are recognized already. List any other GitHub logins
          that open dependency update pull requests, separated by commas, up to 10.
        </Muted>

        {saveError ? <Alert tone="critical">{saveError}</Alert> : null}

        {canManage ? (
          <div class="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save dependency review"}
            </Button>
            {dirty && !saving ? (
              <Button variant="ghost" onClick={() => model.discard()}>
                Discard changes
              </Button>
            ) : null}
            {model.justSaved.value && !dirty ? (
              <span class="font-mono text-[12px] text-ink-muted">Saved.</span>
            ) : null}
          </div>
        ) : (
          <Muted class="text-[13px] m-0">
            Only organization owners and admins can change dependency review settings.
          </Muted>
        )}
      </SettingsCardBody>
    </form>
  );
}

function Checkbox({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  children: ComponentChildren;
}) {
  return (
    <label class="flex items-start gap-2 text-[13px] cursor-pointer has-[:disabled]:cursor-not-allowed">
      <input
        type="checkbox"
        class="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span>{children}</span>
    </label>
  );
}
