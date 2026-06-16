import type { ComponentChildren } from "preact";
import { Eyebrow, LinkButton, PageShell, SectionLabel } from "../../components";
import { privacyPageSeo, PageSeo } from "../../lib/seo";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

// Generic, document-shaped privacy policy. Wording is deliberately conservative
// and aligned with the product's trust boundary: publish credentials are stored
// encrypted and only decrypted to reach the registry, and package contents are
// never executed (see AGENTS.md "trust boundary"). Update the effective date
// below when the substantive terms change.
const EFFECTIVE_DATE = "2026-06-16";

const PRIVACY_MAILTO =
  "mailto:drydock@drydock.org?subject=Drydock%20privacy%20request&body=Tell%20us%20what%20you%27d%20like%20us%20to%20do%20with%20your%20data%3A%0A%0A";

export default function PrivacyPage() {
  const authed = useAuthedSession();

  return (
    <PageShell
      width="doc"
      class="gap-12"
      headerActions={<MarketingHeaderActions authed={authed} />}
    >
      <PageSeo metadata={privacyPageSeo} />
      <header class="py-8 md:py-12 border-t border-border flex flex-col gap-5">
        <Eyebrow tone="accent">Legal</Eyebrow>
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Privacy Policy
        </h1>
        <p class="m-0 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
          Effective {EFFECTIVE_DATE}
        </p>
        <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
          This policy explains what Drydock collects when you use the service, how that information
          is used, and the choices you have. We collect the minimum needed to review your releases
          and run your account.
        </p>
      </header>

      <div class="flex flex-col gap-14">
        <Section id="information-we-collect" label="What we collect">
          <Prose>We collect information in a few narrow categories:</Prose>
          <List
            items={[
              <>
                <Strong>Account information.</Strong> The email address you register with and basic
                authentication data needed to sign you in, keep your session, and (if you enable it)
                verify a second factor.
              </>,
              <>
                <Strong>Organization data.</Strong> The organizations, members, and invitations you
                create, and the repositories, registries, and environments you connect for review.
              </>,
              <>
                <Strong>Integration credentials.</Strong> Tokens you provide to connect a registry
                or code host. These are stored encrypted and used only to reach the integrated
                service on your behalf.
              </>,
              <>
                <Strong>Release metadata.</Strong> Package names, versions, file listings, diffs,
                checksums, and the review findings we compute for the releases you submit.
              </>,
              <>
                <Strong>Operational data.</Strong> Logs and events generated as the service runs,
                kept for reliability, abuse prevention, and debugging. We redact secrets and never
                log raw credentials, headers, or package contents.
              </>,
            ]}
          />
        </Section>

        <Section id="how-we-use" label="How we use it">
          <Prose>We use the information above to:</Prose>
          <List
            items={[
              <>operate your account, organizations, and sessions;</>,
              <>review the releases you submit and show you the resulting report;</>,
              <>
                connect to the registries and code hosts you authorize, and report decisions back;
              </>,
              <>keep the service secure, prevent abuse, and diagnose problems;</>,
              <>send you transactional messages such as verification and review notifications.</>,
            ]}
          />
          <Prose>
            We do not sell your personal information, and we do not use your release contents to
            train models.
          </Prose>
        </Section>

        <Section id="credentials-and-contents" label="Credentials &amp; package contents">
          <Prose>
            Integration tokens are stored encrypted and decrypted only at the moment Drydock needs
            to talk to the integrated service. Drydock never publishes on your behalf — you complete
            a publish with your own credentials — and a release is downloaded into a short-lived,
            isolated sandbox where its contents are inspected as untrusted evidence and never
            executed.
          </Prose>
        </Section>

        <Section id="sharing" label="How we share it">
          <Prose>
            We share information only as needed to run the service: with infrastructure providers
            that host and operate Drydock, with the registries and code hosts you explicitly connect
            (to fetch the artifacts you ask us to review and report decisions back), and where we
            are legally required to. We do not sell or rent your information to third parties.
          </Prose>
        </Section>

        <Section id="retention" label="Data retention">
          <Prose>
            We keep account and organization data for as long as your account is active. Review
            reports and release metadata are retained so you can refer back to past decisions.
            Operational logs are kept for a limited period and then deleted. When you delete your
            account or an organization, we delete or anonymize the associated data, except where we
            must retain it to meet a legal obligation.
          </Prose>
        </Section>

        <Section id="security" label="Security">
          <Prose>
            We protect data in transit and at rest, encrypt the credentials you entrust to us, scope
            every request to your organization, and limit access to production systems. No system is
            perfectly secure, but the service is built to fail closed and to keep credentials out of
            the components that inspect untrusted package contents.
          </Prose>
        </Section>

        <Section id="cookies" label="Cookies">
          <Prose>
            We use first-party cookies that are strictly necessary to sign you in and keep your
            session. We do not use advertising cookies or third-party tracking cookies.
          </Prose>
        </Section>

        <Section id="your-rights" label="Your choices &amp; rights">
          <Prose>
            Depending on where you live, you may have the right to access, correct, export, or
            delete your personal information, and to object to or restrict certain processing. You
            can manage much of your data from your account settings, or contact us and we will help.
            We will not discriminate against you for exercising these rights.
          </Prose>
        </Section>

        <Section id="international" label="International transfers">
          <Prose>
            Drydock runs on globally distributed infrastructure, so your information may be
            processed in countries other than your own. Where required, we rely on appropriate
            safeguards for those transfers.
          </Prose>
        </Section>

        <Section id="children" label="Children">
          <Prose>
            Drydock is a tool for software maintainers and is not directed to children. We do not
            knowingly collect personal information from anyone under 16.
          </Prose>
        </Section>

        <Section id="changes" label="Changes to this policy">
          <Prose>
            We may update this policy as the service evolves. When we make material changes, we will
            update the effective date above and, where appropriate, notify you. Continued use of
            Drydock after a change means you accept the updated policy.
          </Prose>
        </Section>

        <section class="flex flex-col gap-4 border-t border-border pt-10">
          <SectionLabel>Contact us</SectionLabel>
          <Prose>
            Questions about this policy or a request about your data? Email us and we will respond.
          </Prose>
          <div class="flex flex-wrap gap-3">
            <LinkButton href={PRIVACY_MAILTO}>Email drydock@drydock.org</LinkButton>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function Section({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ComponentChildren;
}) {
  return (
    <section id={id} class="flex flex-col gap-3.5 scroll-mt-6">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </section>
  );
}

function Prose({ children }: { children: ComponentChildren }) {
  return <p class="m-0 max-w-[680px] text-[14px] text-ink-muted leading-[1.65]">{children}</p>;
}

function Strong({ children }: { children: ComponentChildren }) {
  return <strong class="font-medium text-ink">{children}</strong>;
}

function List({ items }: { items: ComponentChildren[] }) {
  return (
    <ul class="list-none p-0 m-0 flex flex-col gap-2.5 max-w-[680px]">
      {items.map((item, index) => (
        <li key={index} class="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-x-2.5">
          <span class="font-mono text-[13px] text-ink-subtle leading-[1.65]" aria-hidden>
            ·
          </span>
          <span class="text-[14px] text-ink-muted leading-[1.65]">{item}</span>
        </li>
      ))}
    </ul>
  );
}
