import { useLocation } from "preact-iso";
import { LinkButton } from "../../components/Button";
import { HeaderFeedback } from "../../components/PageShell";
import { OrgSwitcher } from "../../components/OrgSwitcher";
import { UserMenu } from "../../components/UserMenu";
import { sessionModel } from "../../models/auth";
import type { OrganizationModel } from "../../models/organization";

type OrganizationModelInstance = InstanceType<typeof OrganizationModel>;

export type AppSection = "reviews" | "settings";

/**
 * The one header every signed-in page carries: where you can go (reviews,
 * settings), which organization you are in, and who you are. Pages differ only
 * in which section is current and in what switching organizations means for
 * them — a list reloads, a review that belongs to one organization leaves for
 * the new organization's reviews — so those are the inputs. A page without an
 * organization scope (account) omits the switcher rather than showing one that
 * changes nothing on it.
 */
export function AppHeaderActions({
  current,
  organizations,
  onActivate,
  onCreate,
}: {
  current?: AppSection | null;
  organizations?: OrganizationModelInstance;
  onActivate?: (organizationId: string) => Promise<unknown> | unknown;
  onCreate?: (name: string) => Promise<unknown> | unknown;
}) {
  const location = useLocation();
  const user = sessionModel.user.value;
  const onSignOut = async () => {
    await sessionModel.signOut();
    location.route("/", true);
  };
  return (
    <>
      <nav aria-label="Workspace" class="flex items-center gap-1">
        <SectionLink href="/dashboard" current={current === "reviews"}>
          Reviews
        </SectionLink>
        <SectionLink href="/dashboard/settings" current={current === "settings"}>
          Settings
        </SectionLink>
      </nav>
      <HeaderFeedback hideOnPhone />
      {organizations && onActivate && onCreate ? (
        <OrgSwitcher
          organizations={organizations.organizations.value}
          activeOrganizationId={organizations.activeOrganizationId.value}
          busy={organizations.busy.value}
          error={organizations.error.value}
          onActivate={onActivate}
          onCreate={onCreate}
        />
      ) : null}
      <UserMenu email={user?.email} name={user?.name} onSignOut={onSignOut} />
    </>
  );
}

function SectionLink({
  href,
  current,
  children,
}: {
  href: string;
  current: boolean;
  children: string;
}) {
  return (
    <LinkButton href={href} variant="ghost" size="sm" aria-current={current ? "page" : undefined}>
      {children}
    </LinkButton>
  );
}
