import { useComputed } from "@preact/signals";
import { useLocation } from "preact-iso";
import { sessionModel, signInMethodsModel } from "../../../models/auth";
import { useAuthedDashboardSession } from "../../../features/account/useAuthedDashboardSession";
import { LinkButton } from "../../../components/Button";
import { SettingsCard } from "../../../components/Card";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { MonoDetail, Muted, SectionLabel } from "../../../components/Typography";
import { UserMenu } from "../../../components/UserMenu";
import { TwoFactorSection } from "./TwoFactorSection";
import { DeleteAccountSection } from "./DeleteAccountSection";

export default function AccountPage() {
  const location = useLocation();
  const sessionChecked = useAuthedDashboardSession({
    onReady: (session) => signInMethodsModel.load(session.user.id),
  });
  // The delete section needs to know whether a password is on file, so the
  // page holds its skeleton until sign-in methods have loaded too.
  const ready = useComputed(() => sessionChecked.value && signInMethodsModel.loaded.value);

  const onSignOut = async () => {
    await sessionModel.signOut();
    location.route("/", true);
  };

  if (!ready.value) {
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
          <SectionLabel as="h2">Profile</SectionLabel>
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
      <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Account settings</h1>
      <Muted class="text-[14px] leading-[1.55] m-0">
        Manage the security of your personal account. These settings apply to you across every
        organization.
      </Muted>
    </header>
  );
}
