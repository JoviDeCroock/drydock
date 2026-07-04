import QRCode from "qrcode";
import { createModel, signal } from "@preact/signals";
import { authPost, sessionModel } from "./auth";
import { runAction } from "./async-action";

interface EnableResponse {
  totpURI?: string;
  backupCodes?: string[];
}

interface BackupCodesResponse {
  backupCodes?: string[];
}

function parseSecret(totpURI: string): string | null {
  try {
    return new URL(totpURI).searchParams.get("secret");
  } catch {
    return null;
  }
}

export const TwoFactorModel = createModel(() => {
  const busy = signal(false);
  const error = signal<string | null>(null);
  const totpURI = signal<string | null>(null);
  const secret = signal<string | null>(null);
  const qrDataUrl = signal<string | null>(null);
  const backupCodes = signal<string[] | null>(null);

  return {
    busy,
    error,
    totpURI,
    secret,
    qrDataUrl,
    backupCodes,

    reset() {
      this.busy.value = false;
      this.error.value = null;
      this.totpURI.value = null;
      this.secret.value = null;
      this.qrDataUrl.value = null;
      this.backupCodes.value = null;
    },

    async beginEnroll(password: string): Promise<boolean> {
      return (
        (await runAction({
          status: this.busy,
          error: this.error,
          pending: true,
          idle: false,
          run: async () => {
            const data = (await authPost("/api/auth/two-factor/enable", {
              password,
            })) as EnableResponse;
            if (!data.totpURI) throw new Error("Could not start two-factor setup.");
            this.totpURI.value = data.totpURI;
            this.secret.value = parseSecret(data.totpURI);
            this.backupCodes.value = data.backupCodes ?? null;
            this.qrDataUrl.value = await QRCode.toDataURL(data.totpURI, { margin: 1, width: 200 });
            return true;
          },
        })) ?? false
      );
    },

    async confirmEnroll(code: string): Promise<boolean> {
      return (
        (await runAction({
          status: this.busy,
          error: this.error,
          pending: true,
          idle: false,
          run: async () => {
            await authPost("/api/auth/two-factor/verify-totp", { code });
            await sessionModel.load();
            return true;
          },
        })) ?? false
      );
    },

    async disable(password: string): Promise<boolean> {
      return (
        (await runAction({
          status: this.busy,
          error: this.error,
          pending: true,
          idle: false,
          run: async () => {
            await authPost("/api/auth/two-factor/disable", { password });
            await sessionModel.load();
            return true;
          },
        })) ?? false
      );
    },

    async regenerateBackupCodes(password: string): Promise<boolean> {
      return (
        (await runAction({
          status: this.busy,
          error: this.error,
          pending: true,
          idle: false,
          run: async () => {
            const data = (await authPost("/api/auth/two-factor/generate-backup-codes", {
              password,
            })) as BackupCodesResponse;
            this.backupCodes.value = data.backupCodes ?? null;
            return true;
          },
        })) ?? false
      );
    },
  };
});
