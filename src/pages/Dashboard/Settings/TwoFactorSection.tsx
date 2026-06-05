import { useModel, useSignal } from "@preact/signals";
import { sessionModel } from "../../../models/auth";
import { TwoFactorModel } from "../../../models/two-factor";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  LinkButton,
  MonoDetail,
  Muted,
  SectionLabel,
} from "../../../components";

type DialogMode = "none" | "enroll" | "regenerate" | "disable";
type EnrollStep = "password" | "verify" | "backup";

function BackupCodes({ codes }: { codes: string[] }) {
  const downloadHref = `data:text/plain;charset=utf-8,${encodeURIComponent(codes.join("\n"))}`;
  return (
    <div class="flex flex-col gap-3">
      <div class="grid grid-cols-2 gap-1.5 rounded-md border border-border bg-surface-2 p-3 font-mono text-[13px]">
        {codes.map((value) => (
          <span key={value}>{value}</span>
        ))}
      </div>
      <LinkButton
        variant="secondary"
        size="sm"
        class="self-start"
        href={downloadHref}
        download="drydock-backup-codes.txt"
      >
        Download codes
      </LinkButton>
    </div>
  );
}

export function TwoFactorSection() {
  const tf = useModel(TwoFactorModel);
  const dialog = useSignal<DialogMode>("none");
  const enrollStep = useSignal<EnrollStep>("password");
  const password = useSignal("");
  const code = useSignal("");
  const savedConfirmed = useSignal(false);

  const enabled = sessionModel.user.value?.twoFactorEnabled === true;
  const busy = tf.busy.value;
  const error = tf.error.value;
  const codes = tf.backupCodes.value;

  const close = () => {
    dialog.value = "none";
    enrollStep.value = "password";
    password.value = "";
    code.value = "";
    savedConfirmed.value = false;
    tf.reset();
  };

  const open = (mode: Exclude<DialogMode, "none">) => {
    close();
    dialog.value = mode;
  };

  const onDialogClose = () => {
    if (dialog.value === "enroll" && enrollStep.value === "backup" && !savedConfirmed.value) {
      return;
    }
    close();
  };

  const onBeginEnroll = async (event: Event) => {
    event.preventDefault();
    const pw = password.value;
    if (await tf.beginEnroll(pw)) enrollStep.value = "verify";
  };

  const onConfirmEnroll = async (event: Event) => {
    event.preventDefault();
    const value = code.value.trim();
    if (await tf.confirmEnroll(value)) enrollStep.value = "backup";
  };

  const onRegenerate = async (event: Event) => {
    event.preventDefault();
    const pw = password.value;
    await tf.regenerateBackupCodes(pw);
  };

  const onDisable = async (event: Event) => {
    event.preventDefault();
    const pw = password.value;
    if (await tf.disable(pw)) close();
  };

  let dialogTitle = "";
  let dialogDescription: string | undefined;
  let dialogBody = null;

  if (dialog.value === "enroll" && enrollStep.value === "password") {
    dialogTitle = "Enable two-factor";
    dialogDescription = "Confirm your password to begin setup.";
    dialogBody = (
      <form class="flex flex-col gap-4" onSubmit={onBeginEnroll}>
        <Field label="Current password" for="tf-enroll-password">
          <Input
            id="tf-enroll-password"
            type="password"
            value={password}
            autocomplete="current-password"
            required
            onInput={(e) => (password.value = (e.target as HTMLInputElement).value)}
          />
        </Field>
        {error ? <Alert tone="critical">{error}</Alert> : null}
        <Button type="submit" class="self-end" disabled={busy}>
          {busy ? "Starting…" : "Continue"}
        </Button>
      </form>
    );
  } else if (dialog.value === "enroll" && enrollStep.value === "verify") {
    dialogTitle = "Scan the QR code";
    dialogDescription = "Scan with your authenticator app, then enter the 6-digit code to confirm.";
    dialogBody = (
      <form class="flex flex-col gap-4" onSubmit={onConfirmEnroll}>
        {tf.qrDataUrl.value ? (
          <img
            src={tf.qrDataUrl.value}
            alt="Two-factor QR code"
            width={200}
            height={200}
            class="self-center rounded-md border border-border bg-white p-2"
          />
        ) : null}
        {tf.secret.value ? (
          <div class="flex flex-col gap-1">
            <Muted class="text-[12px] m-0">Can't scan? Enter this key manually:</Muted>
            <code class="font-mono text-[12px] text-ink break-all rounded-md border border-border bg-surface-2 px-2 py-1.5">
              {tf.secret.value}
            </code>
          </div>
        ) : null}
        <Field label="Authentication code" for="tf-verify-code">
          <Input
            id="tf-verify-code"
            type="text"
            value={code}
            inputmode="numeric"
            autocomplete="one-time-code"
            required
            onInput={(e) => (code.value = (e.target as HTMLInputElement).value)}
          />
        </Field>
        {error ? <Alert tone="critical">{error}</Alert> : null}
        <Button type="submit" class="self-end" disabled={busy}>
          {busy ? "Verifying…" : "Verify & enable"}
        </Button>
      </form>
    );
  } else if (dialog.value === "enroll" && enrollStep.value === "backup") {
    dialogTitle = "Save your backup codes";
    dialogDescription =
      "Each code works once. Store them somewhere safe — you won't see them again.";
    dialogBody = (
      <div class="flex flex-col gap-4">
        {codes ? <BackupCodes codes={codes} /> : null}
        <label class="flex items-center gap-2 text-[13px] text-ink-muted">
          <input
            type="checkbox"
            checked={savedConfirmed.value}
            onInput={(e) => (savedConfirmed.value = (e.target as HTMLInputElement).checked)}
          />
          I've saved these codes
        </label>
        <Button class="self-end" disabled={!savedConfirmed.value} onClick={close}>
          Done
        </Button>
      </div>
    );
  } else if (dialog.value === "regenerate") {
    dialogTitle = "Regenerate backup codes";
    dialogDescription = codes
      ? undefined
      : "Confirm your password to generate a fresh set. Your old codes stop working.";
    dialogBody = codes ? (
      <div class="flex flex-col gap-4">
        <BackupCodes codes={codes} />
        <Button class="self-end" onClick={close}>
          Done
        </Button>
      </div>
    ) : (
      <form class="flex flex-col gap-4" onSubmit={onRegenerate}>
        <Field label="Current password" for="tf-regen-password">
          <Input
            id="tf-regen-password"
            type="password"
            value={password}
            autocomplete="current-password"
            required
            onInput={(e) => (password.value = (e.target as HTMLInputElement).value)}
          />
        </Field>
        {error ? <Alert tone="critical">{error}</Alert> : null}
        <Button type="submit" class="self-end" disabled={busy}>
          {busy ? "Generating…" : "Regenerate"}
        </Button>
      </form>
    );
  } else if (dialog.value === "disable") {
    dialogTitle = "Disable two-factor";
    dialogDescription = "Confirm your password. Your account will be protected by password only.";
    dialogBody = (
      <form class="flex flex-col gap-4" onSubmit={onDisable}>
        <Field label="Current password" for="tf-disable-password">
          <Input
            id="tf-disable-password"
            type="password"
            value={password}
            autocomplete="current-password"
            required
            onInput={(e) => (password.value = (e.target as HTMLInputElement).value)}
          />
        </Field>
        {error ? <Alert tone="critical">{error}</Alert> : null}
        <Button type="submit" variant="danger" class="self-end" disabled={busy}>
          {busy ? "Disabling…" : "Disable two-factor"}
        </Button>
      </form>
    );
  }

  return (
    <Card as="section" class="p-0 overflow-hidden">
      <div class="p-5 flex flex-col gap-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="flex flex-col gap-1.5 max-w-[760px]">
            <SectionLabel>Two-factor authentication</SectionLabel>
            <Muted class="text-[13px] m-0">
              Protect your account with a time-based code from an authenticator app. Once enabled,
              you'll enter a code each time you sign in.
            </Muted>
            <MonoDetail
              parts={[
                <span key="totp">totp authenticator</span>,
                <span key="backup">10 backup codes</span>,
              ]}
            />
          </div>
          <div class="shrink-0">
            {enabled ? <Badge tone="ok">enabled</Badge> : <Badge tone="neutral">not enabled</Badge>}
          </div>
        </div>

        {enabled ? (
          <div class="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => open("regenerate")}>
              Regenerate backup codes
            </Button>
            <Button variant="danger" onClick={() => open("disable")}>
              Disable two-factor
            </Button>
          </div>
        ) : (
          <div>
            <Button onClick={() => open("enroll")}>Enable two-factor</Button>
          </div>
        )}
      </div>

      <Dialog
        open={dialog.value !== "none"}
        onClose={onDialogClose}
        title={dialogTitle}
        description={dialogDescription}
      >
        {dialogBody}
      </Dialog>
    </Card>
  );
}
