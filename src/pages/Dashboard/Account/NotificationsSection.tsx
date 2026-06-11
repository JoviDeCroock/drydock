import { useEffect } from "preact/hooks";
import { useModel } from "@preact/signals";
import { NotificationSettingsModel } from "../../../models/account-settings";
import { Alert, Card, LoadingLine, Muted, SectionLabel } from "../../../components";

export function NotificationsSection() {
  const model = useModel(NotificationSettingsModel);

  useEffect(() => {
    void model.load();
  }, []);

  const settings = model.settings.value;
  const error = model.error.value;
  const saving = model.status.value === "saving";

  return (
    <Card class="p-5 flex flex-col gap-3">
      <SectionLabel>Notifications</SectionLabel>
      {error ? <Alert tone="critical">{error}</Alert> : null}
      {settings ? (
        <label class="flex items-start gap-2 text-[13px] text-ink cursor-pointer">
          <input
            type="checkbox"
            class="mt-[2px]"
            checked={settings.mentionEmails}
            disabled={saving}
            onChange={(e) => void model.setMentionEmails((e.target as HTMLInputElement).checked)}
          />
          <span class="flex flex-col gap-0.5">
            Email me when I'm mentioned
            <Muted class="text-[12px]">
              Sends an email when a teammate @-mentions you in a scan comment.
            </Muted>
          </span>
        </label>
      ) : (
        <LoadingLine size="inline">Loading notification settings</LoadingLine>
      )}
    </Card>
  );
}
