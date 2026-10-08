import { useComputed } from "@preact/signals";
import { useLocation } from "preact-iso";
import { authConfigModel, sessionModel, signInMethodsModel } from "../../../models/auth";
import { useAuthedDashboardSession } from "../../../features/account/useAuthedDashboardSession";
import { AppHeaderActions } from "../../../features/account/AppHeaderActions";
import { SettingsCard } from "../../../components/Card";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { MonoDetail, Muted, SectionLabel } from "../../../components/Typography";
import { TwoFactorSection } from "./TwoFactorSection";
import { DeleteAccountSection } from "./DeleteAccountSection";

export default function AccountPage() {
  const location = useLocation();
  const sessionChecked = useAuthedDashboardSession({
    onReady: async (session) => {
      await Promise.all([signInMethodsModel.load(session.user.id), authConfigModel.load()]);
    },
  });
  // The delete and two-factor sections word themselves around whether a
  // password is on file and whether this deployment can mail a link to add
  // one, so the page holds its skeleton until both lookups have answered.
  const ready = useComputed(
    () => sessionChecked.value && signInMethodsModel.loaded.value && authConfigModel.settled.value,
  );

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
    <PageShell width="doc" headerActions={<AppHeaderActions />}>
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
