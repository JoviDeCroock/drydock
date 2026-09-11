import { createModel, signal } from "@preact/signals";
import type {
  OutOfBandAlarmWire,
  OutOfBandAlarmsResponse,
} from "../../server/routes/package-watch";
import { apiFetch, errorMessage } from "./api";

export type { OutOfBandAlarmWire };

export const OutOfBandModel = createModel(() => {
  const alarms = signal<OutOfBandAlarmWire[]>([]);
  const loaded = signal(false);
  const error = signal<string | null>(null);
  const acknowledging = signal<string | null>(null);

  return {
    alarms,
    loaded,
    error,
    acknowledging,

    reset(): void {
      this.alarms.value = [];
      this.loaded.value = false;
      this.error.value = null;
    },

    async refresh(): Promise<void> {
      try {
        const result = await apiFetch<OutOfBandAlarmsResponse>("/api/v1/package-watch/out-of-band");
        this.alarms.value = result.alarms;
        this.error.value = null;
      } catch (err) {
        this.error.value = errorMessage(err);
      } finally {
        this.loaded.value = true;
      }
    },

    async acknowledge(alarmId: string): Promise<void> {
      this.acknowledging.value = alarmId;
      try {
        await apiFetch(
          `/api/v1/package-watch/out-of-band/${encodeURIComponent(alarmId)}/acknowledge`,
          { method: "POST" },
        );
        this.alarms.value = this.alarms.value.filter((alarm) => alarm.id !== alarmId);
        this.error.value = null;
      } catch (err) {
        this.error.value = errorMessage(err);
      } finally {
        this.acknowledging.value = null;
      }
    },
  };
});
