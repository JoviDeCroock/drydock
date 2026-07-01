import { useEffect } from "preact/hooks";
import { useModel, useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { sessionModel } from "../../models/auth";
import {
  GithubAppModel,
  type CallbackError,
  type GithubAppCallbackErrorCode,
} from "../../models/github-app";
import { Alert } from "../../components/Alert";
import { LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { LoadingState } from "../../components/Loading";
import { PageShell } from "../../components/PageShell";
import { Eyebrow, MonoDetail, Muted, SectionLabel } from "../../components/Typography";
import { UserMenu } from "../../components/UserMenu";

const SETTINGS_PATH = "/dashboard/settings";
const SUCCESS_REDIRECT_MS = 1500;

type CallbackPhase = "checking-session" | "verifying" | "success" | "error";

export default function GithubAppCallbackPage() {
  const location = useLocation();
  const githubApp = useModel(GithubAppModel);
  const phase = useSignal<CallbackPhase>("checking-session");
  const queryError = useSignal<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await sessionModel.load();
      if (cancelled) return;
      if (!data) {
        // Preserve return path so the user lands back here after login.
        const returnTo = `${SETTINGS_PATH}/github-app/callback${window.location.search}`;
        location.route(`/login?returnTo=${encodeURIComponent(returnTo)}`, true);
        return;
      }

      const parsed = parseCallbackQuery(window.location.search);
      if (typeof parsed === "string") {
        queryError.value = parsed;
        phase.value = "error";
        return;
      }
      phase.value = "verifying";
      const installation = await githubApp.completeInstall(parsed);
      if (cancelled) return;
      if (installation) {
        phase.value = "success";
        window.setTimeout(() => {
          if (cancelled) return;
          location.route(SETTINGS_PATH, true);
        }, SUCCESS_REDIRECT_MS);
      } else {
        phase.value = "error";
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const user = sessionModel.user.value;
  const callbackError = githubApp.callbackError.value;
  const lastLinked = githubApp.lastLinked.value;

  const onSignOut = async () => {
    await sessionModel.signOut();
    location.route("/", true);
  };

  return (
    <PageShell
      headerActions={
        user ? <UserMenu email={user.email} name={user.name} onSignOut={onSignOut} /> : undefined
      }
    >
      <header class="flex flex-col gap-2 max-w-[640px]">
        <Eyebrow>GitHub App install</Eyebrow>
        <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">
          {phase.value === "success"
            ? "Installation linked"
            : phase.value === "error"
              ? "Installation could not be linked"
              : "Finishing GitHub App install"}
        </h1>
        <Muted class="text-[14px] leading-[1.55] m-0">
          We're confirming the install with GitHub and storing the installation against your active
          organization.
        </Muted>
      </header>

      {(phase.value === "checking-session" || phase.value === "verifying") && (
        <LoadingState
          title={
            phase.value === "checking-session" ? "Confirming session" : "Verifying with GitHub"
          }
          detail={
            phase.value === "checking-session"
              ? "loading user"
              : "exchanging code · linking installation"
          }
        />
      )}

      {phase.value === "success" && lastLinked ? (
        <Card as="section" class="p-5 flex flex-col gap-4">
          <SectionLabel>Linked installation</SectionLabel>
          <div class="flex flex-col gap-2">
            <span class="font-mono text-[16px] font-medium">{lastLinked.accountLogin}</span>
            <MonoDetail
              parts={[
                <span key="installation">installation {lastLinked.installationId}</span>,
                <span key="status">{lastLinked.status}</span>,
                <span key="account">{lastLinked.accountType.toLowerCase()}</span>,
              ]}
            />
          </div>
          <Muted class="text-[13px] m-0">Returning you to settings…</Muted>
          <div>
            <LinkButton variant="secondary" size="sm" href={SETTINGS_PATH}>
              Back to settings now
            </LinkButton>
          </div>
        </Card>
      ) : null}

      {phase.value === "error" ? (
        <Card as="section" class="p-5 flex flex-col gap-4">
          <SectionLabel>What went wrong</SectionLabel>
          <CallbackErrorView queryError={queryError.value} callbackError={callbackError} />
          <div class="flex gap-2 flex-wrap">
            <LinkButton href={SETTINGS_PATH}>Back to settings</LinkButton>
            <LinkButton variant="ghost" href="/dashboard">
              Go to dashboard
            </LinkButton>
          </div>
        </Card>
      ) : null}
    </PageShell>
  );
}

function CallbackErrorView({
  queryError,
  callbackError,
}: {
  queryError: string | null;
  callbackError: CallbackError | null;
}) {
  if (queryError) {
    return (
      <Alert tone="critical">
        <div class="flex flex-col gap-1.5">
          <span>{queryError}</span>
          <span class="font-mono text-[12px] text-ink-muted">code: invalid_callback_url</span>
        </div>
      </Alert>
    );
  }
  if (!callbackError) {
    return <Alert tone="critical">Installation could not be linked.</Alert>;
  }
  const tone = callbackError.code === "github_app_not_configured" ? "warn" : "critical";
  return (
    <Alert tone={tone}>
      <div class="flex flex-col gap-1.5">
        <span>{describeCallbackError(callbackError.code)}</span>
        <span class="font-mono text-[12px] text-ink-muted">
          code: {callbackError.code} · {callbackError.message}
        </span>
      </div>
    </Alert>
  );
}

function describeCallbackError(code: GithubAppCallbackErrorCode): string {
  switch (code) {
    case "github_app_not_configured":
      return "GitHub App is not configured yet on this Drydock instance. Ask the operator to add the GitHub App secrets.";
    case "installation_missing":
      return "GitHub returned an installation id we couldn't resolve. Try installing again from the settings page.";
    case "installation_inactive":
      return "The installation exists but is suspended on GitHub. Re-enable it on GitHub and link it again.";
    case "installation_not_authorized":
      return "The signed-in GitHub user does not have access to that installation. Pick an account they own and retry.";
    case "installation_not_active":
      return "GitHub reported the installation isn't active yet. Approve the install on GitHub, then try again.";
    case "invalid_input":
      return "GitHub redirected back with missing or malformed parameters. Start the install again from settings.";
    case "state_invalid":
      return "The install link expired or was tampered with. Start the install again from settings.";
    case "state_org_mismatch":
      return "Your active organization changed during the install. Switch back to the original organization and retry.";
    case "state_user_mismatch":
      return "The signed-in user doesn't match the user who started the install. Sign in as that user and retry.";
    case "unknown":
      return "Something went wrong while linking the installation. Try again or contact the operator.";
  }
}

function parseCallbackQuery(
  search: string,
): { state: string; code: string; installationId: string; setupAction: string } | string {
  const params = new URLSearchParams(search);
  const state = params.get("state")?.trim() ?? "";
  const code = params.get("code")?.trim() ?? "";
  const installationId = params.get("installation_id")?.trim() ?? "";
  const setupAction = params.get("setup_action")?.trim() ?? "install";

  if (!state)
    return "GitHub did not return an install state token. Restart the install from settings.";
  if (!installationId)
    return "GitHub did not return an installation id. Restart the install from settings.";
  if (!code) {
    return "GitHub did not return a user authorization code. Check that the GitHub App has 'Request user authorization (OAuth) during installation' enabled.";
  }
  if (setupAction === "request") {
    return "Your install is pending an organization owner's approval. Once approved, GitHub will redirect you back here automatically.";
  }
  return { state, code, installationId, setupAction };
}
