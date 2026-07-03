import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { rememberDashboardReturnUrl } from "../../../lib/query-state";
import { sessionModel } from "../../../models/auth";
import { LinkButton } from "../../../components/Button";
import { SettingsCard } from "../../../components/Card";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { Eyebrow, MonoDetail, Muted, SectionLabel } from "../../../components/Typography";
import { UserMenu } from "../../../components/UserMenu";
import { TwoFactorSection } from "./TwoFactorSection";
import { DeleteAccountSection } from "./DeleteAccountSection";

export default function AccountPage() {
  const location = useLocation();
  const sessionChecked = useSignal(false);

  useEffect(() => {
    rememberDashboardReturnUrl(location.url);
  }, [location.url]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await sessionModel.load();
      if (cancelled) return;
      if (!data) {
        location.route("/login", true);
        return;
      }
      sessionChecked.value = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSignOut = async () => {
    await sessionModel.signOut();
    location.route("/", true);
  };

  if (!sessionChecked.value) {
    return (
      <PageShell width="doc">
        <AccountHeader />
        <LoadingState title="Opening account" detail="confirming session" />
      </PageShell>
    );
  }

  const user = sessionModel.user.value;

  return (
    <PageShell
      width="doc"
      headerActions={
        <>
          <LinkButton variant="ghost" size="sm" href="/dashboard">
            Dashboard
          </LinkButton>
          <UserMenu email={user?.email} name={user?.name} onSignOut={onSignOut} />
        </>
      }
    >
      <AccountHeader />

      <div class="flex flex-col gap-6">
        <SettingsCard class="flex flex-col gap-1.5">
          <SectionLabel>Profile</SectionLabel>
          {user?.name ? <span class="text-[14px] font-medium text-ink">{user.name}</span> : null}
          <MonoDetail parts={[user?.email ? <span key="email">{user.email}</span> : null]} />
        </SettingsCard>

        <TwoFactorSection />

        <DeleteAccountSection onDeleted={() => location.route("/", true)} />
      </div>
    </PageShell>
  );
}

function AccountHeader() {
  return (
    <header class="flex flex-col gap-2 max-w-[640px]">
      <Eyebrow>Account</Eyebrow>
      <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Account settings</h1>
      <Muted class="text-[14px] leading-[1.55] m-0">
        Manage the security of your personal account. These settings apply to you across every
        organization.
      </Muted>
    </header>
  );
}
