import { useModel } from "@preact/signals";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { Muted } from "../../components/Typography";
import type { OutOfBandAlarmWire, OutOfBandModel } from "../../models/package-watch";

const VISIBLE_ALARM_LIMIT = 5;

function formatDetected(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "recently";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function OutOfBandAlarms({
  model,
}: {
  model: ReturnType<typeof useModel<typeof OutOfBandModel.prototype>>;
}) {
  const alarms = model.alarms.value;
  if (!alarms.length) return null;
  return (
    <Alert tone="critical">
      <div class="flex flex-col gap-2 min-w-0 flex-1">
        <strong class="font-semibold">Published without a Drydock review</strong>
        <Muted class="text-[12px] m-0">
          These versions reached the registry without going through your staged review or workflow
          gate. If nobody published them on purpose, treat the publishing credential as compromised.
        </Muted>
        {alarms.slice(0, VISIBLE_ALARM_LIMIT).map((alarm: OutOfBandAlarmWire) => (
          <div key={alarm.id} class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-[12px]">
              {alarm.packageName}@{alarm.version}
            </span>
            <Muted class="text-[12px] m-0">
              {`detected ${formatDetected(alarm.detectedAt)}${
                alarm.statusConfirmed ? "" : " · unconfirmed by npm status"
              }`}
            </Muted>
            <Button
              variant="ghost"
              size="sm"
              disabled={model.acknowledging.value === alarm.id}
              onClick={() => void model.acknowledge(alarm.id)}
            >
              {model.acknowledging.value === alarm.id ? "Acknowledging…" : "Acknowledge"}
            </Button>
          </div>
        ))}
        {alarms.length > VISIBLE_ALARM_LIMIT ? (
          <Muted class="text-[12px] m-0">+{alarms.length - VISIBLE_ALARM_LIMIT} more</Muted>
        ) : null}
        {model.error.value ? <span>{model.error.value}</span> : null}
      </div>
    </Alert>
  );
}
